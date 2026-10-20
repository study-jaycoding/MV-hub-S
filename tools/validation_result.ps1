# Source-only validation evidence. No tests, servers, publishing, or installation.
# A running file left by a killed process is incomplete, never a previous success.
function Write-ValidationJson {
    param([string]$Path, [object]$Value, [switch]$CreateOnly)

    $Temp = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $Bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(
            ($Value | ConvertTo-Json -Depth 16) + "`n")
        [System.IO.File]::WriteAllBytes($Temp, $Bytes)
        try {
            if (-not $CreateOnly -and [System.IO.File]::Exists($Path)) {
                [System.IO.File]::Replace($Temp, $Path, [NullString]::Value)
            }
            else {
                [System.IO.File]::Move($Temp, $Path)
            }
        }
        catch {
            $WriteFailure = $_
            # A filesystem can report an error after replacement. Only the exact
            # intended bytes establish completion; unreadable/other bytes fail.
            try {
                if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path)) -eq
                    [Convert]::ToBase64String($Bytes)) { return }
            }
            catch { }
            throw $WriteFailure
        }
    }
    finally {
        if ([System.IO.File]::Exists($Temp)) { [System.IO.File]::Delete($Temp) }
    }
}

function Assert-ValidationPlainPath {
    param([string]$Path)
    $Current = [System.IO.Path]::GetFullPath($Path)
    while ($Current) {
        if (Test-Path -LiteralPath $Current) {
            if ((Get-Item -LiteralPath $Current -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "Validation paths must not traverse a reparse point."
            }
        }
        $Current = [System.IO.Path]::GetDirectoryName($Current)
    }
}

function Start-ValidationRun {
    param([string]$ReportDirectory, [System.Collections.IDictionary]$Options = @{})

    $Directory = [System.IO.Path]::GetFullPath($ReportDirectory)
    Assert-ValidationPlainPath $Directory
    [void][System.IO.Directory]::CreateDirectory($Directory)
    $RunId = [Guid]::NewGuid().ToString('N')
    $RunFile = "validation-$RunId.json"
    $Data = [ordered]@{
        format_version = 1
        run_id = $RunId
        scope = 'source-only'
        status = 'running'
        passed = $false
        release_eligible = $false
        eligibility_reasons = @('artifact_validation_not_implemented')
        started_at = [DateTime]::UtcNow.ToString('o')
        finished_at = $null
        elapsed_ms = $null
        options = $Options
        current_step = 'initializing'
        source = $null
        source_after = $null
        source_unchanged = $null
        steps = @()
        cleanup = @{ status = 'not_measured' }
        error = $null
    }
    $Run = [pscustomobject]@{
        Path = Join-Path $Directory $RunFile
        LatestPath = Join-Path $Directory 'predeploy-latest.json'
        Clock = [System.Diagnostics.Stopwatch]::StartNew()
        Data = $Data
    }
    Write-ValidationJson -Path $Run.Path -Value $Data -CreateOnly
    # Pointer only: completion updates the unique run, never an older run's latest.
    # If this write fails, the caller must abort before any validation command.
    Write-ValidationJson -Path $Run.LatestPath -Value ([ordered]@{
        format_version = 1; run_id = $RunId; run_file = $RunFile
    })
    return $Run
}

function Save-ValidationRun {
    param([object]$Run)
    if ($Run.Data.status -ne 'running') { throw 'A completed validation run is immutable.' }
    Write-ValidationJson -Path $Run.Path -Value $Run.Data
}

function Complete-ValidationRun {
    param(
        [object]$Run,
        [ValidateSet('passed', 'failed', 'interrupted')][string]$Status,
        [object]$Failure = $null
    )
    if ($Run.Data.status -ne 'running') { throw 'A completed validation run is immutable.' }
    # Do not mutate the in-memory state until the atomic write succeeds. A write
    # failure must leave running/incomplete evidence, never a false passed state.
    $Final = [ordered]@{}
    foreach ($Key in $Run.Data.Keys) { $Final[$Key] = $Run.Data[$Key] }
    $Final.status = $Status
    $Final.passed = $Status -eq 'passed'
    $Final.release_eligible = $false  # P0 has no artifact validation authority.
    $Final.finished_at = [DateTime]::UtcNow.ToString('o')
    $Final.elapsed_ms = $Run.Clock.Elapsed.TotalMilliseconds
    $Final.error = $Failure
    Write-ValidationJson -Path $Run.Path -Value $Final
    $Run.Data = $Final
    $Run.Clock.Stop()
}

function Get-ValidationSourceManifest {
    param([string]$ProjectRoot)

    $Root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
    Assert-ValidationPlainPath $Root
    $GitRoot = @(& git -C $Root rev-parse --show-toplevel)
    if ($LASTEXITCODE -ne 0 -or -not $GitRoot -or
        [System.IO.Path]::GetFullPath([string]$GitRoot[0]).TrimEnd('\', '/') -ine $Root) {
        throw 'Validation source must be the Git repository root.'
    }
    $Commit = @(& git -C $Root rev-parse HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'Git commit could not be resolved.' }
    $Branch = @(& git -C $Root branch --show-current)
    if ($LASTEXITCODE -ne 0) { throw 'Git branch could not be resolved.' }
    $Dirty = @(& git -C $Root status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Git status could not be read.' }
    $TrackedRaw = @(& git -C $Root -c core.quotepath=false ls-files --cached -z)
    if ($LASTEXITCODE -ne 0) { throw 'Tracked source paths could not be read.' }
    $OtherRaw = @(& git -C $Root -c core.quotepath=false ls-files --others --exclude-standard -z)
    if ($LASTEXITCODE -ne 0) { throw 'Untracked source paths could not be read.' }
    $Tracked = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $Paths = [System.Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
    foreach ($Path in (([string]::Join("`n", $TrackedRaw)) -split "`0")) {
        if ($Path) { [void]$Tracked.Add($Path); [void]$Paths.Add($Path) }
    }
    foreach ($Path in (([string]::Join("`n", $OtherRaw)) -split "`0")) {
        if ($Path) { [void]$Paths.Add($Path) }
    }
    $Files = @()
    foreach ($Path in $Paths) {
        # Positive source scope; never traverse a data/profile/runtime directory.
        $SourcePath = $Path -match '^(backend/(app/|tests/|[^/]+$)|frontend/(src/|tests/|measure/|[^/]+$)|tools/|release/|deploy/|[^/]+$)'
        $SourceType = $Path -match '\.(py|ps1|bat|ts|tsx|js|cjs|mjs|json|toml|ini|sql|html|css|xml|ya?ml)$' -or
            $Path -match '(^|/)(requirements[^/]*\.txt|hf_cli_version\.txt|\.gitignore)$'
        $Excluded = $Path -match '(^|/)(data[^/]*|media|backups?|profiles?|runtime|node_modules|dist|measure-dist|packages|_staging|__pycache__|\.venv|\.git|predeploy-reports)/' -or
            $Path -match '(^|/)([^/]*(secret|password|credential|token)[^/]*\.(json|txt|ini)|\.env[^/]*|id_rsa[^/]*|machine_settings\.json|device_identity\.json|publish_target\.txt|backup_replica_target\.txt)$' -or
            ($Path -match '(^|/)\.[^/]+$' -and $Path -notmatch '(^|/)\.gitignore$')
        if (-not $SourcePath -or -not $SourceType -or $Excluded) { continue }
        if ($Path -match '[\r\n]' -or $Path.Split('/') -contains '..') { throw 'Unsafe source path.' }
        $Full = [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
        if (-not $Full.StartsWith($Root + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Source path escaped the repository.'
        }
        Assert-ValidationPlainPath $Full
        $Hash = $null
        $Size = $null
        if ([System.IO.File]::Exists($Full)) {
            $Stream = [System.IO.File]::OpenRead($Full)
            $Hasher = [System.Security.Cryptography.SHA256]::Create()
            try {
                $Size = $Stream.Length
                $Hash = ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
            }
            finally { $Hasher.Dispose(); $Stream.Dispose() }
        }
        $Files += [ordered]@{ path = $Path; tracked = $Tracked.Contains($Path); size = $Size; sha256 = $Hash }
    }
    if (-not $Files.Count) { throw 'No source files matched the validation scope.' }
    $Bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($Files | ConvertTo-Json -Depth 4 -Compress))
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $Digest = ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $Hasher.Dispose() }
    return [ordered]@{
        scope_version = 1
        scope = 'Git tracked and non-ignored untracked source/config/lock files; explicit source paths/extensions; data, secrets, dependencies and build outputs excluded'
        commit = [string]$Commit[0]
        branch = [string]($Branch -join '')
        dirty = $Dirty.Count -gt 0
        file_count = $Files.Count
        sha256 = $Digest
        files = $Files
    }
}

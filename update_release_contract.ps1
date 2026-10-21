# Installed trusted verifier; source publisher and updater share this implementation.
function Get-ReleaseSha256 {
    param([string]$Path)
    $Stream = [System.IO.File]::OpenRead($Path)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $Hasher.Dispose(); $Stream.Dispose() }
}

function ConvertFrom-ReleaseJson {
    param([byte[]]$Bytes)
    if ($Bytes.Length -gt 4194304) { throw 'Release contract is too large.' }
    $Text = [System.Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF)
    # ConvertFrom-Json silently keeps the last duplicate. Check property scopes first.
    $Tokens = [regex]::Matches($Text, '"(?:\\.|[^"\\])*"|[{}\[\]:]')
    $Stack = New-Object System.Collections.Stack
    for ($Index = 0; $Index -lt $Tokens.Count; $Index++) {
        $Token = $Tokens[$Index].Value
        if ($Token -eq '{') { $Stack.Push((New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase))) }
        elseif ($Token -eq '[') { $Stack.Push($null) }
        elseif ($Token -in @('}', ']')) { if ($Stack.Count) { $null = $Stack.Pop() } }
        elseif ($Token.StartsWith('"') -and $Index + 1 -lt $Tokens.Count -and $Tokens[$Index + 1].Value -eq ':') {
            $Key = @(('[' + $Token + ']') | ConvertFrom-Json)[0]
            if ($Stack.Count -and $null -ne $Stack.Peek() -and -not $Stack.Peek().Add($Key)) { throw 'Duplicate JSON property.' }
        }
    }
    return $Text | ConvertFrom-Json
}

function Get-QualifiedRelease {
    # Source-side publisher only. Never starts Python from the candidate ZIP.
    param([string]$PackagePath, [switch]$AllowUnqualified)
    $Package = Get-Item -LiteralPath $PackagePath -ErrorAction Stop
    $CandidatePath = [System.IO.Path]::ChangeExtension($Package.FullName, '.candidate.json')
    $Raw = [System.IO.File]::ReadAllBytes($CandidatePath)
    $Candidate = ConvertFrom-ReleaseJson $Raw
    $Contract = $Candidate.contract
    if ($Contract.format_version -isnot [int] -or $Contract.format_version -ne 1 -or -not $Contract.build_id -or $Contract.descriptor_sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Qualified release contract required; legacy-unverified packages cannot be published.'
    }
    if ($Candidate.file -cne $Package.Name -or $Candidate.size -ne $Package.Length -or
        $Candidate.sha256 -cne (Get-ReleaseSha256 $Package.FullName)) { throw 'Release artifact mismatch.' }
    $Ref = $Contract.validation_receipt
    $ReceiptPath = $null
    $ReceiptRaw = $null
    if (-not $Ref -and -not $AllowUnqualified) { throw 'Validation receipt required.' }
    if ($Ref) {
    if (-not $Ref -or $Ref.file -match '[/\\:]' -or $Ref.file -in @('', '.', '..') -or
        $Ref.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Validation receipt required.' }
    $ReceiptPath = Join-Path $Package.DirectoryName $Ref.file
    if ((Get-ReleaseSha256 $ReceiptPath) -cne $Ref.sha256) { throw 'Validation receipt digest mismatch.' }
    $ReceiptRaw = [System.IO.File]::ReadAllBytes($ReceiptPath)
    $Receipt = ConvertFrom-ReleaseJson $ReceiptRaw
    if ($Receipt.format_version -isnot [int] -or $Receipt.format_version -ne 1 -or $Receipt.scope -cne 'artifact' -or
        $Receipt.profile -cne 'release-qualification-v1' -or $Receipt.status -cne 'passed' -or
        $Receipt.release_eligible -isnot [bool] -or -not $Receipt.release_eligible -or -not $Receipt.run_id -or
        $Receipt.artifact.sha256 -cne $Candidate.sha256 -or $Receipt.artifact.size -ne $Candidate.size -or
        $Receipt.descriptor_sha256 -cne $Contract.descriptor_sha256 -or $null -eq $Receipt.skips -or
        @($Receipt.skips).Count -ne 0 -or $Receipt.cleanup.status -cne 'passed') { throw 'Artifact qualification did not pass.' }
    foreach ($Check in @('artifact_integrity', 'isolated_install', 'runtime_health', 'compatibility', 'cleanup')) {
        if ($Receipt.checks.$Check -cne 'passed') { throw "Required qualification check did not pass: $Check" }
    }
    foreach ($Check in $Receipt.checks.PSObject.Properties) {
        if ($Check.Value -cne 'passed') { throw 'Qualification contains failed/skipped checks.' }
    }
    if (-not $Receipt.tool_sha256 -or @($Receipt.tool_sha256.PSObject.Properties).Count -eq 0) { throw 'Qualification tool digests required.' }
    foreach ($Tool in $Receipt.tool_sha256.PSObject.Properties) {
        if ($Tool.Value -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid qualification tool digest.' }
    }
    if ($Receipt.started_at -notmatch '(Z|[+-]\d\d:\d\d)$' -or $Receipt.finished_at -notmatch '(Z|[+-]\d\d:\d\d)$' -or
        [DateTimeOffset]::Parse($Receipt.finished_at) -lt [DateTimeOffset]::Parse($Receipt.started_at)) { throw 'Invalid qualification times.' }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [System.IO.Compression.ZipFile]::OpenRead($Package.FullName)
    try {
        $Entries = @($Archive.Entries | Where-Object { $_.FullName -ieq 'build-manifest.json' })
        if ($Entries.Count -ne 1 -or $Entries[0].Length -gt 4194304) { throw 'Build descriptor missing or invalid.' }
        $Stream = $Entries[0].Open()
        $Memory = New-Object System.IO.MemoryStream
        try { $Stream.CopyTo($Memory); $DescriptorRaw = $Memory.ToArray() }
        finally { $Stream.Dispose(); $Memory.Dispose() }
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try { $Digest = ([BitConverter]::ToString($Hasher.ComputeHash($DescriptorRaw))).Replace('-', '').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
        if ($Digest -cne $Contract.descriptor_sha256) { throw 'Descriptor digest mismatch.' }
        $Descriptor = ConvertFrom-ReleaseJson $DescriptorRaw
        if ($Descriptor.format_version -isnot [int] -or $Descriptor.format_version -ne 1 -or $Descriptor.version -cne $Candidate.version -or
            $Descriptor.build_id -cne $Contract.build_id -or $Descriptor.source.dirty -isnot [bool] -or
            $Descriptor.source.dirty -or $Descriptor.PSObject.Properties.Name -contains 'sha256' -or
            $Descriptor.PSObject.Properties.Name -contains 'artifact_sha256') { throw 'Invalid build descriptor.' }
        $Compatibility = $Contract.compatibility
        if (($Descriptor.compatibility | ConvertTo-Json -Depth 10 -Compress) -cne ($Compatibility | ConvertTo-Json -Depth 10 -Compress)) {
            throw 'Compatibility declaration mismatch.'
        }
        if ($Compatibility.protocol_version -isnot [int] -or $Compatibility.protocol_version -ne 1 -or $Compatibility.rollout -cnotin @('bridge', 'enforced') -or
            $Compatibility.required_installer_capabilities -isnot [array]) { throw 'Unsupported compatibility declaration.' }
        foreach ($Capability in $Compatibility.required_installer_capabilities) {
            if ($Capability -isnot [string]) { throw 'Unsupported compatibility declaration.' }
        }
        if ($Compatibility.rollout -ceq 'bridge' -and
            ($Compatibility.backward_compatible -isnot [bool] -or -not $Compatibility.backward_compatible -or
             @($Compatibility.required_installer_capabilities).Count -ne 0)) { throw 'Bridge must be backward compatible.' }
        if ($Compatibility.rollout -ceq 'enforced' -and $Compatibility.required_installer_capabilities -cnotcontains 'artifact-receipt-v1') {
            throw 'Enforced release requires artifact-receipt-v1.'
        }
        $Schema = $Compatibility.db_schema
        foreach ($Key in @('read_min', 'read_max', 'write_min', 'write_max')) {
            if (($Schema.$Key -isnot [int] -and $Schema.$Key -isnot [long]) -or $Schema.$Key -lt 0) { throw 'Database compatibility range required.' }
        }
        if ($Schema.read_min -gt $Schema.write_min -or $Schema.write_min -gt $Schema.write_max -or $Schema.write_max -gt $Schema.read_max) {
            throw 'Invalid database compatibility range.'
        }
        $Names = @{}
        foreach ($Entry in $Archive.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            if (-not $Name -or $Name -match '(^/|:|(^|/)\.\.?(/|$)|//|[. ](/|$))') { throw 'Unsafe ZIP path.' }
            $IsDirectory = $Name.EndsWith('/')
            $Name = $Name.TrimEnd('/')
            if (@($Name.Split('/') | Where-Object { $_ -match '^[^/.]{1,6}~[0-9]+(\.[^/]{1,3})?$' }).Count) { throw 'Unsafe ZIP path.' }
            if ($Name -match '^(backend/data|data|logs|\.install-checkpoints|\.install-journals)(/|$)' -or
                $Name -match '^backend/(content_hub|content_hub_trash)\.db(?:-(?:wal|shm|journal))?$' -or
                $Name -match '^(INSTALL_SOURCE\.txt|update-journal\.json|\.install-activation\.json|\.update\.lock|\.resolve-transfer\.lock)$') { throw 'Package targets installation-owned data.' }
            if ((($Entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'ZIP symlink forbidden.' }
            if ($IsDirectory) { continue }
            if ($Names.ContainsKey($Name)) { throw 'Duplicate ZIP path.' }
            $Names[$Name] = $Entry
        }
        $Seen = @{ 'build-manifest.json' = $true }
        if (-not $Descriptor.payload -or $Descriptor.role -cne 'worker' -or $Descriptor.source.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Payload/source declaration required.'
        }
        if (-not $Descriptor.source.commit -or -not $Descriptor.source.tree -or -not $Descriptor.runtime -or
            -not $Descriptor.lock_sha256 -or @($Descriptor.lock_sha256.PSObject.Properties).Count -eq 0) { throw 'Build provenance required.' }
        foreach ($DigestEntry in $Descriptor.lock_sha256.PSObject.Properties) {
            if ($DigestEntry.Value -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid dependency lock digest.' }
        }
        foreach ($Row in $Descriptor.payload) {
            $Name = [string]$Row.path
            if ($Seen.ContainsKey($Name) -or -not $Names.ContainsKey($Name) -or $Names[$Name].FullName.Replace('\', '/') -cne $Name -or
                $Names[$Name].Length -ne $Row.size -or $Row.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Payload inventory mismatch.' }
            $Seen[$Name] = $true
            $PayloadStream = $Names[$Name].Open()
            $PayloadHasher = [System.Security.Cryptography.SHA256]::Create()
            try { $PayloadHash = ([BitConverter]::ToString($PayloadHasher.ComputeHash($PayloadStream))).Replace('-', '').ToLowerInvariant() }
            finally { $PayloadHasher.Dispose(); $PayloadStream.Dispose() }
            if ($PayloadHash -cne $Row.sha256) { throw 'Payload digest mismatch.' }
        }
        if ($Seen.Count -ne $Names.Count) { throw 'Unlisted ZIP payload.' }
        foreach ($VersionName in @('VERSION.txt', 'hf_cli_version.txt')) {
            if (-not $Names.ContainsKey($VersionName) -or $Names[$VersionName].Length -gt 4096) { throw 'Version metadata missing.' }
            $Reader = New-Object System.IO.StreamReader($Names[$VersionName].Open())
            try { $VersionText = $Reader.ReadToEnd().Trim() }
            finally { $Reader.Dispose() }
            $ExpectedVersion = if ($VersionName -ceq 'VERSION.txt') { $Candidate.version } else { $Descriptor.runtime.higgsfield_cli }
            if ($VersionText -cne $ExpectedVersion) { throw 'Version metadata mismatch.' }
        }
    }
    finally { $Archive.Dispose() }
    return [pscustomobject]@{ Bytes = $Raw; Candidate = $Candidate; CandidatePath = $CandidatePath; ReceiptPath = $ReceiptPath; ReceiptBytes = $ReceiptRaw }
}

function Assert-ReleaseEvidenceUnchanged {
    param($Evidence)
    foreach ($Item in @(@($Evidence.CandidatePath, $Evidence.Bytes), @($Evidence.ReceiptPath, $Evidence.ReceiptBytes))) {
        if (-not $Item[0]) { continue }
        if ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Item[0])) -cne [Convert]::ToBase64String($Item[1])) {
            throw 'Qualification evidence changed before publication.'
        }
    }
}

function Assert-InstalledReleasePayload {
    param([string]$Root, $Candidate)
    if (-not $Candidate.contract) { return }
    $DescriptorPath = Join-Path $Root 'build-manifest.json'
    if ((Get-ReleaseSha256 $DescriptorPath) -cne $Candidate.contract.descriptor_sha256) { throw 'Installed build descriptor changed.' }
    $Descriptor = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($DescriptorPath))
    $Prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $CheckedDirectories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($Entry in $Descriptor.payload) {
        $Path = [IO.Path]::GetFullPath((Join-Path $Root $Entry.path))
        if (-not $Path.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload escaped its installation.' }
        $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        $Ancestor = $Item
        while ($Ancestor) {
            if ($Ancestor -is [IO.DirectoryInfo] -and $CheckedDirectories.Contains($Ancestor.FullName)) { break }
            if ($Ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installed payload traverses a reparse point.' }
            if ($Ancestor -is [IO.DirectoryInfo]) { $null = $CheckedDirectories.Add($Ancestor.FullName) }
            $Ancestor = if ($Ancestor -is [IO.FileInfo]) { $Ancestor.Directory } else { $Ancestor.Parent }
        }
        if ($Item.Length -ne $Entry.size -or (Get-ReleaseSha256 $Path) -cne $Entry.sha256) { throw 'Installed payload digest mismatch.' }
    }
}

function Write-InstallRecord {
    param([string]$Path, $Record)
    $Bytes = [System.Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Depth 20) + "`n")
    $Temporary = $Path + '.tmp-' + [Guid]::NewGuid().ToString('N')
    try {
        $Stream = [System.IO.File]::Open($Temporary, 'CreateNew', 'Write', 'None')
        try { $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) }
        finally { $Stream.Dispose() }
        if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
        else { [System.IO.File]::Move($Temporary, $Path) }
    }
    catch {
        if (-not (Test-Path -LiteralPath $Path) -or
            [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path)) -cne [Convert]::ToBase64String($Bytes)) { throw }
        # A replace can finish before reporting an I/O error. Confirm exact durable bytes.
    }
    finally { if (Test-Path -LiteralPath $Temporary) { [System.IO.File]::Delete($Temporary) } }
}

function Set-InstallPhase {
    param([string]$Phase, [hashtable]$Changes = @{})
    if (-not $script:InstallJournal) { throw 'Install journal is not initialized.' }
    $Disk = ConvertFrom-ReleaseJson ([System.IO.File]::ReadAllBytes($JournalPath))
    if ($Disk.run_id -cne $script:InstallJournal.run_id -or $Disk.phase -cne $script:InstallJournal.phase -or
        $Disk.updated_at -cne $script:InstallJournal.updated_at) { throw 'Install journal changed.' }
    $Phases = @('prepare', 'verified', 'draining', 'quiesced', 'checkpointed', 'activation_pending', 'starting', 'ready', 'committed')
    if ($script:InstallJournal.phase -in @('committed', 'rolled_back')) { throw 'Install journal is terminal.' }
    if ($Phase -cne $script:InstallJournal.phase -and $Phase -notin @('failed', 'recovery_required', 'rolled_back') -and
        ([Array]::IndexOf($Phases, $Phase) -ne [Array]::IndexOf($Phases, $script:InstallJournal.phase) + 1)) { throw 'Invalid install phase transition.' }
    $Next = @{}
    foreach ($Key in $script:InstallJournal.Keys) { $Next[$Key] = $script:InstallJournal[$Key] }
    foreach ($Key in $Changes.Keys) { $Next[$Key] = $Changes[$Key] }
    foreach ($Flag in @('db_mutation_possible', 'business_writes_possible')) {
        if ($script:InstallJournal[$Flag] -and -not $Next[$Flag]) { throw 'Install mutation flags cannot be cleared.' }
    }
    if ($Phase -in @('starting', 'ready', 'committed') -and -not $Next.db_mutation_possible) { throw 'Startup DB intent must be recorded first.' }
    $Next.phase = $Phase
    $Next.updated_at = [DateTime]::UtcNow.ToString('o')
    Write-InstallRecord -Path $JournalPath -Record $Next
    $script:InstallJournal = $Next
}

function Assert-InstalledCapability {
    param($Candidate, [string]$Root)
    if (-not $Candidate.contract) {
        if (Test-Path -LiteralPath (Join-Path $Root 'build-manifest.json')) { throw 'Descriptor downgrade to an unverified legacy package is forbidden.' }
        return
    }
    $Path = Join-Path $Root 'installer-capabilities.json'
    $Capabilities = @()
    if (Test-Path -LiteralPath $Path) {
        $Installed = ConvertFrom-ReleaseJson ([System.IO.File]::ReadAllBytes($Path))
        if ($Installed.format_version -ne 1) { throw 'Unsupported installed capabilities.' }
        $Capabilities = @($Installed.capabilities)
    }
    foreach ($Required in $Candidate.contract.compatibility.required_installer_capabilities) {
        if ($Capabilities -cnotcontains $Required) { throw 'Install the compatible bridge before this release.' }
    }
}

function Test-PreviousDatabaseCompatibility {
    param($PreviousCompatibility, [object[]]$Current, [object[]]$Checkpoint)
    if (-not $PreviousCompatibility -or -not $Current -or $Current.Count -ne $Checkpoint.Count) { return $false }
    $Schema = $PreviousCompatibility.db_schema
    if ($null -eq $PreviousCompatibility.reader_protocol -or $null -eq $PreviousCompatibility.writer_protocol) { return $false }
    foreach ($Name in @('reader_protocol', 'writer_protocol')) {
        if (($PreviousCompatibility.$Name -isnot [int] -and $PreviousCompatibility.$Name -isnot [long]) -or $PreviousCompatibility.$Name -lt 1) { return $false }
    }
    $SeenDatabases = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($Database in $Current) {
        if (-not $SeenDatabases.Add(([string]$Database.key) + ':' + ([string]$Database.database_id))) { return $false }
        if ($Database.status -cne 'compatible' -or -not $Database.database_id -or
            @($Checkpoint | Where-Object { $_.key -ceq $Database.key -and $_.database_id -ceq $Database.database_id }).Count -ne 1 -or
            $Database.schema_version -lt $Schema.read_min -or $Database.schema_version -gt $Schema.read_max -or
            $Database.schema_version -lt $Schema.write_min -or $Database.schema_version -gt $Schema.write_max -or
            $Database.minimum_reader_protocol -gt $PreviousCompatibility.reader_protocol -or
            $Database.minimum_writer_protocol -gt $PreviousCompatibility.writer_protocol) { return $false }
        foreach ($Component in $Database.components) {
            if (@($PreviousCompatibility.supported_components) -cnotcontains $Component) { return $false }
        }
    }
    return $true
}

function Test-ReadyProcessIdentity {
    param($Ready, [string]$ExpectedBuild, [string]$Nonce, [int]$Port, [string]$Root, [DateTime]$NotBefore)
    if ($Ready.status -cne 'ready' -or $Ready.runtime.execution_nonce -cne $Nonce -or
        $Ready.runtime.build_id -cne $ExpectedBuild -or $Ready.runtime.role -cne 'worker') { return $false }
    $Listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($Listener.Count -ne 1 -or [int]$Ready.runtime.process_id -ne [int]$Listener[0]) { return $false }
    $Process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Listener[0]) -ErrorAction Stop
    if ($Process.CreationDate.ToUniversalTime() -lt $NotBefore.ToUniversalTime()) { return $false }
    $Prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $Process.ExecutablePath -or -not ([string]$Process.ExecutablePath).StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return @{ pid = [int]$Process.ProcessId; creation_time = [string]$Process.CreationDate.ToUniversalTime().ToString('o'); executable_sha256 = Get-ReleaseSha256 $Process.ExecutablePath }
}

function Assert-LegacyCommittedInstall {
    param([string]$Root, $Intent)
    if (@($Intent.PSObject.Properties).Count -ne 3 -or
        $Intent.token -isnot [string] -or $Intent.token -cnotmatch '^[0-9a-f]{8}$' -or
        $Intent.updated_at -isnot [string] -or $Intent.updated_at -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -or
        $Intent.components -isnot [array] -or $Intent.components.Count -eq 0) { throw 'Invalid legacy install journal.' }
    $null = [DateTimeOffset]::Parse($Intent.updated_at)
    foreach ($Name in @('build-manifest.json', 'VERSION.txt')) {
        $Item = Get-Item -LiteralPath (Join-Path $Root $Name) -Force -ErrorAction Stop
        if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid legacy install metadata.' }
    }
    $DescriptorPath = Join-Path $Root 'build-manifest.json'
    $DescriptorHash = Get-ReleaseSha256 $DescriptorPath
    $Descriptor = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($DescriptorPath))
    if ($Descriptor.format_version -isnot [int] -or $Descriptor.format_version -ne 1 -or $Descriptor.role -cne 'worker' -or
        $Descriptor.version -isnot [string] -or -not $Descriptor.version -or
        $Descriptor.version -cne ([IO.File]::ReadAllText((Join-Path $Root 'VERSION.txt'))).Trim() -or
        $Descriptor.payload -isnot [array] -or $Descriptor.payload.Count -eq 0) { throw 'Legacy install version or payload is invalid.' }

    # Reconstruct the old worker's replacement list from the installed inventory, not its progress flags.
    $Expected = @{ 'backend/app' = 'dir'; 'frontend/dist' = 'dir'; 'runtime/node' = 'dir';
        'runtime/higgsfield' = 'dir'; 'runtime/python' = 'dir'; 'build-manifest.json' = 'file' }
    $Covered = @{}
    $Payload = @{}
    foreach ($Entry in $Descriptor.payload) {
        $Name = $Entry.path
        if ($Name -isnot [string] -or -not $Name -or $Name -match '(^/|[\\<>:"|?*\x00-\x1f]|(^|/)\.\.?(/|$)|//|[. ](/|$)|/$)' -or
            $Name -match '^(backend/data|data|logs|\.install-checkpoints|\.install-journals)(/|$)' -or
            $Name -match '^backend/(content_hub|content_hub_trash)\.db(?:-(?:wal|shm|journal))?$' -or
            $Name -match '^(build-manifest\.json|INSTALL_SOURCE\.txt|update-journal\.json|\.install-activation\.json|\.update\.lock|\.resolve-transfer\.lock)$' -or
            $Payload.ContainsKey($Name) -or ($Entry.size -isnot [int] -and $Entry.size -isnot [long]) -or
            $Entry.size -lt 0 -or $Entry.sha256 -isnot [string] -or $Entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid legacy payload inventory.' }
        $Payload[$Name] = $true
        if ($Name -ceq 'VERSION.txt') { continue }
        $Parts = $Name.Split('/')
        $Relative = $Parts[0]
        $Kind = if ($Parts.Count -eq 1) { 'file' } else { 'dir' }
        if ($Parts.Count -gt 1 -and $Parts[0] -cin @('backend', 'frontend', 'runtime')) {
            $Relative = $Parts[0] + '/' + $Parts[1]
            $Kind = if ($Parts.Count -eq 2) { 'file' } else { 'dir' }
            if ($Parts[0] -cin @('frontend', 'runtime') -and -not $Expected.ContainsKey($Relative)) { throw 'Payload is outside legacy replacement components.' }
        }
        if ($Expected.ContainsKey($Relative) -and $Expected[$Relative] -cne $Kind) { throw 'Conflicting legacy component kinds.' }
        $Expected[$Relative] = $Kind
        $Covered[$Relative] = $true
    }
    foreach ($Required in @('VERSION.txt', 'MV_agent.bat', 'update_release.bat', 'run_release_update.ps1',
        'update_release_worker.bat', 'run_agent_session.py', 'agent_push.py', 'backend/serve.py',
        'backend/app/main.py', 'frontend/dist/index.html')) {
        if (-not $Payload.ContainsKey($Required)) { throw 'Required legacy payload is missing.' }
    }
    foreach ($Required in @('backend/app', 'frontend/dist', 'runtime/node', 'runtime/higgsfield', 'runtime/python')) {
        if (-not $Covered.ContainsKey($Required)) { throw 'Required legacy component is empty.' }
    }
    $Seen = @{}
    foreach ($Component in $Intent.components) {
        if (@($Component.PSObject.Properties).Count -ne 5 -or $Component.relative -isnot [string] -or
            $Component.had_previous -isnot [bool] -or $Component.old_moved -isnot [bool] -or -not $Component.old_moved -or
            $Component.swapped -isnot [bool] -or -not $Component.swapped) { throw 'Legacy component swap is incomplete.' }
        $Relative = $Component.relative.Replace('\', '/')
        if ($Seen.ContainsKey($Relative) -or -not $Expected.ContainsKey($Relative) -or
            $Component.kind -cne $Expected[$Relative]) { throw 'Legacy component list does not match installed payload.' }
        $Seen[$Relative] = $true
    }
    if ($Seen.Count -ne $Expected.Count) { throw 'Legacy component list is incomplete.' }
    # Rollback leaves swap flags set, so verify actual files even when VERSION matches.
    Assert-InstalledReleasePayload -Root $Root -Candidate ([pscustomobject]@{ contract = @{ descriptor_sha256 = $DescriptorHash } })
}

function Initialize-WorkerActivation {
    param([string]$Root)
    $Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($Root.StartsWith('\\')) { throw 'Worker activation requires a local installation.' }
    $Control = Join-Path $Root '.install-activation.json'
    $Journal = Join-Path $Root 'update-journal.json'
    foreach ($Path in @($Root, $Control, $Journal)) {
        if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Activation reparse points are forbidden.'
        }
    }
    $Ancestor = [IO.DirectoryInfo]$Root
    while ($Ancestor) {
        if ($Ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Activation root traverses a reparse point.' }
        $Ancestor = $Ancestor.Parent
    }
    if ($env:MVHUB_ACTIVATION_CONTROL) {
        if ($env:MVHUB_ACTIVATION_CONTROL -ine $Control -or $env:MVHUB_ACTIVATION_ROOT.TrimEnd('\') -ine $Root) {
            throw 'Inherited activation path does not match this installation.'
        }
        $Record = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($Control))
        $Intent = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($Journal))
        if ($Record.state -cne 'pending' -or $Record.execution_nonce -cne $env:MVHUB_EXECUTION_NONCE -or
            $Intent.execution_nonce -cne $Record.execution_nonce -or $Intent.phase -cne 'starting' -or
            -not $Intent.db_mutation_possible -or -not $Intent.business_writes_possible) { throw 'Invalid update boot intent.' }
        return 'READY:' + $Record.execution_nonce
    }
    $Intent = $null
    if (Test-Path -LiteralPath $Journal) {
        $Intent = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($Journal))
        if ($Intent.PSObject.Properties.Name -notcontains 'format_version') {
            Assert-LegacyCommittedInstall -Root $Root -Intent $Intent
            # The app reuses this normal activation decision; the old updater owns journal cleanup.
        }
        elseif ($Intent.format_version -ne 1 -or $Intent.phase -notin @('committed', 'rolled_back')) {
            throw 'Interrupted installation requires updater recovery before normal boot.'
        }
    }
    if ((Test-Path -LiteralPath $Control) -and $Intent.phase -cne 'rolled_back') {
        $Existing = ConvertFrom-ReleaseJson ([IO.File]::ReadAllBytes($Control))
        if ($Existing.format_version -ne 1 -or $Existing.execution_nonce -cnotmatch '^[0-9a-f]{32}$' -or
            $Existing.state -notin @('normal', 'activated')) { throw 'Existing activation state requires recovery.' }
        # A second launcher may reuse the live hub. Do not invalidate its nonce.
        return 'READY:' + $Existing.execution_nonce
    }
    $Nonce = [Guid]::NewGuid().ToString('N')
    Write-InstallRecord -Path $Control -Record @{ format_version = 1; state = 'normal'; execution_nonce = $Nonce }
    return 'READY:' + $Nonce
}


function Assert-FreshInstallLocation {
    param([string]$Root)
    foreach ($Name in @('CONTENT_HUB_DATA', 'CONTENT_HUB_DB', 'ASSETS_DIR', 'CONTENT_HUB_ASSETS_DIR', 'CONTENT_HUB_MANAGE_DB')) {
        if ([Environment]::GetEnvironmentVariable($Name, 'Process')) { throw 'Fresh install cannot inherit external data paths.' }
    }
    $Cursor = [System.IO.Path]::GetFullPath($Root)
    while ($Cursor) {
        if (Test-Path -LiteralPath $Cursor) {
            if ((Get-Item -LiteralPath $Cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fresh install path is redirected.' }
        }
        $Cursor = Split-Path -Parent $Cursor
    }
}

function Get-FreshInstallProof {
    param([string]$Root, [switch]$Empty)
    Assert-FreshInstallLocation -Root $Root
    $Allowed = if ($Empty) { @() } else { @('INSTALL_SOURCE.txt', 'update_release_contract.ps1', 'installer-capabilities.json') }
    $Items = @(if (Test-Path -LiteralPath $Root) { Get-ChildItem -LiteralPath $Root -Force })
    if ($Items.Count -ne $Allowed.Count) { throw 'Fresh install requires an empty target or exactly the trusted bootstrap files.' }
    $Hashes = @{}
    foreach ($Item in $Items) {
        if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.Name -cnotin $Allowed) { throw 'Unknown existing install content; fresh install is forbidden.' }
        $Hashes[$Item.Name] = Get-ReleaseSha256 $Item.FullName
    }
    return @{ root = [IO.Path]::GetFullPath($Root); files = $Hashes; database_set = 'verified_empty' }
}

function Assert-FreshInstallUnchanged {
    param($Proof, [object[]]$Components, [string]$Token)
    Assert-FreshInstallLocation -Root $Proof.root
    foreach ($Name in $Proof.files.Keys) {
        if ((Get-ReleaseSha256 (Join-Path $Proof.root $Name)) -cne $Proof.files[$Name]) { throw 'Fresh bootstrap changed.' }
    }
    $Allowed = @($Proof.files.Keys) + @('.update.lock', '.resolve-transfer.lock', 'update-journal.json')
    $Staged = @($Components | ForEach-Object { $_.Relative + '.next.' + $Token })
    $Prefix = $Proof.root.TrimEnd('\') + '\'
    foreach ($Item in @(Get-ChildItem -LiteralPath $Proof.root -Recurse -Force)) {
        if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fresh install tree is redirected.' }
        $Relative = $Item.FullName.Substring($Prefix.Length)
        if (-not $Item.PSIsContainer -and $Relative -cin $Allowed) { continue }
        $Expected = $false
        foreach ($Path in $Staged) {
            if ($Relative -ceq $Path -or $Relative.StartsWith($Path + '\', [StringComparison]::Ordinal) -or
                ($Item.PSIsContainer -and $Path.StartsWith($Relative + '\', [StringComparison]::Ordinal))) { $Expected = $true; break }
        }
        if (-not $Expected) { throw 'Fresh target gained unverified content before activation.' }
    }
}

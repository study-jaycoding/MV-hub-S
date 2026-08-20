param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port
)

$ErrorActionPreference = "Stop"

function Get-CommandLineTokens([string]$CommandLine) {
    $tokens = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $tokens
    }
    $current = New-Object System.Text.StringBuilder
    $inQuote = $false
    foreach ($ch in $CommandLine.ToCharArray()) {
        if ($ch -eq '"') {
            $inQuote = -not $inQuote
            continue
        }
        if (-not $inQuote -and ($ch -eq ' ' -or $ch -eq "`t")) {
            if ($current.Length -gt 0) {
                [void]$tokens.Add($current.ToString())
                [void]$current.Clear()
            }
            continue
        }
        [void]$current.Append($ch)
    }
    if ($current.Length -gt 0) {
        [void]$tokens.Add($current.ToString())
    }
    return $tokens
}

function Test-MvHubServerCommandLine(
    [string]$CommandLine,
    [string]$ExpectedServePath,
    [string]$BundledPythonPath
) {
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or
        [string]::IsNullOrWhiteSpace($ExpectedServePath)) {
        return $false
    }

    $expected = $ExpectedServePath
    try { $expected = [System.IO.Path]::GetFullPath($ExpectedServePath) } catch { }
    $tokens = Get-CommandLineTokens -CommandLine $CommandLine

    foreach ($token in $tokens) {
        $candidate = $token
        try { $candidate = [System.IO.Path]::GetFullPath($token) } catch { }
        if ([string]::Equals(
            $candidate,
            $expected,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            return $true
        }
    }

    # Legacy launchers started the hub with a relative "serve.py" token, so the absolute
    # path proof above can never match them. Those processes still ran under THIS
    # install's bundled python.exe (foreign software cannot use that interpreter path),
    # so exe-path ownership plus a serve.py token is an equally safe proof.
    if (-not [string]::IsNullOrWhiteSpace($BundledPythonPath) -and $tokens.Count -gt 0) {
        $exeToken = $tokens[0]
        try { $exeToken = [System.IO.Path]::GetFullPath($exeToken) } catch { }
        if ([string]::Equals(
            $exeToken,
            $BundledPythonPath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            foreach ($token in $tokens) {
                if ([string]::Equals($token, "serve.py", [StringComparison]::OrdinalIgnoreCase) -or
                    $token.ToLowerInvariant().EndsWith("\serve.py")) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Get-ListenOwnerIds([int]$TargetPort) {
    try {
        return @(
            Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { $_.LocalPort -eq $TargetPort } |
                Select-Object -ExpandProperty OwningProcess -Unique |
                Sort-Object
        )
    }
    catch {
        # Normal worker sessions can be denied CIM access to Get-NetTCPConnection.
        # netstat is only a PID discovery fallback; every PID still has to pass the
        # exact command-line and creation-time checks below before taskkill runs.
        $lines = @(& netstat.exe -ano -p TCP 2>$null)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect listening ports."
        }
        $ownerIds = New-Object System.Collections.Generic.HashSet[int]
        foreach ($line in $lines) {
            $parts = @($line.Trim() -split "\s+")
            if ($parts.Count -lt 5 -or $parts[0] -ne "TCP" -or
                $parts[3] -ne "LISTENING") {
                continue
            }
            $separator = $parts[1].LastIndexOf(":")
            if ($separator -lt 0) {
                continue
            }
            $parsedPort = 0
            $parsedPid = 0
            if ([int]::TryParse($parts[1].Substring($separator + 1), [ref]$parsedPort) -and
                [int]::TryParse($parts[4], [ref]$parsedPid) -and
                $parsedPort -eq $TargetPort -and $parsedPid -gt 0) {
                [void]$ownerIds.Add($parsedPid)
            }
        }
        return @($ownerIds | Sort-Object)
    }
}

function Get-ProcessIdentity([int]$TargetPid) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine) -or
        [string]::IsNullOrWhiteSpace([string]$process.CreationDate)) {
        throw "Could not verify process identity for PID $TargetPid."
    }
    return [pscustomobject]@{
        ProcessId = [int]$process.ProcessId
        CommandLine = [string]$process.CommandLine
        CreationDate = [string]$process.CreationDate
    }
}

try {
    $rootPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..") -ErrorAction Stop).Path.TrimEnd("\")
    $expectedServePath = [System.IO.Path]::GetFullPath(
        (Join-Path $rootPath "backend\serve.py")
    )
    $bundledPythonPath = [System.IO.Path]::GetFullPath(
        (Join-Path $rootPath "runtime\python\python.exe")
    )
    $ownerIds = @(Get-ListenOwnerIds -TargetPort $Port)
    if (-not $ownerIds) {
        exit 0
    }

    # Validate every owner before stopping any process. A mixed/foreign owner set is
    # fail-closed so this launcher never partially clears a port it does not own.
    $verified = @{}
    foreach ($ownerPid in $ownerIds) {
        $identity = Get-ProcessIdentity -TargetPid ([int]$ownerPid)
        if (-not (Test-MvHubServerCommandLine `
            -CommandLine $identity.CommandLine `
            -ExpectedServePath $expectedServePath `
            -BundledPythonPath $bundledPythonPath
        )) {
            throw "Port $Port is owned by another process (PID $ownerPid). It was not stopped."
        }
        $verified[[int]$ownerPid] = $identity
    }

    foreach ($ownerPid in $ownerIds) {
        $targetPid = [int]$ownerPid
        $currentOwners = @(Get-ListenOwnerIds -TargetPort $Port)
        if ($targetPid -notin $currentOwners) {
            continue
        }
        $before = $verified[$targetPid]
        $current = Get-ProcessIdentity -TargetPid $targetPid
        if ($current.CreationDate -ne $before.CreationDate -or
            $current.CommandLine -ne $before.CommandLine -or
            -not (Test-MvHubServerCommandLine `
                -CommandLine $current.CommandLine `
                -ExpectedServePath $expectedServePath `
                -BundledPythonPath $bundledPythonPath
            )) {
            throw "Process identity changed before stop (PID $targetPid). It was not stopped."
        }

        & taskkill.exe /PID $targetPid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0 -and
            (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
            throw "Could not stop the previous MV Hub process (PID $targetPid)."
        }
    }
    exit 0
}
catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

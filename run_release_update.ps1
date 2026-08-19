param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$ExitCode = 1

function Resolve-MvHubTempDirectory {
    $Candidates = @(
        $env:TEMP,
        $env:TMP,
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Temp" }),
        $(if ($env:SystemRoot) { Join-Path $env:SystemRoot "Temp" })
    )
    foreach ($Candidate in $Candidates) {
        if (-not $Candidate) {
            continue
        }
        try {
            $Resolved = [System.IO.Directory]::CreateDirectory($Candidate).FullName
            # CreateDirectory succeeds on an existing folder even when its ACL is
            # read-only, and then the worker copy below fails without trying the
            # next candidate. Prove writability with a real create+delete first.
            $ProbePath = Join-Path $Resolved ("mvhub-temp-probe-{0}.tmp" -f [Guid]::NewGuid().ToString("N"))
            [System.IO.File]::WriteAllText($ProbePath, "probe")
            [System.IO.File]::Delete($ProbePath)
            return $Resolved
        }
        catch {
            continue
        }
    }
    throw "No writable temporary folder is available."
}

$TempDirectory = Resolve-MvHubTempDirectory
$TempWorker = Join-Path $TempDirectory ("mvhub-release-update-{0}.bat" -f [Guid]::NewGuid().ToString("N"))

try {
    $RootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $Worker = Join-Path $RootPath "update_release_worker.bat"
    if (-not (Test-Path -LiteralPath $Worker -PathType Leaf)) {
        throw "Release update worker is missing: $Worker"
    }

    # update_release.bat and this runner are replaced during installation. The
    # batch worker must therefore be copied outside the target before any package
    # file is touched. PowerShell has already parsed this runner into memory.
    Copy-Item -LiteralPath $Worker -Destination $TempWorker -Force
    if (-not $env:MVHUB_UPDATE_TARGET_DIR) {
        $env:MVHUB_UPDATE_TARGET_DIR = $RootPath
    }

    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $Process.StartInfo.FileName = $env:ComSpec
    $Process.StartInfo.Arguments = ('/d /s /c ""{0}""' -f $TempWorker)
    $Process.StartInfo.UseShellExecute = $false
    if (-not $Process.Start()) {
        throw "Could not start the isolated release updater."
    }
    $Process.WaitForExit()
    $ExitCode = $Process.ExitCode
}
catch {
    Write-Host "[ERROR] Could not start the safe release updater: $($_.Exception.Message)"
    if ($env:MVHUB_NO_PAUSE -ne "1") {
        Write-Host "Press any key to continue . . ."
        [void][Console]::ReadKey($true)
    }
    $ExitCode = 1
}
finally {
    Remove-Item -LiteralPath $TempWorker -Force -ErrorAction SilentlyContinue
}

# `powershell.exe -Command "& script.ps1"` normalizes a nested script's non-zero
# `exit` to 1 on Windows PowerShell 5.1. The updater must preserve the worker's
# exact exit code for automation while still using explicit invocation (which
# avoids the intermittent cross-language-mode dot-source failure of `-File`).
[Environment]::Exit($ExitCode)

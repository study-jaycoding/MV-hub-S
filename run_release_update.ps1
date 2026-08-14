param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$ExitCode = 1
$TempWorker = Join-Path $env:TEMP ("mvhub-release-update-{0}.bat" -f [Guid]::NewGuid().ToString("N"))

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

exit $ExitCode

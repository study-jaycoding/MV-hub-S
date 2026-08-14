param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$ExitCode = 1
$TempWorker = Join-Path $env:TEMP ("mvhub-update-{0}.bat" -f [Guid]::NewGuid().ToString("N"))

try {
    $RootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $Worker = Join-Path $RootPath "tools\update_git_worker.bat"
    if (-not (Test-Path -LiteralPath $Worker -PathType Leaf)) {
        throw "Update worker is missing: $Worker"
    }

    # cmd.exe executes batch files by reading from disk while they run. Running the
    # repository copy directly would therefore corrupt the current control flow when
    # git pull replaces that file. The immutable TEMP copy survives the whole update.
    Copy-Item -LiteralPath $Worker -Destination $TempWorker -Force

    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $Process.StartInfo.FileName = $env:ComSpec
    $Process.StartInfo.Arguments = ('/d /s /c ""{0}" "{1}""' -f $TempWorker, $RootPath)
    $Process.StartInfo.UseShellExecute = $false
    if (-not $Process.Start()) {
        throw "Could not start the isolated update worker."
    }
    $Process.WaitForExit()
    $ExitCode = $Process.ExitCode
}
catch {
    Write-Host "[ERROR] Could not start the safe updater: $($_.Exception.Message)"
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

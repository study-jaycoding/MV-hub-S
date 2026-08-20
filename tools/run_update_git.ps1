param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = "Stop"
$ExitCode = 1
$TempWorkers = New-Object System.Collections.Generic.List[string]

function Get-Sha256Hex {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    # Get-FileHash is loaded from Microsoft.PowerShell.Utility on demand. A fresh or
    # redirected TEMP can prevent that module's analysis cache from loading during
    # updater bootstrap, so use the .NET runtime that Windows PowerShell already owns.
    $Stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [System.BitConverter]::ToString(
                $Hasher.ComputeHash($Stream)
            ).Replace("-", "")
        }
        finally {
            $Hasher.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
    }
}

function Invoke-IsolatedWorker {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkerPath,
        [Parameter(Mandatory = $true)]
        [string]$RootPath
    )

    $TempWorker = Join-Path $env:TEMP ("mvhub-update-{0}.bat" -f [Guid]::NewGuid().ToString("N"))
    Copy-Item -LiteralPath $WorkerPath -Destination $TempWorker -Force
    [void]$TempWorkers.Add($TempWorker)

    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $Process.StartInfo.FileName = $env:ComSpec
    $Process.StartInfo.Arguments = ('/d /s /c ""{0}" "{1}""' -f $TempWorker, $RootPath)
    $Process.StartInfo.UseShellExecute = $false
    if (-not $Process.Start()) {
        throw "Could not start the isolated update worker."
    }
    $Process.WaitForExit()
    return $Process.ExitCode
}

try {
    $RootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    $Worker = Join-Path $RootPath "tools\update_git_worker.bat"
    if (-not (Test-Path -LiteralPath $Worker -PathType Leaf)) {
        throw "Update worker is missing: $Worker"
    }

    # cmd.exe executes batch files by reading from disk while they run. Running the
    # repository copy directly would therefore corrupt the current control flow when
    # git pull replaces that file. The immutable TEMP copy survives the whole update.
    $InitialWorkerHash = Get-Sha256Hex -LiteralPath $Worker
    $ExitCode = Invoke-IsolatedWorker -WorkerPath $Worker -RootPath $RootPath

    # A git pull may replace the repository worker while the immutable old TEMP
    # copy is still running. If that old worker fails, retry exactly once with the
    # newly pulled worker. This heals updater migrations without an extra click and
    # never masks an ordinary failure where the worker file did not change.
    if ($ExitCode -ne 0 -and (Test-Path -LiteralPath $Worker -PathType Leaf)) {
        $CurrentWorkerHash = Get-Sha256Hex -LiteralPath $Worker
        if ($CurrentWorkerHash -ne $InitialWorkerHash) {
            Write-Host "[recovery] The updater changed during git pull; retrying once with the new worker..."
            $ExitCode = Invoke-IsolatedWorker -WorkerPath $Worker -RootPath $RootPath
        }
    }
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
    foreach ($TempWorker in $TempWorkers) {
        Remove-Item -LiteralPath $TempWorker -Force -ErrorAction SilentlyContinue
    }
}

exit $ExitCode

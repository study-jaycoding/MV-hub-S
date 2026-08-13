$ErrorActionPreference = "Stop"

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Invoke-Native(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments
) {
    Write-Host "--> $Label"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE)"
    }
}

function Find-PythonCommand {
    if (Test-Command "py") {
        & py -3 --version *> $null
        if ($LASTEXITCODE -eq 0) { return @("py", "-3") }
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python -and $python.Source -notmatch "WindowsApps") {
        & $python.Source --version *> $null
        if ($LASTEXITCODE -eq 0) { return @($python.Source) }
    }
    return @()
}

function Install-WingetPackage([string]$Label, [string]$Id) {
    if (-not (Test-Command "winget")) {
        throw "$Label is missing and winget is unavailable. Install $Label manually."
    }
    Invoke-Native "Install $Label" "winget" @(
        "install", "--id", $Id, "-e", "--source", "winget",
        "--accept-source-agreements", "--accept-package-agreements"
    )
    Refresh-ProcessPath
}

try {
    if (-not (Test-Command "git")) {
        Install-WingetPackage "Git" "Git.Git"
    }
    if (-not (Test-Command "npm.cmd")) {
        Install-WingetPackage "Node.js LTS" "OpenJS.NodeJS.LTS"
    }

    $pythonCommand = @(Find-PythonCommand)
    if ($pythonCommand.Count -eq 0) {
        Install-WingetPackage "Python 3.12" "Python.Python.3.12"
        $pythonCommand = @(Find-PythonCommand)
    }
    if ($pythonCommand.Count -eq 0) {
        throw "A real Python 3 installation could not be resolved. Disable the Windows Store python aliases and retry."
    }

    foreach ($required in @("git", "npm.cmd")) {
        if (-not (Test-Command $required)) {
            throw "$required is still unavailable. Close this window and run setup again."
        }
    }

    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
        throw "Desktop folder not found: $desktop"
    }
    $repo = Join-Path $desktop "MV-hub-S"
    Write-Host "Target: $repo"

    if (Test-Path -LiteralPath (Join-Path $repo ".git")) {
        Push-Location $repo
        try {
            & git sparse-checkout list *> $null
            if ($LASTEXITCODE -eq 0) {
                Invoke-Native "Include required sparse folders" "git" @(
                    "sparse-checkout", "set", "backend", "frontend", "tools"
                )
            }
            Invoke-Native "Update repository" "git" @("pull", "--ff-only")
        }
        finally { Pop-Location }
    }
    elseif (Test-Path -LiteralPath $repo) {
        throw "MV-hub-S exists on the Desktop but is not a Git clone. Rename it and retry."
    }
    else {
        Push-Location $desktop
        try {
            Invoke-Native "Clone repository" "git" @(
                "clone", "--filter=blob:none", "--sparse",
                "https://github.com/study-jaycoding/MV-hub-S.git"
            )
        }
        finally { Pop-Location }
        Push-Location $repo
        try {
            Invoke-Native "Select required folders" "git" @(
                "sparse-checkout", "set", "backend", "frontend", "tools"
            )
        }
        finally { Pop-Location }
    }

    $pythonExe = $pythonCommand[0]
    $pythonArgs = @($pythonCommand | Select-Object -Skip 1)
    Invoke-Native "Install backend dependencies" $pythonExe @(
        $pythonArgs + @("-m", "pip", "install", "-r", (Join-Path $repo "backend\requirements.txt"))
    )
    Invoke-Native "Verify backend dependency pins" $pythonExe @(
        $pythonArgs + @(
            (Join-Path $repo "tools\verify_requirements.py"),
            (Join-Path $repo "backend\requirements.txt")
        )
    )

    Push-Location (Join-Path $repo "frontend")
    try {
        Invoke-Native "Restore locked frontend packages" "npm.cmd" @(
            "ci", "--include=dev", "--no-audit", "--no-fund"
        )
        Invoke-Native "Build frontend" "npm.cmd" @("run", "build")
    }
    finally { Pop-Location }

    $pinFile = Join-Path $repo "hf_cli_version.txt"
    $pin = if (Test-Path -LiteralPath $pinFile) {
        (Get-Content -LiteralPath $pinFile -TotalCount 1).Trim()
    } else { "" }
    $cliPackage = if ($pin) { "@higgsfield/cli@$pin" } else { "@higgsfield/cli" }
    Invoke-Native "Install Higgsfield CLI ($cliPackage)" "npm.cmd" @(
        "install", "-g", $cliPackage
    )

    Write-Host ""
    Write-Host "Everything installed: $repo"
    Write-Host "Next: run MV_agent.bat (worker) or register_autostart.bat (server)."
}
catch {
    Write-Host ""
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

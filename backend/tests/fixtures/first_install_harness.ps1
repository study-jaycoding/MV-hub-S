param([string]$Tree,[string]$CaseRoot,[string]$Scenario)
$ErrorActionPreference='Stop'
function Get-FunctionText([string]$Path,[string[]]$Only=@()) {
    $Raw=[IO.File]::ReadAllText($Path)
    if ($Path.EndsWith('.bat')) { $Raw=($Raw -split '### MVHUB_(?:INSTALL|UPDATE)_POWERSHELL ###',2)[1] }
    $Tokens=$null;$Errors=$null
    $Ast=[Management.Automation.Language.Parser]::ParseInput($Raw,[ref]$Tokens,[ref]$Errors)
    if ($Errors.Count) { throw ($Errors | Out-String) }
    return (($Ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false) | Where-Object { -not $Only.Count -or $_.Name -cin $Only } | ForEach-Object {$_.Extent.Text}) -join "`n")
}
$TargetDir=Join-Path $CaseRoot 'target'
$BaseUrl=Join-Path $CaseRoot 'feed'
$TempRoot=Join-Path $CaseRoot 'installer-temp'
[IO.Directory]::CreateDirectory($TempRoot)|Out-Null
Copy-Item (Join-Path $BaseUrl 'latest.json') (Join-Path $TempRoot 'latest.json')
$Latest=Get-Content (Join-Path $TempRoot 'latest.json') -Raw | ConvertFrom-Json
$WorkerRaw=[IO.File]::ReadAllText((Join-Path $Tree 'update_release_worker.bat'))
$WorkerFunctions=Get-FunctionText (Join-Path $Tree 'update_release_worker.bat')
$WorkerFunctions=$WorkerFunctions.Replace('function Install-Package {','function Install-WorkerPackage {')
$Needle='[System.Diagnostics.Process]::Start($StartInfo)'
if ([regex]::Matches($WorkerFunctions, [regex]::Escape($Needle)).Count -ne 2) { throw 'Process boundary changed.' }
$WorkerFunctions=$WorkerFunctions.Replace($Needle,'(Invoke-FakeProcessStart $StartInfo)')
Invoke-Expression $WorkerFunctions
$Template=Join-Path $Tree 'release\MVHub_Install.bat'
if ((Get-Content $Template -Raw).Contains('__MVHUB_TRUSTED_BOOTSTRAP_BASE64__')) {
    Invoke-Expression (Get-FunctionText (Join-Path $Tree 'release\make_release.ps1') @('Write-TrustedFirstInstaller'))
    $Built=Join-Path $CaseRoot 'trusted-installer.bat'
    Write-TrustedFirstInstaller -Template $Template -Verifier (Join-Path $Tree 'update_release_contract.ps1') -Destination $Built
    $Template=$Built
}
$Caller=Get-FunctionText $Template @('Install-Package','Get-ReleaseFile','Get-Sha256Hex')
$Needle='& $env:ComSpec /d /c $Command'
if (($Caller.Split(@($Needle),[StringSplitOptions]::None)).Count -ne 2) { throw 'Worker boundary changed.' }
$Caller=$Caller.Replace($Needle,'Invoke-MockWorker -PackageUpdater $PackageUpdater')
Invoke-Expression $Caller
$script:Trace=@{worker_calls=0;runtime_checks=0;checkpoint_calls=0;process_starts=0;stops=0;ready_calls=0;undo_calls=0}
function Write-UpdateState {}
function Get-ReleaseFileWithProgress { param($Name,$Destination,$ExpectedSize); Copy-Item -LiteralPath (Join-Path $BaseUrl $Name) -Destination $Destination }
function Assert-PythonRuntime { param($RuntimeDir,$Label)
    $script:Trace.runtime_checks++
    if ($Label -eq 'staged' -and $Scenario -eq 'stage_failed') { throw 'injected stage validation failure' }
    if ($Label -eq 'staged' -and $Scenario -eq 'late_data') {
        [IO.File]::WriteAllText((Join-Path $TargetDir 'late.db'),'do not remove')
    }
    if ($Label -eq 'staged' -and $Scenario -eq 'bootstrap_tamper') {
        [IO.File]::AppendAllText((Join-Path $TargetDir 'update_release_contract.ps1'),'# changed')
    }
}
function Assert-BundledCli { param($Root,$ExpectedVersion,$Label) }
function Assert-NoActiveResolveImport {}
function Wait-WorkerDrain {}
function Stop-MvHubProcesses { $script:Trace.stops++ }
function Invoke-InstallCheckpoint { $script:Trace.checkpoint_calls++; throw 'Old runtime checkpoint must not run in a proven fresh install.' }
function Undo-ComponentSwaps { $script:Trace.undo_calls++; throw 'No rollback allowed in this fresh harness.' }
function Start-Sleep {}
function Get-Date { $script:Tick++; return ([DateTime]'2026-10-18T00:00:00Z').AddMinutes($script:Tick) }
function Invoke-FakeProcessStart {
    param($StartInfo)
    $script:Trace.process_starts++
    if (-not $script:InstallJournal.db_mutation_possible -or $script:InstallJournal.phase -cne 'starting') { throw 'Missing durable startup intent' }
    if ($Scenario -eq 'restart_failed') { throw 'injected process start failure' }
    $Data=Join-Path $TargetDir 'backend\data\db'
    [IO.Directory]::CreateDirectory($Data)|Out-Null
    [IO.File]::Copy((Join-Path $CaseRoot 'synthetic.db'),(Join-Path $Data 'content_hub.db'))
    return [pscustomobject]@{Id=424242}
}
function Invoke-RestMethod {
    $script:Trace.ready_calls++
    $Nonce=if ($Scenario -eq 'ready_nonce_mismatch') {'wrong'} else {$script:InstallJournal.execution_nonce}
    return [pscustomobject]@{status='ready';runtime=[pscustomobject]@{execution_nonce=$Nonce;build_id=$script:InstallJournal.target.contract.build_id;role='worker';process_id=424242}}
}
function Get-NetTCPConnection {return [pscustomobject]@{OwningProcess=424242}}
function Get-CimInstance {return [pscustomobject]@{ProcessId=424242;CreationDate=[DateTime]::UtcNow.AddSeconds(1);ExecutablePath=(Join-Path $TargetDir 'runtime\python\python.exe')}}
function Invoke-MockWorker {
    param($PackageUpdater)
    $script:Trace.worker_calls++
    if (-not (Test-Path $PackageUpdater)) {throw 'missing package caller'}
    $Start=$WorkerRaw.IndexOf('$TargetDir = (Resolve-Path')
    $End=$WorkerRaw.IndexOf('if ($StateFile -and', $Start)
    if ($Start -lt 0 -or $End -lt 0) {throw 'Worker initialization boundary changed'}
    Invoke-Expression $WorkerRaw.Substring($Start,$End-$Start)
    $BaseUrl=(Get-Content (Join-Path $TargetDir 'INSTALL_SOURCE.txt') -Raw).Trim()
    $TempRoot=Join-Path $CaseRoot 'worker-temp'
    [IO.Directory]::CreateDirectory($TempRoot)|Out-Null
    $ManifestName='latest.json';$ExpectSha256='';$ExpectVersion=''
    $RestartAfterInstall=$env:MVHUB_UPDATE_RESTART
    $script:Trace.requested_restart=$RestartAfterInstall
    $ReadyUrl='http://127.0.0.1:18999/api/ready'
    $Latest=Read-ReleaseManifest
    if ($Scenario -eq 'worker_receipt_missing') {
        $Latest.contract.validation_receipt=$null
        $ManifestName='candidate.json';$ExpectSha256=$Latest.sha256;$ExpectVersion=$Latest.version
    }
    try {
        Install-WorkerPackage -Latest $Latest -TempRoot $TempRoot
        Restart-MvHubAndWaitReady -ExpectedVersion $Latest.version
    } catch {
        $Failure=$_
        Finalize-FailedInstall
        throw $Failure
    }
    $global:LASTEXITCODE=0
}
if ($Scenario -in @('unknown_file','existing_db','existing_helper')) {
    [IO.Directory]::CreateDirectory($TargetDir)|Out-Null
    if ($Scenario -eq 'unknown_file') {[IO.File]::WriteAllText((Join-Path $TargetDir 'unknown.txt'),'preserve')}
    if ($Scenario -eq 'existing_db') {
        [IO.Directory]::CreateDirectory((Join-Path $TargetDir 'backend\data'))|Out-Null
        [IO.File]::Copy((Join-Path $CaseRoot 'synthetic.db'),(Join-Path $TargetDir 'backend\data\content_hub.db'))
    }
    if ($Scenario -eq 'existing_helper') {
        Copy-Item (Join-Path $Tree 'update_release_contract.ps1') (Join-Path $TargetDir 'update_release_contract.ps1')
        [IO.File]::WriteAllText((Join-Path $TargetDir 'installer-capabilities.json'),'{"format_version":1,"capabilities":[]}')
        [IO.File]::WriteAllText((Join-Path $TargetDir 'VERSION.txt'),'old')
    }
}
if ($Scenario -eq 'external_data') {$env:CONTENT_HUB_DB=Join-Path $CaseRoot 'synthetic.db'}
$script:Tick=0
$Failure=$null
try {Install-Package -Latest $Latest -TempRoot $TempRoot} catch {$Failure=$_.Exception.Message; $Stack=$_.ScriptStackTrace}
$Journal=$null
if (Test-Path (Join-Path $TargetDir 'update-journal.json')) {$Journal=Get-Content (Join-Path $TargetDir 'update-journal.json') -Raw|ConvertFrom-Json}
$Result=@{scenario=$Scenario;error=$Failure;stack=$Stack;trace=$script:Trace;journal=$Journal;target_exists=(Test-Path $TargetDir);data_preserved=(Test-Path (Join-Path $TargetDir 'backend\data\db\content_hub.db'))}
$Result|ConvertTo-Json -Depth 24|Set-Content -LiteralPath (Join-Path $CaseRoot 'result.json') -Encoding UTF8
if ($Failure) {Write-Host ('OBSERVED FAILURE: '+$Failure)}

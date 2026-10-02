# 릴리스 폴더 표지(latest.json·candidate.json) 쓰기 공통 — make_release.ps1·select_release.ps1 이 dot-source 한다.
# 로컬 허브 promote(backend/app/services/release_update.py)와 같은 잠금·교체 규칙이다(B안 r4, docs/UPDATE_ANNOUNCEMENTS.md).

function Open-ReleaseLock {
    # 릴리스 폴더 잠금 — release.lock 을 공유 없이 연 동안이 잠금이다(promote·make_release 와 같은 규칙).
    # 핸들을 닫으면 풀리므로 잠금 파일은 지우지 않는다.
    param([string]$Directory, [double]$WaitSeconds)
    $LockPath = Join-Path $Directory "release.lock"
    $Clock = [System.Diagnostics.Stopwatch]::StartNew()  # 벽시계(Get-Date)가 아니라 경과 시간으로 잰다
    while ($true) {
        try {
            return [System.IO.File]::Open($LockPath, "OpenOrCreate", "ReadWrite", "None")
        }
        catch [System.IO.IOException] {
            # 0x80070020 공유 위반 = 다른 쓰기자가 잠금을 쥐고 있다. 그 밖의 오류(경로·네트워크)는 원래 오류 그대로 올린다.
            if (($_.Exception.HResult -band 0xFFFF) -ne 32) { throw }
            if ($Clock.Elapsed.TotalSeconds -gt $WaitSeconds) {
                throw "Release folder is locked by another release tool; retry shortly: $LockPath"
            }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Write-ManifestAtomic {
    # 같은 폴더 임시 파일 → 대상이 있으면 File.Replace, 없으면 File.Move(덮어쓰기 없음).
    # Move-Item -Force 는 PowerShell 5.1 에서 '기존 대상 삭제 → 이동'이라 표지가 사라지는 틈이 있다(Codex r3).
    # 실패하면 대상을 다시 읽어 셋으로 가른다: 새 내용이면 성공, 이전 그대로면 임시 파일 지우고 실패,
    # 확인할 수 없으면 임시 파일을 남기고 실패(Codex r4).
    param([string]$Path, [byte[]]$Bytes)
    $Old = $null
    if (Test-Path -LiteralPath $Path -PathType Leaf) { $Old = [System.IO.File]::ReadAllBytes($Path) }
    $Temp = Join-Path (Split-Path -Parent $Path) ("{0}.tmp-{1}" -f (Split-Path -Leaf $Path), [Guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllBytes($Temp, $Bytes)
    try {
        if ($null -ne $Old) { [System.IO.File]::Replace($Temp, $Path, [NullString]::Value) }
        else { [System.IO.File]::Move($Temp, $Path) }
    }
    catch {
        $Failure = $_.Exception.Message
        try {
            $Now = if (Test-Path -LiteralPath $Path -PathType Leaf) { [System.IO.File]::ReadAllBytes($Path) } else { $null }
        }
        catch {
            throw "Could not confirm $Path after a failed replace (temporary file kept: $Temp): $Failure"
        }
        $NewText = [Convert]::ToBase64String($Bytes)
        $NowText = if ($null -ne $Now) { [Convert]::ToBase64String($Now) } else { "" }
        $OldText = if ($null -ne $Old) { [Convert]::ToBase64String($Old) } else { "" }
        if ($NowText -eq $NewText) { return }
        if ($NowText -eq $OldText) {
            Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue
            throw "Could not replace ${Path}: $Failure"
        }
        throw "$Path is in an unexpected state after a failed replace (temporary file kept: $Temp): $Failure"
    }
}

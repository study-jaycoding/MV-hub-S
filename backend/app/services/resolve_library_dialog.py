"""Resolve의 Project Library 연결 창을 채우고 Connect 까지 누른다(Jay 결정 2026-09-22)."""

from __future__ import annotations

import json
import hashlib
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from .path_safety import unc_for_drive
from .resolve_diagnostics import resolve_environment_snapshot
from .resolve_status_runner import resolve_mutation_slot, run_resolve_library_list_isolated


_RESULT_PREFIX = "MVHUB_RESOLVE_LIBRARY="
_DIALOG_LOCK = threading.Lock()


class ResolveLibraryDialogError(RuntimeError):
    """연결 창을 준비하지 못한 경우."""


_POWERSHELL = r'''
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MVHubResolveNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@

$ProjectManagerId = "UiProjectManagerDialog"
$LibraryDialogId = "UiProjectManagerDBDialogImp"
$LocalTabId = "UiProjectManagerDialog.frameProjectManagerBorder.m_ProjectManagerView.projManagerHeaderFrame.frameProjectManagerTitle.frameProjectManagerTitleLeft.frameDbTypeTabBar.btnLocal"
$SidePanelId = "UiProjectManagerDialog.frameProjectManagerBorder.m_ProjectManagerView.projManagerContents.splitterProjects.m_ViewProjects.frameTopContainer.frameToolbar.m_BtnSidePanel"
$AddLibraryId = "UiProjectManagerDialog.frameProjectManagerBorder.m_ProjectManagerView.projManagerContents.splitterProjects.m_ViewDatabase.m_DbBottomFrame.frame_3.frameDBListBottomView.buttonNewDatabase"
$ConnectTabId = "UiProjectManagerDBDialogImp.frameAddDBBackground.frameSelectDBType.btnConnect"
$NameEditId = "UiProjectManagerDBDialogImp.frameAddDBBackground.frameAddDBCenter.nameEdit"
$BrowseId = "UiProjectManagerDBDialogImp.frameAddDBBackground.frameAddDBCenter.buttonBrowseDiskLocation"
$LocationId = "UiProjectManagerDBDialogImp.frameAddDBBackground.frameAddDBCenter.textDiskBrowseLocation"
$FinalButtonId = "UiProjectManagerDBDialogImp.frameAddDBBackground.frameAddDBButtonBar.buttonOk"
$Deadline = [DateTime]::UtcNow.AddSeconds(70)

function Write-Result([bool]$ok, [string]$message, [int]$processId = 0) {
    $payload = @{ ok = $ok; message = $message; process_id = $processId }
    Write-Output ($env:MVHUB_RESULT_PREFIX + ($payload | ConvertTo-Json -Compress))
}

function Find-ById($root, [string]$automationId) {
    if ($null -eq $root) { return $null }
    $condition = New-Object System.Windows.Automation.PropertyCondition `
        ([System.Windows.Automation.AutomationElement]::AutomationIdProperty), $automationId
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-TopWindow([int]$processId, [string]$automationId) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = New-Object System.Windows.Automation.PropertyCondition `
        ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), $processId
    $windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    for ($i = 0; $i -lt $windows.Count; $i++) {
        $window = $windows.Item($i)
        if ($window.Current.AutomationId -eq $automationId) { return $window }
    }
    return $null
}

function Wait-TopWindow([int]$processId, [string]$automationId) {
    while ([DateTime]::UtcNow -lt $Deadline) {
        $window = Find-TopWindow $processId $automationId
        if ($null -ne $window) { return $window }
        Start-Sleep -Milliseconds 200
    }
    throw "Resolve 창을 기다리다 시간이 초과되었습니다: $automationId"
}

function Wait-ById($root, [string]$automationId) {
    while ([DateTime]::UtcNow -lt $Deadline) {
        $element = Find-ById $root $automationId
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 150
    }
    throw "Resolve 화면 요소를 찾지 못했습니다: $automationId"
}

function Invoke-Element($element) {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Set-ElementValue($element, [string]$value) {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    ([System.Windows.Automation.ValuePattern]$pattern).SetValue($value)
}

function Toggle-IsOn($element) {
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        return ([System.Windows.Automation.TogglePattern]$pattern).Current.ToggleState -eq `
            [System.Windows.Automation.ToggleState]::On
    } catch {
        return $false
    }
}

function Close-Window($element) {
    if ($null -eq $element) { return }
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        ([System.Windows.Automation.WindowPattern]$pattern).Close()
    } catch {
        # 정리 실패가 원래 오류를 가리지 않게 한다.
    }
}

function Close-NativeWindow([IntPtr]$handle) {
    if ($handle -eq [IntPtr]::Zero) { return }
    try {
        if ([MVHubResolveNative]::IsWindow($handle)) {
            [MVHubResolveNative]::PostMessage(
                $handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero
            ) | Out-Null
            Start-Sleep -Milliseconds 100
        }
    } catch {
        # 정리 실패가 원래 오류를 가리지 않게 한다.
    }
}

function Find-NativeFolderDialogHandle($root) {
    if ($null -eq $root) { return [IntPtr]::Zero }
    $condition = New-Object System.Windows.Automation.PropertyCondition `
        ([System.Windows.Automation.AutomationElement]::ClassNameProperty), "#32770"
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    for ($i = 0; $i -lt $matches.Count; $i++) {
        $candidate = $matches.Item($i)
        if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and `
            $candidate.Current.NativeWindowHandle -ne 0) {
            return [IntPtr]$candidate.Current.NativeWindowHandle
        }
    }
    return [IntPtr]::Zero
}

function Test-SameWindowsPath([string]$left, [string]$right) {
    try {
        $leftFull = [System.IO.Path]::GetFullPath($left).TrimEnd([char[]]"\/")
        $rightFull = [System.IO.Path]::GetFullPath($right).TrimEnd([char[]]"\/")
        return [string]::Equals(
            $leftFull, $rightFull, [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

$projectManager = $null
$libraryDialog = $null
$folderDialogHandle = [IntPtr]::Zero
$projectManagerOpenedByMVHub = $false
$libraryDialogOpenedByMVHub = $false

try {
    if ($env:MVHUB_CLEANUP_ONLY -eq "1") {
        $cleanupProcess = Get-Process -Name Resolve -ErrorAction SilentlyContinue |
            Sort-Object StartTime -Descending | Select-Object -First 1
        if ($null -eq $cleanupProcess) { exit 0 }
        $cleanupDialog = Find-TopWindow $cleanupProcess.Id $LibraryDialogId
        if ($null -eq $cleanupDialog) { exit 0 }
        $cleanupName = Find-ById $cleanupDialog $NameEditId
        if ($null -ne $cleanupName) {
            $cleanupValue = $cleanupName.GetCurrentPattern(
                [System.Windows.Automation.ValuePattern]::Pattern
            )
            $cleanupNameText = ([System.Windows.Automation.ValuePattern]$cleanupValue).Current.Value
            if (-not [string]::IsNullOrWhiteSpace($cleanupNameText) -and `
                $cleanupNameText -ne $env:MVHUB_LIBRARY_NAME) { exit 0 }
        }

        $cleanupFolderHandle = Find-NativeFolderDialogHandle $cleanupDialog
        Close-NativeWindow $cleanupFolderHandle
        Close-Window $cleanupDialog
        exit 0
    }

    $process = Get-Process -Name Resolve -ErrorAction SilentlyContinue |
        Sort-Object StartTime -Descending | Select-Object -First 1
    if ($null -eq $process) {
        if (-not $env:MVHUB_RESOLVE_EXE -or -not (Test-Path -LiteralPath $env:MVHUB_RESOLVE_EXE)) {
            throw "DaVinci Resolve 설치 파일을 찾지 못했습니다."
        }
        $process = Start-Process -FilePath $env:MVHUB_RESOLVE_EXE -PassThru
    }

    while ([DateTime]::UtcNow -lt $Deadline -and $process.MainWindowHandle -eq 0) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
    }
    if ($process.MainWindowHandle -eq 0) { throw "DaVinci Resolve 창이 열리지 않았습니다." }

    $existingLibraryDialog = Find-TopWindow $process.Id $LibraryDialogId
    if ($null -ne $existingLibraryDialog) {
        [MVHubResolveNative]::SetForegroundWindow(
            [IntPtr]$existingLibraryDialog.Current.NativeWindowHandle
        ) | Out-Null
        throw "Resolve에 이미 Add Project Library 창이 열려 있습니다. 먼저 Connect 또는 Cancel로 닫아주세요."
    }

    $projectManager = Find-TopWindow $process.Id $ProjectManagerId
    if ($null -eq $projectManager) {
        [MVHubResolveNative]::SetForegroundWindow([IntPtr]$process.MainWindowHandle) | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        if (-not $shell.AppActivate($process.Id)) { throw "DaVinci Resolve를 앞으로 가져오지 못했습니다." }
        Start-Sleep -Milliseconds 250
        $shell.SendKeys("+1")
        $projectManager = Wait-TopWindow $process.Id $ProjectManagerId
        $projectManagerOpenedByMVHub = $true
    }

    $localTab = Wait-ById $projectManager $LocalTabId
    if (-not (Toggle-IsOn $localTab)) {
        Invoke-Element $localTab
        Start-Sleep -Milliseconds 300
    }

    $addLibrary = Find-ById $projectManager $AddLibraryId
    if ($null -eq $addLibrary) {
        $sidePanel = Wait-ById $projectManager $SidePanelId
        Invoke-Element $sidePanel
        $addLibrary = Wait-ById $projectManager $AddLibraryId
    }
    Invoke-Element $addLibrary
    $libraryDialogOpenedByMVHub = $true
    $libraryDialog = Wait-TopWindow $process.Id $LibraryDialogId

    $connectTab = Wait-ById $libraryDialog $ConnectTabId
    if (-not (Toggle-IsOn $connectTab)) {
        Invoke-Element $connectTab
        Start-Sleep -Milliseconds 250
    }

    $nameEdit = Wait-ById $libraryDialog $NameEditId
    Set-ElementValue $nameEdit $env:MVHUB_LIBRARY_NAME

    $browse = Wait-ById $libraryDialog $BrowseId
    Invoke-Element $browse
    Start-Sleep -Milliseconds 300

    $folderEdit = $null
    while ([DateTime]::UtcNow -lt $Deadline -and $null -eq $folderEdit) {
        if ($folderDialogHandle -eq [IntPtr]::Zero) {
            $folderDialogHandle = Find-NativeFolderDialogHandle $libraryDialog
        }
        $condition = New-Object System.Windows.Automation.PropertyCondition `
            ([System.Windows.Automation.AutomationElement]::AutomationIdProperty), "1152"
        $matches = $libraryDialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        for ($i = 0; $i -lt $matches.Count; $i++) {
            $candidate = $matches.Item($i)
            if ($candidate.Current.NativeWindowHandle -ne 0 -and `
                $candidate.Current.BoundingRectangle.Width -gt 100) {
                $folderEdit = $candidate
                break
            }
        }
        if ($null -eq $folderEdit) { Start-Sleep -Milliseconds 150 }
    }
    if ($null -eq $folderEdit) { throw "폴더 선택창의 경로 입력란을 찾지 못했습니다." }
    if ($folderDialogHandle -eq [IntPtr]::Zero) {
        $folderDialogHandle = [MVHubResolveNative]::GetAncestor(
            [IntPtr]$folderEdit.Current.NativeWindowHandle, 2
        )
    }
    [MVHubResolveNative]::SendMessage(
        [IntPtr]$folderEdit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero,
        $env:MVHUB_LIBRARY_PATH
    ) | Out-Null

    $selectFolder = $null
    while ([DateTime]::UtcNow -lt $Deadline -and $null -eq $selectFolder) {
        $condition = New-Object System.Windows.Automation.PropertyCondition `
            ([System.Windows.Automation.AutomationElement]::AutomationIdProperty), "1"
        $matches = $libraryDialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        for ($i = 0; $i -lt $matches.Count; $i++) {
            $candidate = $matches.Item($i)
            if ($candidate.Current.NativeWindowHandle -ne 0 -and `
                $candidate.Current.BoundingRectangle.Width -gt 50 -and `
                $candidate.Current.BoundingRectangle.Height -gt 15) {
                $selectFolder = $candidate
                break
            }
        }
        if ($null -eq $selectFolder) { Start-Sleep -Milliseconds 150 }
    }
    if ($null -eq $selectFolder) { throw "폴더 선택 버튼을 찾지 못했습니다." }
    [MVHubResolveNative]::SendMessage(
        [IntPtr]$selectFolder.Current.NativeWindowHandle, 0x00F5,
        [IntPtr]::Zero, [IntPtr]::Zero
    ) | Out-Null

    $location = Wait-ById $libraryDialog $LocationId
    while ([DateTime]::UtcNow -lt $Deadline -and `
        -not (Test-SameWindowsPath $location.Current.Name $env:MVHUB_LIBRARY_PATH)) {
        Start-Sleep -Milliseconds 150
        $location = Find-ById $libraryDialog $LocationId
    }
    if ($null -eq $location -or `
        -not (Test-SameWindowsPath $location.Current.Name $env:MVHUB_LIBRARY_PATH)) {
        throw "Resolve 연결 경로가 입력되지 않았습니다."
    }
    $folderDialogHandle = [IntPtr]::Zero

    # 폴더 선택 후에도 이름과 Connect 모드가 유지됐는지 다시 확정한다.
    Set-ElementValue (Wait-ById $libraryDialog $NameEditId) $env:MVHUB_LIBRARY_NAME
    $connectTab = Wait-ById $libraryDialog $ConnectTabId
    if (-not (Toggle-IsOn $connectTab)) { Invoke-Element $connectTab }

    $finalButton = Wait-ById $libraryDialog $FinalButtonId
    if (-not $finalButton.Current.IsEnabled) { throw "Resolve의 Connect 버튼이 활성화되지 않았습니다." }

    # Jay 결정(2026-09-22): 마지막 Connect 까지 앱이 누른다. 누르기 전에 창을 앞으로 가져와
    # 무슨 일이 일어나는지 보이게 하고, 성공은 '창이 닫혔다'로만 인정한다.
    $dialogHandle = [IntPtr]$libraryDialog.Current.NativeWindowHandle
    [MVHubResolveNative]::SetForegroundWindow($dialogHandle) | Out-Null
    Invoke-Element $finalButton

    while ([DateTime]::UtcNow -lt $Deadline -and [MVHubResolveNative]::IsWindow($dialogHandle)) {
        Start-Sleep -Milliseconds 200
    }
    if ([MVHubResolveNative]::IsWindow($dialogHandle)) {
        # Resolve 가 거절한 상태다(같은 경로가 이미 있는 등). 사람이 보고 판단하도록 연결 창과
        # 그 창을 품은 Project Manager 를 둘 다 닫지 않는다(부모를 닫으면 자식도 닫힌다).
        $libraryDialogOpenedByMVHub = $false
        $projectManagerOpenedByMVHub = $false
        throw "Connect 를 눌렀지만 Resolve 연결 창이 닫히지 않았습니다. Resolve 화면의 안내를 확인하세요."
    }
    # 성공 판정은 부모(파이썬)가 Resolve 등록 목록으로 한 번 더 한다. Project Manager 는 닫지 않는다 —
    # Resolve 가 연결 창을 닫고 따로 띄운 오류 창을 함께 가릴 수 있다.
    Write-Result $true "Resolve 라이브러리를 연결했습니다." $process.Id
} catch {
    Close-NativeWindow $folderDialogHandle
    if ($libraryDialogOpenedByMVHub) {
        if ($null -eq $libraryDialog -and $null -ne $process) {
            $libraryDialog = Find-TopWindow $process.Id $LibraryDialogId
        }
        Close-Window $libraryDialog
    }
    if ($projectManagerOpenedByMVHub) { Close-Window $projectManager }
    Write-Result $false $_.Exception.Message
    exit 1
}
'''


def library_name_for_project(
    project_name: str, library_path: Path | None = None
) -> str:
    """Resolve에 보일 짧고 안전한 라이브러리 이름."""
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", project_name).strip(" ._")
    base = f"MVHub - {cleaned or 'Project'}"
    if library_path is None:
        return base[:100]
    normalized_path = os.path.normcase(os.path.abspath(str(library_path))).replace("\\", "/")
    path_id = hashlib.sha256(normalized_path.encode("utf-8")).hexdigest()[:8]
    suffix = f" - {path_id}"
    return base[: 100 - len(suffix)] + suffix


def _dblist_path() -> Path:
    """Resolve가 등록된 프로젝트 라이브러리를 적어 두는 파일(Windows 사용자별)."""
    return (
        Path(os.environ.get("APPDATA", ""))
        / "Blackmagic Design" / "DaVinci Resolve" / "Preferences" / "dblist.conf"
    )


def _folder_key(value: str) -> str:
    # Z: 와 UNC 로 달리 적은 같은 NAS 폴더를 맞춘다(path_safety.unc_for_drive). 모르면(None) 적힌 그대로 견준다.
    return os.path.normcase(os.path.normpath(unc_for_drive(value) or value)).rstrip("\\/")


def registered_library_name(library_root: Path) -> str | None:
    """Resolve가 이 폴더를 이미 등록해 둔 라이브러리 이름. 없으면 "", 알 수 없으면 None.

    dblist.conf 는 한 줄에 `이름:경로:…:DISK` 로 적는다. 드라이브 경로는 콜론을 빼고
    (C:/x → C/x), UNC 는 그대로 적는다(2026-09-22 실측). Resolve 는 같은 경로를 두 번
    등록하지 못하므로("Choose a unique path") 경로가 유일한 신분이다 — 이름은 해시가 붙기 전
    옛 규칙이거나 사람이 지은 것일 수 있어 믿지 않는다. Resolve 가 꺼져 있어도 읽힌다.
    ponytail: Resolve 내부 파일이라 형식이 바뀔 수 있다. 모르는 모양의 DISK 줄이 하나라도
    있거나 한 줄도 못 읽으면 None(모름)으로 물러난다 — '확실히 미등록'이라고 말하지 않는다.
    """
    try:
        text = _dblist_path().read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None
    wanted = _folder_key(str(library_root))
    understood = 0
    doubtful = False
    for line in text.splitlines():
        name, separator, rest = line.partition(":")
        fields = rest.split(":")
        if not separator or not name or len(fields) < 2 or fields[-1].strip().upper() != "DISK":
            continue
        path = fields[0]
        if len(path) >= 2 and path[0].isalpha() and path[1] in "\\/":
            path = f"{path[0]}:{path[1:]}"  # 드라이브 문자 뒤의 콜론을 되살린다
        elif not path.startswith(("\\\\", "//")):
            doubtful = True  # 이름에 ':' 가 들었거나 형식이 바뀌었다 — 이 줄이 우리 것일 수 있다
            continue
        understood += 1
        if _folder_key(path) == wanted:
            return name
    return None if doubtful or not understood else ""


def _resolve_disk_library_names() -> set[str] | None:
    """Resolve 에 지금 올라와 있는 Disk 라이브러리 이름(API). 알 수 없으면 None."""
    listed = run_resolve_library_list_isolated()
    if listed.get("status") != "complete":
        return None
    return set(listed.get("names") or [])


_CONFIRM_ATTEMPTS = 3
_CONFIRM_DELAY_SECONDS = 1.0
_ALREADY_NOTE = "Resolve 에 안내 창이 떠 있으면 OK·Cancel 로 닫아 주세요."


def _confirm_registered(name: str) -> bool | None:
    """Connect 뒤 Resolve 에 이 이름이 올라왔나(API). 끝내 목록을 못 읽으면 None.

    Connect 직후에는 목록 반영이 늦을 수 있어(Codex P1) 잠깐씩 몇 번 다시 묻는다.
    """
    answered = False
    for attempt in range(_CONFIRM_ATTEMPTS):
        names = _resolve_disk_library_names()
        if names is not None:
            answered = True
            if name in names:
                return True
        if attempt + 1 < _CONFIRM_ATTEMPTS:
            time.sleep(_CONFIRM_DELAY_SECONDS)
    return False if answered else None


def _connected_result(name: str, root: Path, *, already: bool, note: str = "") -> dict[str, Any]:
    message = (
        f"이미 연결돼 있습니다 — Resolve 라이브러리 '{name}'."
        if already
        else "Resolve 라이브러리를 연결했습니다."
    )
    return {
        "ok": True,
        "message": f"{message} {note}".strip(),
        "process_id": 0,
        "connected": True,
        "already_connected": already,
        "library_name": name,
        "library_path": str(root),
    }


def _resolve_executable() -> str:
    installations = resolve_environment_snapshot().get("resolve_installations") or []
    for installation in installations:
        executable = str(installation.get("executable") or "").strip()
        if executable:
            return executable
    return ""


def _parse_result(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        if not line.startswith(_RESULT_PREFIX):
            continue
        try:
            payload = json.loads(line[len(_RESULT_PREFIX) :])
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None
    return None


def _cleanup_after_timeout(env: dict[str, str]) -> None:
    cleanup_env = {**env, "MVHUB_CLEANUP_ONLY": "1"}
    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Sta",
                "-Command",
                _POWERSHELL,
            ],
            env=cleanup_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def _run_automation(library_path: Path, library_name: str) -> dict[str, Any]:
    env = {
        **os.environ,
        "MVHUB_LIBRARY_PATH": str(library_path),
        "MVHUB_LIBRARY_NAME": library_name,
        "MVHUB_RESOLVE_EXE": _resolve_executable(),
        "MVHUB_RESULT_PREFIX": _RESULT_PREFIX,
        "MVHUB_CLEANUP_ONLY": "0",
    }
    try:
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Sta",
                "-Command",
                _POWERSHELL,
            ],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=80,
        )
    except subprocess.TimeoutExpired as exc:
        _cleanup_after_timeout(env)
        raise ResolveLibraryDialogError("Resolve 연결 창을 여는 시간이 초과되었습니다.") from exc
    except OSError as exc:
        raise ResolveLibraryDialogError("Windows 자동화 도구를 실행하지 못했습니다.") from exc

    result = _parse_result(completed.stdout)
    if result and result.get("ok") is True:
        return result
    detail = str((result or {}).get("message") or "").strip()
    if not detail:
        detail = (completed.stderr or "").strip()[-2000:] or "Resolve 연결 창을 열지 못했습니다."
    raise ResolveLibraryDialogError(detail)


def open_library_connect_dialog(library_path: Path, project_name: str) -> dict[str, Any]:
    """검증된 Disk Project Library를 Resolve Connect 창에 입력하고 Connect 를 누른다.

    Resolve 설정 파일은 읽기만 하고 고치지 않는다. 판정은 둘로 한다.
    - 누르기 전: 이 폴더가 이미 등록돼 있으면(dblist.conf, 경로 대조) 창을 열지 않는다.
    - 누른 뒤: 창이 닫힌 것만으로는 부족하다 — Resolve 는 창을 닫고 따로 'Cannot Connect'
      창을 띄울 수 있다(Codex P1, 2026-09-22). Resolve 에 이름이 올라왔는지 API 로 확인한다.
    """
    if os.name != "nt":
        raise ResolveLibraryDialogError("이 기능은 Windows에서만 사용할 수 있습니다.")
    root = Path(library_path)
    if not root.is_dir() or not (root / "Resolve Projects").is_dir():
        raise ResolveLibraryDialogError("Resolve Projects 폴더가 있는 @davinci 경로가 아닙니다.")
    if not _DIALOG_LOCK.acquire(blocking=False):
        raise ResolveLibraryDialogError("Resolve 연결 창을 여는 중입니다.")
    try:
        # 확인과 연결을 한 임계 구역으로 묶는다 — 확인한 뒤 다른 작업이 끼어들지 못하게.
        with resolve_mutation_slot(blocking=False) as acquired:
            if not acquired:
                raise ResolveLibraryDialogError("Resolve에서 다른 작업이 진행 중입니다.")
            registered = registered_library_name(root)
            if registered:
                return _connected_result(registered, root, already=True)
            library_name = library_name_for_project(project_name, root)
            try:
                _run_automation(root, library_name)
                failure: ResolveLibraryDialogError | None = None
            except ResolveLibraryDialogError as exc:
                failure = exc
            # Resolve 가 꺼져 있었으면 자동화가 켰고, Resolve 는 켜면서 등록 파일을 새로 쓴다 —
            # 이 폴더가 (이제) 등록돼 있는지 경로로 한 번 더 본다(Codex P1: 꺼진 채 누른 경우).
            registered = registered_library_name(root)
            # 자동화가 거절당했거나 다른 이름으로 등록돼 있으면, 누르기 전부터 있던 등록이다.
            # 우리 이름이 보여도 자동화가 성공했다면 파일만 믿지 않고 아래 API 로 판정한다(Codex 3차).
            if registered and (failure is not None or registered != library_name):
                return _connected_result(registered, root, already=True, note=_ALREADY_NOTE)
            if failure is not None:
                raise failure
            confirmed = _confirm_registered(library_name)
            if confirmed is None:
                raise ResolveLibraryDialogError(
                    "Connect 는 눌렀지만 Resolve 에 연결됐는지 확인하지 못했습니다. "
                    "Resolve 의 Project Manager 에서 확인하세요."
                )
            if not confirmed:
                raise ResolveLibraryDialogError(
                    "Connect 를 눌렀지만 Resolve 에 라이브러리가 등록되지 않았습니다. "
                    "Resolve 화면의 안내를 확인하세요."
                )
            return _connected_result(library_name, root, already=False)
    finally:
        _DIALOG_LOCK.release()

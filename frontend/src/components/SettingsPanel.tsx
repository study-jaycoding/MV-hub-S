// 설정 — AccountMenu의 "설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
//  · 단축키(변경은 별도 플로팅 창 ShortcutsWindow)
//  · 생성물 점검(HF 최신분 동기화·삭제물 확인) + 100건 밖 과거 전체 MCP 백필
import { useEffect, useRef, useState } from "react";
import {
  FOLDER_TREE_THEMES,
  loadAccent,
  loadLang,
  loadReduceMotion,
  saveAccent,
  saveFolderTreeTheme,
  saveReduceMotion,
  useFolderTreeTheme,
  type Lang,
} from "../lib/theme";
import { fmtBackupWhen } from "../lib/format";
import { setLang, useT } from "../lib/i18n";
import {
  clearDownloadDir,
  downloadDirName,
  fsaSupported,
  pickDownloadDir,
} from "../lib/downloadDir";
import { listScenes } from "../lib/scenes";
import { sceneStoreReady } from "../lib/sceneStore";
import { api, type HistoryImportStatus } from "../api";
import {
  selectCurrentServerBackup,
  type BackupContinuityStatus,
  type ServerBackupVersion,
} from "../lib/assetsApi";
import { useModalFocus } from "../lib/keyGate";
import { useEscapeClose } from "../lib/useEscapeClose";
import { ShortcutsWindow } from "./ShortcutsWindow";
import {
  AppearanceSettingsSection,
  AssetTransferLine,
  BACKUP_STATE_LABELS,
  DbFileTransfer,
  DownloadLocationSection,
  MetadataContinuitySection,
  ReleaseUpdateSettingsSection,
  ResolveScriptSettingsSection,
  ServerBackupSyncButton,
} from "./settings/SettingsSections";
import { McpQuickConnect } from "./mcp/McpQuickConnect";
import { BackupSection, backupSummary } from "./settings/BackupSection";
import { SettingsFold } from "./settings/SettingsFold";
import { CanvasArchiveSection, heldRecoveryCounts, useStorageRecovery } from "./settings/CanvasArchiveSection";
import { ComfyConnectionSection } from "./settings/ComfyConnectionSection";
import { ComfyUnresolvedRunsSection } from "./settings/ComfyUnresolvedRunsSection";
import { SettingsDescription } from "./settings/SettingsDescription";
import { SettingsGroup } from "./settings/SettingsGroup";
import { SlackNotificationSection } from "./settings/SlackNotificationSection";
import { saveResolveSelectionFollow, useResolveSelectionFollow } from "../lib/resolveSelectionSettings";
import {
  getResolveConnectionStatus,
  getResolveEnvironmentDiagnostics,
  getResolveScriptStatus,
  installResolveScript,
  getResolvePanelPluginStatus,
  installResolvePanelPlugin,
  type ResolvePanelPluginStatus,
  type ResolveConnectionStatus,
  type ResolveEnvironmentDiagnostics,
  type ResolveScriptStatus,
} from "../lib/resolveTransfer";
import {
  FORCE_UPDATE_INSTALLS_PUBLIC,
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  pollFailureMessage,
  releaseUpdateMessage,
  startReleaseUpdate,
  UPDATE_TIMEOUT_MESSAGE,
  UPDATE_WAIT_VERSION_KEY,
  createUpdateWaitClock,
  type ReleaseUpdateStatus,
} from "../lib/releaseUpdate";
import { CloseIcon } from "./common/ViewIcons";
import { reloadIfFree, reloadNow, unsavedNote, unsavedPlaces } from "../lib/unloadGuard"; // 앱이 스스로 하는 새로고침 — 서버 상태를 바꾼 뒤라 묻지 않고 진행한다

/** 자료 관리 묶음 제목 밑 줄 — 진행·결과 문구는 접어 둬도 보이게 맨 앞에, 여럿이 함께 돌면 모두(배포 전 검토 Claude 2). */
export function dataFoldSummary(history: HistoryImportStatus | null, progress: string[], rest: string[]): string {
  const historyText = history?.state === "running" ? `과거 생성물 가져오는 중 ${history.received}건` : history?.message || "";
  return [historyText, ...progress, ...rest].filter(Boolean).join(" · ");
}

/** 자료 관리 접힌 줄 조각 — '복원 보류 N'(주황)은 시안 2판 자리인 백업 세트 뒤·서버 상태 앞. 보류 0 이면 뺀다. failed면 보류 뒤에 '보관본 읽기 실패'를 둔다. */
export function dataFoldParts(lead: string, held: number, shared: string, failed = false): (string | { held: number } | { failed: boolean })[] {
  return [lead, held > 0 ? { held } : "", failed ? { failed: true } : "", shared].filter((part) => part !== "");
}

// Resolve 연결을 확인하지 못했을 때의 상태 — 처음 확인·다시 확인·진단이 같이 쓴다.
const RESOLVE_UNKNOWN: ResolveConnectionStatus = {
  status: "api_unavailable",
  connected: false,
  process_running: false,
  project_open: false,
  project_id: "",
  project_name: "",
  message: "Resolve 연결 상태를 확인하지 못했습니다",
};

export function SettingsPanel({
  onClose,
  onImported,
  onOpenMcp,
  anchor,
}: {
  /** 연 자리 — 아바타 바로 밑(프로필 메뉴와 같은 자리, AccountMenu 가 잰다). 없으면 CSS 기본 자리 */
  anchor?: { top: number; right: number } | null;
  onClose: () => void;
  onImported?: (msg: string) => void; // 라이브러리 변경 후 리로드+안내(휴지통 이동 등)
  onOpenMcp?: () => void;
}) {
  const t = useT();
  const recoveryState = useStorageRecovery();
  const [heldRecovery, , recoveryFailed] = recoveryState; // 접힌 줄과 펼친 칸이 한 번 읽은 결과를 같이 쓴다.
  const [accent, setAccent] = useState(loadAccent());
  const [lang, setLangState] = useState<Lang>(loadLang());
  const [reduceMotion, setReduceMotion] = useState(loadReduceMotion());
  const treeTheme = useFolderTreeTheme();
  const resolveSelectionFollow = useResolveSelectionFollow();
  const [historyImport, setHistoryImport] = useState<HistoryImportStatus | null>(null);
  const [scOpen, setScOpen] = useState(false);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState("");
  const [backupContinuity, setBackupContinuity] = useState<BackupContinuityStatus | null>(null);
  const [serverBackups, setServerBackups] = useState<ServerBackupVersion[] | null>(null);
  const [serverBackupsLoading, setServerBackupsLoading] = useState(false);
  const [metadataSyncTarget, setMetadataSyncTarget] = useState<ServerBackupVersion | null>(null);
  const [metadataSyncTargetState, setMetadataSyncTargetState] = useState<
    "loading" | "ready" | "empty" | "error"
  >("loading");
  const [syncMsg, setSyncMsg] = useState("");
  const [reinspectMsg, setReinspectMsg] = useState("");
  const [hfMsg, setHfMsg] = useState("");
  const [dlDir, setDlDir] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState("");
  const [resolveScriptStatus, setResolveScriptStatus] = useState<ResolveScriptStatus | null>(null);
  const [panelPluginStatus, setPanelPluginStatus] = useState<ResolvePanelPluginStatus | null>(null);
  const [panelPluginBusy, setPanelPluginBusy] = useState(false);
  const [panelPluginError, setPanelPluginError] = useState("");
  const installPanelPlugin = async () => {
    setPanelPluginBusy(true); setPanelPluginError("");
    try { setPanelPluginStatus(await installResolvePanelPlugin()); }
    catch (error) { setPanelPluginError(error instanceof Error ? error.message : String(error)); }
    finally { setPanelPluginBusy(false); }
  };
  const [resolveConnection, setResolveConnection] = useState<ResolveConnectionStatus | null>(null);
  const [resolveDiagnostics, setResolveDiagnostics] = useState<ResolveEnvironmentDiagnostics | null>(null);
  // 설정 창을 열면 바로 연결 검사를 시작한다. 첫 응답 전에도 버튼을 잠가
  // 느린 Resolve API 검사가 겹쳐 실행되거나 늦은 응답이 최신 상태를 덮지 않게 한다.
  const [resolveConnectionBusy, setResolveConnectionBusy] = useState(true);
  const [resolveScriptBusy, setResolveScriptBusy] = useState(false);
  const [resolveScriptMsg, setResolveScriptMsg] = useState("");
  const [releaseUpdateStatus, setReleaseUpdateStatus] = useState<ReleaseUpdateStatus | null>(null);
  const [releaseUpdateBusy, setReleaseUpdateBusy] = useState(false);
  const [releaseUpdateMsg, setReleaseUpdateMsg] = useState("");
  const [releaseUpdatePolling, setReleaseUpdatePolling] = useState(false);
  // 접는 묶음 제목 밑 상태 줄 — 칸 안에서만 아는 값(Slack 상태·저장된 Comfy 연결·미회수 수)은 칸이 넘겨 준다
  const [slackSummary, setSlackSummary] = useState("");
  const [comfySummary, setComfySummary] = useState("");
  const [unresolvedSummary, setUnresolvedSummary] = useState("");
  const [mcpSummary, setMcpSummary] = useState("");
  const [transferWaiting, setTransferWaiting] = useState<number | null>(null); // 자료 관리 '전송 대기' 숫자
  // 백업 현황 — 창을 열 때, [지금 백업]·보관 양을 바꾼 뒤 다시 읽는다.
  const refreshBackupContinuity = () => {
    api.backupContinuity().then(setBackupContinuity).catch(() => {
      setDbMsg("백업 상태를 확인하지 못했습니다.");
    });
  };

  useEffect(() => {
    downloadDirName().then(setDlDir).catch(() => {});
    getResolvePanelPluginStatus().then(setPanelPluginStatus).catch(error => {
      setPanelPluginError(error instanceof Error ? error.message : String(error));
    });
    getResolveScriptStatus().then(setResolveScriptStatus).catch(() => {
      setResolveScriptMsg("설치 상태를 확인하지 못했습니다. 로컬 MV Hub에서 다시 시도하세요.");
    });
    getResolveConnectionStatus()
      .then(setResolveConnection)
      .catch(() => setResolveConnection(RESOLVE_UNKNOWN))
      .finally(() => {
        setResolveConnectionBusy(false);
      });
    getReleaseUpdateStatus(true).then((status) => {
      setReleaseUpdateStatus(status);
      let waitingVersion = "";
      try {
        waitingVersion = window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY) || "";
      } catch {
        // sessionStorage를 막은 브라우저에서도 설정 창은 정상 사용한다.
      }
      if (isReleaseUpdateRunning(status.state)) {
        if (!waitingVersion && status.latest_version) {
          try {
            window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, status.latest_version);
          } catch {
            // 상태 폴링 자체는 계속 가능하다.
          }
        }
        setReleaseUpdatePolling(true);
      } else if (waitingVersion) {
        setReleaseUpdatePolling(true);
      }
    }).catch(() => {
      setReleaseUpdateMsg("업데이트 상태를 확인하지 못했습니다.");
    });
    refreshBackupContinuity();
    api.serverBackups()
      .then((result) => {
        const target = selectCurrentServerBackup(result.backups);
        setMetadataSyncTarget(target);
        setMetadataSyncTargetState(target ? "ready" : "empty");
      })
      .catch(() => setMetadataSyncTargetState("error"));
    api.historyImportStatus().then(setHistoryImport).catch(() => {});
  }, []);

  // ★폴 사슬은 `historyImport.state` 가 바뀔 때만 다시 만든다(2026-09-12, C-17).
  //  종전에는 `onImported` 도 의존성이었는데 그건 `App.tsx:1644` 가 넘기는 **인라인 화살표**라
  //  App 이 렌더될 때마다 식별자가 바뀐다. 그때마다 사슬이 끊기고 600ms 뒤부터 다시 시작하므로,
  //  임포트 중 App 이 600ms 보다 자주 렌더되면 상태 조회가 **한 번도 못 나가** 진행률이 멈춘다.
  //  (임포트는 생성물을 넣어 라이브러리 갱신을 일으키므로 그 렌더가 실제로 잦은 구간이다.)
  //  같은 파일 아래의 릴리스 폴은 의존성이 불리언 하나뿐이라 이 문제가 없다 — 건드리지 않았다.
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  useEffect(() => {
    if (historyImport?.state !== "running") return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await api.historyImportStatus();
        if (cancelled) return;
        setHistoryImport(status);
        if (status.state === "complete") {
          onImportedRef.current?.(
            `과거 생성물 확인 완료 · 신규 ${status.inserted} · 갱신 ${status.updated} · 기존 ${status.unchanged}`,
          );
          return;
        }
        if (status.state === "failed") return;
      } catch {
        // 백엔드가 잠깐 바쁜 경우 다음 조회에서 이어간다.
      }
      if (!cancelled) timer = window.setTimeout(poll, 1000);
    };
    timer = window.setTimeout(poll, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historyImport?.state]);

  useEffect(() => {
    if (!releaseUpdatePolling) return;
    let cancelled = false;
    let timer = 0;
    // 시작부터 고정 5분이 아니라 진행이 멈춘 시간으로 끊는다 — 덮개와 같은 시계(lib/releaseUpdate createUpdateWaitClock).
    //  요청과 따로 도는 감시라 끝나지 않는 요청에도 멈춘다(덮개와 같은 이유 — 2026-10-03 CXF-6, Codex 리뷰 1차 중간).
    const clock = createUpdateWaitClock();
    const watch = window.setInterval(() => {
      if (cancelled || !clock.expired()) return;
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(watch);
      setReleaseUpdateBusy(false);
      setReleaseUpdatePolling(false);
      setReleaseUpdateMsg(UPDATE_TIMEOUT_MESSAGE);
    }, 1000);

    const poll = async () => {
      let expected = "";
      try {
        expected = window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY) || "";
      } catch {
        // 아래 status.latest_version으로 폴백한다.
      }
      clock.asked();
      try {
        const status = await getReleaseUpdateStatus(false);
        if (cancelled) return;
        clock.answered(status);
        setReleaseUpdateStatus(status);
        const target = expected || status.latest_version;
        if (status.state === "failed") {
          window.clearInterval(watch); // 결과가 정해졌다 — 감시가 뒤늦게 시간 초과로 덮지 않게
          // recovery_required 안내(로그 확인·관리자 문의)까지 포함되도록 공용 문구를 쓴다.
          setReleaseUpdateMsg(releaseUpdateMessage(status) || "업데이트에 실패했습니다.");
          setReleaseUpdateBusy(false);
          setReleaseUpdatePolling(false);
          try {
            window.sessionStorage.removeItem(UPDATE_WAIT_VERSION_KEY);
          } catch {
            // ignore
          }
          return;
        }
        if (
          target
          && (status.state === "complete" || status.state === "up_to_date")
          && status.current_version === target
        ) {
          // 완료가 정해졌다 — 새로고침을 예약한 0.5초 사이에 감시가 전체 상한에 닿아 성공을 시간 초과로 덮지 않게(Codex 재확인 중간)
          window.clearInterval(watch);
          setReleaseUpdateMsg("업데이트 완료 · 새 화면을 여는 중…");
          try {
            window.sessionStorage.removeItem(UPDATE_WAIT_VERSION_KEY);
          } catch {
            // ignore
          }
          // 저장하지 못한 편집이 있으면 스스로 새로고침하지 않는다 — 업데이트 덮개가 [지금 새로고침]·[닫기]를 내준다(같은 판정:
          //  lib/unloadGuard). 여기서 묻지 않고 새로고침하면 덮개가 묻기도 전에 그 편집이 사라졌다(Codex 재검토 3회째).
          window.setTimeout(() => {
            if (reloadIfFree() || cancelled) return;
            setReleaseUpdateMsg(`업데이트가 끝났습니다 — ${unsavedPlaces()}에 저장하지 못한 변경이 있어 자동으로 새로고침하지 않았습니다.`);
            setReleaseUpdateBusy(false);
            setReleaseUpdatePolling(false);
          }, 500);
          return;
        }
      } catch {
        // 기존 허브가 종료되고 새 허브가 뜨는 동안 연결 실패는 정상이다.
        // 다만 무응답이 90초를 넘으면 멈춘 문구 대신 정직한 대기 안내로 바꾼다(유령 진행률 방지).
        if (!cancelled) {
          clock.failed();
          setReleaseUpdateMsg(
            pollFailureMessage(clock.failedSince(), Date.now()) ?? "프로그램을 교체하고 다시 시작하는 중…",
          );
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 1500); // 멈출 때는 위 감시가 정한다
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(watch);
    };
  }, [releaseUpdatePolling]);

  const refreshReleaseUpdate = async () => {
    setReleaseUpdateBusy(true);
    setReleaseUpdateMsg("최신 릴리스를 확인하는 중…");
    try {
      const status = await getReleaseUpdateStatus(true);
      setReleaseUpdateStatus(status);
      setReleaseUpdateMsg(status.message);
    } catch (error) {
      setReleaseUpdateMsg("확인 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setReleaseUpdateBusy(false);
    }
  };

  // force=true — 오류 잔여 카드가 '진행 중'으로 집계돼 일반 버튼이 막힐 때, 검사를 건너뛰고
  // 강제 시작(폴더의 update_release.bat 직접 실행과 동일한 우회를 앱 안에서).
  const runReleaseUpdate = async (force = false) => {
    const status = releaseUpdateStatus;
    if (!force && (!status?.can_update || !status.latest_version)) return;
    const confirmText = force
      ? `진행 중 작업 검사를 건너뛰고 강제로 업데이트합니다.\n${FORCE_UPDATE_INSTALLS_PUBLIC}\n실제로 생성·Resolve 전송이 돌고 있다면 그 작업은 중단될 수 있습니다.\n프로그램이 자동으로 다시 시작됩니다. 계속할까요?`
      : `MV Hub를 ${status?.latest_version} 버전으로 업데이트합니다.\n프로그램이 자동으로 다시 시작됩니다.\n계속할까요?`;
    if (!window.confirm(confirmText)) return;
    setReleaseUpdateBusy(true);
    setReleaseUpdateMsg("업데이트를 준비하는 중…");
    try {
      // 강제 경로는 버전 확인이 실패한 상태일 수도 있다 — 알 때만 대기 버전을 기록.
      if (status?.latest_version) {
        window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, status.latest_version);
      }
    } catch {
      // 저장 불가 시에도 현재 설정 창에서 폴링한다.
    }
    try {
      const started = await startReleaseUpdate(force);
      setReleaseUpdateStatus(started);
      setReleaseUpdateMsg(started.message);
      setReleaseUpdatePolling(true);
    } catch (error) {
      try {
        window.sessionStorage.removeItem(UPDATE_WAIT_VERSION_KEY);
      } catch {
        // ignore
      }
      setReleaseUpdateMsg("업데이트 시작 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
      setReleaseUpdateBusy(false);
    }
  };

  const refreshResolveConnection = async () => {
    setResolveConnectionBusy(true);
    try {
      const diagnostics = await getResolveEnvironmentDiagnostics();
      setResolveDiagnostics(diagnostics);
      setResolveConnection(diagnostics.connection);
      setResolveScriptStatus(diagnostics.script);
    } catch {
      setResolveConnection(RESOLVE_UNKNOWN);
    } finally {
      setResolveConnectionBusy(false);
    }
  };

  // [다시 확인] — 연결 상태만 다시 묻는다(진단보다 가볍다, 시안 v3 연결 상자).
  const recheckResolveConnection = async () => {
    setResolveConnectionBusy(true);
    try {
      setResolveConnection(await getResolveConnectionStatus());
    } catch {
      setResolveConnection(RESOLVE_UNKNOWN);
    } finally {
      setResolveConnectionBusy(false);
    }
  };

  const installResolveExporter = async () => {
    setResolveScriptBusy(true);
    setResolveScriptMsg("Resolve 설치 중…");
    try {
      const result = await installResolveScript();
      setResolveScriptStatus(result);
      const versions = `내보내기 v${result.bundled_version || "확인 불가"} · 가져오기 v${result.importer_bundled_version || "확인 불가"}`;
      const summary = result.changed
        ? `가져오기·내보내기 도구 설치 완료 · ${versions} · Resolve를 완전히 종료하고 다시 실행하세요.`
        : `가져오기·내보내기 도구가 이미 최신입니다 · ${versions}`;
      const migration = result.backup_paths?.length
        ? ` · 예전 사용자용 스크립트 ${result.backup_paths.length}개 안전 백업`
        : "";
      setResolveScriptMsg(
        result.warnings?.length
          ? `${summary}${migration} · ${result.warnings[0]}`
          : `${summary}${migration}`,
      );
    } catch (error) {
      setResolveScriptMsg(
        "설치 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""),
      );
    } finally {
      setResolveScriptBusy(false);
    }
  };

  const pickDir = async () => {
    setDlErr("");
    try {
      setDlDir(await pickDownloadDir());
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") setDlErr(String((e as Error)?.message || e));
    }
  };

  const clearDir = async () => {
    await clearDownloadDir().catch(() => {});
    setDlDir(null);
  };

  // 'HF 생성물 체크' — 내 에이전트를 깨워 허브 밖(HF 웹·CLI)에서 만든 결과물을 push.
  const syncMine = async () => {
    setSyncMsg("요청 보냄…");
    try {
      const r = await api.agentSync();
      setSyncMsg(r.connected ? "✓ 에이전트에 전달됨" : "에이전트가 꺼져 있어요");
    } catch {
      setSyncMsg("실패");
    }
    setTimeout(() => setSyncMsg(""), 2500);
  };

  // '생성물 재점검' — 내 에이전트를 깨워 최신 N개를 known-필터 없이 재전송 → 서버가 힉스필드 상태와
  //  대조해 어긋난 것(로컬만 실패 등)을 정정. 눌렀을 때만 작동(자동 아님).
  const reinspectGenerations = async () => {
    setReinspectMsg("요청 보냄…");
    try {
      const r = await api.agentReinspect();
      setReinspectMsg(r.connected ? "✓ 에이전트가 재점검 중" : "에이전트가 꺼져 있어요");
    } catch {
      setReinspectMsg("실패");
    }
    setTimeout(() => setReinspectMsg(""), 3000);
  };

  // 'HF 삭제물 체크' — 내 생성물 중 힉스필드에서 삭제된 것을 찾아 휴지통으로 보낸다.
  const reviewHfDeleted = async () => {
    setHfMsg("힉스필드 점검 중…");
    try {
      const r = await api.trashHfMissing();
      const total = r.trashed + (r.server_trashed || 0); // 로컬 + 서버 공유본 삭제물 합
      setHfMsg(total > 0 ? `✓ ${total}건 휴지통으로` : `삭제물 없음 (${r.checked}건 점검)`);
      if (total > 0) onImported?.(`힉스필드 삭제물 ${total}건을 휴지통으로 보냈습니다.`);
    } catch {
      setHfMsg("실패");
    }
    setTimeout(() => setHfMsg(""), 2800);
  };

  // 내 DB 가져오기(통째 교체) — 성공하면 라이브러리를 새로 읽도록 전체 새로고침.
  const importDb = async (file: File | null | undefined) => {
    if (!file) return;
    if (!window.confirm("현재 로컬 DB를 이 파일로 통째 교체합니다. (현재 DB는 자동 백업)\n계속할까요?" + unsavedNote())) {
      return;
    }
    setDbBusy(true);
    setDbMsg("가져오는 중…");
    try {
      await api.importDb(file);
      setDbMsg("가져오기 완료 — 라이브러리를 새로고침합니다…");
      setTimeout(() => reloadNow(), 800);
    } catch (e) {
      setDbMsg("가져오기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  const startHistoryImport = async () => {
    try {
      setHistoryImport(await api.historyImportStart());
    } catch (error) {
      setHistoryImport({
        state: "failed",
        pages: 0,
        received: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        errors: 0,
        message: String(error).replace(/^Error:\s*\d+:\s*/, ""),
        started_at: null,
        finished_at: null,
      });
    }
  };

  const loadServerBackups = async () => {
    if (serverBackups !== null) {
      setServerBackups(null);
      return;
    }
    setServerBackupsLoading(true);
    setDbMsg("서버 백업 목록을 확인하는 중");
    try {
      const result = await api.serverBackups();
      const versions = result.backups.filter((item) => item.kind === "set");
      setServerBackups(versions);
      setDbMsg(versions.length ? "적용할 서버 백업을 선택하세요." : "서버 백업이 없습니다.");
    } catch (error) {
      setDbMsg("서버 백업 목록 확인 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setServerBackupsLoading(false);
    }
  };

  const serverRestore = async (backup: ServerBackupVersion) => {
    const backupSetId = backup.backup_set_id || backup.name;
    const when = fmtBackupWhen(backup.created_at, backup.mtime);
    const device = backup.device?.device_name || "알 수 없는 PC";
    if (
      !window.confirm(
        `${device}에서 만든 ${when} 메타데이터를 적용합니다.\n현재 로컬 데이터는 먼저 안전하게 보관되며, 적용 후 재로그인합니다.\n계속할까요?` + unsavedNote(),
      )
    ) {
      setDbMsg("서버 백업 가져오기를 취소했습니다.");
      return false;
    }
    setDbBusy(true);
    setDbMsg("서버에서 가져오는 중…");
    try {
      await api.serverRestore(backupSetId);
      setDbMsg("복원 완료 — 다시 로그인해 주세요…");
      setTimeout(() => reloadNow(), 900);
      return true;
    } catch (e) {
      setDbMsg("가져오기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
      return false;
    } finally {
      setDbBusy(false);
    }
  };

  const syncMetadata = async () => {
    setServerBackupsLoading(true);
    setDbMsg("서버의 최신 백업을 확인하는 중");
    try {
      const result = await api.serverBackups();
      const backup = selectCurrentServerBackup(result.backups);
      setMetadataSyncTarget(backup);
      setMetadataSyncTargetState(backup ? "ready" : "empty");
      if (!backup) {
        setDbMsg("서버에 가져올 백업이 없습니다.");
        return;
      }
      await serverRestore(backup);
    } catch (error) {
      setMetadataSyncTargetState("error");
      setDbMsg("서버 백업 가져오기 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setServerBackupsLoading(false);
    }
  };

  useEscapeClose(onClose);
  // 설정 창과 옆 창(SettingsFold — body 에 따로 그려진다)은 한 조작 영역이다: Tab 이 둘 사이를 돌고 뒤 화면으로는 나가지 않는다
  //  (lib/keyGate '모달의 초점'). 옆 창은 한 번에 하나만 보이고, 나머지는 숨긴 채 붙어 있다.
  const floatRef = useRef<HTMLDivElement>(null);
  useModalFocus(() => [floatRef.current, document.querySelector<HTMLElement>(".settings-group-flyout:not([hidden])")]);

  // 묶음 두 줄은 그 밑으로 펼친다(Jay 2026-11-16 시안 v3) — 처음엔 둘 다 접혀 안의 항목 이름이 보인다.
  const [openGroups, setOpenGroups] = useState({ basic: false, external: false });
  const toggleGroup = (key: "basic" | "external") => setOpenGroups((now) => ({ ...now, [key]: !now[key] }));

  const pickAccent = (hex: string) => {
    setAccent(hex);
    saveAccent(hex);
  };

  const pickLang = (nextLang: Lang) => {
    setLangState(nextLang);
    setLang(nextLang);
  };

  const pickReduceMotion = (value: boolean) => {
    setReduceMotion(value);
    saveReduceMotion(value);
  };

  // 접는 묶음 제목 밑 줄 — 접어 둬도 보이는 지금 상태("실시간 정보는 접기 밖", Jay 08-20). 글자 끝 '…' 없음(Jay 10-29).
  const themeLabel = (FOLDER_TREE_THEMES.find((item) => item.key === treeTheme) ?? FOLDER_TREE_THEMES[0]).label;
  const appearanceSummary = (
    <>
      <span className="settings-fold-dot" style={{ background: accent }} aria-hidden="true" />
      {[lang === "ko" ? "한글" : "English", `${t("모션")} ${reduceMotion ? "OFF" : "ON"}`, `${t("필터")} ${t(themeLabel)}`].join(" · ")}
    </>
  );
  const workSummary = dlDir
    ? `${t("선택된 폴더")}: ${dlDir}`
    : fsaSupported() ? t("다운로드 폴더 지정 안 됨") : t("현재 접속에서는 다운로드 폴더를 직접 지정할 수 없습니다.");
  const sharedBackup = backupContinuity?.shared;
  const dataLead = dataFoldSummary(historyImport, [dbMsg, reinspectMsg, syncMsg, hfMsg], [
    sceneStoreReady() ? t("캔버스 {n}개").replace("{n}", String(listScenes(null).length)) : "",
    backupSummary(backupContinuity),
  ]);
  const sharedText = sharedBackup ? `${t("서버")} ${BACKUP_STATE_LABELS[sharedBackup.state] || sharedBackup.state}` : "";
  const dataSummary = <>{dataFoldParts(dataLead, heldRecoveryCounts(heldRecovery).total, sharedText, recoveryFailed).map((part, i) => (
    <span key={i}>{i ? " · " : ""}{typeof part === "string" ? part
      : <b style={{ color: "var(--warning, #c86f20)" }}>{"held" in part ? t("복원 보류 {n}").replace("{n}", String(part.held)) : t("보관본 읽기 실패")}</b>}</span>
  ))}</>;
  // DaVinci 줄 밑 상태 — '연결됨 · 프로젝트 · 설치 n/전체'(시안 v3). 패널 플러그인이 릴리스에서 꺼졌으면 전체는 Script 하나.
  const panelShown = panelPluginStatus?.state !== "release_disabled";
  const installedCount = (panelShown && panelPluginStatus?.state === "up_to_date" ? 1 : 0) + (resolveScriptStatus?.up_to_date ? 1 : 0);
  const resolveSummary = [
    resolveConnectionBusy ? t("확인하는 중") : resolveConnection?.connected ? t("연결됨") : resolveConnection?.message || "",
    !resolveConnectionBusy && resolveConnection?.connected ? resolveConnection.project_name : "",
    resolveScriptStatus ? `${t("설치")} ${installedCount}/${panelShown ? 2 : 1}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div ref={floatRef} className="manage-float settings-float" role="dialog" aria-label={t("설정")}
        style={anchor ? { top: anchor.top, right: anchor.right, maxHeight: `calc(100vh - ${anchor.top + 8}px)` } : undefined}>
        <header className="admin-head">
          <span className="admin-title">⚙ {t("설정")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            <CloseIcon />
          </button>
        </header>

        {/* 묶음 두 줄은 그 밑으로 펼치고 항목은 옆 창, 맨 아래 MV Hub Update(Jay 2026-11-16 시안 v3) */}
        <div className="admin-body">
          <SettingsGroup title={t("기본 설정")} summary={[t("화면"), t("작업"), t("자료 관리")].join(" · ")}
            open={openGroups.basic} onToggle={() => toggleGroup("basic")}>
            <SettingsFold title={t("화면")} summary={appearanceSummary}>
              <AppearanceSettingsSection
                accent={accent}
                lang={lang}
                reduceMotion={reduceMotion}
                treeTheme={treeTheme}
                onAccent={pickAccent}
                onLang={pickLang}
                onReduceMotion={pickReduceMotion}
                onTreeTheme={saveFolderTreeTheme}
              />
            </SettingsFold>

            <SettingsFold title={t("작업")} summary={workSummary}>
              <DownloadLocationSection
                dlDir={dlDir}
                dlErr={dlErr}
                onPickDir={pickDir}
                onClearDir={clearDir}
              />

              <section className="settings-section">
                <h4>{t("단축키")}</h4>
                <button className="settings-action" onClick={() => setScOpen(true)}>
                  {t("단축키 설정")}
                </button>
                <SettingsDescription summary={t("현재 단축키를 확인하고 원하는 키로 변경합니다.")} />
              </section>
            </SettingsFold>

            {/* 숫자 요약 + 주 단추 둘 → 복원 보류 경고·파일로 주고받기·생성물 점검 → '백업 자동 설정 · 고급' 접기(시안 v3).
                드문 일(서버 백업 고르기·DB 통째 주고받기·과거 생성물 전체)은 고급에 그대로 있다 — 기능은 빼지 않았다. */}
            <SettingsFold title={t("자료 관리")} summary={dataSummary}>
              <BackupSection
                status={backupContinuity}
                onRefresh={refreshBackupContinuity}
                held={heldRecoveryCounts(heldRecovery).total}
                transfer={transferWaiting}
                actions={<ServerBackupSyncButton dbBusy={dbBusy} loading={serverBackupsLoading} onSync={syncMetadata} />}
                advanced={<>
                  <MetadataContinuitySection
                    dbBusy={dbBusy}
                    serverBackups={serverBackups}
                    serverBackupsLoading={serverBackupsLoading}
                    metadataSyncTarget={metadataSyncTarget}
                    metadataSyncTargetState={metadataSyncTargetState}
                    onLoadServerBackups={loadServerBackups}
                    onServerRestore={serverRestore}
                  />
                  <DbFileTransfer dbBusy={dbBusy} onImportDb={importDb} />
                  <div className="settings-subblock">
                    <h6>{t("과거 생성물")}</h6>
                    <button
                      className={"settings-action" + (historyImport?.state === "running" ? " is-busy" : "")}
                      onClick={startHistoryImport}
                      disabled={historyImport?.state === "running"}
                    >
                      {historyImport?.state === "running"
                        ? `가져오는 중 ${historyImport.received}건`
                        : "과거 생성물 전체 가져오기"}
                    </button>
                    <p>{t("과거 생성물 전체 가져오기는 최신 100건 밖의 오래된 결과까지 보충합니다.")}</p>
                  </div>
                </>}
              >
                {dbMsg && <p className="manage-msg">{dbMsg}</p>}
                <AssetTransferLine onCount={setTransferWaiting} />
                <CanvasArchiveSection recoveryState={recoveryState} />

                <h5 className="settings-mini-title">{t("생성물 점검")}</h5>
                <div className="settings-row">
                  <button className="settings-action" onClick={reinspectGenerations} disabled={!!reinspectMsg}
                    title={t("최근 결과의 잘못된 상태를 정정합니다.")}>
                    {reinspectMsg || t("재점검")}
                  </button>
                  <button className="settings-action" onClick={syncMine} disabled={!!syncMsg}
                    title={t("힉스필드에서 직접 만든 최신 결과물을 가져옵니다.")}>
                    {syncMsg || t("HF 생성물")}
                  </button>
                  <button className="settings-action" onClick={reviewHfDeleted} disabled={!!hfMsg}
                    title={t("힉스필드에서 지워진 생성물을 허브 휴지통으로 보냅니다.")}>
                    {hfMsg || t("HF 삭제물")}
                  </button>
                </div>
                {/* 실시간 정보(과거 가져오기 진행·결과)는 접기 밖 캡션에 상시 표시(Jay 규칙). */}
                <SettingsDescription
                  summary={
                    historyImport?.state === "running"
                      ? `과거 생성물 가져오는 중 ${historyImport.received}건`
                      : historyImport?.message
                        ? historyImport.message +
                          (historyImport.state === "complete"
                            ? ` · 신규 ${historyImport.inserted} · 갱신 ${historyImport.updated} · 기존 ${historyImport.unchanged}`
                            : "")
                        : t("HF 생성물의 누락·상태·삭제 여부를 한곳에서 확인합니다.")
                  }
                />
              </BackupSection>
            </SettingsFold>
          </SettingsGroup>

          <SettingsGroup title={t("외부 프로그램")}
            summary={["Slack", "ComfyUI", "DaVinci Resolve", ...(onOpenMcp ? ["MCP"] : [])].join(" · ")}
            open={openGroups.external} onToggle={() => toggleGroup("external")}>
            <SettingsFold title={t("Slack 알림")} summary={slackSummary} hideFirstTitle>
              <SlackNotificationSection onSummary={setSlackSummary} />
            </SettingsFold>

            <SettingsFold title="ComfyUI" summary={[comfySummary, unresolvedSummary].filter(Boolean).join(" · ")} hideFirstTitle>
              <ComfyConnectionSection onSummary={setComfySummary} />
              <ComfyUnresolvedRunsSection onSummary={setUnresolvedSummary} />
            </SettingsFold>

            <SettingsFold title="DaVinci Resolve" summary={resolveSummary} hideFirstTitle>
              <ResolveScriptSettingsSection
                selectionFollow={resolveSelectionFollow}
                onSelectionFollowChange={saveResolveSelectionFollow}
                status={resolveScriptStatus}
                panelPlugin={panelPluginStatus}
                panelPluginBusy={panelPluginBusy}
                panelPluginError={panelPluginError}
                onInstallPanelPlugin={installPanelPlugin}
                connection={resolveConnection}
                diagnostics={resolveDiagnostics}
                connectionBusy={resolveConnectionBusy}
                busy={resolveScriptBusy}
                msg={resolveScriptMsg}
                onInstall={installResolveExporter}
                onRefreshConnection={refreshResolveConnection}
                onRecheckConnection={recheckResolveConnection}
              />
            </SettingsFold>

            {/* [한 번에 연결] + 앱별 상태(시안 v3). 다른 MCP 프로그램·옛 연결·MCP 업데이트는 고급의 연결 창에 */}
            {onOpenMcp && <SettingsFold title={t("MV·MCP 연결")} summary={mcpSummary} hideFirstTitle>
              <McpQuickConnect onSummary={setMcpSummary} onOpenWindow={() => { onClose(); onOpenMcp(); }} />
            </SettingsFold>}
          </SettingsGroup>

          <ReleaseUpdateSettingsSection
            status={releaseUpdateStatus}
            busy={releaseUpdateBusy}
            msg={releaseUpdateMsg}
            onRefresh={refreshReleaseUpdate}
            onUpdate={() => void runReleaseUpdate()}
            onForceUpdate={() => void runReleaseUpdate(true)}
          />

        </div>
      </div>

      {scOpen && <ShortcutsWindow onClose={() => setScOpen(false)} />}
    </>
  );
}

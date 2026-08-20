// 설정 — AccountMenu의 "설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
//  · 단축키(변경은 별도 플로팅 창 ShortcutsWindow)
//  · 생성물 점검(HF 최신분 동기화·삭제물 확인) + 100건 밖 과거 전체 MCP 백필
import { useEffect, useState } from "react";
import {
  loadAccent,
  loadLang,
  loadReduceMotion,
  saveAccent,
  saveReduceMotion,
  type Lang,
} from "../lib/theme";
import { setLang, useT } from "../lib/i18n";
import {
  clearDownloadDir,
  downloadDirName,
  pickDownloadDir,
} from "../lib/downloadDir";
import { api, type HistoryImportStatus } from "../api";
import {
  selectCurrentServerBackup,
  type BackupContinuityStatus,
  type ServerBackupVersion,
} from "../lib/assetsApi";
import { useEscapeClose } from "../lib/useEscapeClose";
import { ShortcutsWindow } from "./ShortcutsWindow";
import {
  AppearanceSettingsSection,
  DownloadLocationSection,
  MetadataContinuitySection,
  ReleaseUpdateSettingsSection,
  ResolveScriptSettingsSection,
} from "./settings/SettingsSections";
import { ComfyConnectionSection } from "./settings/ComfyConnectionSection";
import { SettingsDescription } from "./settings/SettingsDescription";
import { SettingsGroup } from "./settings/SettingsGroup";
import {
  getResolveConnectionStatus,
  getResolveEnvironmentDiagnostics,
  getResolveScriptStatus,
  installResolveScript,
  type ResolveConnectionStatus,
  type ResolveEnvironmentDiagnostics,
  type ResolveScriptStatus,
} from "../lib/resolveTransfer";
import {
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  startReleaseUpdate,
  UPDATE_WAIT_VERSION_KEY,
  type ReleaseUpdateStatus,
} from "../lib/releaseUpdate";

export function SettingsPanel({
  onClose,
  onImported,
  initialSection,
}: {
  onClose: () => void;
  onImported?: (msg: string) => void; // 라이브러리 변경 후 리로드+안내(휴지통 이동 등)
  initialSection?: "release-update";
}) {
  const t = useT();
  const [accent, setAccent] = useState(loadAccent());
  const [lang, setLangState] = useState<Lang>(loadLang());
  const [reduceMotion, setReduceMotion] = useState(loadReduceMotion());
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

  useEffect(() => {
    downloadDirName().then(setDlDir).catch(() => {});
    getResolveScriptStatus().then(setResolveScriptStatus).catch(() => {
      setResolveScriptMsg("설치 상태를 확인하지 못했습니다. 로컬 MV Hub에서 다시 시도하세요.");
    });
    getResolveConnectionStatus()
      .then(setResolveConnection)
      .catch(() => {
        setResolveConnection({
          status: "api_unavailable",
          connected: false,
          process_running: false,
          project_open: false,
          project_id: "",
          project_name: "",
          message: "Resolve 연결 상태를 확인하지 못했습니다",
        });
      })
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
    api.backupContinuity().then(setBackupContinuity).catch(() => {
      setDbMsg("백업 상태를 확인하지 못했습니다.");
    });
    api.serverBackups()
      .then((result) => {
        const target = selectCurrentServerBackup(result.backups);
        setMetadataSyncTarget(target);
        setMetadataSyncTargetState(target ? "ready" : "empty");
      })
      .catch(() => setMetadataSyncTargetState("error"));
    api.historyImportStatus().then(setHistoryImport).catch(() => {});
  }, []);

  useEffect(() => {
    if (initialSection !== "release-update") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("settings-release-update")?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialSection]);

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
          onImported?.(
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
  }, [historyImport?.state, onImported]);

  useEffect(() => {
    if (!releaseUpdatePolling) return;
    let cancelled = false;
    let timer = 0;
    const deadline = Date.now() + 5 * 60 * 1000;

    const poll = async () => {
      let expected = "";
      try {
        expected = window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY) || "";
      } catch {
        // 아래 status.latest_version으로 폴백한다.
      }
      try {
        const status = await getReleaseUpdateStatus(false);
        if (cancelled) return;
        setReleaseUpdateStatus(status);
        const target = expected || status.latest_version;
        if (status.state === "failed") {
          setReleaseUpdateMsg(status.message || "업데이트에 실패했습니다.");
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
          setReleaseUpdateMsg("업데이트 완료 · 새 화면을 여는 중…");
          try {
            window.sessionStorage.removeItem(UPDATE_WAIT_VERSION_KEY);
          } catch {
            // ignore
          }
          window.setTimeout(() => window.location.reload(), 500);
          return;
        }
      } catch {
        // 기존 허브가 종료되고 새 허브가 뜨는 동안 연결 실패는 정상이다.
        if (!cancelled) setReleaseUpdateMsg("프로그램을 교체하고 다시 시작하는 중…");
      }
      if (!cancelled && Date.now() < deadline) {
        timer = window.setTimeout(poll, 1500);
      } else if (!cancelled) {
        setReleaseUpdateBusy(false);
        setReleaseUpdatePolling(false);
        setReleaseUpdateMsg("자동 확인 시간이 초과됐습니다. 프로그램 창을 확인한 뒤 다시 열어주세요.");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
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

  const runReleaseUpdate = async () => {
    const status = releaseUpdateStatus;
    if (!status?.can_update || !status.latest_version) return;
    if (!window.confirm(
      `MV Hub를 ${status.latest_version} 버전으로 업데이트합니다.\n프로그램이 자동으로 다시 시작됩니다.\n계속할까요?`,
    )) return;
    setReleaseUpdateBusy(true);
    setReleaseUpdateMsg("업데이트를 준비하는 중…");
    try {
      window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, status.latest_version);
    } catch {
      // 저장 불가 시에도 현재 설정 창에서 폴링한다.
    }
    try {
      const started = await startReleaseUpdate();
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
      setResolveConnection({
        status: "api_unavailable",
        connected: false,
        process_running: false,
        project_open: false,
        project_id: "",
        project_name: "",
        message: "Resolve 연결 상태를 확인하지 못했습니다",
      });
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
    if (!window.confirm("현재 로컬 DB를 이 파일로 통째 교체합니다. (현재 DB는 자동 백업)\n계속할까요?")) {
      return;
    }
    setDbBusy(true);
    setDbMsg("가져오는 중…");
    try {
      await api.importDb(file);
      setDbMsg("가져오기 완료 — 라이브러리를 새로고침합니다…");
      setTimeout(() => window.location.reload(), 800);
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
    setDbMsg("서버 메타데이터 목록을 확인하는 중…");
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
    const when = backup.created_at
      ? new Date(backup.created_at).toLocaleString()
      : new Date(backup.mtime * 1000).toLocaleString();
    const device = backup.device?.device_name || "알 수 없는 PC";
    if (
      !window.confirm(
        `${device}에서 만든 ${when} 메타데이터를 적용합니다.\n현재 로컬 데이터는 먼저 안전하게 보관되며, 적용 후 재로그인합니다.\n계속할까요?`,
      )
    ) {
      setDbMsg("메타데이터 동기화를 취소했습니다.");
      return false;
    }
    setDbBusy(true);
    setDbMsg("서버에서 가져오는 중…");
    try {
      await api.serverRestore(backupSetId);
      setDbMsg("복원 완료 — 다시 로그인해 주세요…");
      setTimeout(() => window.location.reload(), 900);
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
    setDbMsg("서버의 최신 메타데이터를 확인하는 중…");
    try {
      const result = await api.serverBackups();
      const backup = selectCurrentServerBackup(result.backups);
      setMetadataSyncTarget(backup);
      setMetadataSyncTargetState(backup ? "ready" : "empty");
      if (!backup) {
        setDbMsg("서버에 적용할 메타데이터 백업이 없습니다.");
        return;
      }
      await serverRestore(backup);
    } catch (error) {
      setMetadataSyncTargetState("error");
      setDbMsg("메타데이터 동기화 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setServerBackupsLoading(false);
    }
  };

  useEscapeClose(onClose);

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

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="manage-float settings-float" role="dialog" aria-label={t("설정")}>
        <header className="admin-head">
          <span className="admin-title">⚙ {t("설정")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            ✕
          </button>
        </header>

        <div className="admin-body">
          <SettingsGroup title={t("기본 설정")}>
            <AppearanceSettingsSection
              accent={accent}
              lang={lang}
              reduceMotion={reduceMotion}
              onAccent={pickAccent}
              onLang={pickLang}
              onReduceMotion={pickReduceMotion}
            />

            <DownloadLocationSection
              dlDir={dlDir}
              dlErr={dlErr}
              onPickDir={pickDir}
              onClearDir={clearDir}
            />

            <section className="settings-section">
              <h4>{t("단축키")}</h4>
              <button className="settings-action" onClick={() => setScOpen(true)}>
                ⌨️ {t("단축키 설정")}
              </button>
              <SettingsDescription summary={t("현재 단축키를 확인하고 원하는 키로 변경합니다.")} />
            </section>

            <MetadataContinuitySection
              dbBusy={dbBusy}
              dbMsg={dbMsg}
              backupContinuity={backupContinuity}
              serverBackups={serverBackups}
              serverBackupsLoading={serverBackupsLoading}
              metadataSyncTarget={metadataSyncTarget}
              metadataSyncTargetState={metadataSyncTargetState}
              onSyncMetadata={syncMetadata}
              onLoadServerBackups={loadServerBackups}
              onServerRestore={serverRestore}
              onImportDb={importDb}
            />
          </SettingsGroup>

          <SettingsGroup title={t("외부 프로그램")}>
            <ComfyConnectionSection />

            <ResolveScriptSettingsSection
              status={resolveScriptStatus}
              connection={resolveConnection}
              diagnostics={resolveDiagnostics}
              connectionBusy={resolveConnectionBusy}
              busy={resolveScriptBusy}
              msg={resolveScriptMsg}
              onInstall={installResolveExporter}
              onRefreshConnection={refreshResolveConnection}
            />
          </SettingsGroup>

          <section className="settings-section">
            <h4>{t("생성물 재점검")}</h4>
            <button className="settings-action" onClick={reinspectGenerations} disabled={!!reinspectMsg}>
              🔄 {reinspectMsg || t("생성물 재점검")}
            </button>
            <div className="settings-row">
              <button className="settings-action" onClick={syncMine} disabled={!!syncMsg}>
                📤 {syncMsg || t("HF 생성물 체크")}
              </button>
              <button className="settings-action" onClick={reviewHfDeleted} disabled={!!hfMsg}>
                🗑️ {hfMsg || t("HF 삭제물 체크")}
              </button>
            </div>
            <SettingsDescription summary={t("HF 생성물의 누락·상태·삭제 여부를 한곳에서 확인합니다.")}>
              <p>{t("생성물 재점검은 최근 결과의 잘못된 상태를 정정합니다.")}</p>
              <p>{t("HF 생성물 체크는 힉스필드에서 직접 만든 최신 결과물을 가져옵니다.")}</p>
              <p>{t("HF 삭제물 체크는 힉스필드에서 지워진 생성물을 허브 휴지통으로 보냅니다.")}</p>
              <button
                className={"settings-action" + (historyImport?.state === "running" ? " is-busy" : "")}
                onClick={startHistoryImport}
                disabled={historyImport?.state === "running"}
              >
                {historyImport?.state === "running"
                  ? `가져오는 중… ${historyImport.received}건`
                  : "⏱ 과거 생성물 전체 가져오기"}
              </button>
              <p>{t("과거 생성물 전체 가져오기는 최신 100건 밖의 오래된 결과까지 보충합니다.")}</p>
              {historyImport?.message && (
                <p className="manage-msg" aria-live="polite">
                  {historyImport.message}
                  {historyImport.state === "complete"
                    ? ` · 신규 ${historyImport.inserted} · 갱신 ${historyImport.updated} · 기존 ${historyImport.unchanged}`
                    : ""}
                </p>
              )}
            </SettingsDescription>
          </section>

          <ReleaseUpdateSettingsSection
            status={releaseUpdateStatus}
            busy={releaseUpdateBusy}
            msg={releaseUpdateMsg}
            onRefresh={refreshReleaseUpdate}
            onUpdate={runReleaseUpdate}
          />

        </div>
      </div>

      {scOpen && <ShortcutsWindow onClose={() => setScOpen(false)} />}
    </>
  );
}

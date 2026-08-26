import { useState } from "react";
import { ACCENT_PRESETS, type Lang } from "../../lib/theme";
import { fsaSupported } from "../../lib/downloadDir";
import { useT } from "../../lib/i18n";
import type { BackupContinuityStatus, ServerBackupVersion } from "../../lib/assetsApi";
import {
  startResolvePythonInstall,
  type ResolveConnectionStatus,
  type ResolveEnvironmentDiagnostics,
  type ResolveScriptStatus,
} from "../../lib/resolveTransfer";
import {
  isReleaseUpdateRunning,
  releaseUpdateMessage,
  type ReleaseUpdateStatus,
} from "../../lib/releaseUpdate";
import { SettingsDescription } from "./SettingsDescription";

export function AppearanceSettingsSection({
  accent,
  lang,
  reduceMotion,
  onAccent,
  onLang,
  onReduceMotion,
}: {
  accent: string;
  lang: Lang;
  reduceMotion: boolean;
  onAccent: (hex: string) => void;
  onLang: (lang: Lang) => void;
  onReduceMotion: (value: boolean) => void;
}) {
  const t = useT();
  const isCustom = !ACCENT_PRESETS.some((preset) => preset.hex.toLowerCase() === accent.toLowerCase());
  return (
    <>
      <section className="settings-section">
        <h4>{t("강조색")}</h4>
        <div className="accent-swatches">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              className={"accent-swatch" + (accent === preset.hex ? " on" : "")}
              style={{ background: preset.hex }}
              title={preset.name}
              onClick={() => onAccent(preset.hex)}
            >
              {accent === preset.hex && <span className="accent-check">✓</span>}
            </button>
          ))}
          <label
            className={"accent-swatch accent-custom" + (isCustom ? " on" : "")}
            title="커스텀 색 선택"
            style={isCustom ? { background: accent } : undefined}
          >
            <input type="color" value={accent} onChange={(e) => onAccent(e.target.value)} />
            <span className="accent-check">{isCustom ? "✓" : "＋"}</span>
          </label>
        </div>
        <SettingsDescription summary={t("강조색을 바로 적용하고 다음 접속에도 유지합니다.")} />
      </section>

      <section className="settings-section">
        <h4>{t("언어 · Language")}</h4>
        <div className="lang-toggle">
          <button className={lang === "ko" ? "on" : ""} onClick={() => onLang("ko")}>
            한글
          </button>
          <button className={lang === "en" ? "on" : ""} onClick={() => onLang("en")}>
            English
          </button>
        </div>
        <SettingsDescription summary={t("화면 언어를 선택하고 자동 저장합니다.")}>
          <p>{t("영어 UI 번역은 순차적으로 적용되고 있습니다.")}</p>
        </SettingsDescription>
      </section>

      <section className="settings-section">
        <h4>{t("모션")}</h4>
        <div className="lang-toggle">
          <button className={!reduceMotion ? "on" : ""} onClick={() => onReduceMotion(false)}>
            ON
          </button>
          <button className={reduceMotion ? "on" : ""} onClick={() => onReduceMotion(true)}>
            OFF
          </button>
        </div>
        <SettingsDescription summary={t("카드 장식 애니메이션을 켜거나 끕니다.")}>
          <p>{t("ON은 최종 카드의 흐르는 빛을 재생하고, OFF는 장식 움직임을 멈춥니다.")}</p>
        </SettingsDescription>
      </section>
    </>
  );
}

export function DownloadLocationSection({
  dlDir,
  dlErr,
  onPickDir,
  onClearDir,
}: {
  dlDir: string | null;
  dlErr: string;
  onPickDir: () => void;
  onClearDir: () => void;
}) {
  const t = useT();
  return (
    <section className="settings-section">
      <h4>{t("다운로드 위치")}</h4>
      {fsaSupported() ? (
        <>
          <div className="settings-row">
            <button className="settings-action" onClick={onPickDir}>
              📁 {dlDir ? t("다운로드 폴더 위치 변경") : t("다운로드 폴더 위치 선택")}
            </button>
            {dlDir && (
              <button className="settings-action ghost" onClick={onClearDir}>
                {t("해제")}
              </button>
            )}
          </div>
          <SettingsDescription
            summary={
              dlDir
                ? `${t("선택된 폴더")}: ${dlDir}`
                : t("다운로드할 기본 폴더를 선택합니다.")
            }
          >
            <p>
              {dlDir
                ? t("다운로드 파일을 선택한 폴더에 바로 저장합니다.")
                : t("폴더를 정하지 않으면 브라우저의 기본 다운로드 위치를 사용합니다.")}
            </p>
          </SettingsDescription>
        </>
      ) : (
        <SettingsDescription summary={t("현재 접속에서는 다운로드 폴더를 직접 지정할 수 없습니다.")}>
          <p>{t("localhost 또는 HTTPS로 접속하거나 브라우저 다운로드 설정을 사용하세요.")}</p>
        </SettingsDescription>
      )}
      {dlErr && <p className="settings-hint" style={{ color: "#f5a623" }}>{dlErr}</p>}
    </section>
  );
}

export function MetadataContinuitySection({
  dbBusy,
  dbMsg,
  backupContinuity,
  serverBackups,
  serverBackupsLoading,
  metadataSyncTarget,
  metadataSyncTargetState,
  onSyncMetadata,
  onLoadServerBackups,
  onServerRestore,
  onImportDb,
}: {
  dbBusy: boolean;
  dbMsg: string;
  backupContinuity: BackupContinuityStatus | null;
  serverBackups: ServerBackupVersion[] | null;
  serverBackupsLoading: boolean;
  metadataSyncTarget: ServerBackupVersion | null;
  metadataSyncTargetState: "loading" | "ready" | "empty" | "error";
  onSyncMetadata: () => void;
  onLoadServerBackups: () => void;
  onServerRestore: (backup: ServerBackupVersion) => void;
  onImportDb: (file: File | null | undefined) => void;
}) {
  const t = useT();
  const stateLabels: Record<string, string> = {
    waiting_for_backup: "첫 자동 백업 대기",
    waiting_for_data: "작업 데이터 대기",
    pending: "전송 대기",
    uploading: "전송 중",
    success: "정상",
    login_required: "로그인 대기",
    failed: "재시도 대기",
    server_update_required: "서버 업데이트 필요",
  };
  const shared = backupContinuity?.shared;
  const lastSuccess = shared?.last_success_at
    ? new Date(shared.last_success_at).toLocaleString()
    : "아직 없음";
  const formatBytes = (size: number) =>
    size >= 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  const syncTargetText = metadataSyncTargetState === "loading"
    ? "동기화 대상 확인 중…"
    : metadataSyncTargetState === "error"
      ? "동기화 대상을 확인하지 못했습니다."
      : metadataSyncTargetState === "empty" || !metadataSyncTarget
        ? "동기화할 서버 메타데이터가 없습니다."
        : `동기화 대상: ${metadataSyncTarget.device?.device_name || "알 수 없는 PC"} · ${
          metadataSyncTarget.created_at
            ? new Date(metadataSyncTarget.created_at).toLocaleString()
            : new Date(metadataSyncTarget.mtime * 1000).toLocaleString()
        } · 앱 ${metadataSyncTarget.app_version || "—"}`;
  return (
    <section className="settings-section">
      <h4>{t("메타데이터")}</h4>
      <div className="settings-row">
        <button
          className="settings-action metadata-sync-primary"
          onClick={onSyncMetadata}
          disabled={dbBusy || serverBackupsLoading}
        >
          {dbBusy ? "동기화 중…" : serverBackupsLoading ? "확인 중…" : "🔄 메타데이터 동기화"}
        </button>
      </div>
      {/* 실시간 정보(동기화 대상·백업 상태)는 접기 밖 캡션에 상시 표시(Jay 규칙). */}
      <SettingsDescription
        summary={
          <>
            {syncTargetText}
            <br />
            <span aria-live="polite">
              로컬 백업 <b>{backupContinuity?.local.set_count ?? "—"}세트</b>
              {backupContinuity?.local.latest_file_count
                ? ` · 최신 ${backupContinuity.local.latest_file_count}개 DB 구성`
                : ""}
              {" · "}공유 서버 <b>{shared ? (stateLabels[shared.state] || shared.state) : "확인 중"}</b>
              {shared?.pending ? ` · 대기 ${shared.pending}건` : ""}
              {shared ? ` · 마지막 성공 ${lastSuccess}` : ""}
            </span>
          </>
        }
      >
        <p>{t("자동 백업은 서버로 올리기만 하며 로컬 작업을 자동으로 덮어쓰지 않습니다.")}</p>
        <p>{t("동기화 전 백업 날짜와 PC를 확인하며, 적용 전 현재 DB를 안전하게 보관합니다.")}</p>
        <button className="settings-action ghost" onClick={onLoadServerBackups} disabled={dbBusy || serverBackupsLoading}>
          {serverBackupsLoading ? "확인 중…" : serverBackups === null ? "백업 버전 선택" : "백업 목록 닫기"}
        </button>
        {serverBackups !== null && (
          <div className="metadata-backup-list" aria-label="서버 메타데이터 백업 목록">
            {serverBackups.length === 0 ? (
              <p className="metadata-backup-empty">적용할 서버 백업이 없습니다.</p>
            ) : (
              serverBackups.map((backup) => {
                const summary = backup.summary || {};
                const created = backup.created_at
                  ? new Date(backup.created_at).toLocaleString()
                  : new Date(backup.mtime * 1000).toLocaleString();
                const label = backup.is_current
                  ? "현재"
                  : backup.branch_status === "conflict"
                    ? "다른 PC 버전"
                    : "이전";
                return (
                  <article className="metadata-backup-item" key={backup.backup_set_id || backup.name}>
                    <div className="metadata-backup-main">
                      <div>
                        <b>{backup.device?.device_name || "알 수 없는 PC"}</b>
                        <span className={`metadata-backup-badge is-${backup.branch_status || "history"}`}>
                          {label}
                        </span>
                      </div>
                      <span>{created} · {formatBytes(backup.size)} · 앱 {backup.app_version || "—"}</span>
                      <span>
                        생성물 {summary.generations ?? 0} · 태그 {summary.tags ?? 0} · 캔버스 {summary.canvases ?? 0}
                        {` · 에셋 ${summary.assets ?? 0}`}
                      </span>
                    </div>
                    <button
                      className="settings-action"
                      onClick={() => onServerRestore(backup)}
                      disabled={dbBusy}
                    >
                      이 데이터 적용
                    </button>
                  </article>
                );
              })
            )}
          </div>
        )}
        <details className="settings-details">
          <summary style={{ cursor: "pointer" }}>서버 없이 파일로 직접 주고받기 (고급)</summary>
          <a className="settings-action" href="/api/db/export" download="MV-hub-mydb.db">
            ⬆ 내 DB 내보내기
          </a>
          <label className={"settings-action" + (dbBusy ? " is-busy" : "")}>
            {dbBusy ? "가져오는 중…" : "⬇ DB 가져오기 (통째 교체)"}
            <input
              type="file"
              accept=".db,application/octet-stream"
              style={{ display: "none" }}
              disabled={dbBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                onImportDb(file);
              }}
            />
          </label>
          <p>
            ⚠️ 가져오기는 <b>현재 로컬 DB를 통째로 덮어씁니다</b>(현재 DB는 자동 백업). 보통
            작업자=1PC라 한 번에 한 PC에서만 쓰세요.
          </p>
        </details>
      </SettingsDescription>
      {dbMsg && <p className="manage-msg">{dbMsg}</p>}
    </section>
  );
}

export function ResolveScriptSettingsSection({
  status,
  connection,
  diagnostics,
  connectionBusy,
  busy,
  msg,
  onInstall,
  onRefreshConnection,
}: {
  status: ResolveScriptStatus | null;
  connection: ResolveConnectionStatus | null;
  diagnostics: ResolveEnvironmentDiagnostics | null;
  connectionBusy: boolean;
  busy: boolean;
  msg: string;
  onInstall: () => void;
  onRefreshConnection: () => void;
}) {
  const [pythonInstallBusy, setPythonInstallBusy] = useState(false);
  const [pythonInstallMsg, setPythonInstallMsg] = useState("");
  const handlePythonInstall = async () => {
    setPythonInstallBusy(true);
    setPythonInstallMsg("공식 설치 파일을 준비하는 중… (최초 1회 약 25MB 다운로드)");
    try {
      const result = await startResolvePythonInstall();
      setPythonInstallMsg(result.message);
    } catch (error) {
      const known = error as { detail?: string; message?: string };
      setPythonInstallMsg(known.detail || known.message || "Python 설치를 시작하지 못했습니다.");
    } finally {
      setPythonInstallBusy(false);
    }
  };
  const activeInstallation = status?.installations?.find((installation) => installation.installed);
  const exporterCurrent = activeInstallation?.installed_version || status?.installed_version;
  const importerCurrent = activeInstallation?.importer_version;
  const exporterBundled = status?.bundled_version;
  const importerBundled = status?.importer_bundled_version;
  const currentVersions = `내보내기 ${exporterCurrent ? `v${exporterCurrent}` : "미설치"} · 가져오기 ${importerCurrent ? `v${importerCurrent}` : "미설치"}`;
  const bundledVersions = `내보내기 ${exporterBundled ? `v${exporterBundled}` : "확인 불가"} · 가져오기 ${importerBundled ? `v${importerBundled}` : "확인 불가"}`;
  const versionChanges = [
    exporterCurrent !== exporterBundled
      ? `내보내기 ${exporterCurrent ? `v${exporterCurrent}` : "미설치"} → ${exporterBundled ? `v${exporterBundled}` : "확인 불가"}`
      : "",
    importerCurrent !== importerBundled
      ? `가져오기 ${importerCurrent ? `v${importerCurrent}` : "미설치"} → ${importerBundled ? `v${importerBundled}` : "확인 불가"}`
      : "",
  ].filter(Boolean).join(" · ");
  const stateText = status
    ? status.up_to_date
      ? `Resolve 도구 2개 설치됨 · ${bundledVersions}`
      : status.installed
        ? `Resolve 도구 업데이트 필요 · ${versionChanges || `${currentVersions} · 최신 파일로 교체 필요`}`
        : "Resolve 가져오기·내보내기 도구가 아직 설치되지 않았습니다."
    : "설치 상태를 확인하는 중…";
  // 연결 상태·확인된 프로그램은 접기 밖 캡션에 상시 표시(Jay 요청 — 업데이트 섹션과 같은 패턴).
  const connectionLine = connectionBusy
    ? "연결 상태: 확인하는 중…"
    : connection
      ? `연결 상태: ${connection.message || "확인하지 못했습니다"}`
      : null;
  const programLine =
    !connectionBusy && connection?.connected && connection.resolve_version
      ? `확인된 프로그램: ${connection.resolve_product || "DaVinci Resolve"} ${connection.resolve_version}`
      : null;
  return (
    <section className="settings-section">
      <h4>DaVinci Resolve</h4>
      <div className="settings-row">
        <button className="settings-action" onClick={onRefreshConnection} disabled={connectionBusy}>
          ◆ {connectionBusy ? "진단 중…" : "Resolve 진단"}
        </button>
        <button className="settings-action" onClick={onInstall} disabled={busy}>
          ◆ {busy ? "설치 중…" : "Script 설치"}
        </button>
      </div>
      <SettingsDescription
        summary={
          connectionLine ? (
            <>
              {connectionLine}
              {programLine && (
                <>
                  <br />
                  {programLine}
                </>
              )}
            </>
          ) : (
            "Resolve 연결을 확인하고 도구를 설치합니다."
          )
        }
      >
        {diagnostics && (
          <div className={`resolve-diagnostics is-${diagnostics.status}`}>
            <p className="resolve-diagnostics-summary">{diagnostics.summary}</p>
            <div className="resolve-diagnostics-list">
              {diagnostics.checks.map((check) => (
                <div className="resolve-diagnostic-row" key={check.key}>
                  <span className={`resolve-diagnostic-state is-${check.state}`} aria-hidden="true" />
                  <span className="resolve-diagnostic-label">{check.label}</span>
                  <span className="resolve-diagnostic-message" title={check.detail || undefined}>
                    {check.message}
                  </span>
                </div>
              ))}
            </div>
            {!!diagnostics.recommendations.length && (
              <ul className="resolve-diagnostics-actions">
                {diagnostics.recommendations.map((recommendation) => (
                  <li key={recommendation}>{recommendation}</li>
                ))}
              </ul>
            )}
            {diagnostics.connection.status === "python_incompatible" && (
              <div className="resolve-python-install">
                <button
                  className="settings-action"
                  onClick={handlePythonInstall}
                  disabled={pythonInstallBusy}
                >
                  ◆ {pythonInstallBusy ? "설치 준비 중…" : "Python 자동 설치"}
                </button>
                {pythonInstallMsg && (
                  <p className="resolve-python-install-msg">{pythonInstallMsg}</p>
                )}
              </div>
            )}
            <details className="resolve-diagnostics-details">
              <summary>진단 상세 경로</summary>
              <p>Windows 계정 · {diagnostics.environment.windows_user}</p>
              <p>
                MV Hub Python · {diagnostics.environment.mvhub_python.version} · {diagnostics.environment.mvhub_python.bits}비트
                <br />{diagnostics.environment.mvhub_python.path}
              </p>
              {!!diagnostics.environment.resolve_installations.length && (
                <p>Resolve · {diagnostics.environment.resolve_installations[0].executable}</p>
              )}
              {!!diagnostics.environment.api.existing_module_paths.length && (
                <p>API · {diagnostics.environment.api.existing_module_paths[0]}</p>
              )}
              {diagnostics.environment.api.library_path && (
                <p>DLL · {diagnostics.environment.api.library_path}</p>
              )}
            </details>
          </div>
        )}
        <p>{msg || stateText}</p>
        {status?.installations?.length
          ? status.installations.map((installation) => (
              <p key={installation.scope} className="resolve-script-path" title={installation.path}>
                {installation.scope === "all_users" ? "모든 사용자" : "현재 사용자"}: {" "}
                {installation.up_to_date
                  ? "가져오기·내보내기 설치됨"
                  : installation.installed
                    ? "업데이트 필요"
                    : "설치 안 됨"}
                {" · "}{installation.path}
                {installation.importer_path && (
                  <><br />가져오기 도구 · {installation.importer_path}</>
                )}
              </p>
            ))
          : status?.path && (
              <p className="resolve-script-path" title={status.path}>{status.path}</p>
            )}
        {!!status?.warnings?.length && <p>설치 참고: {status.warnings[0]}</p>}
        <p>
          설치 후 Resolve를 완전히 종료했다가 다시 실행하세요. 자동 연결은 Resolve 환경설정의
          External scripting using을 Local로 설정해야 합니다.
        </p>
      </SettingsDescription>
    </section>
  );
}

export function ReleaseUpdateSettingsSection({
  status,
  busy,
  msg,
  onRefresh,
  onUpdate,
}: {
  status: ReleaseUpdateStatus | null;
  busy: boolean;
  msg: string;
  onRefresh: () => void;
  onUpdate: () => void;
}) {
  const running = busy || isReleaseUpdateRunning(status?.state);
  const releaseInstall = status?.install_mode === "release";
  const active = status?.active_total || 0;
  const resolveActive = status?.resolve_active || 0;
  const generationActive = Math.max(0, active - resolveActive);
  // 유료 생성·Comfy 와 Resolve 전송을 나눠 말한다 — 둘 다 업데이트(프로세스 교체)를 막는다.
  const busyText = [
    generationActive > 0 ? `생성 ${generationActive}건` : "",
    resolveActive > 0 ? `Resolve 전송 ${resolveActive}건` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // 실행기(bat)가 기록하는 전체 진행률 — 버튼·문구에 함께 보여 멈춘 건지 진행 중인지 구분되게.
  const pct = typeof status?.percent === "number" ? Math.min(100, status.percent) : null;
  const pctText = running && pct !== null ? ` ${pct}%` : "";
  const updateAvailable = Boolean(
    status?.latest_version && status.latest_version !== status.current_version,
  );
  const versionText = status
    ? updateAvailable
      ? `현재 ${status.current_version || "미확인"} → 새 버전 ${status.latest_version}`
      : `현재 버전 ${status.current_version || "미확인"}`
    : "버전을 확인하는 중…";
  const actionText = running
    ? status?.state === "restarting"
      ? `프로그램 다시 시작 중…${pctText}`
      : `업데이트 중…${pctText}`
    : !releaseInstall
      ? "업데이트"
      : active > 0
      ? `${busyText} 완료 후 업데이트`
      : status?.can_update
        ? "프로그램 업데이트"
        : "최신 버전";

  return (
    <section className="settings-section">
      <h4>프로그램 업데이트</h4>
      <div className="settings-row">
        <button
          className={
            "settings-action release-update-action" +
            (status?.can_update ? " is-update-available" : "") +
            (running ? " is-busy" : "")
          }
          onClick={onUpdate}
          disabled={!status?.can_update || running || active > 0}
        >
          ↻ {actionText}
        </button>
        <button className="settings-action ghost" onClick={onRefresh} disabled={running}>
          다시 확인
        </button>
      </div>
      {/* 실시간 정보(버전·진행 메시지·대기 경고)는 접기 밖 캡션에 상시 표시(Jay 규칙). */}
      <SettingsDescription
        summary={
          <>
            {versionText}
            {(msg || releaseUpdateMessage(status)) && (
              <>
                <br />
                {msg || releaseUpdateMessage(status)}
              </>
            )}
            {releaseInstall && active > 0 && (
              <>
                <br />
                <span style={{ color: "#f5a623" }}>
                  유료 생성 또는 Comfy 작업이 끝나기 전에는 업데이트하지 않습니다.
                </span>
              </>
            )}
          </>
        }
      >
        <p>
          {releaseInstall
            ? "검증된 릴리스를 설치한 뒤 MV Hub를 자동으로 다시 시작합니다. 작업 파일과 로컬 DB는 유지됩니다."
            : "공유 서버 설치본은 update_git.bat으로 업데이트합니다."}
        </p>
      </SettingsDescription>
    </section>
  );
}

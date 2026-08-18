import { ACCENT_PRESETS, type Lang } from "../../lib/theme";
import { fsaSupported } from "../../lib/downloadDir";
import { useT } from "../../lib/i18n";
import type { BackupContinuityStatus } from "../../lib/assetsApi";
import type { ResolveConnectionStatus, ResolveScriptStatus } from "../../lib/resolveTransfer";
import {
  isReleaseUpdateRunning,
  releaseUpdateMessage,
  type ReleaseUpdateStatus,
} from "../../lib/releaseUpdate";

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
        <p className="settings-hint">{t("선택 즉시 적용되고 다음 접속에도 유지됩니다.")}</p>
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
        <p className="settings-hint">
          {t("선택은 저장됩니다. 영어 UI 번역은 순차 적용 예정입니다.")}
        </p>
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
        <p className="settings-hint">
          {t("ON이면 최종(골드) 카드의 흐르는 빛 같은 장식 애니메이션이 재생되고, OFF면 멈춥니다.")}
        </p>
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
              📁 {dlDir ? t("폴더 변경") : t("폴더 선택")}
            </button>
            {dlDir && (
              <button className="settings-action ghost" onClick={onClearDir}>
                {t("해제")}
              </button>
            )}
          </div>
          <p className="settings-hint">
            {dlDir
              ? `${t("저장 위치")}: ${dlDir} — ${t("이제 다운로드가 묻지 않고 이 폴더에 바로 저장됩니다.")}`
              : t("폴더를 지정하면 다운로드 때마다 묻지 않고 그 폴더에 바로 저장됩니다(미지정 시 브라우저 기본).")}
          </p>
        </>
      ) : (
        <p className="settings-hint">
          {t("이 접속에서는 폴더 자동저장을 쓸 수 없습니다(localhost 또는 HTTPS 필요). 브라우저 다운로드 설정을 사용하세요.")}
        </p>
      )}
      {dlErr && <p className="settings-hint" style={{ color: "#f5a623" }}>{dlErr}</p>}
    </section>
  );
}

export function BackfillSettingsSection({
  uploading,
  msg,
  onDownloadBackfill,
  onBackfillFile,
}: {
  uploading: boolean;
  msg: string;
  onDownloadBackfill: () => void;
  onBackfillFile: (file: File | null | undefined) => void;
}) {
  const t = useT();
  return (
    <section className="settings-section">
      <h4>{t("과거 생성물 가져오기")}</h4>
      <p className="settings-hint">
        허브에서 만든 결과물과 최신분은 <b>자동으로</b> 올라갑니다. 여기서는 CLI가 못 가져오는{" "}
        <b>100건 밖 과거 전체</b>만 보충합니다.
      </p>
      <div className="settings-row">
        <button className="settings-action" onClick={onDownloadBackfill}>
          ① ⬇ History 지시문 .md 받기
        </button>
        <label className={"settings-action" + (uploading ? " is-busy" : "")}>
          {uploading ? "적재 중…" : "② ⬆ 만든 파일 올려서 적용"}
          <input
            type="file"
            accept=".json,.jsonl,.txt,application/json"
            style={{ display: "none" }}
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              onBackfillFile(file);
            }}
          />
        </label>
      </div>
      <p className="settings-hint">
        <b>①</b> 받은 <b>.md</b>를 <b>힉스필드 MCP가 붙은 Claude</b>에 주면 전체 이력을{" "}
        <b>파일</b>로 만들어 줍니다(허브 접속·명령어 불필요).{" "}
        <b>②</b> Claude가 만든 <b>JSON/JSONL 파일</b>을 올리면 멱등으로 적재됩니다(중복 안 생김).
      </p>
      {msg && <p className="manage-msg">{msg}</p>}
    </section>
  );
}

export function MetadataContinuitySection({
  dbBusy,
  dbMsg,
  backupContinuity,
  onServerBackup,
  onRetryServerBackup,
  onServerRestore,
  onImportDb,
}: {
  dbBusy: boolean;
  dbMsg: string;
  backupContinuity: BackupContinuityStatus | null;
  onServerBackup: () => void;
  onRetryServerBackup: () => void;
  onServerRestore: () => void;
  onImportDb: (file: File | null | undefined) => void;
}) {
  const t = useT();
  const stateLabels: Record<string, string> = {
    waiting_for_backup: "첫 자동 백업 대기",
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
  return (
    <section className="settings-section">
      <h4>{t("내 메타데이터 (작업 연속성)")}</h4>
      <p className="settings-hint">
        내 라이브러리·태그·컬러·계보가 담긴 <b>로컬 DB</b>를 <b>서버에 백업</b>해두고, 다른
        PC에서 내 계정으로 로그인해 <b>서버에서 가져오기</b>로 그대로 이어 작업합니다(계정별 보관).
      </p>
      <div className="settings-row">
        <button className="settings-action" onClick={onServerBackup} disabled={dbBusy}>
          ☁ 서버에 백업
        </button>
        <button className="settings-action" onClick={onServerRestore} disabled={dbBusy}>
          ⬇ 서버에서 가져오기
        </button>
        {shared && shared.state !== "success" && shared.state !== "waiting_for_backup" && (
          <button className="settings-action" onClick={onRetryServerBackup} disabled={dbBusy}>
            다시 시도
          </button>
        )}
      </div>
      <p className="settings-hint" aria-live="polite">
        로컬 백업 <b>{backupContinuity?.local.set_count ?? "—"}세트</b>
        {backupContinuity?.local.latest_file_count
          ? ` · 최신 ${backupContinuity.local.latest_file_count}개 DB 구성`
          : ""}
        {" · "}공유 서버 <b>{shared ? (stateLabels[shared.state] || shared.state) : "확인 중"}</b>
        {shared?.pending ? ` · 대기 ${shared.pending}건` : ""}
        {shared ? ` · 마지막 성공 ${lastSuccess}` : ""}
      </p>
      <p className="settings-hint">
        백업은 <b>내 계정으로만</b> 저장·복원됩니다(남의 백업은 안 보임). 토큰 등 민감정보는
        올리기 전에 제거되며, 가져오기는 현재 로컬 DB를 통째 교체(자동 백업) 후 재로그인합니다.
      </p>
      <details className="settings-details">
        <summary className="settings-hint" style={{ cursor: "pointer" }}>
          서버 없이 파일로 직접 주고받기 (고급)
        </summary>
        <a className="settings-action" href="/api/db/export" download="MV-hub-mydb.db">
          ⬇ 내 DB 내보내기
        </a>
        <label className={"settings-action" + (dbBusy ? " is-busy" : "")}>
          {dbBusy ? "가져오는 중…" : "⬆ DB 가져오기 (통째 교체)"}
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
        <p className="settings-hint">
          ⚠️ 가져오기는 <b>현재 로컬 DB를 통째로 덮어씁니다</b>(현재 DB는 자동 백업). 보통
          작업자=1PC라 한 번에 한 PC에서만 쓰세요.
        </p>
      </details>
      {dbMsg && <p className="manage-msg">{dbMsg}</p>}
    </section>
  );
}

export function SyncToolsSection({
  syncMsg,
  hfMsg,
  onSyncMine,
  onReviewHfDeleted,
}: {
  syncMsg: string;
  hfMsg: string;
  onSyncMine: () => void;
  onReviewHfDeleted: () => void;
}) {
  const t = useT();
  return (
    <section className="settings-section">
      <h4>{t("동기화 · 점검")}</h4>
      <p className="settings-hint">
        허브에서 만든 결과물·최신분은 <b>자동</b>으로 올라갑니다. 아래는 수동 동기화·점검용입니다.
      </p>
      <div className="settings-row">
        <button className="settings-action" onClick={onSyncMine} disabled={!!syncMsg}>
          📤 {syncMsg || "외부 생성물 올리기"}
        </button>
        <button className="settings-action" onClick={onReviewHfDeleted} disabled={!!hfMsg}>
          🗑 {hfMsg || "힉스필드 삭제물 검토"}
        </button>
      </div>
      <p className="settings-hint">
        <b>외부 생성물 올리기</b> — 허브 밖(Claude·웹·CLI)에서 만든 결과물을 지금 올립니다.{" "}
        <b>힉스필드 삭제물 검토</b> — 힉스필드에서 지워진 내 생성물을 찾아 휴지통으로 보냅니다.
      </p>
    </section>
  );
}

export function ResolveScriptSettingsSection({
  status,
  connection,
  connectionBusy,
  busy,
  msg,
  onInstall,
  onRefreshConnection,
}: {
  status: ResolveScriptStatus | null;
  connection: ResolveConnectionStatus | null;
  connectionBusy: boolean;
  busy: boolean;
  msg: string;
  onInstall: () => void;
  onRefreshConnection: () => void;
}) {
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
  return (
    <section className="settings-section">
      <h4>DaVinci Resolve</h4>
      <div className="settings-row">
        <button className="settings-action" onClick={onRefreshConnection} disabled={connectionBusy}>
          ◆ {connectionBusy ? "연결 확인 중…" : "Resolve 연결 다시 확인"}
        </button>
        <button className="settings-action" onClick={onInstall} disabled={busy}>
          ◆ {busy ? "설치 중…" : "Resolve 스크립트 설치"}
        </button>
      </div>
      <p className="settings-hint">
        연결 상태: {connectionBusy ? "확인하는 중…" : connection?.message || "확인하지 못했습니다"}
      </p>
      {!connectionBusy && connection?.connected && connection.resolve_version && (
        <p className="settings-hint">
          확인된 프로그램: {connection.resolve_product || "DaVinci Resolve"} {connection.resolve_version}
        </p>
      )}
      <p className="settings-hint">{msg || stateText}</p>
      {status?.installations?.length
        ? status.installations.map((installation) => (
            <p
              key={installation.scope}
              className="settings-hint resolve-script-path"
              title={installation.path}
            >
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
            <p className="settings-hint resolve-script-path" title={status.path}>
              {status.path}
            </p>
          )}
      {!!status?.warnings?.length && (
        <p className="settings-hint">설치 참고: {status.warnings[0]}</p>
      )}
      <p className="settings-hint">
        설치 또는 업데이트 후 Resolve를 완전히 종료했다가 다시 실행하세요. 자동 연결은 Resolve 환경설정
        → 시스템 → 일반 → External scripting using이 Local이어야 합니다. 자동 연결이 지원되지 않는
        환경에서도 작업 공간 → 스크립트 → MV Hub → MVHub Importer를 누르면 준비된 원본을 직접
        가져올 수 있습니다.
      </p>
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
  // 실행기(bat)가 기록하는 전체 진행률 — 버튼·문구에 함께 보여 멈춘 건지 진행 중인지 구분되게.
  const pct = typeof status?.percent === "number" ? Math.min(100, status.percent) : null;
  const pctText = running && pct !== null ? ` ${pct}%` : "";
  const versionText = status
    ? status.latest_version && status.latest_version !== status.current_version
      ? `현재 ${status.current_version || "미확인"} → 새 버전 ${status.latest_version}`
      : `현재 버전 ${status.current_version || "미확인"}`
    : "버전을 확인하는 중…";
  const actionText = running
    ? status?.state === "restarting"
      ? `프로그램 다시 시작 중…${pctText}`
      : `업데이트 중…${pctText}`
    : !releaseInstall
      ? "작업자 설치본 전용"
      : active > 0
      ? `생성 ${active}건 완료 후 업데이트`
      : status?.can_update
        ? "프로그램 업데이트"
        : "최신 버전";

  return (
    <section className="settings-section">
      <h4>프로그램 업데이트</h4>
      <div className="settings-row">
        <button
          className={"settings-action" + (running ? " is-busy" : "")}
          onClick={onUpdate}
          disabled={!status?.can_update || running || active > 0}
        >
          ↻ {actionText}
        </button>
        <button className="settings-action ghost" onClick={onRefresh} disabled={running}>
          다시 확인
        </button>
      </div>
      <p className="settings-hint">{versionText}</p>
      <p className="settings-hint">
        {msg || releaseUpdateMessage(status) || "릴리스 서버를 확인하고 있습니다."}
      </p>
      {releaseInstall && active > 0 && (
        <p className="settings-hint" style={{ color: "#f5a623" }}>
          유료 생성 또는 Comfy 작업이 끝나기 전에는 업데이트하지 않습니다.
        </p>
      )}
      {releaseInstall && (
        <p className="settings-hint">
          업데이트하면 검증된 릴리스를 설치하고 MV Hub를 자동으로 다시 시작합니다. 작업 파일과
          로컬 DB는 건드리지 않습니다.
        </p>
      )}
    </section>
  );
}

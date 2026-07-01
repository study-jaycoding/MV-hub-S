import { ACCENT_PRESETS, type Lang } from "../../lib/theme";
import { fsaSupported } from "../../lib/downloadDir";
import { useT } from "../../lib/i18n";

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
  onServerBackup,
  onServerRestore,
  onImportDb,
}: {
  dbBusy: boolean;
  dbMsg: string;
  onServerBackup: () => void;
  onServerRestore: () => void;
  onImportDb: (file: File | null | undefined) => void;
}) {
  const t = useT();
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
      </div>
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

// 설정 — AccountMenu의 "⚙ 설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
//  · 단축키(변경은 별도 플로팅 창 ShortcutsWindow)
//  · 과거 생성물 가져오기(100건 밖 과거 전체를 MCP 백필 .md→파일 업로드로 서버에 적재)
import { useEffect, useState } from "react";
import {
  ACCENT_PRESETS,
  loadAccent,
  saveAccent,
  loadLang,
  loadReduceMotion,
  saveReduceMotion,
  type Lang,
} from "../lib/theme";
import { setLang, useT } from "../lib/i18n";
import { downloadText } from "../lib/download";
import { api } from "../api";
import { ShortcutsWindow } from "./ShortcutsWindow";

// 업로드 파일 → MCP 아이템 배열. JSON 배열 / {items|generations|data:[...]} / JSONL(줄마다 객체) 허용.
//  (backfill_import.py load_items + JSONL 폴백과 동일 규칙 — 통째 JSON 먼저, 실패 시 줄단위.)
function parseMcpItems(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  try {
    const d = JSON.parse(t);
    if (Array.isArray(d)) return d.filter((x) => x && typeof x === "object");
    if (d && typeof d === "object") {
      for (const k of ["items", "generations", "data"]) {
        const arr = (d as Record<string, unknown>)[k];
        if (Array.isArray(arr)) return arr.filter((x) => x && typeof x === "object");
      }
    }
  } catch {
    /* JSONL 폴백 */
  }
  const out: Record<string, unknown>[] = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === "object") out.push(o);
    } catch {
      /* 불량 줄 건너뜀 */
    }
  }
  return out;
}

export function SettingsPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useT();
  const [accent, setAccent] = useState(loadAccent());
  const isCustom = !ACCENT_PRESETS.some(
    (p) => p.hex.toLowerCase() === accent.toLowerCase(),
  );
  const [lang, setLangState] = useState<Lang>(loadLang());
  const [reduceMotion, setReduceMotion] = useState(loadReduceMotion());
  const [msg, setMsg] = useState("");
  const [uploading, setUploading] = useState(false); // 백필 파일 업로드 적재 중
  const [scOpen, setScOpen] = useState(false); // 단축키 변경 플로팅 창
  const [dbBusy, setDbBusy] = useState(false); // 내 DB 가져오기 중
  const [dbMsg, setDbMsg] = useState("");

  // 과거 전체(100건 밖) 백필 지시 — .md 문서로 받아 Claude 세션에 파일째 첨부해 주면 됨.
  //  서버 코드·DB 접근 없이 허브 로그인만으로 /api/ingest/mcp 에 직접 적재(멱등). origin·이메일 자동 주입.
  //  코드블록은 4칸 들여쓰기로 표현(백틱 없이) — 템플릿 리터럴 이스케이프 회피.
  const origin = window.location.origin;
  const backfillMd = `# History 전체 백필 — Claude가 파일로 만들기

힉스필드 MCP의 show_generations 로 내 생성 이력 전체를 끝까지 가져와 **한 파일로 저장**하세요.
그 파일을 허브에 업로드하면 끝입니다(허브가 멱등 적재).
**허브에 직접 접속·POST 할 필요 없습니다 — 파일만 만들면 됩니다.** (허브 주소: ${origin})

## 할 일
1. show_generations 를 next_cursor 가 없어질 때까지 끝까지 페이지네이션합니다.
2. 모든 페이지의 items 를 한 파일로 저장합니다(손타이핑 금지 — 코드로 덤프):
   - my_history.jsonl  (한 줄에 아이템 1개)   또는
   - my_history.json   (아이템 배열 [ ... ])
3. 허브 웹에서 설정 > "과거 생성물 가져오기" > "② 만든 파일 올려서 적용" 에 그 파일을 업로드합니다. 끝.

## 저장할 아이템 키 (이대로 담으면 출처까지 보존됨)
       {
         "id":        "<job id>",            // 필수 · 멱등 키
         "status":    "completed",
         "model":     "<job_set_type>",
         "createdAt": "<ISO 시각>",
         "results":   { "rawUrl": "<결과 미디어 URL>" },
         "params":    { "prompt": "<프롬프트>",
                        "input_images": [ { "role": "@image", "url": "<레퍼런스 URL>" } ] }
       }

- id 는 필수(멱등 키). results.rawUrl 의 user_<id> 로 '내 작업' 귀속이 정해집니다.
- 프롬프트/레퍼런스 출처는 params.prompt / params.input_images 로 보존됩니다.

## ⚠️ 프롬프트/파라미터 누락 주의
show_generations 가 id/type/status/model/url/createdAt 만 주고 prompt·params 를 빼는 경우가 있습니다.
이 허브의 최우선 가치는 '출처(프롬프트·레퍼런스) 보존'이라, 비면 재사용·변형이 약해집니다.
- 가능하면 각 항목을 풍부화해 params.prompt / params.input_images 를 채워 저장하세요.
- 당장 어려우면 메타만 먼저 저장·업로드하고, 나중에 같은 id 로 프롬프트를 보강해 다시 업로드하면 멱등으로 덮어써집니다.

## 참고
- CLI(generate list)는 최신 100건까지만 — 100건 밖 과거 전체는 이 백필로만 채워집니다.
- 멱등이라 같은 파일을 또 올려도 중복이 안 생깁니다.
`;
  const downloadBackfillMd = () => {
    downloadText("MV_history_backfill.md", backfillMd, "text/markdown");
    setMsg("MV_history_backfill.md 를 받았습니다. 힉스필드 MCP가 연결된 Claude 세션에 이 파일을 주면 결과 파일을 만들어 줍니다.");
  };
  // 업로드 경로 — Claude가 만든 JSON/JSONL 파일을 받아 웹 세션으로 /api/ingest/mcp 에 200건씩 배치 적재(멱등).
  const onBackfillFile = async (file: File | null | undefined) => {
    if (!file) return;
    setUploading(true);
    setMsg("파일 읽는 중…");
    try {
      const items = parseMcpItems(await file.text());
      if (!items.length) {
        setMsg("올린 파일에서 항목을 못 찾았습니다 (JSON 배열·{items:[...]}·JSONL 형식이어야 함).");
        return;
      }
      let inserted = 0,
        updated = 0,
        unchanged = 0,
        skipped = 0;
      const BATCH = 200;
      for (let i = 0; i < items.length; i += BATCH) {
        setMsg(`적재 중… ${Math.min(i + BATCH, items.length)}/${items.length}`);
        const r = await api.ingestMcp(items.slice(i, i + BATCH));
        inserted += r.inserted;
        updated += r.updated;
        unchanged += r.unchanged;
        skipped += r.skipped;
      }
      setMsg(
        `적재 완료 · 신규 ${inserted} · 갱신 ${updated} · 중복 ${unchanged} · 건너뜀 ${skipped}. 새로고침하면 보입니다.`,
      );
    } catch (e) {
      setMsg("적재 실패: " + String(e));
    } finally {
      setUploading(false);
    }
  };

  // 내 DB 가져오기(통째 교체) — 성공하면 라이브러리를 새로 읽도록 전체 새로고침.
  const importDb = async (file: File | null | undefined) => {
    if (!file) return;
    if (
      !window.confirm(
        "현재 로컬 DB를 이 파일로 통째 교체합니다. (현재 DB는 자동 백업)\n계속할까요?",
      )
    )
      return;
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

  // ☁ 서버에 백업 — 내 계정 DB 를 공유 서버에 올린다(계정별 보관).
  const serverBackup = async () => {
    setDbBusy(true);
    setDbMsg("서버에 백업 중…");
    try {
      const r = await api.serverBackup();
      setDbMsg(`✓ 서버에 백업 완료 (보관 ${r.count}개)`);
    } catch (e) {
      setDbMsg("백업 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  // ⬇ 서버에서 가져오기 — 서버의 내 최신 백업으로 로컬 DB 통째 교체(복원 후 재로그인).
  const serverRestore = async () => {
    if (
      !window.confirm(
        "서버에 백업해둔 내 계정 DB로 현재 로컬을 통째 교체합니다.\n(현재 DB는 자동 백업, 복원 후 재로그인)\n계속할까요?",
      )
    )
      return;
    setDbBusy(true);
    setDbMsg("서버에서 가져오는 중…");
    try {
      await api.serverRestore();
      setDbMsg("복원 완료 — 다시 로그인해 주세요…");
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setDbMsg("가져오기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickAccent = (hex: string) => {
    setAccent(hex);
    saveAccent(hex); // CSS 변수 즉시 갱신 + localStorage
  };
  const pickLang = (l: Lang) => {
    setLangState(l);
    setLang(l); // 즉시 UI 리렌더 + 영속(<html lang> 포함)
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
          {/* 강조색 팔레트 */}
          <section className="settings-section">
            <h4>{t("강조색")}</h4>
            <div className="accent-swatches">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={"accent-swatch" + (accent === p.hex ? " on" : "")}
                  style={{ background: p.hex }}
                  title={p.name}
                  onClick={() => pickAccent(p.hex)}
                >
                  {accent === p.hex && <span className="accent-check">✓</span>}
                </button>
              ))}
              {/* 커스텀 — OS 컬러 피커로 직접 선택. 프리셋에 없으면 이 칸이 현재 색. */}
              <label
                className={"accent-swatch accent-custom" + (isCustom ? " on" : "")}
                title="커스텀 색 선택"
                style={isCustom ? { background: accent } : undefined}
              >
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => pickAccent(e.target.value)}
                />
                <span className="accent-check">{isCustom ? "✓" : "＋"}</span>
              </label>
            </div>
            <p className="settings-hint">{t("선택 즉시 적용되고 다음 접속에도 유지됩니다.")}</p>
          </section>

          {/* 언어 — 강조색 바로 아래 */}
          <section className="settings-section">
            <h4>{t("언어 · Language")}</h4>
            <div className="lang-toggle">
              <button className={lang === "ko" ? "on" : ""} onClick={() => pickLang("ko")}>
                한글
              </button>
              <button className={lang === "en" ? "on" : ""} onClick={() => pickLang("en")}>
                English
              </button>
            </div>
            <p className="settings-hint">
              {t("선택은 저장됩니다. 영어 UI 번역은 순차 적용 예정입니다.")}
            </p>
          </section>

          {/* 모션(애니메이션) — 언어처럼 ON/OFF 버튼. ON=재생, OFF=정지(reduceMotion=true). */}
          <section className="settings-section">
            <h4>{t("모션")}</h4>
            <div className="lang-toggle">
              <button
                className={!reduceMotion ? "on" : ""}
                onClick={() => {
                  setReduceMotion(false);
                  saveReduceMotion(false); // 즉시 적용 + 영속
                }}
              >
                ON
              </button>
              <button
                className={reduceMotion ? "on" : ""}
                onClick={() => {
                  setReduceMotion(true);
                  saveReduceMotion(true);
                }}
              >
                OFF
              </button>
            </div>
            <p className="settings-hint">
              {t("ON이면 최종(골드) 카드의 흐르는 빛 같은 장식 애니메이션이 재생되고, OFF면 멈춥니다.")}
            </p>
          </section>

          {/* 단축키 — 변경은 별도 플로팅 창으로 */}
          <section className="settings-section">
            <h4>{t("단축키")}</h4>
            <button className="settings-action" onClick={() => setScOpen(true)}>
              ⌨ {t("단축키 설정")}
            </button>
            <p className="settings-hint">
              {t("지정된 단축키를 보고 원하는 키로 바꿀 수 있습니다.")}
            </p>
          </section>

          {/* 과거 생성물 가져오기(백필) — 단축키 아래. 허브 밖(MCP)에서 만든 과거 전체를 서버에 적재.
              ※ 허브 안 작업과 push_agent --watch 가 최신분은 자동으로 올리므로, 여기선 100건 밖 과거만. */}
          <section className="settings-section">
            <h4>{t("과거 생성물 가져오기")}</h4>
            <p className="settings-hint">
              허브에서 만든 결과물과 최신분은 <b>자동으로</b> 올라갑니다. 여기서는 CLI가 못 가져오는{" "}
              <b>100건 밖 과거 전체</b>만 보충합니다.
            </p>
            <div className="settings-row">
              <button className="settings-action" onClick={downloadBackfillMd}>
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
                    const f = e.target.files?.[0];
                    e.target.value = ""; // 같은 파일 재선택 가능하게 초기화
                    onBackfillFile(f);
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

          {/* 내 메타데이터(작업 연속성) — 로컬 DB 통째 내보내기/가져오기. 다른 PC에서 이어 작업. */}
          <section className="settings-section">
            <h4>{t("내 메타데이터 (작업 연속성)")}</h4>
            <p className="settings-hint">
              내 라이브러리·태그·컬러·계보가 담긴 <b>로컬 DB</b>를 <b>서버에 백업</b>해두고, 다른
              PC에서 내 계정으로 로그인해 <b>서버에서 가져오기</b>로 그대로 이어 작업합니다(계정별 보관).
            </p>
            <div className="settings-row">
              <button className="settings-action" onClick={serverBackup} disabled={dbBusy}>
                ☁ 서버에 백업
              </button>
              <button className="settings-action" onClick={serverRestore} disabled={dbBusy}>
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
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  importDb(f);
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
        </div>
      </div>

      {scOpen && <ShortcutsWindow onClose={() => setScOpen(false)} />}
    </>
  );
}

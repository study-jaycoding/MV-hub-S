// 설정 — ComfyUI 연결. 이 PC 로컬(또는 그 계정의 Comfy Cloud) 연결 정보를 저장하고 연결 확인.
// 캔버스 Comfy 노드가 이 설정으로 워크플로우를 실행한다. 저장은 app_setting(로컬 DB) — 재시작 불필요.
// 키 출처(팀 키 = 관리자가 서버에 등록한 comfy.org 키를 허브가 받아 씀 / 개인 키 = 이 PC 에 넣은 키) — docs/status/Comfy팀키_서버배포_2026-11-04.md
import { useEffect, useState } from "react";
import { comfyApi, type ComfySettings, type TeamKeyState } from "../../lib/comfyApi";
import { SettingsDescription } from "./SettingsDescription";

export const keySourceOf = (s: ComfySettings | null): "team" | "personal" => s?.comfy_key_source ?? "personal"; // 옛 허브 = 지금처럼 개인 키

export function hasUnsavedComfySettings(
  draft: ComfySettings,
  saved: ComfySettings | null,
  apiKeyEdit: string,
): boolean {
  return !saved
    || apiKeyEdit.length > 0
    || draft.comfy_url !== saved.comfy_url
    || draft.comfy_target !== saved.comfy_target
    || draft.comfy_concurrency !== saved.comfy_concurrency
    || draft.comfy_input_dir !== saved.comfy_input_dir
    || keySourceOf(draft) !== keySourceOf(saved);
}

// '지금 쓰는 키' 안내 줄 — 상태마다 다른 문구(말줄임표 없음). 키 조각은 절대 안 보인다.
export function teamKeyText(state: TeamKeyState, updatedAt: string | null | undefined): string {
  const when = updatedAt ? ` — 관리자 등록 ${updatedAt.replace("T", " ").replace(/Z$/, "")}` : "";
  switch (state) {
    case "available": return `지금 쓰는 키: 팀 키${when}`;
    case "stale": return `지금 쓰는 키: 팀 키${when} · 서버에 닿지 않아 마지막 받은 팀 키로 실행합니다`;
    case "none": return "팀 키 없음 — 관리자에게 서버 등록을 요청하세요. API 노드를 안 쓰면 '개인 키'를 고르고 비워 두세요";
    case "unreachable": return "서버에 닿지 않아 팀 키를 받지 못했습니다 — 실행은 받은 뒤에 됩니다";
    case "undecryptable": return "서버의 팀 키를 풀 수 없습니다 — 관리자가 다시 등록해야 합니다";
    default: return "공유 서버에서 팀 키를 받지 않습니다 — 로그인과 접근 권한을 확인하거나 개인 키를 쓰세요";
  }
}

export function ComfyConnectionSection() {
  const [s, setS] = useState<ComfySettings | null>(null);
  const [saved, setSaved] = useState<ComfySettings | null>(null);
  const [apiKeyEdit, setApiKeyEdit] = useState(""); // 새로 입력하는 키(빈칸이면 기존 유지)
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    comfyApi
      .settings()
      .then((next) => {
        setS(next);
        setSaved(next);
      })
      .catch(() => setMsg("설정을 불러오지 못했습니다."));
  }, []);

  if (!s) {
    return (
      <section className="settings-section">
        <h4>ComfyUI</h4>
        <p className="settings-hint">{msg || "불러오는 중…"}</p>
      </section>
    );
  }

  const patch = (p: Partial<ComfySettings>) => {
    setS((current) => (current ? { ...current, ...p } : current));
    // 이 문구는 마지막으로 저장된 연결값의 검사 결과다. 초안을 바꾼 뒤에도
    // 이전 "연결됨"이 남으면 새 값이 검증된 것처럼 보이므로 즉시 지운다.
    setMsg("");
  };
  const patchApiKey = (value: string) => {
    setApiKeyEdit(value);
    setMsg("");
  };
  const hasUnsavedChanges = hasUnsavedComfySettings(s, saved, apiKeyEdit);

  const save = async () => {
    setSaving(true);
    setMsg("저장 중…");
    try {
      const body: Partial<Omit<ComfySettings, "has_api_key" | "team_key">> = {
        comfy_url: s.comfy_url,
        comfy_target: s.comfy_target,
        comfy_concurrency: s.comfy_concurrency,
        comfy_input_dir: s.comfy_input_dir,
      };
      if (s.comfy_key_source) body.comfy_key_source = s.comfy_key_source; // 옛 허브(없음)엔 보내지 않는다
      if (apiKeyEdit && keySourceOf(s) === "personal") body.comfy_api_key = apiKeyEdit; // 빈칸이면 기존 키 유지. 팀 키 모드에선 개인 키를 받지 않는다
      const next = await comfyApi.setSettings(body);
      setS(next);
      setSaved(next);
      setApiKeyEdit("");
      setMsg("✓ 저장됨");
    } catch (e) {
      setMsg("저장 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const checkHealth = async () => {
    if (hasUnsavedChanges) {
      setMsg("연결값을 먼저 저장한 뒤 확인하세요.");
      return;
    }
    setChecking(true);
    setMsg("연결 확인 중…");
    try {
      const r = await comfyApi.health();
      setMsg(r.alive ? `✓ 연결됨 (${r.target})` : `✗ 응답 없음 (${r.target})`);
    } catch (e) {
      setMsg("확인 실패: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="settings-section">
      <h4>ComfyUI</h4>
      <div className="comfy-set-row">
        <label>연결 대상</label>
        <select
          value={s.comfy_target}
          disabled={saving || checking}
          onChange={(e) => patch({ comfy_target: e.target.value as "local" | "cloud" })}
        >
          <option value="local">로컬 (내 PC)</option>
          <option value="cloud">Comfy Cloud</option>
        </select>
      </div>

      {s.comfy_target === "local" ? (
        <>
          <div className="comfy-set-row">
            <label>서버 주소</label>
            <input
              type="text"
              value={s.comfy_url}
              disabled={saving || checking}
              placeholder="http://127.0.0.1:8188"
              onChange={(e) => patch({ comfy_url: e.target.value })}
            />
          </div>
          <div className="comfy-set-row">
            <label>input 폴더</label>
            <input
              type="text"
              value={s.comfy_input_dir}
              disabled={saving || checking}
              placeholder="(선택) ComfyUI input 폴더 경로"
              onChange={(e) => patch({ comfy_input_dir: e.target.value })}
            />
          </div>
        </>
      ) : (
        <div className="comfy-set-row">
          <label>동시 실행</label>
          <input
            type="number"
            min={1}
            max={5}
            value={s.comfy_concurrency}
            disabled={saving || checking}
            onChange={(e) => patch({ comfy_concurrency: Number(e.target.value) })}
          />
        </div>
      )}

      {/* 키 출처 — 팀 키(관리자가 서버에 등록, 허브가 받아 씀) / 개인 키(이 PC). 옛 허브(comfy_key_source 없음)에는 보이지 않는다. */}
      {s.comfy_key_source && (
        <>
          <div className="comfy-set-row comfy-key-source" role="radiogroup" aria-label="키 출처">
            <label>키 출처</label>
            <label className="comfy-key-choice">
              <input type="radio" name="comfy-key-source" value="team" checked={keySourceOf(s) === "team"}
                disabled={saving || checking} onChange={() => { patch({ comfy_key_source: "team" }); setApiKeyEdit(""); }} />
              팀 키 (관리자 등록)
            </label>
            <label className="comfy-key-choice">
              <input type="radio" name="comfy-key-source" value="personal" checked={keySourceOf(s) === "personal"}
                disabled={saving || checking} onChange={() => patch({ comfy_key_source: "personal" })} />
              개인 키
            </label>
          </div>
          {keySourceOf(s) === "team" && (
            <p className="settings-hint comfy-key-now" data-state={s.team_key?.state ?? "off"}>
              {teamKeyText(s.team_key?.state ?? "off", s.team_key?.updated_at)}
            </p>
          )}
        </>
      )}
      {/* API 키 — 로컬/클라우드 모두. comfy.org API 노드(Gemini·Seedance 등) 인증 + Cloud 접속에 필요. 팀 키 모드에선 잠근다. */}
      <div className="comfy-set-row">
        <label>API 키</label>
        <input
          type="password"
          value={keySourceOf(s) === "team" ? "" : apiKeyEdit}
          disabled={saving || checking || keySourceOf(s) === "team"}
          placeholder={keySourceOf(s) === "team" ? "팀 키 사용 중 — 개인 키를 쓰려면 위에서 '개인 키'를 고르세요"
            : s.has_api_key ? "저장됨 (바꾸려면 새로 입력)" : "comfy.org API 키 (Gemini·Seedance 등 API 노드용)"}
          onChange={(e) => patchApiKey(e.target.value)}
        />
      </div>

      <div className="settings-actions-row">
        <button className="settings-action" onClick={save} disabled={saving || checking || !hasUnsavedChanges}>
          {saving ? "저장 중…" : "저장"}
        </button>
        <button className="settings-action" onClick={checkHealth} disabled={saving || checking || hasUnsavedChanges}>
          {checking ? "연결 확인 중…" : hasUnsavedChanges ? "저장 후 연결 확인" : "연결 확인"}
        </button>
      </div>
      {/* 연결 결과(msg)는 접기 밖 캡션에 상시 표시(Jay 요청 — Resolve·업데이트 섹션과 같은 패턴) */}
      <SettingsDescription summary={msg || "ComfyUI 연결을 설정하고 상태를 확인합니다."}>
        <p>캔버스에서 Comfy 노드(Tab → Comfy 또는 단축키 C)를 만들어 워크플로우를 실행합니다.</p>
        <p>API 노드(Gemini·Seedance 등)는 comfy.org API 키가 필요합니다. 팀 키는 관리자가 서버 관리 창에 한 번 등록하면 이 PC 가 받아 쓰고, 개인 키는 여기에 직접 넣습니다.</p>
      </SettingsDescription>
    </section>
  );
}

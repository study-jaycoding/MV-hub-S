// 설정 — ComfyUI 연결. 이 PC 로컬(또는 그 계정의 Comfy Cloud) 연결 정보를 저장하고 연결 확인.
// 캔버스 Comfy 노드가 이 설정으로 워크플로우를 실행한다. 저장은 app_setting(로컬 DB) — 재시작 불필요.
import { useEffect, useState } from "react";
import { comfyApi, type ComfySettings } from "../../lib/comfyApi";
import { SettingsDescription } from "./SettingsDescription";

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
    || draft.comfy_input_dir !== saved.comfy_input_dir;
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
      const body: Partial<Omit<ComfySettings, "has_api_key">> = {
        comfy_url: s.comfy_url,
        comfy_target: s.comfy_target,
        comfy_concurrency: s.comfy_concurrency,
        comfy_input_dir: s.comfy_input_dir,
      };
      if (apiKeyEdit) body.comfy_api_key = apiKeyEdit; // 빈칸이면 기존 키 유지
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

      {/* API 키 — 로컬/클라우드 모두. comfy.org API 노드(Gemini·Seedance 등) 인증 + Cloud 접속에 필요. */}
      <div className="comfy-set-row">
        <label>API 키</label>
        <input
          type="password"
          value={apiKeyEdit}
          disabled={saving || checking}
          placeholder={s.has_api_key ? "저장됨 (바꾸려면 새로 입력)" : "comfy.org API 키 (Gemini·Seedance 등 API 노드용)"}
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
      <SettingsDescription summary="ComfyUI 연결을 설정하고 상태를 확인합니다.">
        {msg && <p>{msg}</p>}
        <p>캔버스에서 Comfy 노드(Tab → Comfy 또는 단축키 C)를 만들어 워크플로우를 실행합니다.</p>
        <p>API 노드에서 로그인 오류가 나면 comfy.org API 키를 입력하세요.</p>
      </SettingsDescription>
    </section>
  );
}

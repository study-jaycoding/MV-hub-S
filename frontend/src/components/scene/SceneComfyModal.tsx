// Comfy 노드 더블클릭 시 뜨는 모달 — ComfyUI API 워크플로우 JSON 을 불러오고(드래그/파일),
// 조절할 파라미터를 '노출' 체크리스트로 고른다. 저장하면 comfyCfg 스냅샷을 콜백.
// 실제 파라미터 조절 컨트롤·실행 버튼은 카드 본체(SceneBoard)에 인라인으로 뜬다.
import { useEffect, useRef, useState } from "react";
import { comfyApi, type ComfyParamCandidate } from "../../lib/comfyApi";
import type { SceneComfyCfg } from "../../lib/scenes";

export function SceneComfyModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: SceneComfyCfg;
  onSave: (cfg: SceneComfyCfg) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [content, setContent] = useState(initial?.content || "");
  const [nodeCount, setNodeCount] = useState(initial?.nodeCount || 0);
  const [candidates, setCandidates] = useState<ComfyParamCandidate[]>([]);
  const [exposed, setExposed] = useState<Set<string>>(new Set(initial?.paramExposed || []));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 저장된 워크플로우가 있으면 mount 시 다시 파싱해 최신 후보를 채운다.
  useEffect(() => {
    if (initial?.content) void parseContent(initial.content, initial.name || "", initial.paramExposed || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function parseContent(text: string, wfName: string, exposedList: string[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await comfyApi.parse(text, exposedList);
      setContent(text);
      setName(wfName);
      setNodeCount(res.node_count);
      setCandidates(res.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "파싱 실패");
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadFile(file: File) {
    const text = await file.text();
    const base = file.name.replace(/\.json$/i, "");
    await parseContent(text, base, [...exposed]);
  }

  function toggle(key: string) {
    setExposed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function save() {
    // 노출 선택 순서를 유지하고, 새로 노출된 항목은 현재 값으로 초기값을 채운다.
    const paramExposed = [...exposed];
    const values: Record<string, string | number | boolean> = { ...(initial?.paramValues || {}) };
    const byKey = new Map<string, ComfyParamCandidate>(
      candidates.map((c) => [`${c.node_id}|${c.field}`, c]),
    );
    for (const key of paramExposed) {
      if (!(key in values)) {
        const c = byKey.get(key);
        if (c) values[key] = c.value;
      }
    }
    // 더 이상 노출되지 않는 값은 정리
    for (const key of Object.keys(values)) if (!exposed.has(key)) delete values[key];
    // 노출 파라미터 메타 스냅샷(카드 인라인 컨트롤 렌더용) — 노출 순서 유지.
    const params = paramExposed
      .map((key) => byKey.get(key))
      .filter((c): c is ComfyParamCandidate => !!c)
      .map((c) => ({ key: `${c.node_id}|${c.field}`, label: c.label, type: c.type, choices: c.choices }));
    onSave({
      name,
      content,
      nodeCount,
      paramExposed,
      paramValues: values,
      params,
      output: initial?.output ?? null,
      status: initial?.status ?? "idle",
    });
    onClose();
  }

  // 후보를 노드별로 묶어 표시.
  const groups = new Map<string, { title: string; items: ComfyParamCandidate[] }>();
  for (const c of candidates) {
    const g = groups.get(c.node_id) || { title: c.title, items: [] };
    g.items.push(c);
    groups.set(c.node_id, g);
  }

  return (
    <div className="scene-modelmodal-backdrop" onMouseDown={onClose}>
      <div className="scene-modelmodal scene-comfymodal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="scene-modelmodal-hd">
          <span>Comfy 워크플로우 {name ? `— ${name}` : ""}</span>
          <button className="scene-modelmodal-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>

        <div className="scene-modelmodal-body scene-comfymodal-body">
          {/* API 로드 영역 — 드래그 또는 파일 선택 */}
          <div
            className={"scene-comfy-drop" + (dragOver ? " over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void loadFile(f);
            }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void loadFile(f);
                e.target.value = "";
              }}
            />
            {content ? (
              <span>
                ✅ {name || "workflow"} · 노드 {nodeCount}개
                <br />
                <small>다른 API 로 바꾸려면 여기에 .json 을 드롭하거나 클릭</small>
              </span>
            ) : (
              <span>
                ComfyUI 에서 <b>Export (API)</b> 로 내보낸 .json 을 여기에 드롭하거나 클릭해서 선택
              </span>
            )}
          </div>

          {loading && <div className="scene-comfy-msg">불러오는 중…</div>}
          {error && <div className="scene-comfy-msg err">{error}</div>}

          {/* 파라미터 노출 체크리스트 */}
          {content && !loading && (
            <div className="scene-comfy-catalog">
              <div className="scene-comfy-catalog-hd">조절할 파라미터 선택 (체크한 것만 카드에 노출)</div>
              {candidates.length === 0 ? (
                <div className="scene-comfy-msg">조절 가능한 파라미터가 없습니다.</div>
              ) : (
                [...groups.entries()].map(([nid, g]) => (
                  <div key={nid} className="scene-comfy-grp">
                    <div className="scene-comfy-grp-title">{g.title}</div>
                    {g.items.map((c) => {
                      const key = `${c.node_id}|${c.field}`;
                      return (
                        <label key={key} className="scene-comfy-item">
                          <input type="checkbox" checked={exposed.has(key)} onChange={() => toggle(key)} />
                          <span className="scene-comfy-item-label">{c.label}</span>
                          {c.curated && <span className="scene-comfy-badge">추천</span>}
                          <span className="scene-comfy-item-val">= {String(c.value)}</span>
                        </label>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="scene-modelmodal-ft">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={save} disabled={!content || loading}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

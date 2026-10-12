// Comfy 노드 더블클릭 시 뜨는 모달 — ComfyUI API 워크플로우 JSON 을 불러오고(드래그/파일),
// 조절할 파라미터를 '노출' 체크리스트로 고른다. 저장하면 comfyCfg 스냅샷을 콜백.
// 실제 파라미터 조절 컨트롤·실행 버튼은 카드 본체(SceneBoard)에 인라인으로 뜬다.
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
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
  // 지금의 내용(content)을 읽어 후보를 받았는가 — 저장된 워크플로는 창을 열 때 다시 읽는데, 그것이 실패하면(Comfy 서버가 꺼져 있다)
  //  내용은 있고 후보는 빈 채다. 그대로 저장하면 카드의 조절 칸 목록(params)이 빈 것으로 덮인다 → 읽히기 전에는 저장하지 않는다(조작 규칙 46).
  const [parsed, setParsed] = useState(false);
  const [exposed, setExposed] = useState<Set<string>>(new Set(initial?.paramExposed || []));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEscapeClose(onClose); // 떠 있는 동안 뒤 보드의 단축키도 쉰다(lib/keyGate)
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef); // 초점도 창 안에 둔다 — Tab 이 뒤 보드·프롬프트로 나가지 않는다(lib/keyGate '모달의 초점')

  // 저장된 워크플로우가 있으면 mount 시 다시 파싱해 최신 후보를 채운다.
  useEffect(() => {
    if (initial?.content) void parseContent(initial.content, initial.name || "", initial.paramExposed || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 불러오기의 순서 — 늦게 끝난 앞 불러오기가 나중에 넣은 워크플로를 덮지 않는다(조작 규칙 39). 파싱은 드롭다운 후보를 채우느라
  //  Comfy 서버를 조회해(캐시가 없으면 최대 30초) 먼저 넣은 것이 나중에 끝날 수 있다. 불러오는 중에도 새 파일은 받는다.
  //  · 순번(next)은 일의 맨 앞에서 잡는다 — 파일을 읽기 전에.
  //  · **이미 반영된 것(applied)보다 앞선 것만 버린다.** '가장 나중에 시작한 것만 받는다'로 하면, 나중 것이 읽기·파싱에 실패했을 때
  //    아직 돌던 앞의 것까지 버려져 아무것도 안 들어온다.
  //  · '불러오는 중'은 돌고 있는 수(pending)로 든다 — 버려진 것도, 실패한 것도 끝나면 센다(표시가 남지 않는다).
  const loads = useRef({ next: 0, applied: 0, pending: 0 }).current;
  const beginLoad = () => {
    loads.pending += 1;
    setLoading(true);
    setError(null); // 새로 시작하면 앞의 오류 글은 지운다
    return ++loads.next;
  };
  const endLoad = () => {
    loads.pending -= 1;
    if (loads.pending === 0) setLoading(false);
  };
  async function parseContent(text: string, wfName: string, exposedList: string[], seq = beginLoad()) {
    try {
      const res = await comfyApi.parse(text, exposedList);
      if (seq < loads.applied) return;
      loads.applied = seq;
      if (seq === loads.next) setError(null); // 더 나중에 시작한 것이 실패해 띄운 오류는 두고, 앞선 것의 오류만 지운다
      // 내용·후보·노출 선택은 받아들이는 이 자리에서 **같이** 바꾼다 — 실패하면 앞의 묶음이 그대로 남는다. 전엔 파싱 전에 노출 선택을 비우고
      //  실패 때 후보를 비워, 잘못된 파일을 한 번 놓았다가 저장하면 앞 워크플로의 파라미터 설정이 지워진 채 저장됐다(Codex 코드 리뷰).
      //  노출 선택은 이 불러오기가 들고 온 것(exposedList — 다른 워크플로면 빈 것, 같은 워크플로면 그때의 선택)으로 둔다:
      //  A → B → A 가 겹쳐 B 가 선택을 비운 뒤에 A 가 돌아와도 A 의 선택이 돌아온다.
      setContent(text);
      setName(wfName);
      setNodeCount(res.node_count);
      setCandidates(res.candidates);
      setExposed(new Set(exposedList));
      setParsed(true);
    } catch (e) {
      if (seq < loads.applied) return;
      setError(e instanceof Error ? e.message : "파싱 실패");
    } finally {
      endLoad();
    }
  }

  async function loadFile(file: File) {
    const seq = beginLoad();
    let text: string;
    try {
      text = await file.text();
    } catch {
      endLoad();
      if (seq > loads.applied) setError("파일을 읽지 못했습니다.");
      return;
    }
    if (seq < loads.applied) {
      endLoad();
      return;
    }
    const base = file.name.replace(/\.json$/i, "");
    // 다른 워크플로우를 새로 불러오면 노출 선택을 초기화한다. ComfyUI 워크플로는 노드 id("1","2"…)가
    // 겹치기 쉬워, 옛 선택(node|field)을 그대로 두면 엉뚱한 노드에 매핑돼 옛 값이 남는다.
    const changed = text.trim() !== (content || "").trim();
    await parseContent(text, base, changed ? [] : [...exposed], seq);
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
    // 노출 선택 순서를 유지. 값의 출처:
    //  · 같은 워크플로우(내용 동일)면 카드에서 사용자가 바꾼 값(initial.paramValues)을 우선한다.
    //  · 다른 워크플로우를 새로 불러왔으면 그 워크플로우의 기본값(candidates)에서 새로 채운다(옛 값 잔존 금지).
    const paramExposed = [...exposed];
    const byKey = new Map<string, ComfyParamCandidate>(
      candidates.map((c) => [`${c.node_id}|${c.field}`, c]),
    );
    const sameWorkflow = content === (initial?.content || "");
    const values: Record<string, string | number | boolean> = {};
    for (const key of paramExposed) {
      const prior = sameWorkflow ? initial?.paramValues?.[key] : undefined;
      const c = byKey.get(key);
      if (prior !== undefined) values[key] = prior;
      else if (c) values[key] = c.value;
    }
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
      <div ref={modalRef} className="scene-modelmodal scene-comfymodal" onMouseDown={(e) => e.stopPropagation()}>
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
              e.stopPropagation(); // 창에 놓은 것은 창의 것 — 올려 보내면 뒤 보드가 .json 을 씬 파일로 읽으려다 실패 안내를 띄운다(카드 안의 자리와 같다)
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
          {parsed && !loading && (
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
          <button className="primary" onClick={save} disabled={!parsed || loading}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

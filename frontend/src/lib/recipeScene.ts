// 생성물 하나 → "어떻게 만들었나" 씬(노드+연결) 변환기.
//  · 히스토리 버튼을 누르면 이걸로 스냅샷을 만들어 새 씬 탭으로 연다(ComfyUI 워크플로우 열기와 동일 개념).
//  · Generation 이 이미 recipe 정보를 다 갖고 있어(references/model/params/prompt/assets) 그대로 노드로 편다.
//  · api.history() 의 materials(@소스 생성물)·직속 부모(ancestors[0])는 '1단계 위' 생성물 노드로 추가.
//  · 팀 결과물도 동일(백엔드가 팀 생성물에도 references/params 를 채움).
import type { Generation, History, Reference } from "../types";
import type { SceneCard, SceneEdge, SceneModelCfg, SceneRef, SceneSnapshot } from "./scenes";
import { uid } from "./scenes";

const LEFT_X = 40; // 입력(레퍼런스·모델·텍스트) 열
const RIGHT_X = 620; // 결과 카드 열
const Y_STEP = 200; // 입력 노드 세로 간격
const START_Y = 40;

// 모델 노드 params 는 primitive 만 — 객체/배열(input_images·medias 등 숨김 입력)은 빼야 한다.
//  (문자열로 넣으면 이 노드로 재생성할 때 그 값이 잘못 제출될 수 있어 표시·제출 모두에서 제외.)
function normalizeParams(
  params: Record<string, unknown> | null,
): Record<string, string | number | boolean> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function refToSceneRef(r: Reference): SceneRef {
  return {
    file_path: r.file_path,
    type: r.type === "video" ? "video" : r.type === "audio" ? "audio" : "image",
    name: r.source || r.role || undefined,
    thumb: r.thumbnail_path || null,
  };
}

// 생성물 → 씬 스냅샷. history 가 있으면 재료·직속 부모를 1단계 위 생성물 노드로 함께 그린다.
export function buildRecipeScene(gen: Generation, history?: History | null): SceneSnapshot {
  const cards: SceneCard[] = [];
  const edges: SceneEdge[] = [];
  const resultId = uid();
  const addEdge = (from: string, role: SceneEdge["role"]) =>
    edges.push({ id: uid(), from, to: resultId, role });

  let y = START_Y;
  const pushInput = (card: Omit<SceneCard, "x" | "y">, role: SceneEdge["role"]) => {
    cards.push({ ...card, x: LEFT_X, y });
    addEdge(card.id, role);
    y += Y_STEP;
  };

  // 레퍼런스(입력 이미지/영상/오디오) — 하나당 카드 1개.
  for (const r of gen.references || []) {
    pushInput({ id: uid(), kind: "reference", refs: [refToSceneRef(r)] }, "ref");
  }
  // 재료(@소스로 쓴 생성물) — 1단계 위 생성물 노드.
  for (const m of history?.materials || []) {
    if (m.id === gen.id) continue;
    pushInput({ id: uid(), kind: "generation", genId: m.id, genIds: [m.id], status: "done" }, "ref");
  }
  // 직속 부모(재생성·가져오기 원본) — lineage.
  const parent = history?.ancestors?.[0];
  if (parent && parent.id !== gen.id) {
    pushInput({ id: uid(), kind: "generation", genId: parent.id, genIds: [parent.id], status: "done" }, "lineage");
  }
  // 모델(+파라미터).
  if (gen.model) {
    const modelCfg: SceneModelCfg = {
      model: gen.model,
      modelName: gen.model,
      params: normalizeParams(gen.params),
    };
    pushInput({ id: uid(), kind: "model", modelCfg }, "model");
  }
  // 프롬프트 텍스트.
  const promptText = gen.display_prompt ?? gen.prompt;
  if (promptText && promptText.trim()) {
    pushInput({ id: uid(), kind: "text", text: promptText }, "text");
  }

  // 결과 카드 — 오른쪽, 입력 열의 세로 가운데쯤.
  //  ★refs 도 채운다: 이걸 클릭하면 연결된 레퍼런스가 하단 프롬프트에 붙어 @image 토큰이 해석된다
  //   (from_card=true — 소스 연결에서 온 참조라 연결이 바뀌면 함께 갱신). 없으면 @image 가 ⚠ 로 뜬다.
  const inputSpan = Math.max(0, y - Y_STEP - START_Y);
  cards.push({
    id: resultId,
    kind: "generation",
    x: RIGHT_X,
    y: START_Y + Math.round(inputSpan / 2),
    genId: gen.id,
    genIds: [gen.id],
    status: "done",
    refs: (gen.references || []).map((r) => ({ ...refToSceneRef(r), from_card: true })),
  });

  const name = `히스토리 - ${gen.model || "gen"} - ${gen.id.slice(0, 6)}`;
  return { name, cards, edges };
}

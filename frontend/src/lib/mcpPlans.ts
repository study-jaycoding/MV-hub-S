import type { SubmissionResult } from "../shared/contracts/generation";
import type { GenerationCreateBody } from "../api";
import type { ModelParam, WorkspaceContext } from "../types";
import type { CanvasGenerationLink } from "./canvasGenerationRecovery";
import { createCanvasGenerationLinks } from "./canvasGenerationRecovery";
import type { Scene, SceneCard, SceneEdge, SceneRef } from "./scenes";

export type McpReference = SceneRef & { asset_version?: string; source_version?: string };
export interface McpPlanInputItem {
  label: string;
  prompt: string;
  model: string;
  params: Record<string, string | number | boolean>;
  reference_ids: string[];
  project_id: string;
  folder_path: string;
}
export interface McpPlanItem {
  label: string;
  request: { kind: "create"; workspace: WorkspaceContext; create: GenerationCreateBody; canvas_link: CanvasGenerationLink };
  estimated_credits: number;
  reference_snapshot: McpReference[];
}
export interface McpPlanBody {
  title: string;
  context_id: string;
  scene_id: string;
  scene_hash: string;
  workspace: WorkspaceContext;
  items: McpPlanItem[];
}
export type McpItemState = "pending" | "submitting" | "submitted" | "uncertain" | "rejected";
export interface McpPlanRecord {
  id: string;
  revision: number;
  status: string;
  plan: McpPlanBody;
  items: { state: McpItemState; error: string | null }[];
  approved_at?: string | null;
}

export function strictObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("객체 형식이 필요합니다.");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key))) throw new Error("지원하지 않는 필드가 있습니다. 연쇄 생성은 아직 지원하지 않습니다.");
  return object;
}
export function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} 값이 없거나 너무 깁니다.`);
  return value;
}
export function parseMcpPlan(value: unknown): { title: string; context_id: string; items: McpPlanInputItem[] } {
  const raw = strictObject(value, ["title", "context_id", "items"]);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 20) throw new Error("생성 계획은 독립 항목 1~20개로 구성하세요.");
  const items = raw.items.map((value): McpPlanInputItem => {
    const row = strictObject(value, ["label", "prompt", "model", "params", "reference_ids", "project_id", "folder_path"]);
    const params = row.params ?? {};
    if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 50) throw new Error("모델 옵션 형식이 잘못되었습니다.");
    for (const [key, value] of Object.entries(params)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || !["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new Error("모델 옵션은 유한 숫자·문자열·참/거짓만 지원합니다.");
    }
    if (!Array.isArray(row.reference_ids) || row.reference_ids.length > 8 || row.reference_ids.some((id) => typeof id !== "string")) throw new Error("참고 자료 핸들은 0~8개여야 합니다.");
    const folder = boundedText(row.folder_path, 500, "컷 폴더");
    if (folder.split(/[\\/]/).some((part) => part === "..") || folder.startsWith("/") || /^[a-z]:/i.test(folder)) throw new Error("프로젝트 내 컷 폴더를 지정하세요.");
    return { label: boundedText(row.label, 200, "장면 이름"), prompt: boundedText(row.prompt, 4000, "프롬프트"), model: boundedText(row.model, 200, "모델"), params: params as McpPlanInputItem["params"], reference_ids: row.reference_ids as string[], project_id: boundedText(row.project_id, 200, "프로젝트"), folder_path: folder };
  });
  return { title: boundedText(raw.title, 200, "계획 제목"), context_id: boundedText(raw.context_id, 120, "문맥 ID"), items };
}

export function validateMcpParams(params: Record<string, unknown>, schema: ModelParam[]): void {
  for (const [name, value] of Object.entries(params)) {
    const field = schema.find((item) => item.name === name);
    if (!field) throw new Error(`지원하지 않는 모델 옵션: ${name}`);
    if (field.enum?.length && !field.enum.some((item) => String(item) === String(value))) throw new Error(`모델 옵션 선택값이 잘못되었습니다: ${name}`);
    const type = field.type.split("|")[0];
    if ((type === "integer" && !Number.isInteger(value)) || ((type === "number" || type === "float") && typeof value !== "number") || (type === "boolean" && typeof value !== "boolean") || (type === "string" && typeof value !== "string")) throw new Error(`모델 옵션 형식이 잘못되었습니다: ${name}`);
  }
}

export async function mcpDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const sum = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(sum), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function mcpSceneHash(scene: Scene): Promise<string> {
  // 화면 이동/줌은 생성 입력을 바꾸지 않는다. 카드·연결·공간·이름은 모두 검사한다.
  return mcpDigest({ id: scene.id, name: scene.name, workspace: scene.workspace, cards: scene.cards, edges: scene.edges, groups: scene.groups });
}

export function newMcpLink(sceneId: string): CanvasGenerationLink {
  return createCanvasGenerationLinks({ sceneId, cardId: crypto.randomUUID() }, 1)[0];
}

export function mcpPlanCards(plan: McpPlanBody, scene: Scene): { cards: SceneCard[]; edges: SceneEdge[] } {
  const cards: SceneCard[] = [];
  const edges: SceneEdge[] = [];
  const top = Math.max(0, ...scene.cards.map((card) => card.y + (card.h || 250))) + 100;
  plan.items.forEach((item, index) => {
    const cardId = item.request.canvas_link.card_id;
    const x = index * 650;
    const y = top;
    const { create } = item.request;
    cards.push({ id: cardId, kind: "generation", x: x + 320, y, prompt: create.display_prompt || create.prompt, status: "empty" });
    cards.push({ id: `${cardId}-label`, kind: "head", x, y: y - 70, text: item.label });
    cards.push({ id: `${cardId}-model`, kind: "model", x, y, modelCfg: { model: create.model, params: create.params as Record<string, string | number | boolean> } });
    edges.push({ id: `${cardId}-model-edge`, from: `${cardId}-model`, to: cardId, role: "model" });
    cards.push({ id: `${cardId}-set`, kind: "set", x, y: y + 180, setCfg: { folder: { projectId: create.project_id!, path: create.folder_path! } } });
    edges.push({ id: `${cardId}-set-edge`, from: `${cardId}-set`, to: cardId, role: "set" });
    item.reference_snapshot.forEach((ref, refIndex) => {
      const id = `${cardId}-ref-${refIndex}`;
      const { asset_version: _assetVersion, source_version: _sourceVersion, ...sceneRef } = ref;
      cards.push({ id, kind: "reference", x, y: y + 370 + refIndex * 180, refs: [sceneRef] });
      edges.push({ id: `${id}-edge`, from: id, to: cardId, role: "ref", order: refIndex });
    });
  });
  if (cards.some((card) => scene.cards.some((existing) => existing.id === card.id))) throw new Error("계획 카드가 이미 존재합니다. 다시 생성하지 말고 요청 상태를 확인하세요.");
  return { cards: [...scene.cards, ...cards], edges: [...scene.edges, ...edges] };
}

export interface McpExecutionPorts {
  check: () => Promise<void>;
  approve: (record: McpPlanRecord) => Promise<McpPlanRecord>;
  persistCards: (plan: McpPlanBody) => Promise<void>;
  persistLinks: (plan: McpPlanBody) => Promise<void>;
  state: (record: McpPlanRecord, index: number, state: Exclude<McpItemState, "pending">, error?: string) => Promise<McpPlanRecord>;
  submit: (item: McpPlanItem) => Promise<void | SubmissionResult>;
  discard: (item: McpPlanItem) => void;
  changed: (record: McpPlanRecord) => void;
}

export function mcpDraftMatches(plan: McpPlanBody, scene: Scene): boolean {
  const draft = mcpPlanCards(plan, { ...scene, cards: [], edges: [] });
  const input = (card: SceneCard) => JSON.stringify({ id: card.id, kind: card.kind, prompt: card.prompt, text: card.text, modelCfg: card.modelCfg, setCfg: card.setCfg, refs: card.refs });
  return draft.cards.every((card) => {
    const actual = scene.cards.find((candidate) => candidate.id === card.id);
    return actual && input(actual) === input(card);
  }) && draft.edges.every((edge) => scene.edges.some((candidate) => JSON.stringify(candidate) === JSON.stringify(edge))) &&
    scene.edges.filter((edge) => draft.cards.some((card) => card.id === edge.to)).length === draft.edges.length;
}

export function isMcpDefiniteRejection(error: unknown): boolean {
  const status = Number((error as { status?: number })?.status);
  // MCP의 409는 같은 attempt의 기존 요청 충돌일 수 있으므로 표식을 유지한다.
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

const PREFLIGHT_MESSAGES = {
  scene: "선택 캔버스 또는 승인 카드가 바뀌었거나 저장을 확인하지 못해 제출하지 않았습니다.",
  references: "참고 자료가 바뀌었거나 현재 버전을 확인하지 못해 제출하지 않았습니다.",
  cost: "예상 크레딧이 승인 금액을 넘거나 견적을 확인하지 못해 제출하지 않았습니다.",
  policy: "현재 계정의 모델 사용 정책을 확인하지 못했거나 허용되지 않아 제출하지 않았습니다.",
} as const;
export class McpPreflightError extends Error {
  readonly status = 422;
  constructor(reason: keyof typeof PREFLIGHT_MESSAGES) { super(PREFLIGHT_MESSAGES[reason]); }
}
export function mcpFailureMessage(error: unknown): string {
  if (error instanceof McpPreflightError) return error.message;
  const status = Number((error as { status?: number })?.status);
  // 원격 오류 본문에는 경로·토큰 등이 섞일 수 있어 저장하지 않는다. 단계와 HTTP 상태만 남긴다.
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return isMcpDefiniteRejection(error)
      ? `생성 요청이 서버에서 거절되었습니다(HTTP ${status}). 입력과 권한을 확인하세요.`
      : `생성 요청의 접수 여부를 확인할 수 없습니다(HTTP ${status}). 기존 요청을 확인하세요.`;
  }
  return "생성 요청 중 통신 또는 결과 반영 오류가 발생했습니다. 접수 여부를 기존 요청에서 확인하세요.";
}
export async function executeMcpPlan(initial: McpPlanRecord, ports: McpExecutionPorts): Promise<McpPlanRecord> {
  if (initial.status !== "proposed" || initial.items.some((item) => item.state !== "pending")) throw new Error("이미 승인되었거나 실행한 계획입니다. 기존 생성 요청을 확인하세요.");
  await ports.check();
  let record = await ports.approve(initial);
  ports.changed(record);
  await ports.check();
  await ports.persistCards(record.plan);
  await ports.persistLinks(record.plan);
  for (let index = 0; index < record.plan.items.length; index++) {
    // UI 이중 클릭 가드와 별개로 DB revision CAS가 탭 간 중복 제출을 차단한다.
    record = await ports.state(record, index, "submitting");
    ports.changed(record);
    const item = record.plan.items[index];
    let result: void | SubmissionResult;
    try {
      result = await ports.submit(item);

    } catch (error) {
      const definite = isMcpDefiniteRejection(error);
      if (definite) ports.discard(item);
      record = await ports.state(record, index, definite ? "rejected" : "uncertain", mcpFailureMessage(error));
      ports.changed(record);
      // 모호한 제출 결과에서는 뒤 항목도 멈춘다. 자동 재시도로 유료 작업을 늘리지 않는다.
      if (!definite) throw new Error("제출 결과를 확인할 수 없습니다. 기존 요청을 확인하세요. 자동 재생성하지 않습니다.");
      continue;
    }
      if (result && result.outcome.kind !== "accepted" && result.outcome.kind !== "accepted_local_pending") {
        const definite = result.outcome.kind === "prepare_failed" || result.outcome.kind === "rejected";
        if (definite) ports.discard(item);
        const error = result.error ?? new McpPreflightError("scene");
        record = await ports.state(record, index, definite ? "rejected" : "uncertain", mcpFailureMessage(error));
        ports.changed(record);
        if (!definite) throw new Error("제출 결과를 확인할 수 없습니다. 기존 요청을 확인하세요. 자동 재생성하지 않습니다.");
        continue;
      }
    record = await ports.state(record, index, "submitted");
    ports.changed(record);
  }
  return record;
}

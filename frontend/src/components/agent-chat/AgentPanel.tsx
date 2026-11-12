// MV Agent 옆 칸(기본 폭 520px — 시안 _shots/ask-agent-open-v2.png · 모델 칩 ask-agent-models.png). 머리(왼쪽 [≡ 대화 목록][옆 칸 닫기] · 제목 ·
//  오른쪽 [새 대화][새 창]) · 대화(또는 Claude 연결 안내) · 입력칸(지금 화면 · [모델 ⌄] [생각 깊이 ⌄] · 보내기). 칸을 닫아도 차례는 허브에서 계속 돈다.
//  옆에 붙은 동안 왼쪽 끝선을 끌어 폭을 바꾸고, ≡ 는 대화 서랍(프로젝트별·설정), [새 창]은 Assets 같은 별도 창(AgentWindow)으로 뺀다
//  (Jay 11-10 시안 A안·② — docs/status/MVAgent_서랍_새창_2026-11-10.md).
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from "react";
import { api } from "../../api";
import { getAccountNamespace } from "../../lib/accountScope";
import { assetThumbUrl } from "../../lib/assetUrls";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { thumbOf } from "../../lib/media";
import { parseSceneFolderDrag } from "../../lib/sceneSet";
import { parseSpotlightAssetItems } from "../../lib/spotlightAssetRefs";
import { useDragEndReset } from "../../lib/useDragEndReset";
import type { AgentChoice, AgentMessage } from "../../lib/useAgentChat";
import { useAgentChat } from "../../lib/useAgentChat";
import {
  agentChatApi, type AgentAttachment, type AgentAttachWorkspace, type AgentContext, type AgentConversationPatch, type AgentConversationSummary,
  type AgentEngine, type AgentEngineId, type AgentSessionFileResult,
} from "../../lib/agentChatApi";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { Generation, PreviewTarget } from "../../types";
import { AgentConnect } from "./AgentConnect";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPlanCard } from "./AgentPlanCard";

interface Props {
  context: AgentContext;
  contextLabel: string; // 입력칸의 '지금 화면' 표시(예: 워크스페이스 › e001)
  onClose: () => void;
  popout?: boolean; // 별도 창(?embed=agent) 안 — 창을 채우고, 폭 손잡이·[새 창] 대신 [옆 칸으로 붙이기]
  onPopOut?: () => void; // 옆 칸 → 새 창(없으면 단추도 없다)
  onDock?: () => void; // 새 창 → 옆 칸
  projectName?: (id: string) => string | undefined; // 서랍의 프로젝트 묶음 이름
  findGeneration?: (id: string) => Generation | undefined; // 계획 카드 썸네일 — 앱이 이미 읽은 라이브러리 카드
  onPreview?: (target: PreviewTarget) => void; // 썸네일을 누르면 기존 크게 보기
}

const NO_SCREEN: Record<string, never> = {}; // '지금 화면' 칩을 뺀 동안 보내는 빈 문맥(허브가 '어디인지 묻는다' 안내)

// 옆 칸 폭 — 필터 사이드바처럼 끝선을 끌어 바꾼다. 화면에 보이는 폭은 :root 의 --agent-w(앱 본문 여백 .app.agent-open 도 같이 읽는다)
const BASE_W = 520;
const MIN_W = 380;
const maxWidth = () => Math.max(MIN_W, Math.floor(window.innerWidth / 2));
const clampWidth = (w: number) => Math.max(MIN_W, Math.min(maxWidth(), Math.round(w)));
// 정보 칸 — 대화 오른쪽 옆 칸(docs/status/MVAgent_정보칸분리_2026-11-12.md). 붙은 칸은 열 때 이 폭만큼 넓어지되 앱 본문은 APP_MIN 을 남긴다
const INFO_W = 286;
const APP_MIN = 320;
const INFO_CARDS = ["screen", "made", "attached"] as const;
type InfoCard = (typeof INFO_CARDS)[number];
const showWidth = (w: number) => document.documentElement.style.setProperty("--agent-w", `${w}px`);

const GROUP: Record<AgentEngineId, string> = { claude: "Claude", codex: "ChatGPT" };
const EFFORT: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const FAST_MODEL = "opus"; // 빠른 모드 = Opus 5.5 만
// 허브 MCP 도구 이름 → 칸에 보이는 한 줄(MV Hub · 계획 저장)
const TOOL: Record<string, string> = {
  check_connection: "연결 확인",
  connect: "연결",
  read_context: "자료 조회",
  prepare_generation_plan: "계획 저장",
  get_plan: "계획 보기",
  estimate_plan: "견적",
  execute_generation_plan: "생성 실행",
  wait_results: "결과 기다리기",
  add_to_canvas: "캔버스에 놓기",
};
const TOOL_STATE: Record<string, string> = { started: "하는 중", done: "끝", failed: "실패" };

// ── 끌어다 넣기(docs/status/MVAgent_끌어다넣기_2026-11-12.md 2-1) — 생성물·어셋 레퍼런스·프로젝트 폴더를 칸에 놓으면 입력칸 위 칩 ──
const ATTACH_MAX = 8; // 계획 항목의 reference_ids 상한과 같게
const ATTACH_TYPES: readonly string[] = [DRAG_TYPES.asset, DRAG_TYPES.generationList, DRAG_TYPES.generation, DRAG_TYPES.folder];
const CONTROL = /[\u0000-\u001f\u007f]/;
const GEN_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
/** 받는 형식만 — 그 밖(OS 파일만·글자)은 손대지 않는다(받지 않는 것에 preventDefault 하지 않음 — lib/media.ts) */
const acceptsDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).some((type) => ATTACH_TYPES.includes(type));
const isIdent = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL.test(value);
/** 표시 이름 — 거절하지 않고 정리(제어 글자 → 공백, 120자). 이름 하나 때문에 차례가 막히지 않게(Claude 합의 P1) */
const cleanName = (value: string | null | undefined) => (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120).trim() || undefined;
const lastSegment = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const attachKey = (item: AgentAttachment) => (item.kind === "generation" ? `g:${item.id}`
  : item.kind === "asset" ? `a:${item.project}\u0000${item.path}` : `f:${item.project_id}\u0000${item.path}`);
// uid = 칩 하나하나의 번호 — 보낸 묶음만 지울 때 같은 자료를 다시 붙인 새 칩은 남긴다(독립 리뷰 P2). key 는 중복 막기용
type AttachChip = { uid: number; key: string; item: AgentAttachment; project?: string; pending?: boolean; thumb?: string | null };
type DropChip = Omit<AttachChip, "uid">;

/** 놓은 끌기 값 → 붙일 칩과 버린 개수. 캔버스와 같은 순서(어셋 → 생성물 묶음·한 개 → 폴더). 어셋은 끌기 값만 쓴다 —
 *  localStorage 저장값으로 넓히지 않는다(같은 끌기임을 증명할 표가 없어 저장 실패 때 지난 선택이 섞인다, Codex 2차 P1). */
function readDrop(dt: DataTransfer): { chips: DropChip[]; dropped: number } {
  const chips: DropChip[] = [];
  let dropped = 0;
  const rawAsset = dt.getData(DRAG_TYPES.asset);
  if (rawAsset) {
    let total = 0;
    try {
      const parsed = JSON.parse(rawAsset);
      total = Array.isArray(parsed) ? parsed.length : 1;
    } catch { /* parseSpotlightAssetItems 도 빈 목록 */ }
    const items = parseSpotlightAssetItems(rawAsset);
    dropped += Math.max(0, total - items.length);
    for (const asset of items) {
      if (!isIdent(asset.project, 200) || !isIdent(asset.path, 1000)) {
        dropped += 1;
        continue;
      }
      const item: AgentAttachment = { kind: "asset", project: asset.project, path: asset.path, name: cleanName(asset.name || lastSegment(asset.path)) };
      chips.push({ key: attachKey(item), item, thumb: asset.type === "audio" ? null : assetThumbUrl(asset.project, asset.path, 256) });
    }
    return { chips, dropped };
  }
  const rawGen = dt.getData(DRAG_TYPES.generationList) || dt.getData(DRAG_TYPES.generation);
  if (rawGen) {
    for (const id of rawGen.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!GEN_ID.test(id)) {
        dropped += 1;
        continue;
      }
      const item: AgentAttachment = { kind: "generation", id };
      chips.push({ key: attachKey(item), item, pending: true }); // 조회 전에도 바로 넣는다 — 상한·중복·보내기에 든다(Claude 합의 3차 P2)
    }
    return { chips, dropped };
  }
  const rawFolder = dt.getData(DRAG_TYPES.folder);
  if (rawFolder) {
    const folder = parseSceneFolderDrag(rawFolder);
    // 파서는 projectId 길이·제어 글자를 안 본다 — 그대로 보내면 허브가 차례 전체를 422 로 막는다(Codex 4차 P2)
    if (!folder || !isIdent(folder.projectId, 200) || !isIdent(folder.path, 500)) return { chips, dropped: 1 };
    const item: AgentAttachment = { kind: "folder", project_id: folder.projectId, path: folder.path, name: cleanName(lastSegment(folder.path)) };
    chips.push({ key: attachKey(item), item, project: cleanName(folder.projectName) });
  }
  return { chips, dropped };
}

type ToolMessage = Extract<AgentMessage, { kind: "tool" }>;
type Row = AgentMessage | { kind: "tools"; id: string; tools: ToolMessage[] };
/** 이어진 도구 알약을 한 줄로 묶는다(Aside 처럼 — 시안 A, docs/status/MVAgent_한줄묶기_2026-11-11.md). 사건·저장 형식은 그대로, 그리기만. */
function groupTools(messages: AgentMessage[]): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    const last = rows[rows.length - 1];
    if (m.kind === "tool" && last?.kind === "tools") last.tools.push(m);
    else rows.push(m.kind === "tool" ? { kind: "tools", id: m.id, tools: [m] } : m);
  }
  return rows;
}

export function AgentPanel({ context, contextLabel, onClose, popout = false, onPopOut, onDock, projectName, findGeneration, onPreview }: Props) {
  const t = useT();
  // 정보 칸 — 지금 화면·이 대화 결과물·붙였던 자료. 정보 단추를 다시 누를 때까지 떠 있다(바깥 누름·Esc 로 안 닫힘, 기억함 — Jay 11-12)
  const [infoOpen, setInfoOpen] = useState(() => loadJSON<unknown>(STORAGE_KEYS.agentInfoOpen) === true);
  const toggleInfo = () => {
    const next = !infoOpen;
    setInfoOpen(next);
    saveJSON(STORAGE_KEYS.agentInfoOpen, next);
  };
  const [infoFold, setInfoFold] = useState<InfoCard[]>(() => {
    const saved = loadJSON<unknown>(STORAGE_KEYS.agentInfoFold);
    return Array.isArray(saved) ? INFO_CARDS.filter((c) => saved.includes(c)) : [];
  });
  const foldCard = (card: InfoCard) => {
    const next = infoFold.includes(card) ? infoFold.filter((c) => c !== card) : [...infoFold, card];
    setInfoFold(next);
    saveJSON(STORAGE_KEYS.agentInfoFold, next);
  };

  // 옆 칸 폭 — 고른 폭은 남기고, 보이는 폭은 지금 창 폭의 절반까지(창을 줄였다 키우면 고른 폭으로 돌아간다 — ResizableSidebar 와 같다).
  // 고른 폭(width)은 대화 폭이다 — 정보 칸을 옆에 세울 자리가 있으면 붙은 칸은 그만큼 더 넓게 보인다
  const [width, setWidth] = useState(() => {
    const saved = loadJSON<unknown>(STORAGE_KEYS.agentPanelWidth);
    return typeof saved === "number" && Number.isFinite(saved) ? saved : BASE_W;
  });
  const [winW, setWinW] = useState(() => window.innerWidth);
  // 정보 칸이 대화 옆에 설 자리 — 붙은 칸은 앱 본문을 APP_MIN 남기고 넓어질 수 있을 때, 새 창은 창이 대화 최소 폭 + 정보 칸보다 넓을 때. 없으면 겹쳐 뜬다
  const infoRoom = (chatW: number, ww: number) => (popout ? ww - INFO_W >= MIN_W : chatW + INFO_W <= ww - APP_MIN);
  const shown = (chatW: number) => (infoOpen && !popout && infoRoom(chatW, window.innerWidth) ? chatW + INFO_W : chatW);
  const infoSide = infoRoom(clampWidth(width), winW);
  useLayoutEffect(() => {
    const apply = () => { setWinW(window.innerWidth); showWidth(shown(clampWidth(width))); };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [width, infoOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- shown 은 width·infoOpen·popout 만 읽는다
  const commitWidth = (next: number) => {
    next = clampWidth(next);
    setWidth(next);
    showWidth(shown(next));
    saveJSON(STORAGE_KEYS.agentPanelWidth, next);
  };
  // 끄는 동안은 :root 변수만 바꾼다(앱을 다시 그리지 않는다) — 놓을 때 한 번 남긴다
  const drag = useRef<{ id: number; x: number; from: number; now: number } | null>(null);
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null; // releasePointerCapture 가 lostpointercapture 를 보내도 두 번 처리하지 않는다
    event.currentTarget.classList.remove("resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (keep && d.now !== d.from) commitWidth(d.now);
    else showWidth(shown(clampWidth(width)));
  };

  const [screenOn, setScreenOn] = useState(true); // 기억하지 않는다 — 새 대화·지난 대화 열기마다 다시 붙는다
  const chat = useAgentChat(screenOn ? context : NO_SCREEN, { popout }); // 새 창이면 '새 창에서 열기' 요청을 받는다
  const [text, setText] = useState("");
  const [revising, setRevising] = useState<{ title: string } | null>(null); // [고치기] — 입력칸의 '고칠 계획' 칩
  const [menu, setMenu] = useState<"model" | null>(null); // 모델·생각 깊이·속도 한 메뉴(Aside 처럼)
  const [drawer, setDrawer] = useState(false); // ≡ 대화 서랍
  const [headNote, setHeadNote] = useState<string | null>(null); // 머리글 메뉴로 지운 결과(세션 파일) — 새 대화를 시작하면 지운다
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEscapeClose(closeMenu, menu !== null);
  useEscapeClose(closeDrawer, drawer && menu === null);
  useOutsideMouseDown(modelRef, closeMenu, menu !== null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat.messages, chat.connect.state]);
  useEffect(() => { if (chat.conversationId) setHeadNote(null); }, [chat.conversationId]); // 다른 대화를 열거나 새로 보내면 지운 안내는 끝

  // ── 끌어다 넣기(설계 2-1) — 칩은 앱의 지금 공간에 묶인다(대화에 묶이지 않음) ──
  const [chips, setChips] = useState<AttachChip[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [dropping, setDropping] = useState<"ok" | "blocked" | null>(null);
  const dragDepth = useRef(0);
  const chipEpoch = useRef(0); // 칩을 비울 때마다 올린다 — 그 전에 시작한 생성물 조회의 늦은 답을 버린다(Codex 4차 P1)
  const chipSeq = useRef(0);
  const [genCache, setGenCache] = useState<Record<string, Generation | null>>({}); // 칩·내 말 썸네일용(null = 못 읽음)
  const requestedSent = useRef(new Set<string>()); // 복원 썸네일 묶음 조회 — `대화:id`
  const ws = context.workspace; // '지금 화면' 칩을 뺐어도 칸은 앱 공간을 안다
  const attachWs: AgentAttachWorkspace | null = ws?.scope === "personal" ? { scope: "personal", id: null }
    : ws?.scope === "team" && ws.id ? { scope: "team", id: ws.id } : null; // 미확정(unknown)·공간 정보 없음 = 받지 않음
  // 계정까지 넣는다 — 같은 개인 공간끼리 계정만 바뀌어도 비운다(독립 리뷰 P1)
  const wsKey = `${getAccountNamespace()}|${attachWs ? `${attachWs.scope}:${attachWs.id ?? ""}` : ""}`;
  const attachWsRef = useRef(attachWs);
  attachWsRef.current = attachWs;
  const wsKeyRef = useRef(wsKey);
  useEffect(() => { // 공간(scope·id)·계정이 바뀌면 칩·캐시·조회를 비운다 — 팀 이름만 채워지는 것은 바뀜이 아니다
    if (wsKeyRef.current === wsKey) return;
    wsKeyRef.current = wsKey;
    chipEpoch.current += 1;
    setGenCache({});
    requestedSent.current.clear();
    if (chipsRef.current.length) {
      setChips([]);
      setAttachNote(t("공간이 바뀌어 붙인 자료를 비웠어요"));
    }
  }, [wsKey, t]);
  const genOf = (id: string) => findGeneration?.(id) ?? genCache[id] ?? undefined;
  const removeChip = (uid: number) => {
    setChips((now) => now.filter((c) => c.uid !== uid));
    setAttachNote(null);
  };
  /** 생성물 칩 채우기 — 조회 시작 때 계정·공간·비움 세대를 잡고, 답이 올 때 셋이 그대로일 때만 넣는다(성공이든 실패든) */
  const resolveGeneration = (uid: number, id: string) => {
    const at = { epoch: chipEpoch.current, ws: wsKeyRef.current, account: getAccountNamespace() };
    const apply = (gen: Generation | null) => {
      if (at.epoch !== chipEpoch.current || at.ws !== wsKeyRef.current || at.account !== getAccountNamespace()) return;
      if (gen) setGenCache((m) => ({ ...m, [id]: gen }));
      const space = attachWsRef.current;
      if (gen && space && (gen.workspace_scope !== space.scope || (gen.workspace_id || null) !== space.id)) {
        setChips((now) => now.filter((c) => c.uid !== uid)); // 공간 지정 없는 씬의 카드 등 — 붙였다가 나중에 '확인 안 됨'을 듣지 않게
        setAttachNote(t("다른 공간의 생성물이에요"));
        return;
      }
      setChips((now) => now.map((c) => (c.uid !== uid ? c : {
        ...c, pending: false,
        ...(gen ? { item: { kind: "generation" as const, id, name: cleanName(gen.prompt) }, thumb: thumbOf(gen, 256) } : {}),
      })));
    };
    const known = findGeneration?.(id) ?? genCache[id];
    if (known) return apply(known);
    api.getGeneration(id).then(apply, () => apply(null)); // 못 읽으면 회색 칩 — AI 의 정확히 찾기가 확인한다
  };
  const addChips = (incoming: DropChip[], dropped: number) => {
    const now = chipsRef.current;
    const seen = new Set(now.map((c) => c.key));
    const fresh = incoming.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
    const taken: AttachChip[] = fresh.slice(0, Math.max(0, ATTACH_MAX - now.length)).map((c) => ({ ...c, uid: (chipSeq.current += 1) }));
    const notes = [
      ...(dropped ? [t("{n}개는 붙일 수 없어 뺐어요").replace("{n}", String(dropped))] : []),
      ...(fresh.length > taken.length ? [t("8개까지 붙일 수 있어요")] : []),
    ];
    setAttachNote(notes.join(" · ") || null);
    if (!taken.length) return;
    const next = [...now, ...taken];
    chipsRef.current = next;
    setChips(next);
    for (const c of taken) if (c.item.kind === "generation") resolveGeneration(c.uid, c.item.id);
  };
  const endDropping = useCallback(() => {
    dragDepth.current = 0;
    setDropping(null);
  }, []);
  useDragEndReset(dropping !== null, endDropping); // 받는 쪽 위에서 취소하면 dragleave 가 안 온다
  useEffect(() => {
    if (!dropping) return;
    window.addEventListener("blur", endDropping);
    return () => window.removeEventListener("blur", endDropping);
  }, [dropping, endDropping]);
  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDropping(attachWs ? "ok" : "blocked");
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault(); // 받지 않는 상태에서도 — 입력칸 기본 동작(영상 주소 글자)을 막는다(Claude 합의 2차 P2)
      event.dataTransfer.dropEffect = attachWs ? "copy" : "none";
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrag(event.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDropping(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!acceptsDrag(event.dataTransfer)) return;
      event.preventDefault(); // 입력칸 위에 놓아도 글자가 들어가지 않게
      endDropping();
      if (!attachWs) {
        setAttachNote(t("공간을 확인한 뒤 다시 끌어 주세요"));
        return;
      }
      const { chips: incoming, dropped } = readDrop(event.dataTransfer);
      addChips(incoming, dropped);
    },
  };
  // 내 말 위 썸네일 — 앱이 읽은 카드에 없는 생성물만 묶음 조회 한 번(대화가 바뀌었으면 버림, 설계 2-5)
  const sentGenIds = Array.from(new Set(chat.messages.flatMap((m) => (m.kind === "user" && m.attachments
    ? m.attachments.flatMap((a) => (a.kind === "generation" ? [a.id] : [])) : []))));
  // 정보 칸 — 이 대화 계획 카드에서 끝난 생성물 · 내 말에 붙였던 자료(중복 없이)
  const madeIds = Array.from(new Set(chat.messages.flatMap((m) => (m.kind === "plan" && m.progress
    ? Object.values(m.progress.items).flatMap((it) => (it.generation_id && it.generation_status === "done" ? [it.generation_id] : [])) : []))));
  const attachedBefore = Array.from(new Map(chat.messages.flatMap((m) => (m.kind === "user" && m.attachments
    ? m.attachments.map((a) => [attachKey(a), a] as const) : []))).values());
  const missingSentKey = Array.from(new Set([...sentGenIds, ...madeIds])).filter((id) => !findGeneration?.(id) && !(id in genCache)).join(",");
  const conversationRef = useRef(chat.conversationId);
  conversationRef.current = chat.conversationId;
  // 대화·공간(계정)이 바뀌면 다시 본다 — 같은 미조회 id 를 가진 다른 대화로 옮겨도 그 대화의 조회가 시작되게(독립 리뷰 P2)
  const sentLookupKey = `${chat.conversationId ?? ""}|${wsKey}|${missingSentKey}`;
  useEffect(() => {
    const conversation = conversationRef.current ?? "";
    const ids = missingSentKey ? missingSentKey.split(",").filter((id) => !requestedSent.current.has(`${conversation}:${id}`)) : [];
    if (!ids.length) return;
    ids.forEach((id) => requestedSent.current.add(`${conversation}:${id}`));
    const at = { conversation: conversationRef.current, account: getAccountNamespace(), epoch: chipEpoch.current, ws: wsKeyRef.current };
    const fill = (items: Record<string, Generation>) => {
      if (conversationRef.current !== at.conversation || getAccountNamespace() !== at.account || chipEpoch.current !== at.epoch
        || wsKeyRef.current !== at.ws) {
        ids.forEach((id) => requestedSent.current.delete(`${conversation}:${id}`)); // 다시 열면 다시 묻는다
        return;
      }
      setGenCache((m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, items[id] ?? null])) }));
    };
    api.getGenerationsBatch(ids).then((r) => fill(r.items), () => fill({}));
    // missingSentKey 는 sentLookupKey 안에 있다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentLookupKey]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    // 칩이 있으면 AI 에게는 지금까지와 같은 문장으로 — 고칠 내용을 써야 보낸다(빈 문장 전송 막음)
    const body = revising && text.trim()
      ? `${t("「{title}」 계획을 이렇게 고쳐 주세요").replace("{title}", revising.title || t("계획"))}: ${text.trim()}`
      : text;
    // 보내는 순간의 칩 묶음 — 성공하면 그 묶음만 뺀다(보내는 사이 붙인 칩은 남는다, Codex 1차 P1 5)
    const batch = attachWs ? chipsRef.current : [];
    const attach = batch.length && attachWs ? { workspace: attachWs, items: batch.map((c) => c.item) } : null;
    if (await chat.send(body, attach)) {
      if (batch.length) {
        const sent = new Set(batch.map((c) => c.uid));
        setChips((now) => now.filter((c) => !sent.has(c.uid)));
        setAttachNote(null);
      }
      setText("");
      setRevising(null);
      chat.connect.dismissConnected();
    }
  };
  const scrollToEnd = () => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중의 Enter 는 글자 확정이다 — 보내지 않는다
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  const toggleDrawer = () => {
    if (drawer) return setDrawer(false);
    setMenu(null);
    setDrawer(true);
    void chat.loadConversations();
  };
  const startNew = () => { chat.newConversation(); setText(""); setRevising(null); setScreenOn(true); setDrawer(false); };
  const revise = (title: string) => {
    setRevising({ title });
    inputRef.current?.focus();
  };
  const reuse = (value: string) => { // 내 말 [고쳐 보내기] — 입력칸에 다시 채운다
    setText(value);
    inputRef.current?.focus();
  };

  const engines = chat.session?.engines ?? [];
  const engine = engines.find((e) => e.id === chat.choice?.engine);
  const modelLabel = engine?.models.find((m) => m.id === chat.choice?.model)?.label ?? chat.choice?.model ?? t("모델 없음");
  const blocked = chat.running || chat.sending;
  // Claude 를 아직 못 쓰면 연결 안내 + 입력칸 잠금(허브의 차례 허용 조건과 같다 — available)
  const needsConnect = chat.connect.supported && !chat.connect.allowed && chat.choice?.engine !== "codex";
  const locked = needsConnect || !chat.choice;
  // 머리글 메뉴 — 보고 있는 대화의 요약(목록에 있으면 그것, 없으면 열 때·허브 응답에서 받은 것) · 맨 위 줄은 옆 칸 = 새 창에서 열기, 새 창 = 옆 칸으로 붙이기
  const summary = chat.conversations?.find((c) => c.id === chat.conversationId)
    ?? (chat.current && chat.current.id === chat.conversationId ? chat.current : undefined);
  const headTop = popout
    ? onDock && { icon: <WindowIcon />, label: t("옆 칸으로 붙이기"), run: onDock }
    : onPopOut && {
      icon: <WindowIcon />, label: t("새 창에서 열기"),
      run: () => { if (chat.conversationId && chat.requestOpenInWindow(chat.conversationId)) onPopOut(); },
    };

  return (
    <aside className={`agent-panel${popout ? " popout" : ""}${chat.running ? " is-running" : ""}`} aria-label="MV Agent" {...dropHandlers}>
      {dropping && (
        <div className={`agent-drop${dropping === "blocked" ? " blocked" : ""}`} aria-hidden="true">
          <span className="agent-drop-ic">{dropping === "blocked" ? "!" : "＋"}</span>
          <b>{dropping === "blocked" ? t("공간을 확인한 뒤 다시 끌어 주세요") : t("놓으면 대화에 붙어요")}</b>
          {dropping === "ok" && <small>{t("생성물 · 레퍼런스 · 폴더")}<br />{t("한 번에 8개까지")}</small>}
        </div>
      )}
      {!popout && (
        <div className="agent-resize" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t("MV Agent 칸 너비 조절")} aria-valuemin={MIN_W} aria-valuemax={maxWidth()} aria-valuenow={clampWidth(width)}
          title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary || drag.current) return;
            event.preventDefault(); // 초점을 옮기지 않는다 — 손잡이에 남으면 ←·→ 가 칸 폭을 바꾼다
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.classList.add("resizing");
            const from = clampWidth(width);
            drag.current = { id: event.pointerId, x: event.clientX, from, now: from };
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d || d.id !== event.pointerId) return;
            d.now = clampWidth(d.from - (event.clientX - d.x)); // 칸이 오른쪽에 있어 왼쪽으로 끌면 넓어진다
            showWidth(shown(d.now));
          }}
          onPointerUp={(event) => endDrag(event, true)}
          onPointerCancel={(event) => endDrag(event, false)}
          onLostPointerCapture={(event) => endDrag(event, false)}
          onDoubleClick={() => commitWidth(BASE_W)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowLeft" ? 8 : event.key === "ArrowRight" ? -8 : 0;
            if (!step) return;
            event.preventDefault();
            commitWidth(clampWidth(width) + step);
          }}
        />
      )}
      <header className="agent-head">
        <div className="agent-head-left">
          <button type="button" className={`agent-ic${drawer ? " on" : ""}`} onClick={toggleDrawer}
            aria-expanded={drawer} title={t("대화 목록")} aria-label={t("대화 목록")}>
            <MenuIcon />
          </button>
          {popout ? (
            onDock && (
              <button type="button" className="agent-ic" onClick={onDock} title={t("옆 칸으로 붙이기")} aria-label={t("옆 칸으로 붙이기")}>
                <SidePanelIcon />
              </button>
            )
          ) : (
            <button type="button" className="agent-ic" onClick={onClose} title={t("옆 칸 닫기")} aria-label={t("옆 칸 닫기")}>
              <SidePanelIcon />
            </button>
          )}
          <AgentTitle id={chat.conversationId} title={chat.title} summary={summary} locked={blocked} top={headTop}
            candidates={projectCandidates(context.project, chat.conversations, projectName)} currentProject={context.project}
            onNeedSummary={() => void chat.loadConversations()} onOpen={() => { setDrawer(false); setMenu(null); }}
            onPatch={chat.patchConversation} onDelete={chat.removeConversation} onNote={setHeadNote}
            onLeave={() => { chat.newConversation(); setRevising(null); setScreenOn(true); }} />
        </div>
        <div className="agent-head-actions">
          <button type="button" className="agent-ic" onClick={startNew} disabled={chat.running || chat.sending}
            title={t("새 대화")} aria-label={t("새 대화")}>
            <NewChatIcon />
          </button>
          <button type="button" className={`agent-ic agent-info-btn${infoOpen ? " on" : ""}`} onClick={toggleInfo} aria-pressed={infoOpen}
            title={screenOn ? t("정보") : t("정보 · 지금 화면을 안 보내는 중")} aria-label={t("정보")}>
            <InfoIcon />
            {!screenOn && <span className="agent-info-dot" aria-hidden="true" />}
          </button>
          {!popout && onPopOut && (
            <button type="button" className="agent-ic" onClick={onPopOut} title={t("새 창으로 띄우기")} aria-label={t("새 창으로 띄우기")}>
              <PopOutIcon />
            </button>
          )}
        </div>
      </header>

      {drawer && (
        <AgentDrawer conversations={chat.conversations} currentId={chat.conversationId} running={chat.running}
          locked={chat.running || chat.sending} projectName={projectName} currentProject={context.project} truncated={chat.truncated}
          onNew={startNew}
          onOpen={(id) => { setDrawer(false); setScreenOn(true); setRevising(null); void chat.openConversation(id); }}
          onClose={closeDrawer} onPatch={chat.patchConversation} onDelete={chat.removeConversation}
          /* 새 창에서 열기 — 옆 칸에서만. 새 창이 받을 요청을 적고 지금 [새 창으로 띄우기] 길을 탄다(옆 칸의 지금 대화는 그대로) */
          onOpenInWindow={!popout && onPopOut ? (id) => { if (chat.requestOpenInWindow(id)) { setDrawer(false); onPopOut(); } } : undefined}
          claude={engines.find((e) => e.id === "claude")} />
      )}

      {/* 머리글 아래 = [대화 | 정보 칸]. 정보 칸은 옆에 설 자리가 없을 때만 대화 위에 겹쳐 뜬다(docs/status/MVAgent_정보칸분리_2026-11-12.md) */}
      <div className="agent-body">
      <div className="agent-main">
      <div className="agent-log" ref={logRef} aria-live="polite">
        {chat.connect.connected && (
          <div className="cn-done" role="status">
            <b aria-hidden="true">✓</b>{t("Claude 가 연결됐어요")}
            <small>{chat.connect.connected.subscription
              ? `Claude ${chat.connect.connected.subscription} ${t("구독")}`
              : t("구독 종류는 확인하지 못했어요")}</small>
          </div>
        )}
        {chat.messages.length === 0 && !needsConnect && (
          <div className="agent-empty">
            <span className="agent-empty-mark" aria-hidden="true">⬡</span>
            <p>{t("지금 보는 화면을 같이 보면서 일해요")}</p>
          </div>
        )}
        {groupTools(chat.messages).map((r) => (r.kind === "tools" ? <ToolGroup key={r.id} tools={r.tools} /> : (
          <Message key={r.id} message={r} onExecute={chat.executePlan} onRevise={revise} onReuse={reuse}
            findGeneration={findGeneration} genOf={genOf} onPreview={onPreview} />
        )))}
        {needsConnect && (
          <AgentConnect state={chat.connect.state} version={chat.connect.version} loginWindowEnabled={chat.connect.loginWindowEnabled}
            waiting={chat.connect.waiting} note={chat.connect.note} onConnect={() => void chat.connect.connect()}
            onRecheck={() => void chat.connect.recheck()} onStopWaiting={chat.connect.stopWaiting} />
        )}
      </div>

      {/* 대화 끝의 '일하는 중' 글 대신 입력칸 위에 떠 있는 점 알약 — 누르면 맨 아래로(Aside 'Working — scroll to bottom') */}
      {chat.running && (
        <div className="agent-float" role="status">
          <button type="button" className="agent-working" onClick={scrollToEnd} title={t("맨 아래로")}>
            <span className="agent-dots" aria-hidden="true"><i /><i /><i /></span>
            {chat.turn?.status === "cancelling" ? t("멈추는 중") : t("일하는 중")}
          </button>
        </div>
      )}

      {chat.error && <p className="agent-error" role="alert">{chat.error}</p>}
      {chat.notice && <p className="agent-notice" role="status">{chat.notice}</p>}
      {headNote && <p className="agent-notice" role="status">{headNote}</p>}
      {attachNote && <p className="agent-notice" role="status">{attachNote}</p>}

      <form className="agent-composer" onSubmit={submit}>
        {/* 지금 화면은 머리글 정보 칸으로 옮겼다(docs/status/MVAgent_정보칸_2026-11-12.md) — 입력칸에는 고칠 계획·붙인 자료 칩만 */}
        {(revising || chips.length > 0) && <div className="agent-chips">
          {revising && (
            <div className="agent-context agent-revise">
              <span className="agent-context-mark" aria-hidden="true"><PencilIcon /></span>
              <span className="agent-context-text">
                <b>{t("고칠 계획")}</b>
                <small>{revising.title || t("이름 없는 계획")}</small>
              </span>
              <button type="button" className="agent-context-x" onClick={() => setRevising(null)}
                title={t("고치기 취소")} aria-label={t("고치기 취소")}>×</button>
            </div>
          )}
          {chips.map((c) => (
            <div key={c.uid} className={`agent-context agent-attach${c.pending ? " pending" : ""}`}>
              <span className="agent-attach-thumb" aria-hidden="true">
                {c.thumb ? <img src={c.thumb} alt="" loading="lazy" /> : c.item.kind === "folder" ? <FolderIcon /> : null}
              </span>
              <span className="agent-context-text">
                <b>{c.item.name ?? (c.item.kind === "generation" ? t("생성물") : lastSegment(c.item.path))}</b>
                <small>{c.item.kind === "generation" ? (c.pending ? t("생성물 · 확인 중") : t("생성물"))
                  : c.item.kind === "asset" ? t("레퍼런스") : `${t("폴더")}${c.project ? ` · ${c.project}` : ""}`}</small>
              </span>
              <button type="button" className="agent-context-x" onClick={() => removeChip(c.uid)}
                title={t("붙인 자료 빼기")} aria-label={t("붙인 자료 빼기")}>×</button>
            </div>
          ))}
        </div>}
        <textarea ref={inputRef} className="agent-input" rows={2} value={text} disabled={needsConnect}
          placeholder={needsConnect ? t("Claude 를 연결하면 쓸 수 있어요")
            : revising ? t("어떻게 고칠지 적어 주세요 — 예: 바나나만, 9:16 으로")
            : !screenOn ? t("지금 화면 없이 물어보세요 — 어디인지는 직접 알려 주세요")
            : t("Agent 에게 일을 맡기거나 물어보세요")}
          aria-label={t("Agent 에게 보낼 말")}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <div className="agent-composer-foot">
          {/* 모델 이름 + 생각 깊이(흐리게) 한 단추 — Aside 'GPT-6.1 Sol High ⌄' 처럼 */}
          <div className="agent-model-wrap" ref={modelRef}>
            <button type="button" className="agent-model-btn" disabled={!chat.choice || blocked}
              onClick={() => setMenu(menu === "model" ? null : "model")} aria-haspopup="true" aria-expanded={menu === "model"}
              aria-label={t("모델 고르기")}>
              <span className="agent-co" aria-hidden="true">{chat.choice?.engine === "codex" ? "◎" : "✳"}</span>
              <span>{modelLabel}</span>
              {chat.choice && <span className="agent-model-effort">{t(EFFORT[chat.choice.effort] ?? chat.choice.effort)}</span>}
              {chat.choice?.fast && <span className="agent-fast-mark">{t("빠름")}</span>}
              <Chevron />
            </button>
            {menu === "model" && chat.choice && (
              <ModelMenu engines={engines} choice={chat.choice}
                onChoose={(next) => { chat.choose(next); setMenu(null); }} />
            )}
          </div>
          {chat.running ? (
            <button type="button" className="agent-send agent-stop" onClick={() => void chat.cancel()}
              disabled={chat.turn?.status === "cancelling"} title={t("멈추기")} aria-label={t("멈추기")}>
              <span className="agent-stop-mark" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-send" disabled={blocked || locked || !text.trim()}
              title={t("보내기")} aria-label={t("보내기")}>
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </form>
      </div>
      {infoOpen && (
        <section className={`agent-info ${infoSide ? "side" : "over"}`} aria-label={t("정보")}>
          <InfoCardBox title={t("지금 화면")} folded={infoFold.includes("screen")} onFold={() => foldCard("screen")}
            extra={(
              <span className="agent-info-switch">
                {t("AI 에게 보내기")}
                <button type="button" role="switch" aria-checked={screenOn} className={`agent-switch${screenOn ? " on" : ""}`}
                  onClick={() => setScreenOn((on) => !on)} aria-label={t("지금 화면 AI 에게 보내기")} />
              </span>
            )}>
            <dl className="agent-info-rows">
              <dt>{t("화면")}</dt><dd>{contextLabel}</dd>
              <dt>{t("공간")}</dt>
              <dd>{context.workspace?.name || (context.workspace?.scope === "personal" ? t("개인") : context.workspace?.scope === "team" ? t("팀") : t("확인 중"))}</dd>
              {context.project && <><dt>{t("프로젝트")}</dt><dd>{projectName?.(context.project) ?? context.project}</dd></>}
              {context.folder && <><dt>{t("폴더")}</dt><dd>{context.folder}</dd></>}
              <dt>{t("고른 카드")}</dt><dd>{`${context.selected_ids?.length ?? 0}${t("장")}`}</dd>
              {(context.tab === "compose" || context.scene) && <><dt>{t("열린 씬")}</dt><dd>{context.scene?.name ?? t("없음")}</dd></>}
            </dl>
            <p className="agent-info-note">{screenOn ? t("보내면 AI 가 '여기·이 폴더'를 이 위치로 알아들어요.")
              : t("안 보내는 중 — '여기'라고 하면 AI 가 어디인지 먼저 물어요.")}</p>
          </InfoCardBox>
          <InfoCardBox title={t("이 대화에서 만든 것")} count={madeIds.length} folded={infoFold.includes("made")} onFold={() => foldCard("made")}>
            {madeIds.length ? (
              <div className="agent-info-grid">
                {madeIds.map((id) => <SentAttachment key={id} item={{ kind: "generation", id }} genOf={genOf} onPreview={onPreview} />)}
              </div>
            ) : <p className="agent-info-empty">{t("아직 없어요")}</p>}
          </InfoCardBox>
          <InfoCardBox title={t("붙였던 자료")} count={attachedBefore.length} folded={infoFold.includes("attached")} onFold={() => foldCard("attached")}>
            {attachedBefore.length ? (
              <ul className="agent-info-list">
                {attachedBefore.map((a) => (
                  <li key={attachKey(a)}>
                    <span>{a.name ?? (a.kind === "generation" ? t("생성물") : lastSegment(a.path))}</span>
                    <small>{a.kind === "generation" ? t("생성물") : a.kind === "asset" ? t("레퍼런스") : t("폴더")}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="agent-info-empty">{t("아직 없어요")}</p>}
          </InfoCardBox>
        </section>
      )}
      </div>
    </aside>
  );
}

/** 정보 칸 카드 하나 — 머리(제목·개수·⌄)를 누르면 접힌다. extra(보내기 스위치)는 접어도 머리에 남는다 */
function InfoCardBox({ title, count, folded, onFold, extra, children }: {
  title: string; count?: number; folded: boolean; onFold: () => void; extra?: ReactNode; children: ReactNode;
}) {
  return (
    <div className={`agent-info-sec${folded ? " folded" : ""}`}>
      <h4>
        <button type="button" className="agent-info-fold" aria-expanded={!folded} onClick={onFold}>
          <span>{title}</span>
          {count ? <span className="agent-info-count">{count}</span> : null}
          <Chevron />
        </button>
        {extra}
      </h4>
      {!folded && children}
    </div>
  );
}

function Message({ message: m, onExecute, onRevise, onReuse, findGeneration, genOf, onPreview }: {
  message: AgentMessage;
  onExecute: (planId: string) => void;
  onRevise: (title: string) => void;
  onReuse: (text: string) => void;
  findGeneration?: (id: string) => Generation | undefined;
  genOf: (id: string) => Generation | undefined; // 붙인 생성물 썸네일 — 앱 카드 또는 칸이 읽어 둔 것
  onPreview?: (target: PreviewTarget) => void;
}) {
  switch (m.kind) {
    case "user":
      return <UserMessage text={m.text} attachments={m.attachments} genOf={genOf} onPreview={onPreview} onReuse={onReuse} />;
    case "assistant":
      return <div className="agent-msg agent-assistant"><AgentMarkdown text={m.text} /></div>;
    case "tool":
      return <ToolGroup tools={[m]} />;
    case "plan":
      return <AgentPlanCard plan={m.plan} exec={m.exec} estimate={m.estimate} progress={m.progress} onExecute={() => onExecute(m.plan.plan_id)}
        onRevise={() => onRevise(m.plan.title ?? "")} findGeneration={findGeneration} onPreview={onPreview} />;
    case "notice":
      return <div className="agent-notice" role="status">{m.text}</div>;
    case "error":
      return <div className="agent-msg agent-msg-error" role="alert">{m.message}</div>;
  }
}

/** 도구 묶음 한 줄 — "MV Hub · 자료 조회 2번, 계획 저장 끝". 이름별 횟수(처음 나온 순서)를 앞 3개까지, 나머지는 "외 N".
 *  하나라도 도는 중이면 '하는 중', 실패가 있으면 '실패'. 누르면 하나씩 펼친다. */
function ToolGroup({ tools }: { tools: ToolMessage[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const counts = new Map<string, number>();
  for (const x of tools) counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
  const labels = [...counts].map(([name, n]) => `${t(TOOL[name] ?? name)}${n > 1 ? ` ${n}${t("번")}` : ""}`);
  const summary = labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` ${t("외")} ${labels.length - 3}` : "");
  const status = tools.some((x) => x.status === "started") ? "started" : tools.some((x) => x.status === "failed") ? "failed" : "done";
  return (
    <div className="agent-tools">
      <button type="button" className={`agent-tool is-${status}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="agent-tool-mark" aria-hidden="true" />
        {status === "started" && <span className="agent-tool-spin" aria-hidden="true" />}
        MV Hub · {summary} <span className="agent-tool-state">{t(TOOL_STATE[status])}</span>
        <Chevron />
      </button>
      {open && (
        <ul className="agent-tool-list">
          {tools.map((x) => (
            <li key={x.id} className={`is-${x.status}`}>
              <span className="agent-tool-li-mark" aria-hidden="true">{x.status === "done" ? "✓" : x.status === "failed" ? "✕" : "·"}</span>
              {t(TOOL[x.name] ?? x.name)} <small>{t(TOOL_STATE[x.status] ?? x.status)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 내 말 — 올리면 [복사][고쳐 보내기](Aside Copy · Edit message). 고쳐 보내기는 입력칸에 다시 채울 뿐 바로 보내지 않는다. */
function UserMessage({ text, attachments, genOf, onPreview, onReuse }: {
  text: string;
  attachments?: AgentAttachment[];
  genOf: (id: string) => Generation | undefined;
  onPreview?: (target: PreviewTarget) => void;
  onReuse: (text: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }, () => {});
  };
  return (
    <div className="agent-user-wrap">
      {attachments?.length ? (
        <div className="agent-sent" aria-label={t("붙인 자료")}>
          {attachments.map((a) => <SentAttachment key={attachKey(a)} item={a} genOf={genOf} onPreview={onPreview} />)}
        </div>
      ) : null}
      <div className="agent-msg agent-user">{text}</div>
      <div className="agent-user-acts">
        <button type="button" className="agent-mini" onClick={copy} title={copied ? t("복사했어요") : t("복사")} aria-label={t("복사")}>
          {copied ? <span aria-hidden="true">✓</span> : <CopyIcon />}
        </button>
        <button type="button" className="agent-mini" onClick={() => onReuse(text)} title={t("고쳐 보내기")} aria-label={t("고쳐 보내기")}>
          <PencilIcon />
        </button>
      </div>
    </div>
  );
}

/** 내 말 위 붙인 자료 하나 — 생성물은 누르면 기존 크게 보기, 어셋은 썸네일(못 그리면 빈 칸), 폴더는 이름 칩(설계 2-5) */
function SentAttachment({ item, genOf, onPreview }: {
  item: AgentAttachment;
  genOf: (id: string) => Generation | undefined;
  onPreview?: (target: PreviewTarget) => void;
}) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  if (item.kind === "folder") {
    return <span className="agent-sent-folder" title={item.path}><FolderIcon /><span>{item.name ?? lastSegment(item.path)}</span></span>;
  }
  if (item.kind === "asset") {
    return (
      <span className="agent-sent-tile" title={item.path}>
        {!broken && <img src={assetThumbUrl(item.project, item.path, 256)} alt="" loading="lazy" onError={() => setBroken(true)} />}
      </span>
    );
  }
  const gen = genOf(item.id);
  const thumb = gen ? thumbOf(gen, 256) : null;
  const asset = gen?.assets?.[0];
  if (gen && asset && onPreview) {
    return (
      <button type="button" className="agent-sent-tile" title={item.name ?? t("생성물")} aria-label={t("붙인 생성물 크게 보기")}
        onClick={() => onPreview({ url: asset.file_path, type: asset.type, name: gen.prompt.slice(0, 50) || t("(제목 없음)"), genId: gen.id,
          thumb: thumbOf(gen, 512) })}>
        {thumb && <img src={thumb} alt="" loading="lazy" />}
      </button>
    );
  }
  return <span className="agent-sent-tile" title={item.name ?? t("생성물")}>{thumb && <img src={thumb} alt="" loading="lazy" />}</span>;
}

// 서랍 넓이(설계 docs/status/MVAgent_서랍메뉴_2026-11-12.md 2-4) — 최소 220 · 최대 = 칸 폭 − 40(칸이 좁으면 최대가 이긴다) · 기본 310
const DRAWER_BASE_W = 310;
const DRAWER_MIN_W = 220;
const clampDrawer = (w: number, panelW: number) => Math.round(Math.min(panelW - 40, Math.max(DRAWER_MIN_W, w)));
const SESSION_FILE_NOTE: Record<AgentSessionFileResult, string> = {
  deleted: "지웠어요 · Claude 기억(세션 파일)도 지웠어요",
  not_found: "지웠어요 · Claude 세션 파일은 확인하지 못해 남겨 뒀어요",
  failed: "지웠어요 · Claude 세션 파일은 지우지 못했어요",
  codex_kept: "지웠어요 · Codex 기록은 Codex 폴더에 남아요",
  none: "지웠어요",
};
// sub = 프로젝트 하위 메뉴, side = 펼칠 쪽(오른쪽 자리가 없으면 왼쪽, 둘 다 없으면 아래로 — 좁은 새 창, 독립 리뷰 P2)
type RowMenu = { id: string; top: number; left: number; sub: boolean; side?: "right" | "left" | "below" };
const ROW_MENU_W = 232;
const PIN_GROUP = "__pinned__";
const ARCHIVE_GROUP = "__archived__"; // 보관함 — 처음엔 접혀 있다
type RowAct = "pin" | "unread" | "rename" | "archive" | "delete";
const ROW_KEYS: Record<string, RowAct | undefined> = { KeyP: "pin", KeyU: "unread", KeyR: "rename", KeyA: "archive", KeyD: "delete" };
type SubSide = NonNullable<RowMenu["side"]>;
type MenuTop = { icon: ReactNode; label: string; run: () => void }; // 메뉴 맨 위 한 줄(새 창에서 열기 / 옆 칸으로 붙이기)

/** 프로젝트 하위 메뉴를 펼칠 쪽 — 칸(새 창이면 창) 안에서 오른쪽 자리가 없으면 왼쪽, 그래도 없으면 메뉴 안 아래로 */
const subSide = (leftInPanel: number, room: number): SubSide =>
  leftInPanel + ROW_MENU_W * 2 <= room ? "right" : leftInPanel >= ROW_MENU_W ? "left" : "below";

/** 프로젝트로 옮기기 후보 — 지금 화면 프로젝트 · 서랍에 이름이 보이는 프로젝트(id 별) · 없음. 이름 모르는 것은 고를 수 없다 */
function projectCandidates(currentProject: string | undefined, conversations: AgentConversationSummary[] | null,
  projectName?: (id: string) => string | undefined) {
  const out: { id: string; name: string }[] = [];
  for (const id of [currentProject, ...(conversations ?? []).map((c) => c.project)]) {
    const name = id ? projectName?.(id) : undefined;
    if (id && name && !out.some((p) => p.id === id)) out.push({ id, name });
  }
  return out;
}

/** 메뉴가 열린 동안 글자 단축키 — 자판과 무관하게 event.code, 입력·조합·수정키·반복은 무시. run 은 누를 때의 최신 것(잠금을 다시 본다, 설계 2-1) */
function useMenuKeys(enabled: boolean, run: (kind: RowAct) => void) {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const kind = ROW_KEYS[e.code];
      if (!kind) return;
      e.preventDefault();
      runRef.current(kind);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** 대화 메뉴 본문 — 서랍 줄(⋯·우클릭)과 머리글 제목이 같이 쓴다. 바꾸는 항목은 busy 면 잠근다(맨 위 줄은 늘 된다) */
function ConversationMenu({ target, menuRef, style, sub, side, busy, top, showUnread, candidates, currentProject, onAct, onToggleSub, onProject }: {
  target: AgentConversationSummary;
  menuRef: RefObject<HTMLDivElement>;
  style: CSSProperties;
  sub: boolean;
  side?: SubSide;
  busy: boolean;
  top?: MenuTop;
  showUnread: boolean;
  candidates: { id: string; name: string }[];
  currentProject?: string;
  onAct: (kind: RowAct) => void;
  onToggleSub: () => void;
  onProject: (id: string | null) => void;
}) {
  const t = useT();
  const noProject = t("프로젝트 없음");
  return (
    <div className={`agent-row-menu${sub && side === "below" ? " stacked" : ""}`} role="menu" aria-label={t("대화 메뉴")} ref={menuRef} style={style}>
      {top && (
        <>
          <button type="button" role="menuitem" className="agent-row-mi" onClick={top.run}>{top.icon}<span>{top.label}</span></button>
          <div className="agent-menu-sep" />
        </>
      )}
      <button type="button" role="menuitem" className="agent-row-mi" disabled={busy} onClick={() => onAct("pin")}>
        <PinIcon /><span>{t(target.pinned ? "고정 풀기" : "고정")}</span><kbd>P</kbd>
      </button>
      {showUnread && (
        <button type="button" role="menuitem" className="agent-row-mi" disabled={busy} onClick={() => onAct("unread")}>
          <UnreadIcon /><span>{t(target.unread ? "읽음으로 표시" : "읽지 않음으로 표시")}</span><kbd>U</kbd>
        </button>
      )}
      <button type="button" role="menuitem" className="agent-row-mi" disabled={busy} onClick={() => onAct("rename")}>
        <PenIcon /><span>{t("이름 바꾸기")}</span><kbd>R</kbd>
      </button>
      <div className="agent-menu-sep" />
      <div className="agent-row-sub-wrap">
        <button type="button" role="menuitem" className={`agent-row-mi${sub ? " on" : ""}`} aria-haspopup="menu" aria-expanded={sub}
          disabled={busy} onClick={onToggleSub}>
          <FolderIcon /><span>{t("프로젝트로 옮기기")}</span><Chevron />
        </button>
        {sub && (
          <div className={`agent-row-sub ${side ?? "right"}`} role="menu" aria-label={t("프로젝트로 옮기기")}>
            {candidates.map((p) => (
              <button key={p.id} type="button" role="menuitemradio" aria-checked={target.project === p.id} className="agent-row-mi"
                onClick={() => onProject(p.id)}>
                <span>{p.id === currentProject ? `${p.name} · ${t("지금 화면")}` : p.name}</span>
                {target.project === p.id && <i className="agent-row-check" aria-hidden="true">✓</i>}
              </button>
            ))}
            <button type="button" role="menuitemradio" aria-checked={!target.project} className="agent-row-mi" onClick={() => onProject(null)}>
              <span>{noProject}</span>{!target.project && <i className="agent-row-check" aria-hidden="true">✓</i>}
            </button>
          </div>
        )}
      </div>
      <div className="agent-menu-sep" />
      <button type="button" role="menuitem" className="agent-row-mi" disabled={busy} onClick={() => onAct("archive")}>
        <ArchiveIcon /><span>{t(target.archived ? "보관 풀기" : "보관")}</span><kbd>A</kbd>
      </button>
      <button type="button" role="menuitem" className="agent-row-mi danger" disabled={busy} onClick={() => onAct("delete")}>
        <TrashIcon /><span>{t("삭제")}</span><kbd>D</kbd>
      </button>
    </div>
  );
}

/** 지우기 확인 창 — 칸 기록과 Claude 세션 파일이 같이 지워진다(Codex 는 기록이 남는다) */
function DeleteConfirm({ target, onCancel, onConfirm }: { target: AgentConversationSummary; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  return (
    <div className="agent-drawer-confirm" role="dialog" aria-modal="true" aria-label={t("이 대화를 지울까요?")}>
      <h4>{t("이 대화를 지울까요?")}</h4>
      <p className="agent-confirm-title">「{target.title || t("제목 없음")}」</p>
      <p>{t("칸 기록과 이 대화의 Claude 기억(세션 파일)이 함께 지워지고 되돌릴 수 없어요. 만든 그림은 라이브러리에 그대로 남아요.")}</p>
      {target.engine === "codex" && <p>{t("Codex 대화는 Codex 기록이 Codex 폴더에 남아요.")}</p>}
      <div className="agent-confirm-acts">
        <button type="button" className="agent-confirm-btn" onClick={onCancel}>{t("취소")}</button>
        <button type="button" className="agent-confirm-btn danger" autoFocus onClick={onConfirm}>{t("삭제")}</button>
      </div>
    </div>
  );
}

/** 머리글 제목 — 대화가 있으면 [제목 ⌄] 단추: 누르면 서랍 줄과 같은 메뉴(읽지 않음은 뺌 — 보고 있는 대화라 바로 읽음),
 *  이름 바꾸기는 제목 자리에서(Enter 저장 · Esc 취소), 보관하면 칸은 새 대화로. 답을 받는 중엔 바꾸는 항목을 잠근다.
 *  (시안 head-menu.png, Jay 11-12 "시안대로 만들고") */
function AgentTitle({ id, title, summary, locked, top, candidates, currentProject, onNeedSummary, onOpen, onPatch, onDelete, onLeave, onNote }: {
  id: string | null; // 없으면 아직 보낸 적 없는 새 대화 — 바꿀 것이 없어 단추를 안 보인다
  title: string | null;
  summary?: AgentConversationSummary;
  locked: boolean;
  top?: MenuTop;
  candidates: { id: string; name: string }[];
  currentProject?: string;
  onNeedSummary: () => void; // 요약을 아직 모르면(막 시작한 대화) 목록을 읽어 온다
  onOpen: () => void;
  onPatch: (id: string, body: AgentConversationPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<AgentSessionFileResult | null>;
  onLeave: () => void;
  onNote: (text: string) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ top: number; left: number; sub: boolean; side?: SubSide } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [clip, setClip] = useState(false); // 넘칠 때만 끝을 흐린다 — 단추가 글자 폭만 차지해서, 늘 흐리면 짧은 제목의 끝 글자가 잘려 보인다
  const shown = title || t("새 대화");
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const check = () => setClip(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, id, renaming]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useEscapeClose(() => { setMenu(null); btnRef.current?.focus(); }, !!menu && !menu.sub);
  useEscapeClose(() => setMenu((m) => (m ? { ...m, sub: false } : m)), !!menu?.sub);
  useEscapeClose(() => setRenaming(null), renaming !== null);
  useEscapeClose(() => setConfirm(false), confirm);
  useOutsideMouseDown(menuRef, closeMenu, !!menu, btnRef);
  useEffect(() => { setMenu(null); setRenaming(null); setConfirm(false); }, [id]); // 대화가 바뀌면 열린 것을 닫는다

  const panelOf = () => btnRef.current?.closest<HTMLElement>(".agent-panel") ?? null;
  const openMenu = () => {
    const btn = btnRef.current, panel = panelOf();
    if (!btn || !panel) return;
    const b = btn.getBoundingClientRect(), p = panel.getBoundingClientRect();
    if (!summary) onNeedSummary();
    onOpen();
    setMenu({ left: Math.max(8, Math.min(b.left - p.left, p.width - ROW_MENU_W - 8)), top: b.bottom - p.top + 4, sub: false });
  };
  const act = (kind: RowAct) => {
    setMenu(null);
    if (!summary || locked || kind === "unread") return;
    if (kind === "pin") return void onPatch(summary.id, { pinned: !summary.pinned });
    if (kind === "archive") {
      const archiving = !summary.archived;
      return void onPatch(summary.id, { archived: archiving }).then((ok) => { if (ok && archiving) onLeave(); });
    }
    if (kind === "rename") return setRenaming(summary.title ?? title ?? "");
    setConfirm(true);
  };
  useMenuKeys(!!menu && !menu.sub && !!summary, act);
  const saveRename = async () => {
    if (renaming === null || !summary) return;
    const text = renaming.trim();
    if (text.length < 1 || text.length > 80) return; // 허브도 같은 규칙(1~80자)
    if (await onPatch(summary.id, { title: text })) setRenaming(null);
  };
  const doDelete = async () => {
    if (!summary) return;
    setConfirm(false);
    const result = await onDelete(summary.id);
    if (result) onNote(t(SESSION_FILE_NOTE[result]));
  };

  if (!id) return <span className="agent-title"><span>{shown}</span></span>;
  return (
    <>
      {renaming !== null ? (
        <input className="agent-title-rename" autoFocus value={renaming} maxLength={80} aria-label={t("새 이름")}
          onChange={(e) => setRenaming(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void saveRename(); } }}
          onBlur={() => setRenaming(null)} />
      ) : (
        <button type="button" ref={btnRef} className={`agent-title-btn${menu ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!menu}
          title={t("대화 메뉴")} onClick={() => (menu ? setMenu(null) : openMenu())}>
          <span ref={textRef} className={clip ? "clip" : undefined}>{shown}</span><Chevron />
        </button>
      )}
      {menu && summary && (
        <ConversationMenu target={summary} menuRef={menuRef} style={{ top: menu.top, left: menu.left }} sub={menu.sub} side={menu.side}
          busy={locked} top={top && { ...top, run: () => { setMenu(null); top.run(); } }} showUnread={false} candidates={candidates} currentProject={currentProject} onAct={act}
          onToggleSub={() => setMenu((m) => m && { ...m, sub: !m.sub, side: subSide(m.left, panelOf()?.clientWidth || window.innerWidth) })}
          onProject={(project) => { setMenu(null); void onPatch(summary.id, { project }); }} />
      )}
      {confirm && summary && <DeleteConfirm target={summary} onCancel={() => setConfirm(false)} onConfirm={() => void doDelete()} />}
    </>
  );
}

/** ≡ 대화 서랍 — [새 대화] · 고정됨 · 프로젝트별 대화(고른 것 회색 칸 · 일하는 중 라임 고리 · 읽지 않음 라임 점) · 보관함 ·
 *  맨 아래 한 줄(Claude · 요금제 / Claude Code 판·새 판). 행마다 ⋯ · 우클릭 메뉴(설계 2-1)와 오른쪽 끝선 넓이 조절(2-4).
 *  보내는 중·일하는 중에는 고르기와 그 대화의 바꾸는 항목만 잠근다. 설정 칸(새 대화 모델·칸 위치)은 넣지 않는다(Jay 11-10).
 *  요금제 = 허브가 Claude Code 설정의 표시 이름(Ultra 등)을 같은 계정일 때만 싣는다(docs/status/MVAgent_서랍아래줄_2026-11-10.md). */
function AgentDrawer({ conversations, currentId, running, locked, projectName, currentProject, truncated, onNew, onOpen, onClose,
  onPatch, onDelete, onOpenInWindow, claude }: {
  conversations: AgentConversationSummary[] | null;
  currentId: string | null;
  running: boolean;
  locked: boolean;
  projectName?: (id: string) => string | undefined;
  currentProject?: string;
  truncated: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
  onPatch: (id: string, body: AgentConversationPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<AgentSessionFileResult | null>;
  onOpenInWindow?: (id: string) => void;
  claude?: AgentEngine;
}) {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set([ARCHIVE_GROUP]));
  const [version, setVersion] = useState<{ current: string | null; latest: string | null; newer: boolean } | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<AgentConversationSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { // 서랍을 열 때 한 번 — 허브가 최신 판을 6시간 기억한다
    let live = true;
    agentChatApi.claudeVersion().then((v) => { if (live) setVersion(v); }, () => {});
    return () => { live = false; };
  }, []);

  // ── 넓이 — 고른 폭은 남기고 보이는 폭은 칸 폭에 맞춘다(칸 폭이 바뀌면 다시) ──
  const [width, setWidth] = useState(() => {
    const saved = loadJSON<unknown>(STORAGE_KEYS.agentDrawerWidth);
    return typeof saved === "number" && Number.isFinite(saved) ? saved : DRAWER_BASE_W;
  });
  const [panelW, setPanelW] = useState(() => (typeof window === "undefined" ? 520 : window.innerWidth));
  useLayoutEffect(() => {
    const panel = navRef.current?.parentElement;
    if (!panel) return;
    const measure = () => setPanelW(panel.clientWidth || window.innerWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const shown = clampDrawer(width, panelW);
  const commitWidth = (next: number) => {
    const w = clampDrawer(next, panelW);
    setWidth(w);
    saveJSON(STORAGE_KEYS.agentDrawerWidth, w);
  };
  const drag = useRef<{ id: number; x: number; from: number } | null>(null);

  // ── 겹(Esc 한 번에 한 겹) — 하위 메뉴 → 행 메뉴 → 이름 바꾸기 → 확인 창 → 서랍 ──
  const menuNow = useRef(menu);
  menuNow.current = menu;
  const focusMore = (id: string) => window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLButtonElement>(`[data-more="${id}"]`)?.focus());
  const closeMenu = useCallback(() => {
    const open = menuNow.current;
    setMenu(null);
    if (open) focusMore(open.id); // Esc·바깥 누름으로 닫으면 ⋯ 로 초점을 돌린다
  }, []);
  useEscapeClose(closeMenu, !!menu && !menu.sub);
  useEscapeClose(() => setMenu((m) => (m ? { ...m, sub: false } : m)), !!menu?.sub);
  useEscapeClose(() => setRenaming(null), !!renaming);
  useEscapeClose(() => setConfirm(null), !!confirm);
  useOutsideMouseDown(menuRef, closeMenu, !!menu);

  const byId = new Map((conversations ?? []).map((c) => [c.id, c]));
  const target = menu ? byId.get(menu.id) : undefined;
  const busyRow = (id: string) => locked && id === currentId; // 보내는 중·도는 대화는 바꾸지 않는다
  const openMenuAt = (id: string, row: DOMRect | null, point?: { x: number; y: number }) => {
    const nav = navRef.current?.getBoundingClientRect();
    if (!nav) return;
    setNote(null);
    const left = point ? point.x - nav.left : (row ? row.right - nav.left - 232 : 8);
    const top = point ? point.y - nav.top : (row ? row.bottom - nav.top + 2 : 8);
    setMenu({ id, left: Math.max(8, Math.min(left, nav.width - 240)), top: Math.max(8, top), sub: false });
  };
  useLayoutEffect(() => { // 아래로 넘치면 위로 올린다
    const el = menuRef.current, nav = navRef.current;
    if (!el || !nav || !menu) return;
    const over = el.offsetTop + el.offsetHeight - (nav.clientHeight - 8);
    if (over > 0) el.style.top = `${Math.max(8, el.offsetTop - over)}px`;
  }, [menu]);

  const act = async (kind: RowAct | "window", c: AgentConversationSummary) => {
    setMenu(null);
    if (kind === "window") return onOpenInWindow?.(c.id);
    if (busyRow(c.id)) return;
    if (kind === "pin") return void onPatch(c.id, { pinned: !c.pinned });
    if (kind === "unread") return void onPatch(c.id, { unread: !c.unread });
    if (kind === "archive") return void onPatch(c.id, { archived: !c.archived });
    if (kind === "rename") return setRenaming({ id: c.id, text: c.title ?? "" });
    setConfirm(c);
  };
  useMenuKeys(!!menu && !menu.sub && !!target, (kind) => { if (target) void act(kind, target); });

  const saveRename = async () => {
    if (!renaming) return;
    const text = renaming.text.trim();
    if (text.length < 1 || text.length > 80) return; // 허브도 같은 규칙(1~80자)
    const id = renaming.id;
    if (await onPatch(id, { title: text })) setRenaming(null);
  };
  const doDelete = async () => {
    const c = confirm;
    if (!c) return;
    setConfirm(null);
    const result = await onDelete(c.id);
    if (result) setNote(t(SESSION_FILE_NOTE[result]));
  };

  const candidates = projectCandidates(currentProject, conversations, projectName);

  const noProject = t("프로젝트 없음");
  // 고정됨 → 프로젝트 묶음(최근 순, '프로젝트 없음'은 뒤) → 보관함. 이름을 모르는 프로젝트(지금 공간 밖)는 한 묶음으로
  const pinned = (conversations ?? []).filter((c) => c.pinned && !c.archived);
  const archived = (conversations ?? []).filter((c) => c.archived);
  const groups: { key: string; label: string; items: AgentConversationSummary[] }[] = [];
  if (pinned.length) groups.push({ key: PIN_GROUP, label: t("고정됨"), items: pinned });
  const byProject: typeof groups = [];
  for (const c of conversations ?? []) {
    if (c.pinned || c.archived) continue;
    const label = c.project ? projectName?.(c.project) ?? t("다른 공간 프로젝트") : noProject;
    const group = byProject.find((g) => g.label === label);
    if (group) group.items.push(c);
    else byProject.push({ key: `p:${label}`, label, items: [c] });
  }
  byProject.sort((a, b) => Number(a.label === noProject) - Number(b.label === noProject));
  groups.push(...byProject);
  if (archived.length) groups.push({ key: ARCHIVE_GROUP, label: `${t("보관함")} ${archived.length}`, items: archived });
  const fold = (key: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <>
      <div className="agent-drawer-dim" onMouseDown={onClose} aria-hidden="true" />
      <nav className="agent-drawer" aria-label={t("대화 목록")} ref={navRef} style={{ width: shown }}>
        <button type="button" className="agent-drawer-new" onClick={onNew} disabled={locked}>
          <NewChatIcon /><span>{t("새 대화")}</span>
        </button>
        <div className="agent-drawer-list">
          {conversations === null ? (
            <p className="agent-menu-note">{t("불러오는 중")}</p>
          ) : groups.length === 0 ? (
            <p className="agent-menu-note">{t("지난 대화가 없어요")}</p>
          ) : groups.map((g) => (
            <div key={g.key} className={`agent-drawer-group${g.key === ARCHIVE_GROUP ? " archive" : ""}`}>
              <button type="button" className="agent-drawer-ghead" aria-expanded={!folded.has(g.key)} onClick={() => fold(g.key)}>
                {g.key === ARCHIVE_GROUP && <ArchiveIcon />}<span>{g.label}</span><Chevron />
              </button>
              {!folded.has(g.key) && (
                <div className="agent-drawer-items">
                  {g.items.map((c) => (renaming?.id === c.id ? (
                    <div key={c.id} className="agent-drawer-row on">
                      <input className="agent-drawer-rename" autoFocus value={renaming.text} maxLength={80} aria-label={t("새 이름")}
                        onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void saveRename(); }
                        }}
                        onBlur={() => setRenaming(null)} />
                    </div>
                  ) : (
                    <div key={c.id} className={`agent-drawer-row${c.id === currentId ? " on" : ""}${menu?.id === c.id ? " menu" : ""}`}
                      onContextMenu={(e) => { e.preventDefault(); openMenuAt(c.id, null, { x: e.clientX, y: e.clientY }); }}>
                      <button type="button" className={`agent-drawer-item${c.id === currentId ? " on" : ""}`}
                        disabled={locked} onClick={() => (c.id === currentId ? onClose() : onOpen(c.id))}>
                        {c.pinned && !c.archived && <PinIcon />}
                        <span>{c.title || t("제목 없음")}</span>
                        {!c.resumable && <small>{t("이어 가기 불가")}</small>}
                        {running && c.id === currentId ? <i className="agent-drawer-dot" title={t("일하는 중")} />
                          : c.unread && <i className="agent-drawer-unread" title={t("읽지 않음")} />}
                      </button>
                      <button type="button" className="agent-drawer-more" data-more={c.id} aria-haspopup="menu" aria-expanded={menu?.id === c.id}
                        title={t("대화 메뉴")} aria-label={t("대화 메뉴")}
                        onClick={(e) => (menu?.id === c.id ? closeMenu() : openMenuAt(c.id, e.currentTarget.parentElement!.getBoundingClientRect()))}>
                        <DotsIcon />
                      </button>
                    </div>
                  )))}
                </div>
              )}
            </div>
          ))}
          {truncated && <p className="agent-menu-note">{t("최근 500개만 보여요")}</p>}
        </div>
        {note && <p className="agent-drawer-note" role="status">{note}</p>}

        {menu && target && (
          <ConversationMenu target={target} menuRef={menuRef} style={{ top: menu.top, left: menu.left }} sub={menu.sub} side={menu.side}
            busy={busyRow(target.id)} showUnread candidates={candidates} currentProject={currentProject}
            top={onOpenInWindow && { icon: <WindowIcon />, label: t("새 창에서 열기"), run: () => void act("window", target) }}
            onAct={(kind) => void act(kind, target)}
            onToggleSub={() => {
              const nav = navRef.current;
              setMenu({ ...menu, sub: !menu.sub, side: subSide((nav?.offsetLeft ?? 0) + menu.left, nav?.parentElement?.clientWidth || window.innerWidth) });
            }}
            onProject={(project) => { setMenu(null); void onPatch(target.id, { project }); }} />
        )}

        {confirm && <DeleteConfirm target={confirm} onCancel={() => setConfirm(null)} onConfirm={() => void doDelete()} />}

        <div className="agent-drawer-resize" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t("대화 목록 너비 조절")} aria-valuemin={Math.min(DRAWER_MIN_W, panelW - 40)} aria-valuemax={panelW - 40} aria-valuenow={shown}
          title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary || drag.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, from: shown };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            setWidth(clampDrawer(d.from + (e.clientX - d.x), panelW)); // 서랍은 왼쪽에 있어 오른쪽으로 끌면 넓어진다
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            drag.current = null;
            commitWidth(d.from + (e.clientX - d.x));
          }}
          onPointerCancel={() => { drag.current = null; }}
          onDoubleClick={() => commitWidth(DRAWER_BASE_W)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" ? 8 : e.key === "ArrowLeft" ? -8 : 0;
            if (!step) return;
            e.preventDefault();
            commitWidth(shown + step);
          }}
        />
        <div className="agent-drawer-foot">
          <span className="agent-drawer-plan">
            <span className="agent-co" aria-hidden="true">✳</span>
            {claude?.available ? <>Claude{claude.subscription && <small> · {claude.subscription}</small>}</> : t("Claude 연결 안 됨")}
          </span>
          {/* 지금 쓰는 판(v2.1.296) — 업데이트하면 올라간다. 새 판이 있으면 라임 글자 + 알림(Jay 11-10 "새 판 대신 앞에 v만").
              [업데이트] 단추는 docs/status/MVAgent_ClaudeCode업데이트_2026-11-10.md 설계·검토 뒤 이 자리에 */}
          {version?.current && (
            <span className={`agent-drawer-ver${version.newer ? " new" : ""}`}
              title={version.newer && version.latest ? `v${version.latest} ${t("이 나왔어요")}` : t("Claude Code 판")}>
              v{version.current}
            </span>
          )}
        </div>
      </nav>
    </>
  );
}

/** [모델 ⌄] 한 메뉴(Aside 모델 메뉴처럼) — 모델 찾기 · 회사별 모델(못 쓰는 회사는 머리에 까닭, 고를 수 없음) ·
 *  생각 깊이 · 속도(Opus 만 빠름 — Claude 추가 사용 크레딧). 하나 고르면 닫힌다. 다른 회사 모델을 고르면 새 대화(useAgentChat). */
function ModelMenu({ engines, choice, onChoose }: {
  engines: AgentEngine[];
  choice: AgentChoice;
  onChoose: (next: AgentChoice) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const current = engines.find((e) => e.id === choice.engine);
  const effortFor = (e: AgentEngine) => e.efforts.includes(choice.effort) ? choice.effort : e.efforts.includes("medium") ? "medium" : e.efforts[0] ?? "medium";
  const groups = engines.map((e) => ({ e, models: e.models.filter((m) => !q || `${GROUP[e.id] ?? e.id} ${m.label}`.toLowerCase().includes(q)) }))
    .filter((g) => g.models.length > 0);
  const fastShown = choice.engine === "claude" && choice.model === FAST_MODEL;
  const check = <span className="agent-model-check" aria-hidden="true">✓</span>;
  return (
    <div className="agent-menu agent-model-menu" role="dialog" aria-label={t("모델 고르기")}>
      <input className="agent-model-search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus
        placeholder={t("모델 찾기")} aria-label={t("모델 찾기")} />
      {groups.length === 0 && <p className="agent-menu-note">{t("맞는 모델이 없어요")}</p>}
      {groups.map(({ e, models }) => (
        <div key={e.id} className="agent-model-group" role="group" aria-label={GROUP[e.id] ?? e.id}>
          <div className="agent-model-group-head">
            {GROUP[e.id] ?? e.id}
            {!e.available && <span className="agent-model-reason">{e.reason || t("쓸 수 없음")}</span>}
          </div>
          {models.map((m) => {
            const on = choice.engine === e.id && choice.model === m.id;
            return (
              <button key={m.id} type="button" className={`agent-model-item${on ? " on" : ""}`} disabled={!e.available} aria-pressed={on}
                onClick={() => onChoose(e.id === choice.engine ? { ...choice, model: m.id } : { engine: e.id, model: m.id, effort: effortFor(e), fast: false })}>
                <span className="agent-model-ic" aria-hidden="true">{e.id === "codex" ? "◎" : "✳"}</span>
                <span className="agent-model-name">{m.label}</span>
                {on && check}
              </button>
            );
          })}
        </div>
      ))}
      {current && (
        <>
          <div className="agent-menu-sep" />
          <div className="agent-model-group-head">{t("생각 깊이")}</div>
          <div role="radiogroup" aria-label={t("생각 깊이")}>
            {current.efforts.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={choice.effort === level}
                className={`agent-model-item${choice.effort === level ? " on" : ""}`} onClick={() => onChoose({ ...choice, effort: level })}>
                <span className="agent-model-name">{t(EFFORT[level] ?? level)}</span>
                {choice.effort === level && check}
              </button>
            ))}
          </div>
        </>
      )}
      {fastShown && (
        <>
          <div className="agent-menu-sep" />
          <div className="agent-model-group-head">{t("속도")}</div>
          <div role="radiogroup" aria-label={t("속도")}>
            {[false, true].map((fast) => (
              <button key={String(fast)} type="button" role="radio" aria-checked={!!choice.fast === fast}
                className={`agent-model-item${!!choice.fast === fast ? " on" : ""}`} onClick={() => onChoose({ ...choice, fast })}>
                <span className="agent-model-name">{fast ? t("빠름") : t("기본")}</span>
                {!!choice.fast === fast && check}
              </button>
            ))}
          </div>
          <p className="agent-menu-note">{t("빠름은 Claude 추가 사용 크레딧이 들어요 · 칸을 열 때마다 꺼짐")}</p>
        </>
      )}
    </div>
  );
}
function Chevron() {
  return (
    <svg className="agent-chevron" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6Z" />
    </svg>
  );
}

/** 정보(목록) — Claude 앱 오른쪽 정보 칸 단추처럼 */
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h2M4 12h2M4 18h2M10 6h10M10 12h10M10 18h6" />
    </svg>
  );
}

// 서랍 행 메뉴 아이콘(16px 칸에 14px 선) — 시안 drawer-menu.png
function MenuGlyph({ children }: { children: ReactNode }) {
  return (
    <svg className="agent-row-ic" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.3}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}
function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}
function WindowIcon() { return <MenuGlyph><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2 6h12" /></MenuGlyph>; }
function PinIcon() { return <MenuGlyph><path d="M9.5 2.5l4 4-2 1-2.5 2.5.3 2.5-1.3 1.3-2.4-2.4L2.5 14.5M4.6 7.6l2.3-2.3 1-2" /></MenuGlyph>; }
function UnreadIcon() { return <MenuGlyph><circle cx="8" cy="8" r="5.2" /><circle cx="8" cy="8" r="2" fill="currentColor" /></MenuGlyph>; }
function PenIcon() { return <MenuGlyph><path d="M11 2.5a1.4 1.4 0 0 1 2 2L5.3 12.2 2.5 13l.8-2.8Z" /></MenuGlyph>; }
function FolderIcon() { return <MenuGlyph><path d="M2 4.5c0-.8.6-1.5 1.5-1.5h3l1.5 1.6h4.5c.8 0 1.5.6 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9C2.6 13 2 12.3 2 11.5z" /></MenuGlyph>; }
function ArchiveIcon() { return <MenuGlyph><rect x="2" y="3" width="12" height="3" rx="1" /><path d="M3 6v6c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V6M6.5 8.5h3" /></MenuGlyph>; }
function TrashIcon() { return <MenuGlyph><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c0 .5.5.8 1 .8h3.8c.5 0 .9-.3 1-.8l.6-8.2" /></MenuGlyph>; }

/** 옆 칸 닫기(새 창에서는 옆 칸으로 붙이기) — 오른쪽 칸이 채워진 창(Jay 11-10 시안 — 이미지의 사이드바 단추를 오른쪽 칸으로) */
function SidePanelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5h3.5a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3.5Z" fill="currentColor" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

/** ≡ 대화 목록 — 왼쪽 맞춘 세 줄 */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" aria-hidden="true">
      <path d="M4 6.5h16M4 12h11M4 17.5h7" />
    </svg>
  );
}

/** 새 창으로 띄우기 — 겹친 두 창(Jay 11-10 시안 ②) */
function PopOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8.5" y="3.5" width="12" height="10" rx="2" />
      <path d="M15.5 17v1.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2H7" />
    </svg>
  );
}

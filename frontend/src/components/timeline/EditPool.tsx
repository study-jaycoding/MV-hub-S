// 편집 탭의 미디어 풀 — 재생헤드가 있는 컷 폴더에 공유된 생성물. 왼쪽 폴더 목록 바로 옆에 둔다(다빈치의 Bins | 클립,
//  Jay 2026-10-08). 머리줄에서 보기 방식(썸네일·메타데이터·목록)과 썸네일 크기·검색·정렬을 바꾼다.
//  누르면 고른다(Ctrl·Shift 로, 또는 끌어서 상자로 여러 장 — 마지막 것이 듀얼 뷰어의 소스, 2장 이상이면 비교) ·
//  카드를 끌면 타임라인에 넣는다(놓은 트랙 줄의 그 컷 칸 — Jay 2026-10-13. 상자는 빈 곳에서, 또는 Ctrl·Shift 를 누른 채) ·
//  더블클릭 = 크게 보기(재생) ·
//  우클릭 = 이 컷의 폴더 창(공유 & 리뷰의 '폴더 보기' — 그 카드가 보이게) ·
//  휠 클릭 = 넣을 트랙 고르기(EditTrackMenu). (Jay 2026-10-13 — 그 전에는 우클릭이 트랙 메뉴였다)
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import type { Generation } from "../../types";
import { POOL_SIZE, type EditUi, type PoolSort, type PoolView } from "../../lib/editTimelineStore";
import { formatGenerationDateTime, generationListMeta } from "../../lib/generationDisplay";
import { reviewState } from "../../lib/generationReview";
import { useT } from "../../lib/i18n";
import { pressStartedCovered } from "../../lib/keyGate";
import { computeMarquee, marqueeHits, type MarqueeRect } from "../../lib/marquee";
import { thumbOf } from "../../lib/media";
import { editTick, type EditListState } from "../../lib/useEditSequence";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../../lib/windowDrag";
import { FilterPanelIcon } from "../common/ViewIcons";
import { EditCard, NO_CARD_ACTIONS, poolMark, type PoolCardActions, type PoolItem } from "./EditCard";

export type { PoolItem };
// 썸네일 카드 안의 단추(라이브러리 카드의 호버 단추) — 그 누름은 카드의 누르기·끌기·더블클릭이 아니다(라이브러리 격자와 같은 약속)
const CARD_BUTTON = ".ed-card button";

const ICONS: Record<PoolView | "search" | "sort", JSX.Element> = {
  thumb: <svg viewBox="0 0 16 16" aria-hidden="true">{[1, 6.5, 12].flatMap((y) => [1, 6.5, 12].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="3.5" height="3.5" />))}</svg>,
  meta: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="3" width="6" height="10" /><rect x="9" y="4" width="6" height="1.6" /><rect x="9" y="7.2" width="6" height="1.6" /><rect x="9" y="10.4" width="4" height="1.6" /></svg>,
  list: <svg viewBox="0 0 16 16" aria-hidden="true">{[3, 7.2, 11.4].map((y) => <g key={y}><rect x="1" y={y} width="1.8" height="1.8" /><rect x="5" y={y} width="10" height="1.8" /></g>)}</svg>,
  search: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 1.5a5.3 5.3 0 1 0 3.2 9.5l3.6 3.6 1.3-1.3-3.6-3.6A5.3 5.3 0 0 0 6.8 1.5zm0 1.8a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z" /></svg>,
  sort: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="3" width="8" height="1.8" /><rect x="1" y="7.1" width="6" height="1.8" /><rect x="1" y="11.2" width="4" height="1.8" /><path d="M12 2.5v8.6l-1.9-1.9-1.2 1.2 4 4 4-4-1.2-1.2-1.9 1.9V2.5z" transform="translate(-1.4 0)" /></svg>,
};
const VIEWS: { id: PoolView; label: string }[] = [
  { id: "meta", label: "메타데이터 보기" }, { id: "thumb", label: "썸네일 보기" }, { id: "list", label: "목록 보기" },
];
const SORTS: { id: PoolSort; label: string }[] = [
  { id: "new", label: "최신순" }, { id: "old", label: "오래된순" }, { id: "placed", label: "넣은 것 먼저" },
];
// 줄에 넣는 프롬프트 글자 수(아래 promptShown). 가장 넓은 풀(720px)·가장 작은 썸네일(56px)의 메타 두 줄은 약 1,230px 라, 'i·l' 같은 좁은
//  글자(12px 에 약 3px)면 400자 넘게 든다 — 그때 잘린 끝이 말줄임 없이 보였다(Codex 40회차 리뷰). 1,000자면 글자 폭 1.3px 까지 넘친다.
const PROMPT_SHOWN = 1000;

// 검색 = 프롬프트·모델·만든 사람에 그 글이 들어 있는 것. 정렬 = 받은 순서(최신 먼저)를 바탕으로.
export function arrangePool(items: PoolItem[], query: string, sort: PoolSort): PoolItem[] {
  const needle = query.trim().toLowerCase();
  const found = !needle ? items : items.filter(({ gen }) =>
    [gen.prompt, gen.model, gen.creator_name, gen.worker_name].some((text) => (text ?? "").toLowerCase().includes(needle)));
  if (sort === "old") return [...found].reverse();
  if (sort === "placed") return [...found].sort((a, b) => (b.track ?? 0) - (a.track ?? 0)); // 위 트랙부터, 나머지는 그대로
  return found;
}

export function EditPool({
  title,
  items,
  picked,
  ui,
  onUi,
  listState,
  listStartedAt,
  notice,
  onPick,
  onPickMany,
  onOpen,
  onCompare,
  resolve,
  onClearPicked,
  onMenu,
  sideOpen,
  onToggleSide,
  onFolder,
  onCardDrag,
  cardActions = NO_CARD_ACTIONS,
}: {
  // 왼쪽 폴더 목록 여닫기(Jay 2026-10-13 — 공유 탭 도구 줄의 '필터 사이드바 닫기'와 같은 단추·같은 자리 관계: 사이드바 바로 옆 줄의 첫 단추).
  //  닫아도 단추는 여기 남아 다시 연다. 닫힘은 편집 탭의 화면 설정(EditUi.sideHidden)에만 적는다 — 공유 탭의 것과 따로다.
  sideOpen: boolean;
  onToggleSide: () => void;
  title: string; // 'e070 / c0050'
  items: PoolItem[]; // 받은 순서(최신 먼저)
  picked: readonly string[]; // 고른 카드들(고른 순서 — 마지막 것이 듀얼 뷰어의 소스)
  ui: EditUi;
  onUi: (patch: Partial<EditUi>) => void;
  listState: EditListState;
  listStartedAt: number; // 지금 목록을 낸 조회가 출발한 순번(editTick) — 태그 덧입힘을 걷는 기준
  notice: string | null; // 목록 대신 보여 줄 안내(폴더를 안 골랐다·워크스페이스 미확인 등)
  onPick: (gen: Generation, additive: boolean) => void; // additive = Ctrl·Shift 를 누른 채(더하고 빼기)
  onPickMany: (ids: string[]) => void; // 끌어서 상자로 고른 것(전체 치환)
  onOpen: (gen: Generation, shown: Generation[]) => void; // 더블클릭 — 크게 보기(앞뒤 넘기기는 지금 보이는 순서로)
  onCompare: (gens: Generation[]) => void;
  // Resolve 보내기(Jay 2026-10-08) — 앱의 보내기 줄 그대로(고른 생성물을 넘기면 된다. 탭·선택 상태에 묶여 있지 않다)
  resolve: { send: (gens: Generation[]) => void; busy: boolean; pendingCount: number };
  onClearPicked: () => void;
  onMenu: (gen: Generation, x: number, y: number) => void; // 휠 클릭 — 넣을 트랙 고르기
  onFolder: (gen: Generation) => void; // 우클릭 — 이 컷의 폴더 창을 그 카드가 보이게 연다
  // 카드를 끌어 타임라인에 넣기(Jay 2026-10-13) — 여기서는 몸짓만 알린다(무엇이 어디에 놓이는지는 EditTab 이 정한다).
  //  start = 5px 을 넘겨 끌기가 됐다 · move = 따라가는 자리 · drop = 놓았다 · cancel = 놓는 이벤트 없이 끝났다(창 밖에서 뗌·초점 잃음).
  onCardDrag: (phase: "start" | "move" | "drop" | "cancel", id: string, x: number, y: number) => void;
  cardActions?: PoolCardActions; // 썸네일 카드의 호버 단추(S·T·C·ⓘ)가 부르는 앱의 동작(Jay 2026-10-15)
}) {
  const t = useT();
  const [open, setOpen] = useState<"view" | "sort" | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const toolsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 검색칸이 그려지는 그 커밋에서 초점을 준다. 타이머로 미루면 그사이의 누름(풀의 카드)보다 늦게 와 초점을 가져가고,
  //  그 뒤의 Space·J·K·L 이 편집 조작이 아니라 검색칸에 들어갔다(Codex 검토 — 입력은 타이머보다 먼저 처리된다).
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  // 초점이 도구 줄 밖에 생겨도 닫는다(Jay 2026-10-14) — 마우스로 연 메뉴는 단추가 초점을 받지 않아(keepFocus) 아래 onBlur 가 볼 것이
  //  없었다: Tab 한 번에 초점만 옆 단추로 가고 메뉴는 열린 채 남아 편집 키를 막았다(2026-10-14 격리 실측).
  useOutsideMouseDown(toolsRef, () => setOpen(null), open !== null, undefined, true);
  useEscapeClose(() => setOpen(null), open !== null, true, true);
  const shown = useMemo(() => arrangePool(items, searching ? query : "", ui.sort), [items, searching, query, ui.sort]);
  const placed = items.filter((item) => item.track !== null).length;
  // 썸네일 카드의 T(태그 고치기) — 한 번에 한 장. 고친 태그는 그 카드의 저장이 다 끝난 **뒤에 출발한** 조회의 목록이 들어올 때까지
  //  여기서 덧입힌다: 앱의 낙관적 갱신은 라이브러리 목록에만 닿아, 안 그러면 잇달아 넣는 태그가 옛 태그에서 계산돼 앞에 넣은 것을 지운다.
  //  '목록이 바뀌었다'로 걷으면 뒤 편집의 저장보다 먼저 온 목록·저장 전에 출발한 늦은 응답·그냥 다시 만들어진 배열이 편집을 지웠고,
  //  '목록이 같아질 때'까지 들면 저장 뒤 다른 창이 바꾼 태그를 가려 다음 저장이 덮었다(Codex 리뷰 10-15 세 번).
  //  그래서 카드마다 끝나지 않은 저장을 세고, 다 끝난 순번(savedAt)과 목록을 낸 조회의 출발 순번(listStartedAt)을 견준다.
  const [tagging, setTagging] = useState<string | null>(null);
  const [retag, setRetag] = useState<Record<string, { tags?: string[]; auto_tags?: string[]; savedAt?: number }>>({});
  const saving = useRef<Record<string, number>>({}); // 카드마다 끝나지 않은 저장 수
  const withTags = (gen: Generation) => {
    const kept = retag[gen.id];
    return kept ? { ...gen, ...(kept.tags && { tags: kept.tags }), ...(kept.auto_tags && { auto_tags: kept.auto_tags }) } : gen;
  };
  const keepTags = (gen: Generation, patch: { tags?: string[]; auto_tags?: string[] }, save: void | Promise<void>) => {
    const id = gen.id;
    setRetag((prev) => ({ ...prev, [id]: { tags: prev[id]?.tags, auto_tags: prev[id]?.auto_tags, ...patch } }));
    saving.current[id] = (saving.current[id] ?? 0) + 1;
    void Promise.resolve(save).finally(() => {
      const left = (saving.current[id] ?? 1) - 1;
      if (left > 0) {
        saving.current[id] = left;
        return;
      }
      delete saving.current[id];
      const savedAt = editTick();
      setRetag((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], savedAt } } : prev));
    });
  };
  // 저장이 다 끝난 뒤 출발한 조회의 목록이 들어왔다 — 그 카드는 목록을 믿는다(덧입힘을 걷는다)
  useEffect(() => {
    setRetag((prev) => {
      const done = Object.keys(prev).filter((id) => (prev[id].savedAt ?? Infinity) < listStartedAt);
      if (done.length === 0) return prev;
      const next = { ...prev };
      for (const id of done) delete next[id];
      return next;
    });
  }, [listStartedAt]);
  const actions: PoolCardActions = {
    ...cardActions,
    onSetTags: (gen, tags) => keepTags(gen, { tags }, cardActions.onSetTags(gen, tags)),
    onSetAutoTags: (gen, names) => keepTags(gen, { auto_tags: names }, cardActions.onSetAutoTags(gen, names)),
  };

  // 여기를 눌러도 편집 화면이 키를 받게 초점을 옮기지 않는다. 입력칸(검색·크기)만 초점을 받고, 그 밖을 누르면 입력칸에서
  //  초점을 뗀다 — 안 떼면 Space·J·K·L 이 계속 입력칸으로 간다.
  // 끌기 둘(5px 넘게 움직여야 끌기다 — 그 밑은 누르기):
  //  · 카드 위에서 그냥 끌면 **그 카드를 타임라인으로 끌어 넣는다**(Jay 2026-10-13 — 그 전에는 카드 위에서 시작해도 상자였다).
  //  · 빈 곳에서 끌거나, **Ctrl·Shift 를 누른 채** 끌면(카드 위에서도) 끌어서 고르기(Jay 2026-10-08) — 라이브러리 격자처럼
  //    상자에 걸친 카드를 고른다. 격자는 카드로 꽉 차 빈 곳이 거의 없어, 누른 채 끄는 길을 남긴다(누르면 고른 것에 더한다).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<{
    x: number; y: number; base: readonly string[]; moved: boolean; card: string | null; at: [number, number];
  } | null>(null);
  const draggedRef = useRef(false); // 끌기가 끝난 직후의 click 은 누르기가 아니다(같은 카드 위에서 놓으면 click 이 따라온다)
  const coveredPressRef = useRef(false); // 이 누름은 위에 뜬 메뉴를 닫는 누름이었다(아래 startDrag)
  const live = useRef({ onPickMany, onCardDrag });
  live.current = { onPickMany, onCardDrag };
  const drag = useRef({
    move: (event: MouseEvent) => {
      const state = dragRef.current;
      const body = bodyRef.current;
      if (!state || !body) return;
      // 버튼을 창 밖(다른 앱)에서 놓으면 mouseup 이 오지 않는다 — 버튼이 안 눌린 이동이면 거기서 끝낸다(Codex 코드 리뷰).
      if (!(event.buttons & 1)) return drag.up();
      if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5) return;
      state.at = [event.clientX, event.clientY];
      if (state.card) {
        if (!state.moved) live.current.onCardDrag("start", state.card, ...state.at);
        state.moved = true;
        live.current.onCardDrag("move", state.card, ...state.at);
        return;
      }
      state.moved = true;
      const { rect, b } = computeMarquee(body, state, event);
      setMarquee(rect);
      live.current.onPickMany([...marqueeHits<string>(body, "[data-id]", b, state.base, (el) => el.dataset.id)]);
    },
    // event 가 없거나 mouseup 이 아니면(단추가 떼어진 채 온 움직임·창이 초점을 잃음) 놓친 끝이다 — 카드는 넣지 않는다
    up: (event?: Event) => {
      // 끌기를 시작한 왼쪽 단추의 놓기만 끝이다 — 끄는 중에 다른 단추(휠)를 눌렀다 떼면 그 mouseup 도 여기로 온다. 그것으로 카드가
      //  놓이지 않게, 끌기 상태·리스너를 걷기 전에 거른다(끌기는 이어진다. Codex 코드 리뷰 2회째)
      if (event instanceof MouseEvent && event.type === "mouseup" && event.button !== 0) return;
      const state = dragRef.current;
      dragRef.current = null;
      removeWindowMouseDrag(drag.move, drag.up);
      setMarquee(null);
      if (!state?.moved) return;
      draggedRef.current = true;
      window.setTimeout(() => { draggedRef.current = false; }, 0);
      if (!state.card) return;
      const released = event instanceof MouseEvent && event.type === "mouseup";
      const [x, y] = released ? [event.clientX, event.clientY] : state.at;
      live.current.onCardDrag(released ? "drop" : "cancel", state.card, x, y);
    },
  }).current;
  useEffect(() => {
    window.addEventListener("blur", drag.up); // 끄는 중에 창이 초점을 잃으면 끝낸다
    return () => {
      drag.up(); // 끄는 중에 풀이 사라졌다 — 끌던 카드를 내려놓는다(cancel)
      window.removeEventListener("blur", drag.up);
    };
  }, [drag]);
  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0 || dragRef.current || (event.target as HTMLElement).closest(CARD_BUTTON)) return;
    // 새 누름이다 — 앞 끌기에 딸린 click 은 이미 지나갔다. 안 풀면 끌어서 고른 바로 뒤(타이머가 돌기 전)에 누른 카드가 전부 안 골라진다
    //  (입력은 타이머보다 먼저 처리된다 — 캔버스의 swallowDropClick 과 같은 약속. Codex 코드 리뷰)
    draggedRef.current = false;
    // 위에 뜬 메뉴를 닫는 누름이다 — 끌기도, 뒤따르는 click 의 고르기도 하지 않는다(조작 규칙 4, 58회차). click 때는 이미 메뉴가 닫혀 있어 그때 볼 수 없다.
    coveredPressRef.current = pressStartedCovered();
    if (coveredPressRef.current) return;
    const adding = event.ctrlKey || event.metaKey || event.shiftKey;
    dragRef.current = {
      x: event.clientX, y: event.clientY, moved: false, at: [event.clientX, event.clientY],
      base: adding ? picked : [],
      card: adding ? null : (event.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id ?? null,
    };
    addWindowMouseDrag(drag.move, drag.up);
  };
  const marqueeBox = marquee && (
    <div className="assets-marquee" style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }} />
  );
  const keepFocus = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement).closest("input")) return;
    event.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && event.currentTarget.contains(active)) active.blur();
  };
  const handlersOf = (item: PoolItem): HTMLAttributes<HTMLElement> & { "data-id": string } => ({
    "data-id": item.gen.id, // 끌어서 고르기가 이 값으로 카드를 찾는다
    title: t("끌기 = 타임라인에 넣기 · 더블클릭 = 크게 보기 · 우클릭 = 폴더 창 · 휠 클릭 = 넣을 트랙 고르기 · Ctrl+클릭 = 여러 장 고르기"),
    onClick: (event) => {
      if (draggedRef.current) {
        draggedRef.current = false; // 건너뛰는 것은 그 끌기에 딸린 한 번뿐이다
        return;
      }
      if (coveredPressRef.current && event.detail > 0) { // 키보드의 click(detail 0)은 누름이 아니다
        coveredPressRef.current = false;
        return;
      }
      onPick(item.gen, event.ctrlKey || event.metaKey || event.shiftKey);
    },
    onDoubleClick: (event) => {
      if (!(event.target as HTMLElement).closest(CARD_BUTTON)) onOpen(item.gen, shown.map((entry) => entry.gen));
    },
    // 마우스 우클릭(contextmenu 의 button = 2) = 폴더 창. 키보드의 메뉴 키는 누름 없이 contextmenu 만 온다(button 이 2 가 아니다 —
    //  2026-10-13 크롬 실측 −1) — 그때는 전처럼 트랙 메뉴다: 휠 클릭은 키보드로 할 수 없어, 이 길이 없으면 키보드로는 넣지 못한다.
    onContextMenu: (event) => {
      event.preventDefault();
      if (event.button === 2) onFolder(item.gen);
      else onMenu(item.gen, event.clientX, event.clientY);
    },
    // 휠 클릭(가운데 단추) — 누름의 자동 스크롤은 풀 뿌리의 keepFocus 가 이미 막는다(어느 단추든 preventDefault).
    //  잡는 단계에서 받아 전파를 막는다 — 썸네일 카드(라이브러리 카드)의 휠 클릭 = 정보 창이 같이 뜨지 않게(폴더 창의 격자와 같다)
    onAuxClickCapture: (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragRef.current?.moved) return; // 끄는 중의 휠 클릭은 메뉴가 아니다(끌기는 이어진다)
      onMenu(item.gen, event.clientX, event.clientY);
    },
  });
  const infoOf = ({ gen }: PoolItem) => ({
    who: gen.creator_name || gen.worker_name || "",
    model: gen.model || "",
    duration: gen.assets[0].type === "video" ? generationListMeta(gen.params ?? {}).duration ?? "" : "",
    state: reviewState(gen),
  });
  // 줄에 보이는 프롬프트는 한두 줄(목록 한 줄 · 메타데이터 두 줄)인데 원문은 평균 1만 자를 넘는다(최대 3만) — 다 넣으면 카드 300장에서
  //  보기를 바꿀 때 배치에만 0.2~0.46초가 들어 화면이 멈췄다(40회차 격리 실측). 보이는 것보다 넉넉히만 넣는다 — 검색은 원문 전체로 한다(arrangePool).
  const promptShown = (prompt: string) => (prompt.length > PROMPT_SHOWN ? prompt.slice(0, PROMPT_SHOWN) : prompt);
  const stateMark = (state: string) => (
    <span className={`ed-pstate ed-pstate-${state}`}>{state === "final" ? "★" : state === "held" ? "R" : "S"}</span>
  );
  const trackMark = (item: PoolItem) => {
    const mark = poolMark(item, t); // 넣은 트랙·소스 클립 판 — 썸네일 카드의 아래 표와 같은 글
    return mark && <span className={"cd-mark" + (mark.lead ? " lead" : "")}>{mark.label}</span>;
  };
  // 다빈치(미디어 풀)에서 고른 것 — 빨간 표(Jay 2026-10-14). 썸네일 카드는 아래 표 글에 잇는다(EditCard)
  const dvMark = (item: PoolItem) => item.resolve && <span className="cd-mark ed-dv-chip">{t("다빈치")}</span>;
  const rowClass = (item: PoolItem, kind: string) =>
    `ed-prow ed-prow-${kind}` + (picked.includes(item.gen.id) ? " ed-picked" : "") + (item.track !== null ? " ed-placed" : "") +
    (item.resolve ? " ed-dv" : "");
  // 막대의 대상은 **지금 보이는 것** 가운데 고른 것이다(조작 규칙 42). 전엔 검색 전의 목록(items)에서 구해, 검색으로 가려진 카드가
  //  '2개 선택'에 남아 Resolve 로 같이 나갔다. 고른 것 자체(picked — 마지막 것이 뷰어의 소스)는 건드리지 않는다: 검색을 지우면 다시 보인다.
  const pickedGens = picked.map((id) => shown.find((item) => item.gen.id === id)?.gen).filter((gen): gen is Generation => !!gen);

  return (
    <section className="ed-pool" onMouseDown={keepFocus}>
      <div className="ed-pool-head">
        {/* 모양·글은 공유 탭의 단추 그대로 — 열림 = ▢, 닫힘 = ▷(상태는 글리프가 말한다) */}
        <button type="button" className={"lib-filter lib-filter-ic ed-side-toggle" + (sideOpen ? " on" : "")} aria-pressed={sideOpen}
          title={sideOpen ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")} aria-label={sideOpen ? t("필터 사이드바 닫기") : t("필터 사이드바 열기")}
          onClick={onToggleSide}>
          <FilterPanelIcon open={sideOpen} />
        </button>
        <h3 title={title}>{title || t("이 컷의 생성물")}</h3>
        <div className="ed-pool-tools" ref={toolsRef} onBlur={(event) => {
          // Tab 으로 메뉴 밖으로 나가면 닫는다(뷰어의 메뉴와 같다 — 조작 규칙 51). 안에서 옮기는 것(항목·크기 슬라이더)은 그대로다.
          const to = event.relatedTarget as Node | null;
          if (to && !event.currentTarget.contains(to)) setOpen(null);
        }}>
          <button type="button" className={"ed-pbtn" + (open === "view" ? " ed-on" : "")} aria-haspopup="menu" aria-expanded={open === "view"}
            title={t("보기 방식")} aria-label={t("보기 방식")} onClick={() => setOpen(open === "view" ? null : "view")}>
            {ICONS[ui.view]}<svg className="ed-caret" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0h8L4 5z" /></svg>
          </button>
          <button type="button" className={"ed-pbtn" + (searching ? " ed-on" : "")} aria-pressed={searching}
            title={t("검색")} aria-label={t("검색")}
            onClick={() => setSearching(!searching)}>
            {ICONS.search}
          </button>
          <button type="button" className={"ed-pbtn" + (open === "sort" ? " ed-on" : "")} aria-haspopup="menu" aria-expanded={open === "sort"}
            title={t("정렬")} aria-label={t("정렬")} onClick={() => setOpen(open === "sort" ? null : "sort")}>
            {ICONS.sort}
          </button>
          {open === "view" && (
            <div className="ed-pop" role="menu" aria-label={t("보기 방식")}>
              {VIEWS.map((view) => (
                <button key={view.id} type="button" role="menuitemradio" aria-checked={ui.view === view.id}
                  className={"ed-pop-item" + (ui.view === view.id ? " ed-on" : "")}
                  onClick={() => {
                    onUi({ view: view.id });
                    setOpen(null);
                  }}>
                  <b>{ui.view === view.id ? "✓" : ""}</b>{ICONS[view.id]}{t(view.label)}
                </button>
              ))}
              <div className="ed-pop-sep" />
              {/* 목록 보기에는 그림이 없다 — 크기는 썸네일·메타데이터 보기에서만 */}
              <input type="range" className="ed-pop-size" min={POOL_SIZE.min} max={POOL_SIZE.max} step={10} value={ui.size}
                disabled={ui.view === "list"} aria-label={t("썸네일 크기")} title={t("썸네일 크기")}
                onChange={(event) => onUi({ size: Number(event.target.value) })}
                onMouseUp={(event) => event.currentTarget.blur()} />
            </div>
          )}
          {open === "sort" && (
            <div className="ed-pop" role="menu" aria-label={t("정렬")}>
              {SORTS.map((sort) => (
                <button key={sort.id} type="button" role="menuitemradio" aria-checked={ui.sort === sort.id}
                  className={"ed-pop-item" + (ui.sort === sort.id ? " ed-on" : "")}
                  onClick={() => {
                    onUi({ sort: sort.id });
                    setOpen(null);
                  }}>
                  <b>{ui.sort === sort.id ? "✓" : ""}</b>{t(sort.label)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {searching && (
        <input ref={searchRef} className="ed-pool-search" type="search" value={query} spellCheck={false}
          placeholder={t("프롬프트·모델·만든 사람으로 찾기")} aria-label={t("검색")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Esc = 검색을 접는다(글자도 지운다), Enter = 글자는 두고 입력칸에서 나온다 — 둘 다 편집 키가 다시 듣는다
            if (event.key !== "Escape" && event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
            event.currentTarget.blur();
          }} />
      )}
      <div className="ed-pool-sub">
        {notice ?? (
          <>
            {t("공유된 것 {count}개").replace("{count}", String(items.length))}
            {placed > 0 && <> · {t("넣은 것 {count}개").replace("{count}", String(placed))}</>}
            {shown.length !== items.length && <> · {t("찾은 것 {count}개").replace("{count}", String(shown.length))}</>}
          </>
        )}
      </div>
      {!notice && listState === "loading" && !items.length && (
        <div className="ed-pool-note" role="status">{t("공유 목록을 받는 중...")}</div>
      )}
      {!notice && listState !== "loading" && listState !== "error" && !items.length && (
        <div className="ed-pool-note">{t("이 컷 폴더에 공유된 생성물이 없습니다.")}</div>
      )}
      {!notice && items.length > 0 && !shown.length && <div className="ed-pool-note">{t("검색에 맞는 생성물이 없습니다.")}</div>}
      {!notice && ui.view === "thumb" && (
        <div className="ed-pbody ed-pgrid" ref={bodyRef} onMouseDown={startDrag}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${ui.size}px, 1fr))` }}>
          {marqueeBox}
          {shown.map((item) => (
            <EditCard key={item.gen.id} item={{ ...item, gen: withTags(item.gen) }} picked={picked.includes(item.gen.id)}
              handlers={handlersOf(item)} actions={actions} tagging={tagging === item.gen.id}
              onTagging={(on) => setTagging((now) => (on ? item.gen.id : now === item.gen.id ? null : now))} />
          ))}
        </div>
      )}
      {!notice && ui.view === "meta" && (
        <div className="ed-pbody" ref={bodyRef} onMouseDown={startDrag}>
          {marqueeBox}
          {shown.map((item) => {
            const info = infoOf(item);
            const thumb = thumbOf(item.gen, 512);
            return (
              <button key={item.gen.id} type="button" className={rowClass(item, "meta")} {...handlersOf(item)}>
                <span className="ed-pthumb" style={{ width: ui.size }}>
                  {thumb && <img src={thumb} alt="" loading="lazy" draggable={false} />}
                  {item.gen.assets[0].type === "video" && <i>▶</i>}
                </span>
                <span className="ed-pinfo">
                  <b>{stateMark(info.state)}{[info.who, info.model].filter(Boolean).join(" · ")}{trackMark(item)}{dvMark(item)}</b>
                  <span>{[formatGenerationDateTime(item.gen.created_at), info.duration].filter(Boolean).join(" · ")}</span>
                  <span className="ed-pprompt">{promptShown(item.gen.prompt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {!notice && ui.view === "list" && (
        <div className="ed-pbody ed-plist" ref={bodyRef} onMouseDown={startDrag}>
          {marqueeBox}
          <div className="ed-prow ed-prow-list ed-prow-head">
            <span />
            <span>{t("프롬프트")}</span><span>{t("만든 사람")}</span><span>{t("모델")}</span><span>{t("길이")}</span><span>{t("트랙·소스")}</span>
          </div>
          {shown.map((item) => {
            const info = infoOf(item);
            return (
              <button key={item.gen.id} type="button" className={rowClass(item, "list")} {...handlersOf(item)}>
                {stateMark(info.state)}
                {/* 다빈치 표는 프롬프트 칸 앞에 — 마지막 칸(트랙·소스, 56px)은 그 둘의 짧은 글로 이미 찬다 */}
                <span className="ed-pprompt">{dvMark(item)}{promptShown(item.gen.prompt)}</span><span>{info.who}</span><span>{info.model}</span>
                {/* 마지막 칸 = 넣은 트랙 + 소스 클립 판에 떠 있는 판 — 작은 카드와 같은 짧은 글(V1 · L · V10·L·R, Jay 2026-10-14).
                    칩에 '소스 L·R' 을 다 적으면 좁은 풀에서 잘리고 다른 칸이 사라졌다(격리 실측 — 영어·두 자리 트랙 91/84px) */}
                <span>{info.duration}</span>
                <span className={item.source ? "ed-psrc" : undefined} title={poolMark(item, t)?.label}>{poolMark(item, t)?.short ?? ""}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* 고른 것의 막대 — 비교(2장부터, 앱의 비교 창)와 Resolve 보내기(앱의 보내기 줄). 내려받기·프로젝트에 담기·삭제는
          컷 더블클릭으로 여는 폴더 창의 선택 막대에 있다(그 동작은 탭에 묶여 있어 여기에 그대로 옮기지 못한다 — docs/EDIT_TAB.md). */}
      {pickedGens.length > 0 && (
        <div className="ed-pool-sel">
          <span>{t("{count}개 선택").replace("{count}", String(pickedGens.length))}</span>
          {pickedGens.length > 1 && (
            <button type="button" className="ed-psel-btn" onClick={() => onCompare(pickedGens)}
              title={t("고른 생성물을 나란히 비교합니다")}>⊞ {t("비교")}</button>
          )}
          <button type="button" className="ed-psel-btn ed-psel-resolve" aria-busy={resolve.busy} onClick={() => resolve.send(pickedGens)}
            title={resolve.busy
              ? t("Resolve 작업 {count}건 처리 중 · 선택 항목을 대기열에 추가").replace("{count}", String(resolve.pendingCount))
              : t("선택한 완료본을 프로젝트의 Render 폴더 구조로 저장하고 Resolve로 가져오기")}>
            {resolve.busy ? `${t("◆ Resolve에 추가")} (${resolve.pendingCount})` : t("◆ Resolve 보내기")}
          </button>
          <button type="button" className="ed-link" onClick={onClearPicked}>{t("선택 해제")}</button>
        </div>
      )}
    </section>
  );
}

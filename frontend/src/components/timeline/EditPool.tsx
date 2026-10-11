// 편집 탭의 미디어 풀 — 재생헤드가 있는 컷 폴더에 공유된 생성물. 왼쪽 폴더 목록 바로 옆에 둔다(다빈치의 Bins | 클립,
//  Jay 2026-10-08). 머리줄에서 보기 방식(썸네일·메타데이터·목록)과 썸네일 크기·검색·정렬을 바꾼다.
//  누르면 고른다(Ctrl·Shift 로, 또는 끌어서 상자로 여러 장 — 마지막 것이 듀얼 뷰어의 소스, 2장 이상이면 비교) ·
//  더블클릭 = 크게 보기(재생) ·
//  우클릭 = 넣을 트랙 고르기(EditTrackMenu).
import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import type { Generation } from "../../types";
import { POOL_SIZE, type EditUi, type PoolSort, type PoolView } from "../../lib/editTimelineStore";
import { formatGenerationDateTime, generationListMeta } from "../../lib/generationDisplay";
import { reviewState } from "../../lib/generationReview";
import { useT } from "../../lib/i18n";
import { computeMarquee, marqueeHits, type MarqueeRect } from "../../lib/marquee";
import { thumbOf } from "../../lib/media";
import type { EditListState } from "../../lib/useEditSequence";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../../lib/windowDrag";
import { EditCard, editMarkLabel, type PoolItem } from "./EditCard";

export type { PoolItem };

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
  notice,
  onPick,
  onPickMany,
  onOpen,
  onCompare,
  resolve,
  onClearPicked,
  onMenu,
}: {
  title: string; // 'e070 / c0050'
  items: PoolItem[]; // 받은 순서(최신 먼저)
  picked: readonly string[]; // 고른 카드들(고른 순서 — 마지막 것이 듀얼 뷰어의 소스)
  ui: EditUi;
  onUi: (patch: Partial<EditUi>) => void;
  listState: EditListState;
  notice: string | null; // 목록 대신 보여 줄 안내(폴더를 안 골랐다·워크스페이스 미확인 등)
  onPick: (gen: Generation, additive: boolean) => void; // additive = Ctrl·Shift 를 누른 채(더하고 빼기)
  onPickMany: (ids: string[]) => void; // 끌어서 상자로 고른 것(전체 치환)
  onOpen: (gen: Generation, shown: Generation[]) => void; // 더블클릭 — 크게 보기(앞뒤 넘기기는 지금 보이는 순서로)
  onCompare: (gens: Generation[]) => void;
  // Resolve 보내기(Jay 2026-10-08) — 앱의 보내기 줄 그대로(고른 생성물을 넘기면 된다. 탭·선택 상태에 묶여 있지 않다)
  resolve: { send: (gens: Generation[]) => void; busy: boolean; pendingCount: number };
  onClearPicked: () => void;
  onMenu: (gen: Generation, x: number, y: number) => void; // 우클릭 — 넣을 트랙 고르기
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
  useOutsideMouseDown(toolsRef, () => setOpen(null), open !== null);
  useEscapeClose(() => setOpen(null), open !== null, true, true);
  const shown = useMemo(() => arrangePool(items, searching ? query : "", ui.sort), [items, searching, query, ui.sort]);
  const placed = items.filter((item) => item.track !== null).length;

  // 여기를 눌러도 편집 화면이 키를 받게 초점을 옮기지 않는다. 입력칸(검색·크기)만 초점을 받고, 그 밖을 누르면 입력칸에서
  //  초점을 뗀다 — 안 떼면 Space·J·K·L 이 계속 입력칸으로 간다.
  // 끌어서 고르기(Jay 2026-10-08) — 라이브러리 격자처럼 상자에 걸친 카드를 고른다. 풀의 카드는 끌어 옮기는 것이 없어 카드
  //  위에서 시작해도 상자다. Ctrl·Shift 를 누른 채 끌면 고른 것에 더한다. 5px 넘게 움직여야 끌기다 — 그 밑은 누르기.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<{ x: number; y: number; base: readonly string[]; moved: boolean } | null>(null);
  const draggedRef = useRef(false); // 끌기가 끝난 직후의 click 은 누르기가 아니다(같은 카드 위에서 놓으면 click 이 따라온다)
  const live = useRef({ onPickMany });
  live.current = { onPickMany };
  const drag = useRef({
    move: (event: MouseEvent) => {
      const state = dragRef.current;
      const body = bodyRef.current;
      if (!state || !body) return;
      // 버튼을 창 밖(다른 앱)에서 놓으면 mouseup 이 오지 않는다 — 버튼이 안 눌린 이동이면 거기서 끝낸다(Codex 코드 리뷰).
      if (!(event.buttons & 1)) return drag.up();
      if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 5) return;
      state.moved = true;
      const { rect, b } = computeMarquee(body, state, event);
      setMarquee(rect);
      live.current.onPickMany([...marqueeHits<string>(body, "[data-id]", b, state.base, (el) => el.dataset.id)]);
    },
    up: () => {
      const state = dragRef.current;
      dragRef.current = null;
      removeWindowMouseDrag(drag.move, drag.up);
      setMarquee(null);
      if (!state?.moved) return;
      draggedRef.current = true;
      window.setTimeout(() => { draggedRef.current = false; }, 0);
    },
  }).current;
  useEffect(() => {
    window.addEventListener("blur", drag.up); // 끄는 중에 창이 초점을 잃으면 끝낸다
    return () => {
      window.removeEventListener("blur", drag.up);
      removeWindowMouseDrag(drag.move, drag.up);
    };
  }, [drag]);
  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0 || dragRef.current) return;
    // 새 누름이다 — 앞 끌기에 딸린 click 은 이미 지나갔다. 안 풀면 끌어서 고른 바로 뒤(타이머가 돌기 전)에 누른 카드가 전부 안 골라진다
    //  (입력은 타이머보다 먼저 처리된다 — 캔버스의 swallowDropClick 과 같은 약속. Codex 코드 리뷰)
    draggedRef.current = false;
    dragRef.current = {
      x: event.clientX, y: event.clientY, moved: false,
      base: event.ctrlKey || event.metaKey || event.shiftKey ? picked : [],
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
  const handlersOf = (item: PoolItem): HTMLAttributes<HTMLButtonElement> & { "data-id": string } => ({
    "data-id": item.gen.id, // 끌어서 고르기가 이 값으로 카드를 찾는다
    title: t("더블클릭 = 크게 보기 · 우클릭 = 넣을 트랙 고르기 · Ctrl+클릭 = 여러 장 고르기"),
    onClick: (event) => {
      if (draggedRef.current) {
        draggedRef.current = false; // 건너뛰는 것은 그 끌기에 딸린 한 번뿐이다
        return;
      }
      onPick(item.gen, event.ctrlKey || event.metaKey || event.shiftKey);
    },
    onDoubleClick: () => onOpen(item.gen, shown.map((entry) => entry.gen)),
    onContextMenu: (event) => {
      event.preventDefault();
      onMenu(item.gen, event.clientX, event.clientY);
    },
  });
  const infoOf = ({ gen }: PoolItem) => ({
    who: gen.creator_name || gen.worker_name || "",
    model: gen.model || "",
    duration: gen.assets[0].type === "video" ? generationListMeta(gen.params ?? {}).duration ?? "" : "",
    state: reviewState(gen),
  });
  const stateMark = (state: string) => (
    <span className={`ed-pstate ed-pstate-${state}`}>{state === "final" ? "★" : state === "held" ? "R" : "S"}</span>
  );
  const trackMark = (item: PoolItem) => item.track !== null && (
    <span className={"cd-mark" + (item.showing ? " lead" : "")}>{editMarkLabel(item.track, t)}</span>
  );
  const rowClass = (item: PoolItem, kind: string) =>
    `ed-prow ed-prow-${kind}` + (picked.includes(item.gen.id) ? " ed-picked" : "") + (item.track !== null ? " ed-placed" : "");
  const pickedGens = picked.map((id) => items.find((item) => item.gen.id === id)?.gen).filter((gen): gen is Generation => !!gen);

  return (
    <section className="ed-pool" onMouseDown={keepFocus}>
      <div className="ed-pool-head">
        <h3 title={title}>{title || t("이 컷의 생성물")}</h3>
        <div className="ed-pool-tools" ref={toolsRef}>
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
            <EditCard key={item.gen.id} item={item} picked={picked.includes(item.gen.id)} handlers={handlersOf(item)} />
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
                  <b>{stateMark(info.state)}{[info.who, info.model].filter(Boolean).join(" · ")}{trackMark(item)}</b>
                  <span>{[formatGenerationDateTime(item.gen.created_at), info.duration].filter(Boolean).join(" · ")}</span>
                  <span className="ed-pprompt">{item.gen.prompt}</span>
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
            <span>{t("프롬프트")}</span><span>{t("만든 사람")}</span><span>{t("모델")}</span><span>{t("길이")}</span><span>{t("트랙")}</span>
          </div>
          {shown.map((item) => {
            const info = infoOf(item);
            return (
              <button key={item.gen.id} type="button" className={rowClass(item, "list")} {...handlersOf(item)}>
                {stateMark(info.state)}
                <span className="ed-pprompt">{item.gen.prompt}</span><span>{info.who}</span><span>{info.model}</span>
                <span>{info.duration}</span><span>{item.track !== null ? `V${item.track}` : ""}</span>
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

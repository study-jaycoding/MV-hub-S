// 공유 & 리뷰 탭의 폴더 묶음 보기 — 고른 폴더 바로 아래 폴더마다 카드 한 장(표지·이름·건수).
//  표지는 팀이 정한 대표, 없으면 가장 최근 것(그때는 카드 위에 '대표 미정'). 한 장짜리 카드와 구분되게 종이를 겹친 모양이다.
//  한 번 클릭 = 고르기(Ctrl·⌘ 토글, Shift 범위, 빈 곳에서 끌면 걸친 카드 모두), 휠 클릭 = 컷 정보(Jay 2026-10-08).
//  두 번 클릭 = 컷(하위 폴더 없음)이면 **모아보기**(고른 카드 위면 고른 컷 전부, 아니면 그 컷만 골라서 — Jay 2026-10-13 낮. 아침엔 '그 폴더로
//  들어가기'였고 그 전엔 폴더 창), 에피소드(하위 폴더 있음)면 그 폴더로 **들어가기**(사이드바에서 그 폴더를 누른 것과 같다).
//  **우클릭 = 그 폴더의 창**(두 번 클릭이 모아보기로 바뀌며 창이 여기로 — Jay 2026-10-13 낮. 메뉴 없이 바로 연다). 우클릭 누름이 위에 뜬 메뉴를
//  닫는 누름이었으면 열지 않는다 — 가림은 누름의 시작(mousedown)에 적어 두고 contextmenu(윈도는 단추를 뗀 뒤 온다)에서 본다. 키보드의
//  메뉴 키는 그 순간의 가림을 본다. 끌기·클릭 판정은 ThumbnailGrid 와 같은 식(5px 안 움직이면 클릭, 마퀴는 lib/marquee).
//  S 단추·작성자 표시는 넣지 않는다 — 이 카드는 생성물 한 장이 아니라 묶음이다.
//  키보드: Ctrl+A 모두 · 방향키 옮기기(Shift = 마지막으로 누른 카드부터 범위) · Enter = 두 번 클릭 · Space = 고르기 토글(2026-10-10 —
//  전엔 키가 하나도 없어 Ctrl+A 가 화면 글자를 긁었다). 색·비활성 같은 생성물 단축키는 없다(묶음이라 대상이 없다).
//  **에피소드 화면**(하위 폴더를 가진 카드가 놓인 단계 — lib/episodeBoard)은 모양만 다르다: 도구 줄의 리스트 보기 = 에피소드마다 가로 한 줄,
//  그리드 보기 = 컷 띠가 붙은 큰 카드(Jay 2026-10-13). 카드는 같은 `.cut-card[data-path]` 라 위의 고르기·마퀴·키가 그대로 듣는다. 카드 안의
//  단추(컷 띠의 컷 · '+N' · [열기], `data-ep-action`)의 누름은 카드 고르기·두 번 클릭으로 읽지 않는다 — 그 단추가 제 일을 한다.
//  **컷 화면의 리스트**(2026-10-13 오후): 리스트 단추 한 번 = 같은 줄 모양(띠에는 그 컷의 생성물 — 누르면 크게 보기, [폴더로] = 그 컷 폴더로),
//  한 번 더(도구 줄의 '날짜별 구분' 자리 — 폴더 카드에는 날짜 구분이 없다) = 표. 그리드의 컷 카드(겹친 종이)는 그대로다.
import { useCallback, useEffect, useRef, useState } from "react";
import { boardView, isEpisodeLevel, numberColumn, takesOf } from "../lib/episodeBoard";
import { useT } from "../lib/i18n";
import { backgroundKeysBlocked, isTypingTarget, pressStartedCovered, useLooseKeys } from "../lib/keyGate";
import { computeMarquee, marqueeHits, type MarqueeRect } from "../lib/marquee";
import { mediaThumbUrl, thumbOf } from "../lib/media";
import { matchShortcut } from "../lib/shortcuts";
import { addWindowMouseDrag, dragLost, removeWindowMouseDrag } from "../lib/windowDrag";
import type { FolderCard, FolderCardTake, PreviewItem, PreviewTarget } from "../types";
import { CoverInfo } from "./CoverInfo";
import { EpisodeCardBody } from "./EpisodeCardBody";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folders: FolderCard[];
  scale: number; // 라이브러리 격자와 같은 카드 크기 배율
  fill: boolean; // 썸네일 꽉 채움 ↔ 비율 유지
  layout: "grid" | "list"; // 도구 줄의 보기 방식 — 리스트 = 가로 한 줄, 그리드 = 에피소드 화면은 컷 띠가 붙은 카드·컷 화면은 겹친 종이 카드
  table: boolean; // 리스트 단추를 한 번 더 누른 상태(도구 줄의 '날짜별 구분' 값) — 리스트를 표로
  selected: ReadonlySet<string>; // 고른 카드(폴더 경로)
  onSelect: (next: Set<string>) => void;
  // 두 번 클릭·Enter(하위 폴더 있음 = 에피소드) — 그 폴더로 들어가기. 크롬 뒤로 가기가 이 묶음으로 돌아온다(App 의 enterFolderCard 가 기록을 한 칸 쌓는다).
  onEnter: (folder: FolderCard) => void;
  onOpen: (folder: FolderCard) => void; // 우클릭·메뉴 키 — 그 폴더의 창(에피소드·컷 모두. Jay 2026-10-13 낮)
  onInfo: (folder: FolderCard, x: number, y: number) => void; // 휠 클릭 — 컷 정보
  onReel: (paths: string[]) => void; // 두 번 클릭·Enter(하위 폴더 없음 = 컷) — 모아보기(고른 카드 위면 고른 컷 전부(격자 순서), 아니면 그 컷만)
  onPreview: (target: PreviewTarget) => void; // 컷 줄의 생성물 띠 — 크게 보기(그 띠에 실린 것끼리 ←/→)
  top: boolean; // 프로젝트 맨 위(에피소드 단계)인가 — '컷 밖' 대신 '에피소드 밖'
  outside: number; // 고른 폴더에 직접 든 수 — 어느 카드에도 들지 않아 맨 끝 칸으로 알린다
  onShowAll: () => void; // 그 칸을 누르면 한 장씩 보기로
}

// 한 줄에 놓인 카드 수 — 화면에 놓인 자리로 센다(열 수는 CSS 가 폭에 맞춰 정한다).
function columnsOf(grid: HTMLElement): number {
  const cards = grid.querySelectorAll<HTMLElement>(".cut-card[data-path]");
  let count = 0;
  for (const card of cards) {
    if (card.offsetTop !== cards[0].offsetTop) break;
    count += 1;
  }
  return Math.max(1, count);
}

interface Drag {
  x: number;
  y: number;
  path: string | null; // 카드 위에서 시작했으면 그 카드, 빈 곳이면 null(마퀴)
  additive: boolean; // Ctrl·⌘
  range: boolean; // Shift
  base: Set<string>; // 시작 때 고른 것
  moved: boolean;
}

// 카드 안의 단추(에피소드 카드의 컷 띠·[열기])에서 난 누름인가 — 그 누름은 카드의 것이 아니다.
function inCardAction(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.("[data-ep-action]");
}

export function FolderCardGrid({
  folders, scale, fill, layout, table, selected, onSelect, onEnter, onOpen, onInfo, onReel, onPreview, top, outside, onShowAll,
}: Props) {
  const t = useT();
  const view = boardView(folders, layout, table); // 줄·카드·표 — 모양만 다르다(머리말). null = 겹친 종이 카드(컷 화면의 그리드)
  const board = view !== null;
  const rows = view === "list" || view === "table"; // 한 줄에 하나
  const cutsColumn = isEpisodeLevel(folders); // 표의 '컷' 열 — 하위 폴더를 가진 카드가 있는 화면만
  const numbers = numberColumn(folders);
  // 생성물 띠의 그림 → 크게 보기. 띠에 실린 것끼리 넘겨 본다(생성물 카드의 크게 보기와 같은 모양 — 썸네일 주소는 띠의 것과 같아야 바로 뜬다).
  const previewTake = (folder: FolderCard, take: FolderCardTake) => {
    const items: PreviewItem[] = (takesOf(folder)?.takes ?? []).flatMap((one) => {
      const media = one.cover.assets?.[0];
      if (!media?.file_path) return [];
      return [{
        url: media.file_path, type: media.type === "video" ? "video" as const : "image" as const, name: folder.name, genId: one.cover.id,
        thumb: mediaThumbUrl(media.file_path, media.thumbnail_path, media.type, 256),
      }];
    });
    const index = items.findIndex((item) => item.genId === take.cover.id);
    if (index >= 0) onPreview({ ...items[index], items, index });
  };
  // 두 번 클릭·Enter — 컷이면 모아보기(고른 카드 위면 고른 컷 전부(격자 순서), 아니면 그 컷만 골라서), 에피소드면 들어가기.
  //  열 경로를 먼저 정한다 — 고르기를 바꾼 뒤의 낡은 선택을 읽지 않게. 최신 props 는 ref 로(두 번 클릭의 첫 클릭이 고르기를 바꾼 직후다).
  //  일반 두 번 클릭은 첫 클릭이 고르기를 그 카드 하나로 줄이므로 결국 그 컷만 연다(탐색기와 같다) — 여러 컷은 Ctrl 로 고른 뒤 두 번 클릭하거나
  //  Shift+방향키로 고른 뒤 Enter, 또는 선택 막대의 단추(Codex 코드 리뷰 — 숨은 규칙이 아니라 의도).
  const activate = (folder: FolderCard) => {
    if (folder.subfolders) {
      onEnter(folder);
      return;
    }
    const { folders: list, selected: chosen, onSelect: select } = opsRef.current;
    const paths = chosen.has(folder.path) ? list.filter((item) => chosen.has(item.path)).map((item) => item.path) : [folder.path];
    if (!chosen.has(folder.path)) select(new Set([folder.path]));
    onReel(paths);
  };
  const width = Math.round((board ? 340 : 180) * scale); // 컷 카드는 ThumbnailGrid 의 카드 최소 폭과 같은 식, 에피소드 카드는 그 두 배쯤
  const thumbSize = !board && width * (window.devicePixelRatio || 1) <= 256 ? 256 : 512;
  const now = Date.now(); // 에피소드 카드의 '2시간 전' — 한 번 재어 모든 카드에 같은 값을(다시 그릴 때마다 새로)
  const gridRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const anchorRef = useRef<string | null>(null); // Shift 범위의 시작 = 마지막으로 누른 카드
  const cursorRef = useRef<string | null>(null); // 방향키가 가리키는 카드 — 누른 카드에서 시작한다
  // 최신 props 를 ref 로 — 창 전역 리스너가 낡은 값을 잡지 않게.
  const opsRef = useRef({ folders, selected, onSelect });
  opsRef.current = { folders, selected, onSelect };
  const rafRef = useRef<number | null>(null);
  const lastMoveRef = useRef<MouseEvent | null>(null);

  // 마퀴 히트 계산은 프레임당 한 번(ThumbnailGrid 와 같다).
  const flushMarquee = useCallback(() => {
    rafRef.current = null;
    const e = lastMoveRef.current;
    const d = dragRef.current;
    const grid = gridRef.current;
    if (!e || !d || !grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const base = d.additive || d.range ? d.base : [];
    opsRef.current.onSelect(marqueeHits<string>(grid, ".cut-card[data-path]", b, base, (el) => el.dataset.path || null));
  }, []);
  // 카드 위에서 시작한 끌기도 마퀴다 — 카드가 꽉 찬 격자에는 빈 곳이 없어 달리 시작할 데가 없다(10-09 실측: 100장에서 0장 고름).
  //  생성물 카드와 달리 컷 카드에는 끌어 놓을 데(프롬프트 재사용)가 없어 겹칠 것이 없다. 5px 안이면 클릭.
  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    lastMoveRef.current = e;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushMarquee);
  }, [flushMarquee]);
  // 끝 — mouseup 이면 클릭 판정, 놓쳐서(창을 떠남·단추를 뗀 채 온 움직임 — lib/windowDrag) 끝났으면 버린다(Alt+Tab 뒤 돌아온 움직임이
  //  고르기로 이어지지 않게).
  const endDragRef = useRef<(e?: Event) => void>(() => {});
  const onDragEnd = useCallback((e?: Event) => endDragRef.current(e), []);
  endDragRef.current = (e?: Event) => {
    const left = dragLost(e);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      // 마지막 움직임의 계산이 아직 안 돌았으면 지금 돌린다 — 놓는 순간의 선택이 버려지지 않게(Codex 코드 리뷰). 놓친 것은 버린다.
      if (!left) flushMarquee();
    }
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragEnd);
    setMarquee(null);
    // 마퀴로 고른 뒤에는 누른 자리를 비운다 — 남으면 Shift 클릭·방향키가 (마퀴와 무관한) 먼저 누른 카드에서 출발한다. 비우면 기준은
    //  '고른 것 중 마지막 카드'다(ThumbnailGrid 와 같은 규칙).
    if (d?.moved && !left) {
      anchorRef.current = null;
      cursorRef.current = null;
    }
    if (!d || d.moved || left) return;
    const { folders: list, onSelect: select } = opsRef.current;
    if (d.path) {
      const anchor = anchorRef.current;
      let from = anchor === null ? -1 : list.findIndex((folder) => folder.path === anchor);
      // 누른 카드가 없거나(마퀴로만 고른 뒤) 그사이 목록에서 사라졌으면(다른 창이 그 폴더를 지우거나 이름을 바꿨다) 고른 것 중 목록의
      //  마지막 카드부터 — 전엔 Shift 클릭이 한 장만 골랐다(2026-10-10 재실측).
      const lost = from < 0;
      if (lost && d.range) for (let i = list.length - 1; i >= 0 && from < 0; i--) if (d.base.has(list[i].path)) from = i;
      // 이어지는 Shift 클릭도 같은 카드에서 잰다. 사라진 기준을 그대로 두면 매번 '고른 것 중 마지막'을 다시 찾아, 범위의 앞쪽이 잘려 나갔다
      //  (조작 규칙 45)
      if (lost && from >= 0) anchorRef.current = list[from].path;
      const to = list.findIndex((folder) => folder.path === d.path);
      if (d.range && from >= 0 && to >= 0) {
        // Shift = 마지막으로 누른 카드~여기(격자 순서). 시작은 그대로 둔다 — 이어서 Shift 로 범위를 고친다.
        const [lo, hi] = from < to ? [from, to] : [to, from];
        select(new Set(list.slice(lo, hi + 1).map((folder) => folder.path)));
        cursorRef.current = d.path;
        return;
      }
      anchorRef.current = d.path;
      cursorRef.current = d.path;
      if (d.additive) {
        const next = new Set(d.base);
        if (next.has(d.path)) next.delete(d.path);
        else next.add(d.path);
        select(next);
      } else select(new Set([d.path]));
    } else if (!d.additive && !d.range) select(new Set());
  };
  // 언마운트(폴더 창이 열리며 격자가 사라지는 등) — 누르고 있던 끌기를 버린다(ThumbnailGrid 와 같은 이유).
  useEffect(() => () => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragEnd);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, [onDragMove, onDragEnd]);

  // 격자의 키 — 격자에 초점이 있을 때(onKeyDown)와 초점 잃은 키(useLooseKeys)가 같이 쓴다.
  const onGridKey = (e: KeyboardEvent) => {
    if (backgroundKeysBlocked() || isTypingTarget(e.target)) return; // 위에 뜬 창·메뉴의 키, 글자 입력
    if ((e.target as HTMLElement | null)?.closest?.(".cut-out")) return; // '컷 밖' 칸의 Enter·Space 는 그 단추를 누르는 키
    // 카드 안 단추(띠·[열기]·[폴더로])에 초점이 있으면 Enter·Space 는 그 단추의 키다. 그 밖의 키(방향키·Ctrl+A)는 격자의 것 — 띠의 그림으로
    //  크게 보기를 열었다 닫으면 초점이 그 단추로 돌아오는데, 거기서 격자의 키가 죽으면 안 된다(Codex 코드 리뷰). 출발 자리는 그 단추가 든 카드다.
    if (inCardAction(e.target) && (e.key === "Enter" || e.key === " ")) return;
    const { folders: list, selected: chosen, onSelect: select } = opsRef.current;
    if (!list.length) return;
    if (matchShortcut(e, "selectAll")) {
      e.preventDefault();
      select(new Set(list.map((folder) => folder.path)));
      return;
    }
    // 키가 가리키는 카드: ① 초점이 놓인 카드(Tab 으로 옮긴 경우) ② 방향키·클릭이 남긴 자리 — 그 카드가 골라져 있거나 고른 것이
    //  없을 때(Space 로 막 뺀 자리) ③ 그 밖에는 고른 것 중 목록의 마지막 카드(마퀴로 고른 뒤). 밖에서 선택을 비우면(Esc·빈 곳 클릭)
    //  남긴 자리도 지운다(아래 effect) — 보이지 않는 자리에 Enter 가 듣지 않게.
    const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".cut-card[data-path]")?.dataset.path;
    const kept = cursorRef.current ?? anchorRef.current;
    let pointed: string | null = focused ?? null;
    if (pointed === null) {
      // 남긴 자리가 그사이 목록에서 사라졌으면(다른 창이 그 폴더를 지웠다) 쓰지 않는다 — 고른 것에는 남아 있을 수 있어(부모는 목록과의
      //  교집합으로 쓴다), 그대로 가리키면 방향키가 맨 앞 카드로 튀었다(조작 규칙 45)
      if (kept !== null && list.some((folder) => folder.path === kept) && (chosen.has(kept) || chosen.size === 0)) pointed = kept;
      else for (const folder of list) if (chosen.has(folder.path)) pointed = folder.path;
    }
    const at = list.findIndex((folder) => folder.path === pointed);
    if (e.altKey && e.key.startsWith("Arrow")) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const grid = gridRef.current;
      const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : (e.key === "ArrowUp" ? -1 : 1) * (grid ? columnsOf(grid) : 1);
      const next = at < 0 ? 0 : at + step < 0 || at + step >= list.length ? at : at + step;
      const path = list[next].path;
      cursorRef.current = path;
      // 누른 카드가 없거나(마퀴로만 고른 뒤) 목록에서 사라졌으면 지금 가리키는 카드(고른 것 중 마지막)가 Shift 범위의 시작이다 —
      //  사라진 기준을 그대로 두면 Shift+방향키가 범위를 버리고 한 장만 골랐다(조작 규칙 45)
      if (e.shiftKey && at >= 0 && !list.some((folder) => folder.path === anchorRef.current)) anchorRef.current = list[at].path;
      const from = e.shiftKey && anchorRef.current !== null ? list.findIndex((folder) => folder.path === anchorRef.current) : -1;
      if (from >= 0) {
        const [lo, hi] = from < next ? [from, next] : [next, from];
        select(new Set(list.slice(lo, hi + 1).map((folder) => folder.path)));
      } else {
        anchorRef.current = path;
        select(new Set([path]));
      }
      const card = [...(grid?.querySelectorAll<HTMLElement>(".cut-card[data-path]") ?? [])].find((el) => el.dataset.path === path);
      card?.scrollIntoView?.({ block: "nearest" });
      // 초점이 카드에 놓여 있었으면(Tab·우클릭) 격자로 옮긴다 — 남겨 두면 '초점 카드 먼저' 규칙 때문에 다음 방향키가 다시 그 카드에서
      //  출발해 한 칸에서 멈추고, Enter 가 옮겨 간 카드가 아니라 초점 카드를 연다(Codex 코드 리뷰).
      if (grid && document.activeElement !== grid && grid.contains(document.activeElement)) grid.focus({ preventScroll: true });
      return;
    }
    if (at < 0) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return; // 길게 눌린 Enter 에 폴더가 열리지 않게
      // 여는 것은 **보이는** 카드만 — 골라져 있거나 초점이 놓인 카드. Space 로 뺀 자리(다시 고르기·방향키용으로만 남긴 것)는 화면에
      //  아무 표시가 없다: 그 자리에 Enter 가 폴더 창을 열었다(2026-10-10 최종 재실측 — Space 로 빼고 Esc 뒤 Enter).
      if (focused == null && !chosen.has(list[at].path)) return;
      activate(list[at]);
    } else if (e.key === " ") {
      e.preventDefault();
      if (e.repeat) return; // 길게 눌린 Space — 고르기는 토글이라 반복마다 뒤집힌다(조작 규칙 38)
      const next = new Set(chosen);
      if (next.has(list[at].path)) next.delete(list[at].path);
      else next.add(list[at].path);
      cursorRef.current = list[at].path;
      keepCursorRef.current = next.size === 0; // Space 로 마지막 카드를 뺐다 — 자리는 그대로(한 번 더 누르면 다시 고른다)
      select(next);
    }
  };
  useLooseKeys(gridRef, onGridKey);
  // 선택이 비면 방향키·Shift 의 자리도 지운다 — Space 로 뺀 경우만 예외.
  const keepCursorRef = useRef(false);
  useEffect(() => {
    if (selected.size > 0) return;
    if (keepCursorRef.current) keepCursorRef.current = false;
    else {
      cursorRef.current = null;
      anchorRef.current = null;
    }
  }, [selected]);

  // 우클릭 누름이 시작될 때 위에 메뉴가 떠 있었나 — contextmenu 는 단추를 뗀 뒤 오므로(윈도) 그때는 lib/keyGate 의 '누름 중 가림'이 이미 지워져 있다.
  //  우클릭 누름마다 새로 적는다. 쓰는 곳은 **마우스의 contextmenu(button 2)뿐** — 키보드의 메뉴 키(button 0)는 기록을 보지 않고 그 순간의 가림을 본다.
  //  그래서 소비되지 않은 기록(빈 곳의 우클릭·카드 밖에서 떼어 contextmenu 가 다른 곳에서 났거나 전파가 막힌 경우)이 남아도, 다음 마우스 우클릭은
  //  누름에서 다시 적고 메뉴 키는 안 보니 낡은 기록이 쓰일 길이 없다(Codex 코드 리뷰 2회).
  const rightPressCoveredRef = useRef<boolean | null>(null);
  // 카드 안 단추(에피소드 카드의 컷 띠·[열기])의 누름이 가려진 채 시작됐나. 마우스 클릭(detail > 0)은 늘 같은 단추의 누름이 앞서 새로 적으므로
  //  낡은 기록이 쓰일 길이 없고, 키보드로 누른 것(Enter·Space — detail 0)은 기록을 보지 않고 그 순간의 가림을 본다.
  const actionCoveredRef = useRef(false);
  const actionCovered = (e: React.MouseEvent): boolean => {
    const covered = e.detail > 0 ? actionCoveredRef.current : backgroundKeysBlocked();
    actionCoveredRef.current = false;
    return covered;
  };
  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 휠 클릭의 자동 스크롤 막기(정보는 카드의 auxclick)
      return;
    }
    if (e.button === 2) {
      rightPressCoveredRef.current = pressStartedCovered();
      return; // 고르기는 바꾸지 않는다 — 초점은 누른 카드로 간다(모아보기를 닫으면 거기로 돌아온다)
    }
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".cut-out")) return; // '컷 밖' 칸은 고르는 대상이 아니다(누르면 한 장씩 보기)
    if (inCardAction(target)) {
      // 카드 안 단추(컷 띠·[열기]) — 고르기를 바꾸지 않고 그 단추가 제 일을 한다. 다만 위에 뜬 메뉴를 닫는 누름이었으면 그 일도 하지 않는다:
      //  단추의 click 은 누름 뒤에 와서 그때는 가림이 이미 풀려 있다 — 누름의 시작에 적어 두고 click 에서 본다(우클릭의 기록과 같은 이유).
      actionCoveredRef.current = pressStartedCovered();
      return;
    }
    // 컷 카드 아래의 정보판을 누른 것도 그 카드를 누른 것이다(카드와 한 칸 — .cut-slot)
    const card = (target.closest(".cut-card[data-path]")
      ?? target.closest(".cut-slot")?.querySelector(".cut-card[data-path]") ?? null) as HTMLElement | null;
    e.preventDefault(); // 끌 때 글자·그림이 긁히지 않게(카드 위에서 시작해도 마퀴)
    if (pressStartedCovered()) return; // 위에 뜬 메뉴를 닫는 누름 — 고른 것을 바꾸지 않는다
    gridRef.current?.focus();
    dragRef.current = {
      x: e.clientX, y: e.clientY, path: card?.dataset.path ?? null,
      additive: e.ctrlKey || e.metaKey, range: e.shiftKey, base: new Set(opsRef.current.selected), moved: false,
    };
    addWindowMouseDrag(onDragMove, onDragEnd);
  };

  return (
    <div className="grid-wrap">
      {/* tabIndex — 폴더 창을 닫은 뒤 초점을 돌려받는 자리(App 의 초점 복원) */}
      <div
        className={"cut-grid" + (board ? ` ep-board ep-${view}` + (view === "table" && cutsColumn ? " has-cuts" : "") : "")}
        ref={gridRef}
        tabIndex={-1}
        style={{
          // 리스트(줄·표)는 한 줄에 하나, 그 밖에는 폭에 맞춰 채운다. --ep-scale = 크기 슬라이더, --ep-num-* = 번호 칸(episode-board.css 가 쓴다)
          gridTemplateColumns: rows ? "minmax(0, 1fr)" : `repeat(auto-fill, minmax(${width}px, 1fr))`,
          ...(board
            ? ({ "--ep-scale": String(scale), "--ep-num-w": `${numbers.width}px`, "--ep-num-size": `${numbers.size}px` } as React.CSSProperties)
            : {}),
        }}
        onMouseDown={onGridMouseDown}
        onKeyDown={(e) => onGridKey(e.nativeEvent)}
      >
        {view === "table" && (
          // 표의 머리줄 — 카드가 아니다(고르기·키의 대상이 아님). 열은 줄과 같은 틀(--ep-t-cols)
          <div className="ep-table-head" aria-hidden="true">
            <span /><span />
            <span>{t(top ? "에피소드" : "컷")}</span>
            {cutsColumn && <span className="n">{t("컷")}</span>}
            <span>{t("대표")}</span>
            <span className="n">{t("건수")}</span>
            <span className="n">{t("영상")}</span>
            <span className="n">{t("공유")}</span>
            <span className="n">★ {t("최종")}</span>
            <span className="n">R {t("보류")}</span>
            <span>{t("마지막 공유")}</span>
            <span>{t("작업자")}</span>
            <span />
          </div>
        )}
        {folders.map((folder) => {
          const asset = folder.cover.assets?.[0];
          const isVideo = asset?.type === "video";
          const isSelected = selected.has(folder.path);
          const subfolders = folder.subfolders ?? 0;
          // 카드의 누름·키는 두 모양이 같이 쓴다(에피소드 화면의 카드는 안에 단추가 들어 있어 div — 단추 안에 단추를 둘 수 없다).
          const card = {
            "data-path": folder.path,
            "aria-pressed": isSelected,
            title: `${folder.path} · ${subfolders ? `${t("컷")} ${subfolders} · ` : ""}${folder.count}${t("건")}`,
            onDoubleClick: (e: React.MouseEvent) => {
              if (!inCardAction(e.target)) activate(folder); // 카드 안 단추를 빠르게 두 번 누른 것은 카드의 두 번 클릭이 아니다
            },
            onAuxClick: (e: React.MouseEvent) => {
              if (e.button !== 1) return;
              e.preventDefault();
              if (!isSelected) onSelect(new Set([folder.path]));
              onInfo(folder, e.clientX, e.clientY);
            },
            onContextMenu: (e: React.MouseEvent) => {
              e.preventDefault(); // 컷 카드 위에서만 브라우저 메뉴를 막는다
              // 마우스(button 2)는 누름 시작의 가림, 키보드의 메뉴 키(button 0)는 지금의 가림
              const covered = e.button === 2 ? (rightPressCoveredRef.current ?? backgroundKeysBlocked()) : backgroundKeysBlocked();
              rightPressCoveredRef.current = null;
              if (covered) return; // 위에 뜬 메뉴를 닫는 우클릭 — 뒤의 조작을 실행하지 않는다
              // 그 폴더의 창 — 고르지 않은 카드면 그것만 골라서(어느 폴더를 열었는지 보이게. 창을 닫으면 초점은 격자로 돌아온다)
              const { selected: chosen, onSelect: select } = opsRef.current;
              if (!chosen.has(folder.path)) select(new Set([folder.path]));
              onOpen(folder);
            },
          };
          if (board)
            return (
              <div
                key={folder.path} role="button" tabIndex={0}
                className={`cut-card ep-card ep-${view}` + (subfolders ? "" : " leaf") + (isSelected ? " sel" : "")}
                {...card}
              >
                <EpisodeCardBody
                  folder={folder} layout={view} thumbSize={thumbSize} fill={fill} now={now} cutsColumn={cutsColumn}
                  onEnter={(e) => {
                    if (!actionCovered(e)) onEnter(folder);
                  }}
                  onPreviewTake={(take, e) => {
                    if (!actionCovered(e)) previewTake(folder, take);
                  }}
                  // 컷 띠의 컷 = 그 컷으로 바로(사이드바에서 그 컷을 누른 것과 같다 — 에피소드로 들어가는 것과 같은 길)
                  onEnterCut={(cut, e) => {
                    if (!actionCovered(e)) onEnter({ ...folder, path: cut.path, name: cut.name, subfolders: 0 });
                  }}
                />
              </div>
            );
          // 컷 카드 + 아래 정보판(모델·작업자·크레딧·생성일·검토 — 모아보기 카드와 같은 줄, Jay 2026-10-13). 고르기·마퀴·키의 대상은 전처럼
          //  카드(.cut-card[data-path])다 — 정보판은 그 카드의 일부처럼 듣는다(누름은 위 onGridMouseDown, 두 번 클릭·우클릭·휠 클릭은 같은 처리).
          return (
            <div key={folder.path} className="cut-slot">
            <button type="button" className={"cut-card" + (isSelected ? " sel" : "")} {...card}>
              <span className={"cut-face" + (fill ? "" : " contain")}>
                {/* 생성물 카드와 같은 그림 분기(깨진 뒤 새 대표로 바뀌면 다시 보이고, 포스터 없는 영상은 첫 프레임) */}
                <MediaThumbnail
                  thumb={thumbOf(folder.cover, thumbSize)}
                  isVideo={isVideo}
                  src={asset?.file_path}
                  alt=""
                  fallback={null}
                />
                {isVideo && <span className="play-badge">▶</span>}
                <span className="cut-tab">
                  <span>{folder.name}</span>
                  {subfolders > 0 && <em>{t("컷")} {subfolders} ·</em>}
                  <b>{folder.count}</b>
                </span>
              </span>
              {!folder.rep && <span className="cut-pill">{t("대표 미정")}</span>}
            </button>
            <CoverInfo
              folder={folder} className={"cut-meta" + (isSelected ? " sel" : "")}
              onDoubleClick={card.onDoubleClick} onAuxClick={card.onAuxClick} onContextMenu={card.onContextMenu}
            />
            </div>
          );
        })}
        {outside > 0 && (
          <button
            type="button"
            className="cut-card cut-out"
            title={t("이 폴더에 직접 든 생성물은 컷 카드에 들지 않습니다 — 누르면 한 장씩 모두 봅니다")}
            onClick={onShowAll}
          >
            <span className="cut-out-count">{t(top ? "에피소드 밖" : "컷 밖")} {outside}{t("건")}</span>
            <span className="cut-out-hint">{t("한 장씩 보기")}</span>
          </button>
        )}
        {marquee && (
          <div
            className="assets-marquee"
            style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>
    </div>
  );
}

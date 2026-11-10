import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode, type RefObject, type UIEventHandler } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import { backgroundKeysBlocked, isTypingTarget, useLooseKeys } from "../../lib/keyGate";
import { isKeyHandled, markKeyHandled } from "../../lib/keyHandled";
import { EPISODE_CARD_WIDTH, STRIP_SHOWN } from "../../lib/episodeBoard";
import type { AssetNode } from "../../types";
import { FolderIcon } from "../FolderIcon";
import { FolderCardCoverContent, FolderCardPreview } from "../FolderCardVisuals";
import { MediaThumbnail } from "../MediaThumbnail";
import { LastViewedBadge } from "../scene/LastViewedBadge";
import type { AssetFolderGroup } from "./assetFolderGroups";
import type { AssetFolderLayout } from "./useAssetFolderTabs";
import { AssetFolderTable } from "./AssetFolderTable";
import { AssetSourcePath } from "./AssetSourcePath";

export interface AssetFolderGridProps {
  project: string;
  groups: AssetFolderGroup[];
  directFiles: AssetNode[];
  scale: number;
  fit: "cover" | "contain";
  layout: AssetFolderLayout;
  lastViewedPath?: string;
  initialSelected?: string | null; // 처음 고른 카드 — 뒤로 돌아온 폴더(격자는 폴더마다 새로 선다)
  scrollRef: RefObject<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onEnter: (path: string) => void;
  onOpenTab: (path: string) => void;
  onPreview: (file: AssetNode) => void;
}

/** 표 보기(AssetFolderTable)에 넘기는 선택·키 — 카드·목록·표가 같은 선택과 키 처리를 쓴다. */
export interface AssetFolderSelection {
  selected: string | null;
  setSelected: (path: string | null) => void;
  onGridKeyDown: (e: ReactKeyboardEvent) => void;
}

// 폴더가 많으면 먼 카드의 썸네일은 가까워질 때 붙인다 — 폴더 300개를 열 때 멈춤의 70~80% 가 썸네일 부품(카드마다 표지 + 띠)을 만드는
//  비용이었다(2026-11-10 실측, 설계 docs/status/격자지연_폴더카드_가상목록_설계_2026-11-10.md v3.1 · Codex 합의). 카드 DOM 은 그대로라
//  방향키·Backspace 되돌아오기·스크롤 복원은 바뀌지 않는다.
const NEAR_EAGER_MAX = 48; // shortcut: 항목이 이 수 이하면 지금처럼 바로 그린다 — 화면 두세 쪽 분량으로 정한 값, 실측으로 바꿀 수 있다
const NEAR_MARGIN = "600px 0px"; // 스크롤 상자 위아래 가장자리에서 이만큼 안에 들면 붙인다

interface NearRegistry {
  watch(card: Element, onNear: () => void): () => void;
}
const NearContext = createContext<NearRegistry | null>(null);

/** 카드 요소마다 {켜짐, 구독자}. 관찰자(root = 스크롤 상자)는 상자가 생기거나 바뀔 때 attach 로 다시 만든다 — 그 전에 들어온 등록은 pending 에 남아
 *  새 관찰자가 관찰한다(자식 효과가 부모 효과보다 먼저 돈다). 늦게 온 옛 관찰자의 알림은 세대 번호로 버린다. */
function createNearRegistry() {
  const entries = new WeakMap<Element, { on: boolean; subs: Set<() => void> }>();
  const pending = new Set<Element>(); // 안 켜졌고 구독자가 있는 카드
  let observer: IntersectionObserver | null = null;
  let generation = 0;
  const turnOn = (card: Element) => {
    const entry = entries.get(card);
    if (!entry || entry.on) return;
    entry.on = true;
    pending.delete(card);
    observer?.unobserve(card);
    for (const notify of [...entry.subs]) notify();
  };
  return {
    watch(card: Element, onNear: () => void) {
      const entry = entries.get(card) ?? { on: false, subs: new Set<() => void>() };
      entries.set(card, entry);
      // 이미 켜진 카드에 새로 붙은 썸네일(검색·트리 갱신으로 띠가 바뀜)은 바로 — 교차 상태가 그대로면 알림이 다시 오지 않는다
      if (entry.on) {
        onNear();
        return () => {};
      }
      entry.subs.add(onNear);
      if (!pending.has(card)) {
        pending.add(card);
        observer?.observe(card);
      }
      return () => { // 자기 구독만 뺀다 — 같은 카드의 다른 썸네일이 남아 있으면 관찰을 풀지 않는다
        entry.subs.delete(onNear);
        if (!entry.on && entry.subs.size === 0) {
          pending.delete(card);
          observer?.unobserve(card);
        }
      };
    },
    attach(root: Element) {
      observer?.disconnect();
      const mine = ++generation;
      observer = new IntersectionObserver((list) => {
        if (mine !== generation) return;
        for (const item of list) if (item.isIntersecting) turnOn(item.target);
      }, { root, rootMargin: NEAR_MARGIN });
      for (const card of pending) observer.observe(card);
    },
    detach() {
      generation += 1;
      observer?.disconnect();
      observer = null;
    },
  };
}

/** 썸네일 자리 — 처음엔 빈 자리(단추의 직계 자식 span 하나), 카드가 가까워지면 render() 를 감싸는 요소 없이 그대로. 한 번 붙으면 떼지 않는다.
 *  카드 요소(.assets-folder-card)를 관찰한다 — 카드는 content-visibility 로 내용을 건너뛰어도 자기 상자는 있다. */
function NearThumb({ eager, render }: { eager: boolean; render: () => ReactNode }) {
  const registry = useContext(NearContext);
  const [shown, setShown] = useState(eager);
  const spot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (shown) return;
    const card = spot.current?.closest(".assets-folder-card");
    if (eager || !registry || !card) {
      setShown(true);
      return;
    }
    return registry.watch(card, () => setShown(true));
  }, [eager, shown, registry]);
  return shown ? <>{render()}</> : <span ref={spot} className="assets-folder-placeholder" />;
}

// 카드가 한 줄에 몇 장인가 — 위·아래 방향키의 걸음(공유 탭 컷 카드 격자와 같은 셈).
function columnsOf(grid: HTMLElement): number {
  const cards = grid.querySelectorAll<HTMLElement>(":scope > [data-folder-path], :scope > [data-file-path]");
  let count = 0;
  for (const card of cards) {
    if (card.offsetTop !== cards[0].offsetTop) break;
    count += 1;
  }
  return Math.max(1, count);
}

export function AssetFolderGrid(props: AssetFolderGridProps) {
  const { project, groups, directFiles, scale, fit, layout, lastViewedPath, initialSelected, scrollRef, onScroll, onEnter, onOpenTab, onPreview } = props;
  const t = useT();
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  // 키보드(Jay 10-22 — 워크스페이스·공유처럼): 방향키 = 옆·위아래 카드를 고르고 초점도 옮긴다 · Enter = 고른 폴더로 들어가기/파일 크게 보기 ·
  //  Esc = 고른 것 풀기. 초점이 BODY·툴바에 있어도 받는다(useLooseKeys). 카드 안 단추에 초점이 있으면 Enter·Space 는 그 단추의 키다.
  const items = [...groups.map(({ folder }) => ({ path: folder.path, file: null as AssetNode | null })),
    ...directFiles.map((file) => ({ path: file.path, file }))];
  const onGridKey = (e: KeyboardEvent) => {
    if (backgroundKeysBlocked() || isTypingTarget(e.target) || e.isComposing || !items.length) return;
    const grid = scrollRef.current;
    if (!grid) return;
    const target = e.target as HTMLElement | null;
    const onControl = !!target?.closest?.("button, tr[tabindex]") && grid.contains(target);
    // 출발 카드 = 초점이 놓인 카드·줄(Tab 으로 옮겼을 수 있다), 없으면 고른 것(Codex 검토 3 K2 — 공유 탭 컷 카드와 같은 순서)
    const focusedCard = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-folder-path], [data-file-path]");
    const focusedPath = focusedCard && grid.contains(focusedCard)
      ? focusedCard.getAttribute("data-folder-path") ?? focusedCard.getAttribute("data-file-path") : null;
    const at = items.findIndex((item) => item.path === (focusedPath ?? selected));
    if (e.key.startsWith("Arrow")) {
      if (e.altKey) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로
      e.preventDefault();
      const rows = layout !== "grid";
      const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1
        : (e.key === "ArrowUp" ? -1 : 1) * (rows ? 1 : columnsOf(grid));
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + step));
      const path = items[next].path;
      setSelected(path);
      const attr = items[next].file ? "data-file-path" : "data-folder-path";
      const card = [...grid.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.getAttribute(attr) === path);
      const focusable = card?.matches("tr") ? card : card?.querySelector<HTMLElement>(".ep-cover");
      focusable?.focus({ preventScroll: true });
      card?.scrollIntoView?.({ block: "nearest" });
    } else if (e.key === "Enter") {
      if (onControl || e.repeat || at < 0) return; // 초점 놓인 카드 단추·줄은 제 Enter 로 연다
      e.preventDefault();
      const item = items[at];
      if (item.file) onPreview(item.file);
      else onEnter(item.path);
    } else if (e.key === "Escape") {
      if (isKeyHandled(e) || selected === null) return;
      markKeyHandled(e);
      setSelected(null);
    }
  };
  useLooseKeys(scrollRef, onGridKey, (e) => e.key !== "Backspace"); // Backspace 는 어셋 창의 '상위 폴더로' 처리 몫(AssetsView)
  const onGridKeyDown = (e: ReactKeyboardEvent) => onGridKey(e.nativeEvent);
  // 화면 밖 카드의 자리 높이 — CSS(assets.css)가 먼 카드를 건너뛰고(content-visibility) 이 높이로 자리만 잡는다. 지금 그려진 카드 하나를
  //  잰다(건너뛴 카드는 자리 높이를 돌려준다). 크기·보기·맞춤·개수·격자 폭이 바뀌면 다시 잰다. 자리 높이는 내용 높이라 테두리·안쪽 여백을 뺀다.
  // 재는 카드 = 띠가 있는 첫 폴더(없으면 첫 카드) — CSS 가 이 카드는 늘 그려(.measure-card) 격자가 처음 붙는 순간에도 잰다.
  const measurePath = (groups.find((group) => group.children.length || group.files.length) ?? groups[0])?.folder.path ?? directFiles[0]?.path;
  useLayoutEffect(() => {
    const grid = scrollRef?.current; // 시험처럼 scrollRef 없이 그려도 견딘다
    if (!grid || layout === "table") return;
    const measure = () => {
      const shown = grid.querySelector<HTMLElement>(":scope > .assets-folder-card.measure-card");
      if (!shown) return;
      const s = getComputedStyle(shown);
      const edges = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
      const next = `${Math.max(0, shown.offsetHeight - edges)}px`;
      // 같은 값이면 쓰지 않는다 — 변수는 물려받는 값이라 쓸 때마다 카드 전체 스타일을 다시 계산한다
      if (grid.style.getPropertyValue("--folder-card-h") !== next) grid.style.setProperty("--folder-card-h", next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [scrollRef, layout, scale, fit, groups.length, directFiles.length, measurePath]);
  // 먼 카드 썸네일 늦게 붙이기 — 등록부는 렌더 중에 한 번 만든다(자식이 부모 효과보다 먼저 등록해도 보관). 항목이 적거나 관찰자가 없는 환경은 바로.
  const [nearRegistry] = useState(createNearRegistry);
  const eagerThumbs = items.length <= NEAR_EAGER_MAX || typeof IntersectionObserver === "undefined";
  useEffect(() => {
    const root = scrollRef?.current;
    if (!root || layout === "table" || typeof IntersectionObserver === "undefined") return;
    nearRegistry.attach(root); // 표 ↔ 그리드처럼 상자가 바뀌면 옛 관찰자를 끊고 새 상자로 다시 관찰한다
    return () => nearRegistry.detach();
  }, [nearRegistry, scrollRef, layout]);
  if (layout === "table") return <AssetFolderTable {...props} selected={selected} setSelected={setSelected} onGridKeyDown={onGridKeyDown} />;
  const thumb = (file: AssetNode, size: number) => <NearThumb eager={eagerThumbs} render={() => <MediaThumbnail
    thumb={file.type === "audio" ? null : api.assetThumbUrl(project, file.path, size, file.version)}
    isVideo={false} alt={file.name}
    fallback={<span className="assets-folder-placeholder">{file.type === "audio" ? t("오디오") : <FolderIcon />}</span>}
  />} />;
  return <NearContext.Provider value={nearRegistry}><div ref={scrollRef} onScroll={onScroll} className={"assets-folder-grid" + (layout === "list" ? " list" : "")}
    onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}
    onKeyDown={onGridKeyDown}
    style={{ "--ep-scale": scale, gridTemplateColumns: layout === "list" ? "1fr" : `repeat(auto-fill, minmax(min(100%, ${Math.round(EPISODE_CARD_WIDTH * scale)}px), 1fr))` } as CSSProperties}>
    {groups.map(({ folder, files, category, folderCount, imageCount, videoCount, audioCount, children }) => {
      const summary = [folderCount ? `${t("폴더")} ${folderCount}` : "", `${files.length}${t("건")}`,
        imageCount ? `${t("이미지")} ${imageCount}` : "", videoCount ? `${t("영상")} ${videoCount}` : "",
        audioCount ? `${t("오디오")} ${audioCount}` : ""].filter(Boolean).join(" · ");
      const more = Math.max(0, (children.length || files.length) - STRIP_SHOWN.grid);
      return <article key={folder.path}
      className={"cut-card ep-card ep-grid assets-folder-card" + (selected === folder.path ? " sel" : "") + (folder.path === measurePath ? " measure-card" : "")} data-folder-path={folder.path}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={(event) => {
        if (event.button !== 1 || (event.target instanceof Element && event.target.closest("[data-ep-action], [data-folder-action]"))) return;
        event.preventDefault(); onOpenTab(folder.path);
      }}>
      <button type="button" className={"ep-cover" + (fit === "contain" ? " contain" : "")}
        aria-label={`${category} ${folder.name} ${t("폴더 열기")}. ${summary}`} aria-pressed={selected === folder.path}
        title={`${folder.path} — ${t("더블클릭: 폴더 열기")} · ${t("미들클릭: 새 탭으로 열기")}`}
        onClick={() => setSelected(folder.path)}
        onDoubleClick={() => onEnter(folder.path)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.repeat && !event.nativeEvent.isComposing) {
            event.preventDefault(); onEnter(folder.path);
          }
        }}>
        <FolderCardCoverContent heading={category} name={category.toLowerCase() === folder.name.toLowerCase() ? "" : folder.name} summary={summary}>
          {files.length ? thumb(files[0], 512) : <span className="assets-folder-placeholder"><FolderIcon width={44} height={36} /></span>}
        </FolderCardCoverContent>
      </button>
      {layout === "list" && <span className="assets-folder-info"><strong>{folder.name}</strong><span>{summary}</span><AssetSourcePath project={project} path={folder.path} /></span>}
      {(children.length > 0 || files.length > 0) && <span className="ep-strip">
        {children.length ? children.slice(0, STRIP_SHOWN.grid).map((child) => <FolderCardPreview key={child.folder.path}
          name={child.folder.name} count={child.count} title={`${child.folder.path} · ${child.count}${t("건")}`}
          aria-label={`${child.folder.name} ${t("폴더 열기")}. ${child.count}${t("건")}`}
          onClick={() => onEnter(child.folder.path)}
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onOpenTab(child.folder.path); } }}>
          {child.cover ? thumb(child.cover, 256) : <span className="assets-folder-placeholder"><FolderIcon /></span>}
        </FolderCardPreview>) : files.slice(0, STRIP_SHOWN.grid).map((file) => <FolderCardPreview key={file.path} title={file.name}
          aria-label={`${file.name} ${t("미리보기")}`} onClick={() => onPreview(file)}>{thumb(file, 256)}
          {lastViewedPath === file.path && <LastViewedBadge />}
        </FolderCardPreview>)}
        {more > 0 && <FolderCardPreview className="more" title={t("폴더 열기")}
          onClick={() => onEnter(folder.path)}>+{more}</FolderCardPreview>}
      </span>}
    </article>;
    })}
    {directFiles.map((file) => <article key={file.path} className={"cut-card ep-card ep-grid assets-folder-card" + (selected === file.path ? " sel" : "") + (file.path === measurePath ? " measure-card" : "")} data-file-path={file.path}>
      <button type="button" className={"ep-cover" + (fit === "contain" ? " contain" : "")}
        aria-label={`${file.name} ${t("미리보기")}`} title={file.name} onClick={() => { setSelected(file.path); onPreview(file); }}>
        {thumb(file, 512)}
        {lastViewedPath === file.path && <LastViewedBadge />}
        <span className="ep-cap"><b>{file.name}</b></span>
      </button>
      {layout === "list" && <span className="assets-folder-info"><strong>{file.name}</strong><AssetSourcePath project={project} path={file.path} /></span>}
    </article>)}
    {groups.length === 0 && directFiles.length === 0 && <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>}
  </div></NearContext.Provider>;
}

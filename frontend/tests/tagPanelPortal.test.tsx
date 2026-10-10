// @vitest-environment jsdom
// 태그 패널을 body 에 그린다(조작 점검 7회 R14) — 폴더 창(z 151)·'생성 결과' 창 안에 두면 그 창의 쌓임 맥락에 갇혀, 창 밖에 뜨는
// 코멘트 패널 앞으로 올릴 수 없었다. jsdom 은 쌓임(z-index)을 재지 못하므로 "패널이 창의 자손이 아니다"를 구조로 단언하고,
// 밖으로 나가며 끊기는 '안/밖' 판정을 하나씩 본다:
//  ① 패널의 단추에 남은 초점 = 그 패널을 연 툴바(와 그 창) 안의 초점 — 초점 잃은 키(lib/keyGate)·폴더 창의 색 단축키(useGenerationKeyboardActions)
//  ② 어느 툴바의 패널인가 — 창 밖 툴바에서 연 패널의 초점은 창 안 격자의 것이 아니다
//  ③ 툴바를 감싼 잠금(inert)을 패널도 따른다
//  ④ 앞세우기·창의 Esc·선택 해제·창 바깥 막은 옮기기 전과 같다
//  ⑤ 창의 카드를 끄는 동안 패널은 놓기를 가리지 않는다 — 창 밖의 놓을 자리(사이드바 폴더·프롬프트)보다 앞에 뜨기 때문에
import { act, useRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { LibraryToolbar } from "../src/components/LibraryToolbar";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";
import type { Filters, Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({
  api: { thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path, setColorsBatch: vi.fn(async () => ({ failed: [] })) },
}));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
vi.mock("../src/lib/teamSeen", () => ({
  subscribeTeamSeen: () => () => {}, getTeamSeenVersion: () => 0,
  isFreshGen: () => false, ackTeamFresh: vi.fn(), getTeamBase: () => null,
  ackAllLabel: () => "", isAckedFor: () => false, ackTeamFreshKeys: vi.fn(),
}));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => <span>thumbnail</span> }));

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let select: ReturnType<typeof useGenerationSelection>;
let closed: number; // 창의 바깥 막이 눌린 횟수(= 창 닫기)
const peekKeys: string[] = []; // 폴더 창의 키 처리(React onKeyDown)에 닿은 키
const previews: string[] = [];
const noop = () => {};
const generation = (id: string): Generation => ({
  id, model: "test", prompt: "test", status: "done", created_at: "2026-10-01T12:00:00Z",
  assets: [{ id: `asset-${id}`, type: "image", file_path: `/test/${id}.png` }],
  tags: [], auto_tags: [], references: [], shared: false, is_mine: true, params: {},
}) as unknown as Generation;
const generations = ["g1", "g2", "g3", "g4"].map(generation);
const TOOLBAR: ComponentProps<typeof LibraryToolbar> = {
  typeFilter: "all", onTypeFilter: noop, scale: 1, onScale: noop, fill: true, onToggleFill: noop,
  layout: "grid", onLayout: noop, groupByDate: false, onToggleGroupByDate: noop,
  filtersOpen: false, onToggleFilters: noop, count: 4, loading: false, failedCount: 0, onClearFailed: noop,
  colorDots: [], colorFilter: new Set(), onToggleColor: noop, sharedOnly: false, onToggleShared: noop,
  commentOnly: false, onToggleComment: noop, hasUnread: false,
  tags: ["alpha"], tagFilter: new Set(), onSelectTag: noop, onDeleteTag: noop, onClearTags: noop,
  tagPanelOpen: true, onToggleTagPanel: noop,
};

// 색·비활성 단축키(App 이 건다) — 캔버스(compose)에서 폴더 창이 떠 있는 동안.
function ColorKeys() {
  const filtersRef = useRef({ tab: "compose" } as Filters);
  const gensRef = useRef(generations);
  const gridActive = useRef(true);
  useGenerationKeyboardActions({
    clearSelect: select.clearSelect, filtersRef, flash: noop, gensRef, reload: noop,
    selectedRef: select.selectedRef, setGens: noop, composeGridActiveRef: gridActive,
  });
  return null;
}

// 툴바와 격자가 놓이는 자리 — 보통 탭(tab) · 목록 탭의 폴더 창(peek) · 캔버스의 폴더 창(canvasPeek) · 캔버스의 '생성 결과' 창(varwin)
type Where = "tab" | "peek" | "canvasPeek" | "varwin";
type Options = { where?: Where; locked?: boolean; outer?: boolean; colorKeys?: boolean };
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
function Screen({ where = "tab", locked, outer, colorKeys }: Options) {
  select = useGenerationSelection({ resetKey: "k" });
  // 앱처럼 툴바 요소를 그릴 때마다 새로 만든다(App 의 libraryToolbar) — 같은 요소를 다시 주면 툴바가 다시 그려지지 않는다.
  const body = (
    <>
      <LibraryToolbar {...TOOLBAR} tagPanelOpen={!outer} />
      <ThumbnailGrid
        generations={generations} tab="my" scale={1} fill layout="grid" groupByDate={false}
        selectedIds={select.selected} onSelectedChange={select.setSelected} onToggleSelect={select.toggleSelect}
        onSetSource={noop} onSetTags={noop} onOpenComments={noop} onRegenerate={noop}
        onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop}
        onImport={noop} onRestore={noop} dimDeleted={false}
        onInfo={noop} onPreview={(target) => previews.push(String((target as { id?: string }).id ?? "preview"))}
      />
    </>
  );
  const peek = (
    <>
      <div className="folder-peek-catcher" onMouseDown={() => { closed += 1; }} />
      <section className="folder-peek" tabIndex={-1} onKeyDown={(e) => peekKeys.push(e.key)}>{body}</section>
    </>
  );
  return (
    <>
      {colorKeys && <ColorKeys />}
      {where === "tab" && <main className="main" {...(locked ? { inert: "" } : {})}>{body}</main>}
      {where === "peek" && peek}
      {where === "canvasPeek" && <><div className="scene-board" />{peek}</>}
      {where === "varwin" && (
        // '생성 결과' 창은 보드 안에 그려지고, 안에서 난 mousedown 의 전파를 막는다(components/scene/SceneVariantPopup.tsx)
        <div className="scene-board">
          <div className="scene-varpop-backdrop" onMouseDown={stop}>
            <section className="scene-varwin" tabIndex={-1} onMouseDown={stop}>{body}</section>
          </div>
        </div>
      )}
      {/* 창 밖의 툴바(캔버스 본 화면의 것)에서 연 패널 — 앱은 창이 떠 있으면 이쪽 패널을 띄우지 않지만, 판정은 주인을 가려야 한다 */}
      {outer && <LibraryToolbar {...TOOLBAR} />}
    </>
  );
}
const mount = (options: Options = {}) => act(() => root.render(<Screen {...options} />));
const grid = () => host.querySelector<HTMLElement>(".gen-grid")!;
const cell = (id: string) => host.querySelector<HTMLElement>(`.gen-cell[data-id="${id}"] .card`)!;
const panel = () => document.querySelector<HTMLElement>(".tag-panel")!; // 어디에 그려지든 찾는다
const pill = () => panel().querySelector<HTMLElement>(".tag-pill-name")!;
const chosen = () => generations.map((g) => g.id).filter((id) => select.selected.has(id));
const key = (name: string, target: EventTarget, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const mouse = (type: string, target: EventTarget, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const click = (id: string) => { mouse("mousedown", cell(id)); mouse("mouseup", window); };
const press = (target: Element) => {
  act(() => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  mouse("mousedown", target);
  act(() => { target.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  mouse("mouseup", window);
};
const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
// jsdom 에는 DragEvent·DataTransfer 가 없다 — dataTransfer 대역을 단 이벤트를 보낸다(tests/sceneVariantPopupDrag.test.tsx 와 같다).
const drag = (type: "dragstart" | "dragend" | "drop", target: EventTarget) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: noop, effectAllowed: "" } });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const beat = () => act(() => { vi.runAllTimers(); }); // 한 박자(setTimeout 0) — vi.useFakeTimers() 뒤에
const holder = () => document.querySelector<HTMLElement>("[data-float-of]")!; // 패널을 감싼 칸

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400); // 격자는 두 열 — g1 의 오른쪽이 g2
  HTMLElement.prototype.scrollTo = vi.fn();
  closed = 0; peekKeys.length = 0; previews.length = 0;
  vi.mocked(api.setColorsBatch).mockClear();
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each<Where>(["peek", "canvasPeek", "varwin", "tab"])("%s: 태그 패널은 body 에 그려진다 — 창의 자손이 아니고, 연 툴바를 가리키는 표가 붙는다", (where) => {
  mount({ where });
  expect(panel(), "패널이 떠 있다").toBeTruthy();
  expect(panel().closest(".folder-peek, .scene-varwin, .scene-board, .lib-toolbar")).toBeNull(); // 창의 쌓임 맥락 밖
  expect(panel().parentElement?.parentElement).toBe(document.body);
  const owner = host.querySelector<HTMLElement>(".lib-toolbar")!.dataset.floatOwner;
  expect(owner).toBeTruthy();
  expect(panel().parentElement?.dataset.floatOf).toBe(owner);
  act(() => root.render(<span />)); // 툴바(창)가 사라지면 패널도 body 에 남지 않는다
  expect(document.querySelector(".tag-panel")).toBeNull();
});

it.each<Where>(["tab", "peek", "canvasPeek", "varwin"])("%s: 패널의 단추에 남은 초점의 키는 그 툴바의 격자가 받는다 — Enter 는 그 단추의 것", (where) => {
  mount({ where });
  flushFrames();
  click("g1");
  act(() => pill().focus()); // 태그를 누른 뒤 — 초점이 그 단추에 남는다
  key("ArrowRight", pill());
  expect(chosen()).toEqual(["g2"]);
  expect(document.activeElement).toBe(grid()); // 격자가 쓴 키 — 초점도 격자로 온다
  act(() => pill().focus());
  expect(key("Enter", pill()).defaultPrevented).toBe(false); // 그 단추를 누르는 키 — 크게 보기가 열리지 않는다
  expect(previews).toEqual([]);
});

it("창 밖 툴바에서 연 패널의 초점은 창 안 격자의 것이 아니다 — 어느 툴바의 패널인지 가린다", () => {
  mount({ where: "canvasPeek", outer: true });
  flushFrames();
  click("g1");
  const bars = host.querySelectorAll<HTMLElement>(".lib-toolbar"); // [창 안의 툴바, 창 밖의 툴바]
  expect(panel().parentElement?.dataset.floatOf).toBe(bars[1].dataset.floatOwner);
  expect(bars[0].dataset.floatOwner).not.toBe(bars[1].dataset.floatOwner);
  act(() => pill().focus());
  key("ArrowRight", pill()); // 캔버스 — 창 밖의 초점에서 난 키는 창 안 격자가 받지 않는다
  expect(chosen()).toEqual(["g1"]);
});

it("캔버스 폴더 창: 패널의 단추에 초점이 있어도 색 단축키는 창 안 선택에 먹는다 — 창 밖 툴바의 패널이면 먹지 않는다", () => {
  mount({ where: "canvasPeek", colorKeys: true });
  flushFrames();
  act(() => select.setSelected(new Set(["g1"])));
  act(() => pill().focus()); // Tab 으로 패널에 들어온 초점(누르면 선택이 풀린다)
  expect(key("r", pill()).defaultPrevented).toBe(true);

  mount({ where: "canvasPeek", colorKeys: true, outer: true });
  act(() => select.setSelected(new Set(["g1"])));
  act(() => pill().focus());
  expect(key("r", pill()).defaultPrevented).toBe(false);
});

it("툴바를 감싼 잠금(inert)을 body 의 패널도 따른다 — 낡은 목록을 보이는 동안 패널로 필터를 바꾸지 못한다", () => {
  mount({ where: "tab" });
  expect(holder().hasAttribute("inert")).toBe(false);
  mount({ where: "tab", locked: true }); // <main inert> — 폴더 창을 닫은 직후
  expect(holder().hasAttribute("inert")).toBe(true);
  mount({ where: "tab" });
  expect(holder().hasAttribute("inert")).toBe(false);
});

it("앞세우기·창의 Esc·선택 해제·창 바깥 막은 옮기기 전과 같다", () => {
  mount({ where: "peek" });
  flushFrames();
  click("g1");
  expect(chosen()).toEqual(["g1"]);
  const before = panel().style.zIndex;
  expect(before, "떠 있는 창들의 앞뒤(useFloatingPanel)에 올라 있다").not.toBe("");
  press(panel().querySelector(".tag-panel-head")!);
  expect(panel().style.zIndex).not.toBe(before); // 누른 패널이 앞으로 온다
  expect(chosen()).toEqual([]); // 패널을 누르면 선택이 풀린다 — 전에도 그랬다(선택을 지키는 자리가 아니다)
  expect(closed).toBe(0); // 창은 닫히지 않는다
  key("Escape", pill());
  expect(peekKeys).toEqual(["Escape"]); // 패널에서 난 Esc 도 창의 키 처리에 닿는다(React 전파는 포털을 지난다)
});

it.each<Where>(["varwin", "peek", "canvasPeek"])("%s: 창의 카드를 끄는 동안 패널은 놓기를 가리지 않는다 — 한 박자 뒤에 걸고, 끌기가 끝나면 푼다", (where) => {
  // Codex 코드 리뷰: '생성 결과' 창은 끄는 동안 제 막을 클릭통과로 바꾸는데(.drag-through) body 로 나간 패널은 그것을 물려받지 못해,
  //  패널이 덮은 사이드바 폴더·프롬프트에 놓은 카드가 담기지 않았다. 폴더 창에서는 패널이 프롬프트 위로 올라와 같은 일이 생긴다.
  mount({ where });
  flushFrames();
  vi.useFakeTimers();
  const passing = () => holder().style.pointerEvents === "none";
  drag("dragstart", cell("g1"));
  expect(passing()).toBe(false); // dragstart 안에서는 걸지 않는다 — 그 창의 막과 같은 박자(한 박자 뒤)
  beat();
  expect(passing()).toBe(true);
  drag("dragend", cell("g1"));
  expect(passing()).toBe(false);

  drag("dragstart", cell("g1")); // 한 박자가 오기 전에 끝난 끌기에는 걸지 않는다(걸리면 패널이 눌리지 않는 채로 남는다)
  drag("dragend", cell("g1"));
  beat();
  expect(passing()).toBe(false);

  cell("g1").addEventListener("dragstart", (e) => e.preventDefault(), { once: true }); // 막힌 끌기 — dragend 가 오지 않는다
  drag("dragstart", cell("g1"));
  beat();
  expect(passing()).toBe(false);

  for (const finish of [() => drag("drop", document.body), () => mouse("mouseup", window)]) { // 놓았거나, dragend 없이 끝났거나
    drag("dragstart", cell("g1"));
    beat();
    expect(passing()).toBe(true);
    finish();
    expect(passing()).toBe(false);
  }

  const grip = cell("g1").querySelector(".card-drag-grip")!; // 카드의 그립은 dragstart 전파를 멈춘다 — 그래도 걸린다(잡는 단계로 듣는다)
  drag("dragstart", grip);
  beat();
  expect(passing()).toBe(true);
  drag("dragend", grip);
  expect(passing()).toBe(false);

  const tag = panel().querySelector<HTMLElement>(".tag-pill")!; // 패널 안에서 시작한 끌기(태그 순서 바꾸기)는 패널이 받아야 한다
  drag("dragstart", tag);
  beat();
  expect(passing()).toBe(false);
  drag("dragend", tag);
});

it("보통 탭에서는 끄는 동안에도 패널이 그대로다 — 창 밖의 놓을 자리를 새로 가리게 된 것은 창에서 연 패널뿐이다", () => {
  mount({ where: "tab" });
  flushFrames();
  vi.useFakeTimers();
  drag("dragstart", cell("g1"));
  beat();
  expect(holder().style.pointerEvents).toBe("");
  drag("dragend", cell("g1"));
});

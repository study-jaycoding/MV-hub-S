// @vitest-environment jsdom
// 조작 점검 7회차 — 생성물 격자·툴바.
//  R43-a 선택이 이미 빈 채로 격자 밖을 누르면 Space 로 남긴 초점 카드가 그대로 남아, 고른 것도 없는데 c·Enter·Space 가 그 카드에 실행됐다
//  R43-b 초점 카드 없이(마퀴·체크박스·밖에서 풀린 자리) Shift 클릭을 이어서 하면 기준 카드가 방금 만든 범위의 끝으로 매번 옮겨 갔다
//  R37   저장된 카드 크기 배율이 슬라이더 범위 밖이면 그대로 쓰였다(슬라이더로는 못 만들고 못 고치는 값)
//  R14   태그 패널을 body 로 옮겨 그려도(tests/tagPanelPortal.test.tsx) 패널의 단추에 남은 초점은 '툴바·창 안의 단추'로 판정된다
// 선택은 앱처럼 실제 훅(useGenerationSelection)이 쥔다 — 격자를 매번 새 선택 객체로 다시 그리지 않는다.
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryToolbar } from "../src/components/LibraryToolbar";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import type { Store } from "../src/lib/storage";
import { useEscapeClose } from "../src/lib/useEscapeClose";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({ api: { thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path } }));
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
let shown: Set<string>; // 격자가 보여 주는 선택 — 라이브러리는 훅의 것, '생성 결과' 창은 창의 것
const noop = () => {};
const generation = (id: string): Generation => ({
  id, model: "test", prompt: "test", status: "done", created_at: "2026-10-01T12:00:00Z",
  assets: [{ id: `asset-${id}`, type: "image", file_path: `/test/${id}.png` }],
  tags: [], auto_tags: [], references: [], shared: false, is_mine: true, params: {},
}) as unknown as Generation;
const generations = ["g1", "g2", "g3", "g4", "g5"].map(generation);
const previews: string[] = [];
const comments: string[] = [];

function Overlay() { useEscapeClose(noop); return null; } // Esc 로 닫히는 창 하나(메뉴·확인 덮개)
type LibraryOptions = {
  overlay?: boolean; toolbar?: React.ReactNode; canvas?: boolean; varwin?: boolean; list?: Generation[]; layout?: "grid" | "list";
};
// 앱의 배선 그대로: 선택 훅 → 격자. 툴바·선택 막대·그 밖의 단추는 격자 밖의 것들이다.
function Library({ overlay, toolbar, canvas, varwin, list = generations, layout = "grid" }: LibraryOptions) {
  select = useGenerationSelection({ resetKey: "k" });
  // 캔버스 '생성 결과' 창의 선택은 App 의 훅이 아니라 창의 주인(SceneBoard)이 쥔다 — 훅은 앱에 늘 켜져 있고 창은 자기 선택을 격자에 준다.
  const [own, setOwn] = useState<Set<string>>(new Set());
  shown = varwin ? own : select.selected;
  const body = (
    <>
      {toolbar ?? <div className="lib-toolbar"><button className="bar-button">보기</button></div>}
      <ThumbnailGrid
        generations={list} tab="my" scale={1} fill layout={layout} groupByDate={false}
        selectedIds={shown} onSelectedChange={varwin ? setOwn : select.setSelected} onToggleSelect={select.toggleSelect}
        onSetSource={noop} onSetTags={noop} onOpenComments={(g) => comments.push(g.id)} onRegenerate={noop}
        onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop}
        onImport={noop} onRestore={noop} dimDeleted={false}
        onInfo={noop} onPreview={(target) => previews.push(String((target as { id?: string }).id ?? "preview"))}
      />
      <div className="select-bar"><button className="keep-button">담기</button></div>
    </>
  );
  return (
    <>
      {overlay && <Overlay />}
      {canvas && <div className="scene-board" />}
      <div className="side-blank">빈 곳</div>
      {canvas ? <section className="folder-peek" tabIndex={-1}>{body}</section> : varwin ? (
        // 창이 안에서 난 mousedown 의 전파를 막는다(components/scene/SceneVariantPopup.tsx 와 같게) — document 의 오르는 단계에는 닿지 않는다
        <div className="scene-varpop-backdrop" onMouseDown={(e) => e.stopPropagation()}>
          <section className="scene-varwin" tabIndex={-1} onMouseDown={(e) => e.stopPropagation()}>{body}</section>
        </div>
      ) : body}
    </>
  );
}
const mount = (options: LibraryOptions = {}) => act(() => root.render(<Library {...options} />));
const grid = () => host.querySelector<HTMLElement>(".gen-grid")!;
const cell = (id: string) => host.querySelector<HTMLElement>(`.gen-cell[data-id="${id}"] .card`)!;
const one = (selector: string) => host.querySelector<HTMLElement>(selector)!;
const chosen = () => generations.map((g) => g.id).filter((id) => shown.has(id));
// 리스트 보기의 선택 칸을 누른다(격자를 거치지 않고 선택만 바뀌는 길 — 초점 카드는 생기지 않는다)
const check = (id: string) => act(() => { host.querySelector<HTMLInputElement>(`.gen-cell[data-id="${id}"] .ov-check input`)!.click(); });
const focusedCard = () => host.querySelector<HTMLElement>(".gen-cell.focused")?.dataset.id ?? null;
const key = (name: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
// 끄는 중의 움직임은 단추가 눌려 있다(buttons 1) — 단추 없는 움직임은 끌기의 끝이다(lib/windowDrag)
const mouse = (type: string, target: EventTarget, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mousemove" ? 1 : 0, ...init })); });
const click = (id: string, init: MouseEventInit = {}) => { mouse("mousedown", cell(id), init); mouse("mouseup", window, init); };
// 격자 밖의 누름 — 브라우저의 순서대로(pointerdown 이 '누르는 순간 위에 뭔가 떠 있었나'를 적는다, lib/keyGate).
const press = (target: Element) => {
  act(() => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  mouse("mousedown", target);
  act(() => { target.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  mouse("mouseup", window);
};
const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400); // 격자는 두 열 — g2 의 아래가 g4
  HTMLElement.prototype.scrollTo = vi.fn();
  previews.length = 0; comments.length = 0;
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("R43-a 선택이 이미 빈 채로 격자 밖을 누르면 Space 로 남긴 초점 카드도 지운다 — 방향키·Shift 클릭의 기준 자리만 남는다", () => {
  mount();
  flushFrames();
  click("g2");
  key(" ", grid()); // Space 로 뺐다 — 초점 카드는 남는다(한 번 더 누르면 다시 고른다)
  expect(chosen()).toEqual([]);
  expect(focusedCard()).toBe("g2");

  press(one(".bar-button")); // 툴바 단추 — 선택은 이미 비어 있다. 전엔 아무 일도 없어 초점 카드가 남았다
  expect(focusedCard()).toBeNull();
  key("c", grid());
  key("Enter", grid());
  key(" ", grid());
  expect(comments).toEqual([]);
  expect(previews).toEqual([]);
  expect(chosen()).toEqual([]);
  key("ArrowDown", grid()); // 방향키는 보던 자리(g2)에서 이어 간다 — 목록 맨 위로 튀지 않는다
  expect(chosen()).toEqual(["g4"]);

  click("g2");
  key(" ", grid());
  press(one(".bar-button"));
  click("g4", { shiftKey: true }); // Shift 클릭의 기준도 보던 자리
  expect(chosen()).toEqual(["g2", "g3", "g4"]);
});

it("R43-a 격자 밖의 빈 곳을 눌러도 자리는 기억한다 · 선택 막대 안이나 위에 뜬 것을 닫는 누름은 초점 카드를 지우지 않는다", () => {
  mount();
  flushFrames();
  click("g2");
  key(" ", grid());
  press(one(".side-blank")); // 빈 곳 — 끌기 선택이 '빈 곳 클릭'으로 끝난다. 전엔 자리까지 잊어 방향키가 맨 위(g1)로 갔다
  expect(focusedCard()).toBeNull();
  key("ArrowDown", grid());
  expect(chosen()).toEqual(["g4"]);

  click("g2");
  key(" ", grid());
  press(one(".keep-button")); // 선택 막대 — 선택을 지키는 자리는 초점 카드도 지킨다
  expect(focusedCard()).toBe("g2");
  mount({ overlay: true });
  press(one(".bar-button")); // 위에 메뉴가 떠 있을 때의 누름은 그것을 닫는 누름이다(규칙 4)
  expect(focusedCard()).toBe("g2");
  mount();
  key(" ", grid()); // 남겨 둔 자리에서 다시 고른다
  expect(chosen()).toEqual(["g2"]);
});

it("R43-a 전파를 막는 창('생성 결과' 창) 안에서도 밖 누름이 닿는다 — 창의 툴바를 누르면 Space 로 남긴 초점 카드를 지운다", () => {
  // Codex 코드 리뷰: 그 창은 안에서 난 mousedown 의 전파를 막는다 — 알림이 document 의 오르는 단계에 기대면 창 안의 누름을 놓쳐,
  //  Space 로 뺀 뒤 창의 툴바를 눌러도 초점 카드가 남고 c 에 코멘트가 열렸다.
  mount({ varwin: true });
  flushFrames();
  click("g2");
  press(one(".bar-button")); // 고른 것이 있을 때는 그대로다 — 이 창의 선택은 밖 누름으로 풀리지 않고, 선택이 있는 한 초점 카드도 둔다
  expect(chosen()).toEqual(["g2"]);
  expect(focusedCard()).toBe("g2");
  key(" ", grid());
  expect(chosen()).toEqual([]);
  expect(focusedCard()).toBe("g2");

  press(one(".bar-button")); // 창 안의 툴바 단추
  expect(focusedCard()).toBeNull();
  key("c", grid());
  key("Enter", grid());
  expect(comments).toEqual([]);
  expect(previews).toEqual([]);
  key("ArrowDown", grid()); // 자리는 기억한다
  expect(chosen()).toEqual(["g4"]);
});

it("R43-b 선택 칸으로 선택을 바꿨다가 되돌려도 옛 기준은 되살아나지 않는다 — 바뀐 순간에 잊는다", () => {
  // Codex 코드 리뷰: '지금 선택이 그 Shift 클릭이 만든 범위와 같은가'를 쓸 때 견주면, g1 을 켰다 끈 뒤(집합은 같다) 옛 기준 g3 이 다시 쓰였다.
  mount({ layout: "list" });
  flushFrames();
  check("g2");
  check("g3");
  click("g5", { shiftKey: true }); // 기준 = 고른 것 중 마지막 카드(g3) → g3·g4·g5
  expect(chosen()).toEqual(["g3", "g4", "g5"]);
  check("g1"); // 켰다가
  check("g1"); // 끈다 — 선택은 다시 g3·g4·g5
  expect(chosen()).toEqual(["g3", "g4", "g5"]);
  click("g1", { shiftKey: true }); // 선택이 바뀐 뒤의 기준 = 마지막 카드 g5 (전엔 g3 이 되살아나 g1~g3 만 골랐다)
  expect(chosen()).toEqual(["g1", "g2", "g3", "g4", "g5"]);
});

it("R43-b Shift 클릭을 이어서 해도 기준 카드는 첫 Shift 클릭 때의 것이다 — 초점 카드가 없을 때도", () => {
  mount();
  flushFrames();
  act(() => select.setSelected(new Set(["g2", "g3"]))); // 마퀴·체크박스로만 골랐다 — 초점 카드는 없다
  click("g5", { shiftKey: true }); // 기준 = 고른 것 중 마지막 카드(g3)
  expect(chosen()).toEqual(["g3", "g4", "g5"]);
  act(() => select.setSelected(new Set(select.selected))); // 부모가 같은 선택을 새 객체로 다시 줄 뿐이면('생성 결과' 창의 자료 갱신) 기준은 그대로다
  click("g1", { shiftKey: true }); // 기준은 그대로 g3 — 전엔 방금 만든 범위의 끝(g5)으로 옮겨 가 g1~g5 가 됐다
  expect(chosen()).toEqual(["g1", "g2", "g3"]);
  click("g4", { shiftKey: true });
  expect(chosen()).toEqual(["g3", "g4"]);

  // 밖에서 풀린 뒤 기억해 둔 자리(규칙 9)가 기준일 때도 같다
  click("g2");
  press(document.body); // 격자 밖의 빈 곳 — 선택이 풀린다, 자리는 g2 (29회차: 툴바 단추는 이제 선택을 풀지 않는다 — 보기 필터가 고른 것을 남긴다)
  expect(chosen()).toEqual([]);
  click("g4", { shiftKey: true });
  expect(chosen()).toEqual(["g2", "g3", "g4"]);
  click("g1", { shiftKey: true }); // 전엔 g1~g4
  expect(chosen()).toEqual(["g1", "g2"]);

  // 보통 클릭·Ctrl 클릭은 기준을 옮긴다(탐색기와 같다)
  click("g4", { ctrlKey: true });
  click("g5", { shiftKey: true });
  expect(chosen()).toEqual(["g4", "g5"]);
});

it("R43-b 기억한 기준은 그 Shift 클릭이 만든 선택이 그대로일 때만 쓴다 — 밖에서 바뀌거나 마퀴로 다시 고르면 '고른 것 중 마지막 카드'다", () => {
  mount();
  flushFrames();
  act(() => select.setSelected(new Set(["g2", "g3"])));
  click("g4", { shiftKey: true }); // 기준 g3 → g3·g4
  act(() => select.toggleSelect("g1")); // 리스트 보기의 선택 칸 — 격자 밖에서 선택이 바뀌었다
  click("g2", { shiftKey: true }); // 옛 기준(g3)이 아니라 고른 것 중 마지막(g4)
  expect(chosen()).toEqual(["g2", "g3", "g4"]);

  // 같은 장수의 다른 선택으로 바뀌어도(다빈치 따라가기처럼 밖에서 통째로 바꾼다) 옛 기준은 끝이다
  act(() => select.setSelected(new Set(["g2", "g3"])));
  click("g5", { shiftKey: true }); // 기준 g3 → g3·g4·g5
  act(() => select.setSelected(new Set(["g1", "g2", "g4"])));
  click("g5", { shiftKey: true }); // 기준 = 마지막 카드 g4
  expect(chosen()).toEqual(["g4", "g5"]);

  // 마퀴가 방금의 범위와 똑같은 카드들을 다시 골라도, 마퀴 뒤의 기준은 마지막에 고른 카드다(종전 규칙)
  act(() => select.setSelected(new Set(["g2", "g3"])));
  click("g5", { shiftKey: true }); // 기준 g3 → g3·g4·g5
  const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(grid(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 400));
  generations.forEach((g, i) => vi.spyOn(host.querySelector<HTMLElement>(`.gen-cell[data-id="${g.id}"]`)!, "getBoundingClientRect").mockReturnValue(rect(i * 70, 10, 60, 60)));
  mouse("mousedown", grid(), { clientX: 135, clientY: 200 }); // 빈 곳에서 시작해 g3·g4·g5 를 걸친다
  mouse("mousemove", window, { clientX: 345, clientY: 20 });
  mouse("mouseup", window, { clientX: 345, clientY: 20 });
  expect(chosen()).toEqual(["g3", "g4", "g5"]);
  click("g1", { shiftKey: true }); // 기준 = 마지막 카드 g5
  expect(chosen()).toEqual(["g1", "g2", "g3", "g4", "g5"]);

  // 기준 카드가 목록에서 빠졌으면(다시 받은 목록에 없다) 그 기준은 쓰지 않는다 — 고른 것 중 목록의 마지막 카드
  act(() => select.setSelected(new Set(["g2", "g3"])));
  click("g5", { shiftKey: true }); // 기준 g3 → g3·g4·g5
  mount({ list: generations.filter((g) => g.id !== "g3") });
  click("g1", { shiftKey: true }); // g3 이 없다 — 범위를 못 만들어 g1 하나만 고르는 대신, 마지막 카드 g5 가 기준
  expect(chosen()).toEqual(["g1", "g2", "g4", "g5"]);

  // 밖을 눌러 선택이 풀리면 옛 기준도 끝이다 — 기준이 없는 Shift 클릭은 종전대로 그 카드 하나를 고른다(초점 카드가 생기므로 마지막에 본다)
  mount();
  act(() => select.setSelected(new Set(["g2", "g3"])));
  click("g5", { shiftKey: true }); // 기준 g3 → g3·g4·g5
  press(document.body); // 격자 밖의 빈 곳 — 선택이 풀린다(초점 카드가 없었으니 기억해 둘 자리도 없다)
  click("g1", { shiftKey: true });
  expect(chosen()).toEqual(["g1"]);
});

// 29회차(Jay "검색과 같게"): 툴바(보기 필터)·상단바·태그 패널 안의 누름은 선택을 풀지 않는다 — 고른 채로 필터를 바꾼다. 초점 카드는 전처럼(R43-a) 지운다.
it("툴바 단추를 눌러도 선택은 남고, Space 로 남긴 초점 카드만 지워진다 — 격자 밖의 빈 곳은 전처럼 선택도 푼다", () => {
  mount();
  flushFrames();
  click("g2");
  click("g3", { shiftKey: true });
  expect(chosen()).toEqual(["g2", "g3"]);
  press(one(".bar-button"));
  expect(chosen()).toEqual(["g2", "g3"]); // 선택은 그대로
  key(" ", grid()); // Space — 초점 카드(처음 누른 g2 — Shift 클릭은 기준을 옮기지 않는다)를 뺀다
  expect(chosen()).toEqual(["g3"]);
  expect(focusedCard()).toBe("g2");
  press(one(".bar-button"));
  expect([chosen(), focusedCard()]).toEqual([["g3"], "g2"]); // 고른 것이 남아 있으면 초점 카드도 둔다(R43-a — 키는 고른 것에 간다)
  key(" ", grid()); // g2 를 다시 고른 뒤
  key(" ", grid()); // 다시 뺀다 — 초점은 g2 에 남는다
  expect([chosen(), focusedCard()]).toEqual([["g3"], "g2"]);
  press(document.body);
  expect(chosen()).toEqual([]); // 빈 곳은 선택도 푼다
});

it("R37 저장된 카드 크기 배율이 슬라이더 범위(0.7~1.7) 밖이면 범위로 자르고, 숫자가 아니면 기본값 1 이다", () => {
  let latest!: ReturnType<typeof useLibraryFilters>;
  let store!: Store;
  function Probe() { latest = useLibraryFilters(store); return null; }
  const restore = (saved?: string) => {
    const data: Record<string, string> = saved === undefined ? {} : { scale: saved };
    store = {
      get: (name, fallback) => data[name] ?? fallback,
      set: (name, value) => void (data[name] = value),
      loadJSON: <T,>(name: string) => (name in data ? (JSON.parse(data[name]) as T) : null),
      setJSON: (name, value) => void (data[name] = JSON.stringify(value)),
      loadSet: (name) => new Set(name in data ? (JSON.parse(data[name]) as string[]) : []),
      setSet: (name, value) => void (data[name] = JSON.stringify([...value])),
    };
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Probe />));
    return { scale: latest.scale, saved: data.scale };
  };
  expect(restore("0.2")).toEqual({ scale: 0.7, saved: "0.7" }); // 리스트 보기의 줄이 선택 칸을 가릴 만큼 낮아지던 값 — 자른 값이 다시 저장된다
  expect(restore("9").scale).toBe(1.7);
  expect(restore("Infinity").scale).toBe(1);
  expect(restore("-3").scale).toBe(1);
  expect(restore("abc").scale).toBe(1);
  expect(restore("0").scale).toBe(1);
  expect(restore("1.25").scale).toBe(1.25); // 범위 안의 값은 그대로
  expect(restore().scale).toBe(1);
});

it("R14 태그 패널의 단추에 초점이 남아 있어도 초점 잃은 키는 격자가 받는다 — 패널은 body 에 그려져도 그것을 연 툴바(와 창)의 것이다", () => {
  // lib/keyGate 의 takesLooseKey 는 초점이 '.lib-toolbar 안의 단추'인지, 캔버스에서는 '격자를 품은 창 안'인지를 DOM 포함 관계로 본다.
  //  패널을 body 로 옮겨 그리면(포털) 그 판정이 끊긴다 — 패널을 연 툴바를 찾아 그것으로 묻는다(floatHost). 자리별 시험은 tagPanelPortal 에.
  const toolbarProps: ComponentProps<typeof LibraryToolbar> = {
    typeFilter: "all", onTypeFilter: noop, scale: 1, onScale: noop, fill: true, onToggleFill: noop,
    layout: "grid", onLayout: noop, groupByDate: false, onToggleGroupByDate: noop,
    filtersOpen: false, onToggleFilters: noop, count: 5, loading: false, failedCount: 0, onClearFailed: noop,
    colorDots: [], colorFilter: new Set(), onToggleColor: noop, sharedOnly: false, onToggleShared: noop,
    commentOnly: false, onToggleComment: noop, hasUnread: false,
    tags: ["alpha"], tagFilter: new Set(), onSelectTag: noop, onDeleteTag: noop, onClearTags: noop,
    tagPanelOpen: true, onToggleTagPanel: noop,
  };
  const toolbar = <LibraryToolbar {...toolbarProps} />;
  mount({ toolbar });
  flushFrames();
  click("g1");
  const pill = () => document.querySelector<HTMLElement>(".tag-panel .tag-pill-name")!; // 어디에 그려지든 찾는다
  act(() => pill().focus()); // 태그를 누른 뒤 — 초점이 그 단추에 남는다
  key("ArrowRight", pill());
  expect(chosen()).toEqual(["g2"]);

  mount({ toolbar, canvas: true }); // 캔버스의 폴더 창 — 창 안의 격자가 받는다(규칙 10)
  flushFrames();
  click("g1");
  act(() => pill().focus());
  key("ArrowRight", pill());
  expect(chosen()).toEqual(["g2"]);
});

// @vitest-environment jsdom
// 격자의 키와 초점(2026-10-10 실측에서 나온 것들).
//  ① 창·입력을 닫으면 초점이 BODY 로 떨어져 카드를 다시 누르기 전까지 방향키·Ctrl+A·# 가 죽었다 → 초점 잃은 키는 보이는 격자가 받는다
//  ② 마퀴로 고른 뒤 방향키를 누르면 맨 첫 카드로 튀었고, Shift 클릭은 범위가 되지 않았다 → 기준 = 고른 것 중 마지막 카드
//  ③ 마퀴를 놓는 순간의 마지막 움직임이 버려졌고, 창을 떠나도(blur) 끌기가 남았다
//  ④ 태그 입력이 키로 끝나면 초점을 격자로 돌려준다 · 카드 안 단추에 초점일 때 Enter 는 그 단추의 것
import { act, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import { useEscapeClose } from "../src/lib/useEscapeClose";
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
let selected: Set<string>;
const noop = () => {};
const generation = (id: string): Generation => ({
  id, model: "test", prompt: "test", status: "done", created_at: "2026-10-01T12:00:00Z",
  assets: [{ id: `asset-${id}`, type: "image", file_path: `/test/${id}.png` }],
  tags: [], auto_tags: [], references: [], shared: false, is_mine: true, params: {},
}) as unknown as Generation;
const generations = ["g1", "g2", "g3", "g4", "g5"].map(generation);
type GridProps = ComponentProps<typeof ThumbnailGrid>;
const previews: string[] = [];
const comments: string[] = [];

function Overlay() { useEscapeClose(noop); return null; } // Esc 로 닫히는 창 하나
function draw(extra: { before?: React.ReactNode; wrap?: (grid: React.ReactNode) => React.ReactNode; patch?: Partial<GridProps> } = {}) {
  const props: GridProps = {
    generations, tab: "my", scale: 1, fill: true, layout: "grid", groupByDate: false,
    selectedIds: selected, onSelectedChange: (next) => { selected = next; draw(extra); }, onToggleSelect: noop,
    onSetSource: noop, onSetTags: noop, onOpenComments: (g) => comments.push(g.id), onRegenerate: noop,
    onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop,
    onImport: noop, onRestore: noop, dimDeleted: false,
    onInfo: noop, onPreview: (target) => previews.push(String((target as { id?: string }).id ?? "preview")), ...extra.patch,
  };
  const grid = <ThumbnailGrid {...props} />;
  act(() => root.render(<>{extra.before}{extra.wrap ? extra.wrap(grid) : grid}</>));
}
const grid = () => host.querySelector<HTMLElement>(".gen-grid")!;
const cell = (id: string) => host.querySelector<HTMLElement>(`.gen-cell[data-id="${id}"] .card`)!;
const key = (name: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const mouse = (type: string, target: EventTarget, init: MouseEventInit = {}) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const click = (id: string, init: MouseEventInit = {}) => { mouse("mousedown", cell(id), init); mouse("mouseup", window, init); };
const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
const dropFocus = () => act(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  HTMLElement.prototype.scrollTo = vi.fn();
  selected = new Set(); previews.length = 0; comments.length = 0;
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("초점이 어디에도 없을 때(BODY)의 키는 격자가 받고, 초점도 격자로 온다", () => {
  draw();
  flushFrames();
  click("g1"); // 격자는 두 열(폭 400) — g1 의 오른쪽이 g2
  dropFocus();
  expect(document.activeElement).toBe(document.body);
  key("ArrowRight");
  expect([...selected]).toEqual(["g2"]);
  expect(document.activeElement).toBe(grid());
  dropFocus();
  expect(key("a", document.body, { ctrlKey: true }).defaultPrevented).toBe(true); // 화면 글자를 긁지 않는다
  expect(selected.size).toBe(5);
});

it("툴바·상단바 단추에 초점이 남아 있어도 받는다 — Enter·Space 는 그 단추의 것. 글자 입력칸·다른 곳의 단추는 건드리지 않는다", () => {
  draw({ before: <><div className="lib-toolbar"><button className="bar-button">보기</button><input className="bar-input" /></div><button className="other-button">다른 곳</button></> });
  flushFrames();
  click("g1");
  const focus = (selector: string) => { const el = host.querySelector<HTMLElement>(selector)!; act(() => el.focus()); return el; };
  key("ArrowRight", focus(".bar-button"));
  expect([...selected]).toEqual(["g2"]);
  key("Enter", focus(".bar-button"));
  expect(previews).toEqual([]);
  key("ArrowRight", focus(".bar-input"));
  key("ArrowLeft", focus(".other-button")); // 받았다면 g1 로 갔을 것
  expect([...selected]).toEqual(["g2"]);
});

it("위에 창이 떠 있거나, 격자가 가려져 있거나(inert), 캔버스면 초점 잃은 키를 받지 않는다 — 격자를 품은 창에 초점이면 캔버스에서도 받는다", () => {
  draw({ before: <Overlay /> });
  flushFrames();
  click("g1");
  dropFocus();
  key("ArrowRight");
  expect([...selected]).toEqual(["g1"]);

  draw({ wrap: (inner) => <div {...{ inert: "" }}>{inner}</div> });
  dropFocus();
  key("ArrowRight");
  expect([...selected]).toEqual(["g1"]);

  draw({ before: <div className="scene-board" />, wrap: (inner) => <section className="folder-peek" tabIndex={-1}>{inner}</section> });
  dropFocus();
  key("ArrowRight"); // 캔버스에서 초점 없는 키는 보드의 것
  expect([...selected]).toEqual(["g1"]);
  const peek = host.querySelector<HTMLElement>(".folder-peek")!;
  act(() => peek.focus()); // 막 연 폴더 창 — 초점이 창 자체에 있다
  key("ArrowRight", peek);
  expect([...selected]).toEqual(["g2"]);
  key("Escape", peek); // Esc 는 받지 않는다(창의 키 처리 몫)
  expect([...selected]).toEqual(["g2"]);
});

it("마퀴로만 고른 뒤의 방향키·Shift 클릭은 고른 것 중 마지막 카드가 기준이다 — 첫 카드로 튀지 않는다", () => {
  selected = new Set(["g2", "g3"]); // 마퀴가 남긴 상태 — 초점 카드는 없다
  draw();
  flushFrames();
  act(() => grid().focus());
  key("ArrowRight", grid());
  expect([...selected]).toEqual(["g4"]);

  selected = new Set(["g2", "g3"]);
  draw({ patch: { resetKey: "again" } }); // 초점 카드를 비운다
  click("g5", { shiftKey: true });
  expect([...selected]).toEqual(["g3", "g4", "g5"]);
});

it("마퀴를 놓는 순간의 마지막 움직임을 버리지 않고, 창을 떠나면(blur) 끌기를 버린다", () => {
  draw();
  flushFrames();
  const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(grid(), "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 400));
  generations.forEach((g, i) => vi.spyOn(host.querySelector<HTMLElement>(`.gen-cell[data-id="${g.id}"]`)!, "getBoundingClientRect").mockReturnValue(rect(i * 70, 10, 60, 60)));
  // 빈 곳(카드 아래)에서 시작해 g1·g2 를 걸치고, 프레임이 돌기 전에 놓는다
  mouse("mousedown", grid(), { clientX: 5, clientY: 200 });
  mouse("mousemove", window, { clientX: 100, clientY: 20 });
  mouse("mouseup", window, { clientX: 100, clientY: 20 });
  expect([...selected].sort()).toEqual(["g1", "g2"]);
  expect(host.querySelector(".assets-marquee")).toBeNull();

  // 창을 떠나면 끌기는 끝난 것 — 돌아와서 움직여도 선택이 바뀌지 않는다
  mouse("mousedown", grid(), { clientX: 5, clientY: 200 });
  mouse("mousemove", window, { clientX: 300, clientY: 20 });
  act(() => { window.dispatchEvent(new Event("blur")); });
  const before = [...selected].sort();
  mouse("mousemove", window, { clientX: 390, clientY: 20 });
  flushFrames();
  expect([...selected].sort()).toEqual(before);
  expect(host.querySelector(".assets-marquee")).toBeNull();

  // 카드를 누른 채 창을 떠났다 돌아와 떼면 클릭으로 치지 않는다
  selected = new Set(); draw();
  mouse("mousedown", cell("g4"));
  act(() => { window.dispatchEvent(new Event("blur")); });
  mouse("mouseup", window);
  expect(selected.size).toBe(0);
});

it("태그 입력이 키로 끝나면 초점이 격자로 돌아온다 · 체크박스에 초점이어도 방향키가 먹는다 · 카드 안 단추의 Enter 는 그 단추의 것", () => {
  draw({ patch: { layout: "list" } });
  flushFrames();
  click("g1");
  key("#", grid());
  const input = host.querySelector<HTMLInputElement>(".gen-cell input:not([type=checkbox])");
  expect(input, "태그 입력칸").toBeTruthy();
  act(() => input!.focus());
  key("Escape", input!);
  expect(host.querySelector(".gen-cell input:not([type=checkbox])")).toBeNull();
  expect(document.activeElement).toBe(grid());

  const check = host.querySelector<HTMLInputElement>('.gen-cell[data-id="g1"] input[type=checkbox]')!;
  act(() => check.focus());
  key("ArrowDown", check);
  expect([...selected]).toEqual(["g2"]);

  const button = host.querySelector<HTMLButtonElement>('.gen-cell[data-id="g2"] button')!;
  act(() => button.focus());
  expect(key("Enter", button).defaultPrevented).toBe(false);
  expect(previews).toEqual([]);
});

it("위에 떠 있던 창을 닫은 Esc 는 초점이 남은 격자의 선택까지 지우지 않는다 · 창이 떠 있는 동안 방향키·Space 가 뒤 격자를 밀지 않는다", () => {
  // Codex 코드 리뷰·2026-10-10 재실측: 고른 카드의 ⓘ 로 연 비교 창을 Esc 로 닫으면 선택도 풀렸다(창은 캡처 단계에서 닫히고, 같은 Esc 가
  //  격자에 닿을 때는 게이트가 이미 풀려 있었다). 창이 뜬 채 Space·↓ 를 누르면 뒤 격자가 한 쪽씩 내려갔다.
  // 캡처·비소비 겹 — Esc 를 받으면 **그 자리에서** 닫힌다(브라우저에서는 리스너 사이의 마이크로태스크에 다시 그려진다 = flushSync).
  //  그래서 같은 Esc 가 격자에 닿을 때는 게이트가 이미 풀려 있고, '쓴 것' 표시만이 선택을 지킨다.
  let open = true;
  function ClosingLayer({ close }: { close: () => void }) { useEscapeClose(close, true, true); return null; }
  function Closing() {
    const [shown, setShown] = useState(true);
    return shown ? <ClosingLayer close={() => { open = false; flushSync(() => setShown(false)); }} /> : null;
  }
  draw({ before: <Closing /> });
  flushFrames();
  selected = new Set(["g1", "g2"]);
  draw({ before: <Closing /> });
  act(() => grid().focus());
  expect(key("ArrowDown", grid()).defaultPrevented).toBe(true); // 기본 동작(스크롤)을 막는다
  expect(key(" ", grid()).defaultPrevented).toBe(true);
  expect([...selected]).toEqual(["g1", "g2"]); // 선택은 그대로
  key("Escape", grid());
  expect(open).toBe(false);
  expect([...selected]).toEqual(["g1", "g2"]);
  key("Escape", grid()); // 창이 없는 다음 Esc = 선택 해제
  expect(selected.size).toBe(0);
});

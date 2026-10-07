// @vitest-environment jsdom
// 카드의 폴더 이름표(2026-10-07 Jay) — 폴더에 속한 그리드 카드 안 왼쪽 아래. 누르면 그 폴더의 생성물 창(onOpenFolder).
// 이름표의 클릭·더블클릭·휠클릭·끌기가 카드의 선택·크게 보기·정보·끌어 담기로 번지지 않아야 한다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationCard } from "../src/components/GenerationCard";
import { folderChipLabel, folderFullLabel } from "../src/lib/folderLabel";
import type { Generation } from "../src/types";

vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));

const gen = (over: Partial<Generation> = {}): Generation =>
  ({
    id: "g1", prompt: "test", shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-10-07",
    assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/media/a.png", thumbnail_path: null }],
    references: [], tags: [], auto_tags: [], deleted: false, project_id: "p1", project_name: "뻘뻘뻘", folder_path: "e035/c0010",
    ...over,
  }) as unknown as Generation;

const spies = () => ({
  onOpenFolder: vi.fn(), onInfo: vi.fn(), onPreview: vi.fn(), onToggleSelect: vi.fn(), cellClick: vi.fn(), cellDouble: vi.fn(),
});
type Spies = ReturnType<typeof spies>;
const props = (s: Spies, over: Partial<ComponentProps<typeof GenerationCard>> = {}): ComponentProps<typeof GenerationCard> => ({
  gen: gen(), tab: "my", layout: "grid",
  onSetSource: () => {}, onSetTags: () => {}, onOpenComments: () => {}, onRequestEdit: () => {}, onEditDone: () => {},
  onRegenerate: () => {}, onPublish: () => {}, onUnpublish: () => {}, onFinalize: () => {}, onUnfinalize: () => {},
  onImport: () => {}, onRestore: () => {},
  onInfo: s.onInfo, onPreview: s.onPreview, onToggleSelect: s.onToggleSelect, onOpenFolder: s.onOpenFolder,
  ...over,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

// 격자의 칸처럼 카드를 감싼다 — 선택(클릭)·크게 보기(더블클릭)는 칸이 받는다.
const render = (s: Spies, over: Partial<ComponentProps<typeof GenerationCard>> = {}) =>
  act(() => root.render(
    <div className="gen-cell" onClick={s.cellClick} onDoubleClick={s.cellDouble}>
      <GenerationCard {...props(s, over)} />
    </div>,
  ));
const chip = () => host.querySelector<HTMLButtonElement>(".card-folder");
const fire = (el: Element, type: string, init: MouseEventInit = {}) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(event); });
  return event;
};

it("label: folder names only, the last two parts; the full path goes to the tooltip", () => {
  expect(folderChipLabel("e035/c0010")).toBe("e035 c0010");
  expect(folderChipLabel("ep01/seq02/e035/c0010")).toBe("e035 c0010"); // 앞이 아니라 끝(가장 구체적인 칸)을 남긴다
  expect(folderChipLabel(" e035 \\ c0010 /")).toBe("e035 c0010");
  expect(folderChipLabel("c0010")).toBe("c0010");
  expect(folderChipLabel("")).toBe("");
  expect(folderChipLabel(null)).toBe("");
  expect(folderFullLabel("뻘뻘뻘", "e035/c0010")).toBe("뻘뻘뻘 › e035/c0010");
  expect(folderFullLabel(null, "e035/c0010")).toBe("e035/c0010");
});

it("a card in a folder shows the chip inside the thumbnail; no folder or no handler means no chip", () => {
  const s = spies();
  render(s);
  expect(chip()!.textContent).toBe("e035 c0010");
  expect(chip()!.title).toContain("뻘뻘뻘 › e035/c0010");
  expect(chip()!.closest(".card-thumb")).not.toBeNull(); // 카드 그림 안
  expect(chip()!.parentElement!.className).toBe("card-bl");

  render(s, { gen: gen({ folder_path: null }) });
  expect(chip()).toBeNull();
  render(s, { gen: gen({ folder_path: "  " }) });
  expect(chip()).toBeNull();
  render(s, { onOpenFolder: undefined }); // 캔버스 등 콜백을 안 주는 곳
  expect(chip()).toBeNull();
});

it("clicking the chip opens the folder and nothing else — no select, no preview, no info, no card drag", () => {
  const s = spies();
  render(s);
  fire(chip()!, "mousedown");
  fire(chip()!, "click");
  expect(s.onOpenFolder).toHaveBeenCalledTimes(1);
  expect(s.onOpenFolder.mock.calls[0][0].id).toBe("g1");
  expect(s.cellClick).not.toHaveBeenCalled(); // 선택으로 번지지 않는다

  fire(chip()!, "dblclick");
  expect(s.cellDouble).not.toHaveBeenCalled(); // 크게 보기로 번지지 않는다
  expect(s.onPreview).not.toHaveBeenCalled();

  const aux = fire(chip()!, "auxclick", { button: 1 });
  expect(s.onInfo).not.toHaveBeenCalled(); // 휠클릭 정보 창이 열리지 않는다
  expect(aux.defaultPrevented).toBe(true);
  expect(fire(chip()!, "mousedown", { button: 1 }).defaultPrevented).toBe(true); // 휠클릭 자동스크롤도

  // 이름표에서 시작한 끌기는 취소된다(카드 끌어 담기가 시작되지 않는다). 이름표가 끌기 대상이어야 가로챌 수 있다.
  expect(chip()!.draggable).toBe(true);
  expect(fire(chip()!, "dragstart").defaultPrevented).toBe(true);
  expect(s.onOpenFolder).toHaveBeenCalledTimes(1);
});

it("keyboard: Enter and Space on the chip stay with the chip — the grid's shortcuts would cancel the button press", () => {
  const s = spies();
  const gridKeys = vi.fn((e: { preventDefault: () => void }) => e.preventDefault()); // 격자는 Enter=크게 보기·Space=선택으로 받아 기본 동작을 막는다
  for (const layout of ["grid", "list"] as const) {
    act(() => root.render(
      <div className="gen-grid" onKeyDown={gridKeys}>
        <GenerationCard {...props(s, { layout })} />
      </div>,
    ));
    const button = host.querySelector<HTMLButtonElement>(layout === "grid" ? ".card-folder" : "button.cd-folder")!;
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => { button.dispatchEvent(event); });
      return event;
    };
    gridKeys.mockClear();
    expect(press("Enter").defaultPrevented).toBe(false); // 단추의 기본 누름(=click)이 살아 있다
    expect(press(" ").defaultPrevented).toBe(false);
    expect(gridKeys).not.toHaveBeenCalled();
    press("ArrowRight"); // 그 밖의 키는 종전대로 격자가 받는다
    expect(gridKeys).toHaveBeenCalledTimes(1);
  }
});

it("other bottom-left badges stack under the chip in one group; without a chip the old markup is untouched", () => {
  const s = spies();
  const withBadges = gen({ is_source: true, source_name: "mia", status: "failed" } as Partial<Generation>);
  render(s, { gen: withBadges });
  const group = host.querySelector(".card-bl")!;
  expect([...group.children].map((el) => el.className.split(" ")[0])).toEqual(["card-folder", "source-badge", "status-pill"]);
  expect(host.querySelectorAll(".source-badge")).toHaveLength(1); // 묶음 밖에 또 그리지 않는다
  expect(host.querySelectorAll(".status-pill")).toHaveLength(1);

  render(s, { gen: withBadges, onOpenFolder: undefined });
  expect(host.querySelector(".card-bl")).toBeNull();
  expect(host.querySelector(".card-thumb > .source-badge")).not.toBeNull();
  expect(host.querySelector(".card-thumb > .status-pill")).not.toBeNull();
});

it("list layout: the folder text becomes a button with the same action; without a handler it stays plain text", () => {
  const s = spies();
  render(s, { layout: "list" });
  expect(chip()).toBeNull(); // 리스트는 그림 안 이름표 대신 아래 글자
  const button = host.querySelector<HTMLButtonElement>("button.cd-folder")!;
  expect(button.textContent).toContain("뻘뻘뻘 › e035/c0010");
  fire(button, "click");
  expect(s.onOpenFolder).toHaveBeenCalledTimes(1);
  expect(s.cellClick).not.toHaveBeenCalled();

  render(s, { layout: "list", onOpenFolder: undefined });
  expect(host.querySelector("button.cd-folder")).toBeNull();
  expect(host.querySelector("span.cd-folder")!.textContent).toContain("e035/c0010");
  render(s, { layout: "list", gen: gen({ folder_path: null }) }); // 프로젝트만 있고 폴더가 없으면 누를 것이 없다
  expect(host.querySelector("button.cd-folder")).toBeNull();
  expect(host.querySelector("span.cd-folder")!.textContent).toContain("뻘뻘뻘");
});

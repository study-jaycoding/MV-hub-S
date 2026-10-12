// @vitest-environment jsdom
// 20회차(Codex 전수 검토 — 끌어 놓기·순서 손잡이·창 위의 휠).
//  · 끄는 항목을 목록의 '몇 번째'로 들면, 끄는 사이 목록이 바뀔 때 그 번호 자리에 온 **다른 항목**이 옮겨져 저장된다(조작 규칙 45 의 남은 자리).
//    여기서는 태그 순서·레퍼런스 트레이 — 프로젝트 순서는 tests/projectFolderMenu(사이드바)·tests/adminWindowTabs(관리자 창).
//  · 받는 곳이 없는 자리에 놓인 파일은 '놓을 수 없음'이다(전역 지킴이) — 그래서 받지 못하는 끌기에는 '놓을 수 있음'을 보이지 않는다
//    (폴더 줄의 탐색기 파일 · 들일 폴더가 없는 Assets). 전엔 복사 커서·강조가 뜨고, 놓으면 아무 일도 없었다.
//  · 캔버스 안에 뜬 창 위의 휠은 뒤 보드를 줌하지 않는다(타임라인 재생 창이 그 목록에서 빠져 있었다).
import { act, type DragEvent as ReactDragEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));

import { useAssetDropImport } from "../src/components/assets/useAssetDropImport";
import { FolderTreeView } from "../src/components/common/FolderTreeView";
import { TagFilterPanel } from "../src/components/common/TagFilterPanel";
import { SpotlightRefTray, type SpotlightTrayRef } from "../src/components/spotlight/SpotlightRefTray";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import { installFileDropGuard } from "../src/lib/media";
import { emptySeedanceTokenRoles } from "../src/lib/seedancePrompt";
import { useSceneViewport } from "../src/lib/useSceneViewport";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const drag = (target: Element, type: string, types: string[] = []) => {
  const dataTransfer = { types, effectAllowed: "", dropEffect: "none", getData: () => "", setData: () => {} };
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
  act(() => { target.dispatchEvent(event); });
  return event;
};

// ── 순서 손잡이 ──
it("태그 순서 — 끄는 사이 태그 목록이 바뀌어도 잡은 태그가 옮겨진다(그 번호 자리에 온 다른 태그가 아니다)", () => {
  const panel = (tags: string[]) => (
    <TagFilterPanel tags={tags} activeTags={new Set()} panelRef={{ current: null }} pos={null} onHeadMouseDown={() => {}}
      onClear={() => {}} onSelectTag={() => {}} onDeleteTag={() => {}} orderKey="test.tagOrder" />
  );
  const pills = () => [...document.querySelectorAll<HTMLElement>(".tag-pill")];
  const nameOf = (item: HTMLElement) => item.querySelector("button")!.textContent!.replace(/^#/, "");
  const pill = (tag: string) => pills().find((item) => nameOf(item) === tag)!;
  const shown = () => pills().map(nameOf);
  act(() => root.render(panel(["a", "b", "c"])));
  expect(shown()).toEqual(["a", "b", "c"]);
  drag(pill("b"), "dragstart");
  act(() => root.render(panel(["0", "a", "b", "c"]))); // 끄는 사이 태그가 하나 생겼다(자동 새로 고침) — 앞에 끼어든다
  expect(shown()).toEqual(["0", "a", "b", "c"]);
  expect(pills().filter((item) => item.classList.contains("dragging")).map(nameOf)).toEqual(["b"]);
  drag(pill("c"), "drop");
  expect(shown()).toEqual(["0", "a", "c", "b"]); // 전엔 번호 1 의 a 가 옮겨져 ["0", "b", "c", "a"]

  drag(pill("a"), "dragstart");
  act(() => root.render(panel(["0", "c", "b"]))); // 끄는 사이 잡은 태그가 사라졌다 — 아무것도 옮기지 않는다
  drag(pill("0"), "drop"); // 맨 앞에 놓는다 — 사라진 것을 '마지막 항목'으로 잘못 집으면 b 가 앞으로 온다(맨 뒤에 놓으면 그 잘못이 안 보인다)
  expect(shown()).toEqual(["0", "c", "b"]);
});

it("레퍼런스 트레이 — 끄는 사이 앞에 항목이 끼어들어도 잡은 항목이 옮겨지고, 트레이가 갈렸으면(다른 카드의 것) 옮기지 않는다", () => {
  // 가짜 자리: 항목은 가로 100px 마다 한 장(폭 80) — 삽입 자리는 포인터와 가장 가까운 항목으로 잰다
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const at = this.dataset.tidx === undefined ? -1 : Number(this.dataset.tidx);
    const [x, w, h] = at >= 0 ? [at * 100, 80, 60] : [0, 0, 0];
    return { x, y: 0, left: x, top: 0, width: w, height: h, right: x + w, bottom: h, toJSON: () => ({}) } as DOMRect;
  });
  const onReorder = vi.fn();
  const ref = (uid: string) => ({ uid, file_path: `/files/${uid}.png`, type: "image", role: "@Image", name: uid, thumb: `/files/${uid}.png` }) as SpotlightTrayRef;
  const tray = (uids: string[]) => (
    <SpotlightRefTray trayRefs={uids.map(ref)} model="nano_banana" liveSeedanceRoles={emptySeedanceTokenRoles()} onDragOver={() => {}}
      onDrop={() => {}} onKeyDown={() => {}} onReorder={onReorder} onRemove={() => {}} onClearAll={() => {}} />
  );
  const items = () => [...host.querySelectorAll<HTMLElement>(".sl-reftray-item")];
  const grab = (index: number) => act(() => {
    items()[index].dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: index * 100 + 40, clientY: 30, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 30, buttons: 1 })); // 맨 앞으로 끄는 중
  });
  const release = () => act(() => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 30, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 5, clientY: 30 }));
  });
  act(() => root.render(tray(["a", "b", "c"])));
  grab(1); // b
  act(() => root.render(tray(["x", "a", "b", "c"]))); // 끄는 사이 앞에 하나가 들어왔다
  expect(host.querySelector<HTMLElement>(".sl-reftray-item.reordering")!.title).toContain(". b ·");
  release();
  expect(onReorder.mock.calls).toEqual([[2, 0]]); // 전엔 (1, 0) — a 가 옮겨졌다

  grab(2); // b
  act(() => root.render(tray(["p", "q", "r"]))); // 키로 다른 카드를 골라 트레이가 그 카드의 것으로 갈렸다
  release();
  expect(onReorder).toHaveBeenCalledTimes(1); // 전엔 새 트레이의 2번(r)이 옮겨져 그 카드에 저장됐다
});

// ── 받는 곳이 없는 자리의 파일 ──
it("파일 놓기 지킴이 — 아무도 받지 않은 파일 끌기만 '놓을 수 없음'으로 돌린다(받은 것·파일이 아닌 끌기·파일 입력칸은 그대로)", () => {
  const listeners: Record<string, (event: DragEvent) => void> = {};
  installFileDropGuard({ addEventListener: (type: string, listener: (event: DragEvent) => void) => { listeners[type] = listener; } } as never);
  const fire = (type: "dragover" | "drop", init: { types?: string[]; taken?: boolean; target?: Element }) => {
    const dataTransfer = { types: init.types ?? ["Files"], files: [], items: [], dropEffect: "copy" };
    const event = { type, defaultPrevented: !!init.taken, dataTransfer, target: init.target ?? document.body, preventDefault: vi.fn() };
    listeners[type](event as never);
    return [event.preventDefault.mock.calls.length, dataTransfer.dropEffect];
  };
  expect(fire("dragover", {})).toEqual([1, "none"]);
  expect(fire("drop", {})).toEqual([1, "copy"]); // 놓기는 기본 동작(파일 열기)만 막는다
  expect(fire("dragover", { taken: true })).toEqual([0, "copy"]); // 받는 곳이 이미 받았다
  expect(fire("dragover", { types: ["text/plain"] })).toEqual([0, "copy"]); // 글자 끌기 — 입력칸에 놓는 것은 브라우저의 것
  const input = Object.assign(document.createElement("input"), { type: "file" });
  host.append(input);
  expect(fire("dragover", { target: input })).toEqual([0, "copy"]);
  expect(fire("drop", { target: input })).toEqual([0, "copy"]);
});

it("폴더 줄 — 생성물 카드만 받는다. 탐색기의 파일에는 '놓을 수 있음'(복사 커서·강조)을 보이지 않는다", () => {
  const onDropFolder = vi.fn();
  act(() => root.render(<FolderTreeView nodes={[{ name: "c0010", path: "ep001/c0010" }]} onSelect={() => {}} onDropFolder={onDropFolder} />));
  const row = host.querySelector<HTMLElement>(".folder-tree-row")!;
  const file = drag(row, "dragover", ["Files"]);
  expect([file.defaultPrevented, row.classList.contains("drop-over")]).toEqual([false, false]); // 전엔 [true, true]
  const card = drag(row, "dragover", [DRAG_TYPES.generation]);
  expect([card.defaultPrevented, card.dataTransfer.dropEffect, row.classList.contains("drop-over")]).toEqual([true, "copy", true]);
  drag(row, "drop", [DRAG_TYPES.generation]);
  expect(onDropFolder).toHaveBeenCalledTimes(1);
  expect(drag(row, "dragover", [DRAG_TYPES.generationList]).defaultPrevented).toBe(true); // 여러 장을 끄는 것도
});

it("Assets — 들일 폴더가 없으면 파일을 받지 않는다('현재 폴더로 가져오기'를 띄워 놓고 놓으면 아무 일도 없었다)", () => {
  let zone!: ReturnType<typeof useAssetDropImport>;
  function Probe({ project }: { project: string }) {
    zone = useAssetDropImport({ dir: "", project, onImported: () => {} });
    return <i data-active={String(zone.dropActive)} />;
  }
  const active = () => host.querySelector("i")!.dataset.active;
  const over = () => {
    const event = { preventDefault: vi.fn(), dataTransfer: { types: ["Files"], files: [], items: [], dropEffect: "none" } };
    act(() => { zone.onZoneDragEnter(event as unknown as ReactDragEvent); zone.onZoneDragOver(event as unknown as ReactDragEvent); });
    return [event.preventDefault.mock.calls.length > 0, event.dataTransfer.dropEffect, active()];
  };
  act(() => root.render(<Probe project="" />));
  expect(over()).toEqual([false, "none", "false"]); // 전엔 [true, "copy", "true"]
  act(() => root.render(<Probe project="P" />));
  expect(over()).toEqual([true, "copy", "true"]);
});

// ── 캔버스 안에 뜬 창 위의 휠 ──
// 목록은 시험이 따로 적는다 — 상수에서 뽑으면 상수에서 빠진 창을 시험도 같이 잊는다
it.each([".scene-varpop-backdrop", ".scene-modelmodal-backdrop", ".vtl-backdrop"])("캔버스 안에 뜬 창(%s) 위의 휠은 뒤 보드를 줌하지 않는다 — 보드 위의 휠은 줌한다", (selector) => {
  let camera!: () => { z: number };
  function Probe() {
    const view = useSceneViewport({ sceneId: "s", cullingEnabled: false });
    camera = view.getCamera;
    return (
      <div ref={view.scrollRef} className="board">
        <div ref={view.canvasRef} />
        <div className={selector.slice(1)}><p className="inside" /></div>
      </div>
    );
  }
  act(() => root.render(<Probe />));
  const wheel = (target: Element) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const before = camera().z;
  expect([wheel(host.querySelector(".inside")!), camera().z]).toEqual([false, before]);
  expect(wheel(host.querySelector(".board")!)).toBe(true);
  expect(camera().z).not.toBe(before);
});

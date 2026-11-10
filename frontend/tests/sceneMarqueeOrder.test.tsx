// @vitest-environment jsdom
// 캔버스 범위 선택은 카드 위치를 다 읽은 뒤에 쓴다(사각형 표시·미리보기) — 쓰고 나서 읽으면 걸음마다 브라우저가 배치를
//  그 자리에서 다시 계산했다(2026-11-10 실측: 40걸음에 강제 Layout 40번). 결과(고른 카드)는 그대로다.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSceneMarqueeSelection } from "../src/lib/useSceneMarqueeSelection";
import type { BeginSceneDrag } from "../src/lib/useSceneDragSession";

let root: Root | null = null;
let begin: ((e: React.MouseEvent) => boolean) | null = null;
const log: string[] = [];
let preview: ReadonlySet<string> | null = null;
let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;

function Host() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  const api = useSceneMarqueeSelection<string>({
    selected: new Set(),
    surfaceRef,
    setSelected: () => {},
    setMarquee: (rect) => { log.push(rect ? "write:marquee" : "write:clear"); },
    beginDrag,
    cellSelector: ".cell",
    keyOf: (el) => el.dataset.id,
    previewSelection: (sel) => { log.push("write:preview"); preview = sel; },
  });
  begin = api.begin;
  return (
    <div ref={surfaceRef} className="surface">
      <div className="cell" data-id="a" data-x="10" />
      <div className="cell" data-id="b" data-x="300" />
    </div>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  log.length = 0;
  preview = null;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    log.push("read");
    const x = Number(this.dataset.x ?? 0);
    const w = this.classList.contains("surface") ? 1000 : 50;
    return { x, y: 0, left: x, top: 0, width: w, height: 50, right: x + w, bottom: 50, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

it("걸음마다 읽기(사각형·카드 위치)를 모두 끝낸 뒤 사각형·미리보기를 쓴다 — 고른 카드는 사각형 안의 것", async () => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Host />));
  act(() => { begin!({ button: 0, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} } as unknown as React.MouseEvent); });
  for (const x of [100, 120, 400]) {
    log.length = 0;
    act(() => drag!.move(new MouseEvent("mousemove", { clientX: x, clientY: 40 })));
    const firstWrite = log.findIndex((entry) => entry.startsWith("write"));
    expect(firstWrite).toBeGreaterThan(0);
    expect(log.slice(firstWrite).some((entry) => entry === "read")).toBe(false); // 쓴 뒤에 읽지 않는다
  }
  expect([...(preview ?? [])].sort()).toEqual(["a", "b"]); // 0..400 사각형 = 두 카드
  act(() => drag!.up(new MouseEvent("mouseup")));
});

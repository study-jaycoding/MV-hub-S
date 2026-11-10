// @vitest-environment jsdom
// 가운데 버튼 화면 이동은 끄는 동안 transform 대신 translate + 표식(data-layer-move — 값 0 애니메이션, scene.css)으로 캔버스·점 격자·
//  미니맵 상자를 민다 — 걸음마다 transform 을 바꾸면 크롬이 화면 전체 레이어를 다시 합쳐 느린 PC 에서 끊겼다(2026-11-10 격리 실측).
//  손 떼거나 다른 카메라 변경이 오면 transform 으로 접어 화면·좌표가 같아야 한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { BeginSceneDrag } from "../src/lib/useSceneDragSession";
import { useSceneViewport } from "../src/lib/useSceneViewport";

type Camera = { z: number; x: number; y: number };
let api: ReturnType<typeof useSceneViewport>;
let root: Root | null = null;

function Host({ onCameraChange }: { onCameraChange: (camera: Camera) => void }) {
  api = useSceneViewport({ sceneId: "s", camera: { z: 2, x: 10, y: 20 }, onCameraChange, cullingEnabled: false });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it("끄는 동안은 translate·표식으로만 밀고(격자는 칸 나머지 차이), 손 떼면 transform 으로 접고 저장한다", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const saved = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(<Host onCameraChange={saved} />));
  const minimap = vi.fn();
  api.minimapUpdateRef.current = minimap;
  const canvas = api.canvasRef.current!;
  const grid = api.gridRef.current!;
  let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  const move = (x: number, y: number) => drag!.move(new MouseEvent("mousemove", { clientX: x, clientY: y }));

  expect(api.beginPan({ button: 1, clientX: 100, clientY: 100, preventDefault: () => {} }, beginDrag)).toBe(true);
  move(140, 70);

  expect(canvas.style.transform).toBe("translate(10px, 20px) scale(2)"); // 끄는 동안 transform 은 그대로
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["40px -30px", true]);
  // 칸 44px(22×2): x 10 → 50 = 칸 안 10 → 6 · y 20 → −10 = 칸 안 20 → 34
  expect([grid.style.translate, grid.hasAttribute("data-layer-move")]).toEqual(["-4px 14px", true]);
  expect(minimap).toHaveBeenLastCalledWith(true);
  expect(api.getCamera()).toEqual({ z: 2, x: 50, y: -10 });
  expect(api.toCanvas(300, 400)).toEqual({ x: 125, y: 205 }); // 좌표는 걸음마다 맞다
  expect(saved).not.toHaveBeenCalled();

  // 끄는 도중 보드가 다시 그려져도(보이는 범위 갱신 등) 접지 않는다 — 접으면 그 프레임에 화면 전체 정리가 다시 돈다
  await act(async () => root!.render(<Host onCameraChange={saved} />));
  expect([canvas.style.transform, canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["translate(10px, 20px) scale(2)", "40px -30px", true]);
  expect(minimap).toHaveBeenLastCalledWith(true);

  // 끄는 도중 다른 카메라 변경(툴바 줌)은 applyTransform 을 거쳐 접힌다 — 다음 걸음은 거기서부터 민다
  act(() => api.stepZoom(1));
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move"), grid.hasAttribute("data-layer-move")]).toEqual(["", false, false]);
  const zoomed = canvas.style.transform;
  saved.mockClear();
  move(150, 70);
  expect(canvas.style.transform).toBe(zoomed);
  expect(canvas.hasAttribute("data-layer-move")).toBe(true);

  drag!.up(new MouseEvent("mouseup"));
  const end = api.getCamera();
  expect(end.x).toBe(60);
  expect(canvas.style.transform).toBe(`translate(60px, -10px) scale(${end.z})`);
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["", false]);
  expect([grid.style.translate, grid.hasAttribute("data-layer-move")]).toEqual(["", false]);
  expect(minimap).toHaveBeenLastCalledWith(); // 접을 때는 slide 없이 — 상자 transform·크기를 맞춘다
  expect(saved).toHaveBeenLastCalledWith(end);
});

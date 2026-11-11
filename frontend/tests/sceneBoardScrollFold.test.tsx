// @vitest-environment jsdom
// 캔버스 보드는 overflow:hidden 이지만 브라우저가 초점·캐럿을 보이려고 스스로 스크롤한다 — 그 스크롤이 남으면 toCanvas 가 그만큼 어긋나
//  붙여넣기·새 노드가 마우스보다 위에 놓였다(2026-11-10 격리 실측 121px). 스크롤 양을 카메라 팬으로 옮기고 0 으로 되돌리는지 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CAMERA_IDLE_SAVE_MS, useSceneViewport } from "../src/lib/useSceneViewport";

type Camera = { z: number; x: number; y: number };
let api: ReturnType<typeof useSceneViewport>;
let root: Root | null = null;

function Host({ onCameraChange }: { onCameraChange: (camera: Camera) => void }) {
  api = useSceneViewport({ sceneId: "s", camera: { z: 2, x: 10, y: 20 }, onCameraChange, cullingEnabled: false });
  return <div ref={api.scrollRef}><div ref={api.canvasRef} /></div>;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

it("보드 스크롤을 팬으로 옮겨 0 으로 되돌리고, 좌표 변환이 화면과 맞으며, 카메라는 늦춰 한 번 저장한다", async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const saved = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(<Host onCameraChange={saved} />));
  const board = api.scrollRef.current!;
  const before = api.toCanvas(300, 400);

  board.scrollTop = 121;
  board.scrollLeft = 5;
  board.dispatchEvent(new Event("scroll"));

  expect([board.scrollTop, board.scrollLeft]).toEqual([0, 0]);
  expect(api.getCamera()).toEqual({ z: 2, x: 5, y: -101 });
  expect(api.canvasRef.current!.style.transform).toBe("translate(5px, -101px) scale(2)");
  // 같은 화면 점은 스크롤 양(÷ 줌)만큼 아래·오른쪽 캔버스 점 — 브라우저가 내용을 올려 보인 그 자리다
  expect(api.toCanvas(300, 400)).toEqual({ x: before.x + 5 / 2, y: before.y + 121 / 2 });

  board.dispatchEvent(new Event("scroll")); // 0 으로 되돌린 뒤 다시 오는 scroll 은 아무것도 안 한다
  expect(api.getCamera()).toEqual({ z: 2, x: 5, y: -101 });
  expect(saved).not.toHaveBeenCalled();
  vi.advanceTimersByTime(CAMERA_IDLE_SAVE_MS - 1); // 기록은 유휴 시간 뒤 한 번(옛 400ms 아님)
  expect(saved).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved).toHaveBeenCalledWith({ z: 2, x: 5, y: -101 }, "s"); // 단독 사용 = 씬 ID 가 대상
});

// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoardBoundary } from "../src/components/scene/SceneBoardBoundary";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("청크 실패 뒤에도 바깥 탭은 조작되고 새로고침은 사용자 클릭으로만 요청한다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let reject!: (error: Error) => void;
  const Board = lazy(() => new Promise<{ default: () => React.ReactNode }>((_, fail) => { reject = fail; }));
  const switchTab = vi.fn();
  const reload = vi.fn();
  await act(async () => {
    root.render(<>
      <button onClick={switchTab}>라이브러리</button>
      <SceneBoardBoundary fallback={<div role="status">캔버스 로드 실패<button onClick={reload}>새로고침</button></div>}>
        <Suspense fallback={<div role="status">캔버스 로딩</div>}><Board /></Suspense>
      </SceneBoardBoundary>
    </>);
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("캔버스 로딩");
  expect(host.querySelectorAll("button")).toHaveLength(1);
  await act(async () => { reject(new Error("chunk 404")); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("캔버스 로드 실패");
  expect(reload).not.toHaveBeenCalled();
  act(() => host.querySelectorAll("button")[0].click());
  expect(switchTab).toHaveBeenCalledOnce();
  act(() => host.querySelectorAll("button")[1].click());
  expect(reload).toHaveBeenCalledOnce();
});

// @vitest-environment jsdom
// 공유 & 리뷰 탭의 프로젝트·폴더 선택을 다시 켤 때 되살린다 — 같은 공간의 자동 범위에서 고른 것일 때만(Jay 2026-10-08).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Store } from "../src/lib/storage";
import { restoreViewKey, useLibraryFilters } from "../src/lib/useLibraryFilters";
import { FILTERS_FORMAT_KEY, FILTERS_KEY, FILTERS_VIEW_KEY } from "../src/lib/useLibraryPersistence";
import type { WorkspaceContext } from "../src/types";

function fakeStore(data: Record<string, string>): Store {
  return {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => (key in data ? (JSON.parse(data[key]) as T) : null),
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => new Set(key in data ? (JSON.parse(data[key]) as string[]) : []),
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
}

const A: WorkspaceContext = { scope: "team", id: "a", name: "A" };
const B: WorkspaceContext = { scope: "team", id: "b", name: "B" };
const keyOf = (w: WorkspaceContext) => JSON.stringify([w.scope, w.id]);

let host: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useLibraryFilters>;
let workspace: WorkspaceContext;
let store: Store;
function Probe() {
  latest = useLibraryFilters(store, workspace);
  return null;
}
const render = () => act(() => root.render(<Probe />));
const stored = (more: Record<string, unknown> = {}) => ({
  [FILTERS_KEY]: JSON.stringify({ tab: "team", project_id: "p1", folder_path: "e035", [FILTERS_FORMAT_KEY]: "2", ...more }),
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("공유 탭의 프로젝트·폴더 기억", () => {
  it("같은 공간의 자동 범위에서 고른 것이면 다시 켤 때 그대로 — 저장에는 공간 키가 함께 남는다", () => {
    const data = stored({ [FILTERS_VIEW_KEY]: keyOf(A) });
    store = fakeStore(data);
    workspace = A;
    render();
    expect(latest.filters).toMatchObject({ tab: "team", project_id: "p1", folder_path: "e035" });
    expect(latest.workspaceFollow?.mode).toBe("auto");
    expect(latest.genQuery.workspace_ids).toEqual(["a"]);
    expect(restoreViewKey(store)).toBe(keyOf(A));
    expect(JSON.parse(data[FILTERS_KEY])).toMatchObject({ project_id: "p1", [FILTERS_VIEW_KEY]: keyOf(A) });
    // 공간을 실제로 바꾸면 전처럼 비운다
    workspace = B;
    render();
    expect(latest.filters.project_id).toBeUndefined();
    expect(latest.filters.folder_path).toBeUndefined();
    expect(JSON.parse(data[FILTERS_KEY])[FILTERS_VIEW_KEY]).toBe(keyOf(B));
  });

  it("공간 키가 없거나(옛 저장) 다른 공간의 것이면 전처럼 비운다", () => {
    store = fakeStore(stored());
    workspace = A;
    render();
    expect(latest.filters.project_id).toBeUndefined();

    act(() => root.unmount());
    root = createRoot(host);
    store = fakeStore(stored({ [FILTERS_VIEW_KEY]: keyOf(B) }));
    render();
    expect(latest.filters.project_id).toBeUndefined();
  });

  it("전체 보기 중에 고른 것은 키 없이 저장돼 다시 켤 때 비운다(전체 보기는 그때만 유효하다)", () => {
    const data = stored({ [FILTERS_VIEW_KEY]: keyOf(A) });
    store = fakeStore(data);
    workspace = A;
    render();
    act(() => latest.workspaceFollow!.onChange("all"));
    act(() => latest.patch({ project_id: "p2", folder_path: "x" }));
    expect(JSON.parse(data[FILTERS_KEY])).toMatchObject({ project_id: "p2" });
    expect(JSON.parse(data[FILTERS_KEY])[FILTERS_VIEW_KEY]).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(latest.filters.project_id).toBeUndefined();
    expect(latest.workspaceFollow?.mode).toBe("auto");
  });

  it("공간이 없으면(작업 공간 탭·시험) 전과 같다 — 키를 남기지 않고 지우지도 않는다", () => {
    const data = stored();
    store = fakeStore(data);
    workspace = undefined as unknown as WorkspaceContext;
    render();
    expect(latest.filters).toMatchObject({ project_id: "p1", folder_path: "e035" });
    expect(JSON.parse(data[FILTERS_KEY])[FILTERS_VIEW_KEY]).toBeUndefined();
  });
});

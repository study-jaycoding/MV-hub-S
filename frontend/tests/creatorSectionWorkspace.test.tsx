// @vitest-environment jsdom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreatorSection } from "../src/components/sidebar/CreatorSection";
import { api } from "../src/api";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import { HttpError } from "../src/lib/http";
import { setLang } from "../src/lib/i18n";
import type { Creator } from "../src/types";

const { broadcastListeners } = vi.hoisted(() => ({ broadcastListeners: new Set<() => void>() }));
vi.mock("../src/api", () => ({ api: { creators: vi.fn() } }));
vi.mock("../src/lib/libraryBroadcast", () => ({
  onLibraryChanged: (listener: () => void) => {
    broadcastListeners.add(listener);
    return () => { broadcastListeners.delete(listener); };
  },
}));

const a: Creator[] = [
  { uid: "a-other", name: "A other", count: 2, is_mine: false },
  { uid: "a-mine", name: "A mine", count: 4, is_mine: true },
];
const b: Creator[] = [{ uid: "b", name: "B creator", count: 9, is_mine: false }];
const personal: Creator[] = [
  { uid: "personal-one", name: "Personal one", count: 3, is_mine: true },
  { uid: "personal-two", name: "Personal two", count: 6, is_mine: false },
];
let host: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof CreatorSection>;
const onFilter = vi.fn();
function render(patch: Partial<ComponentProps<typeof CreatorSection>> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(<StrictMode><CreatorSection {...props} /></StrictMode>));
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
function rows() { return [...host.querySelectorAll(".creator-row")].map((row) => row.textContent); }
function event() { act(() => dispatchAppEvent(APP_EVENTS.libraryChanged)); }
function broadcast() { act(() => { for (const listener of broadcastListeners) listener(); }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(api.creators).mockReset();
  broadcastListeners.clear();
  setLang("ko");
  props = { tab: "team", projectId: "project", workspaceFilter: { workspace_ids: ["a"] },
    ready: true, contextKey: "account-one", onFilter };
  vi.mocked(api.creators).mockImplementation(async (_tab, _project, filter) =>
    filter?.workspace_scope === "personal" ? personal :
      filter?.workspace_ids?.includes("a") ? a : filter?.workspace_ids?.includes("b") ? b : [...a, ...b, ...personal]);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("팀 A/B·개인·전체 목록과 건수가 바뀌고 내 생성자를 먼저 표시", async () => {
  render(); await settle();
  expect(rows()).toEqual(["A mine4", "A other2"]);
  expect(api.creators).toHaveBeenLastCalledWith("team", "project", { workspace_ids: ["a"] });
  render({ workspaceFilter: { workspace_ids: ["b"] } }); await settle();
  expect(rows()).toEqual(["B creator9"]);
  render({ workspaceFilter: { workspace_scope: "personal" } }); await settle();
  expect(rows()).toEqual(["Personal one3", "Personal two6"]);
  render({ workspaceFilter: {} }); await settle();
  expect(rows()).toHaveLength(5);
  expect(api.creators).toHaveBeenLastCalledWith("team", "project", {});
});

it("동일한 공간 집합은 canonical 조건을 보내며 순서 변경으로 재조회하지 않음", async () => {
  render({ workspaceFilter: { workspace_ids: ["b", "a", "a"] } }); await settle();
  expect(api.creators).toHaveBeenLastCalledWith("team", "project", { workspace_ids: ["a", "b"] });
  const count = vi.mocked(api.creators).mock.calls.length;
  render({ workspaceFilter: { workspace_ids: ["a", "b"] } }); await settle();
  expect(api.creators).toHaveBeenCalledTimes(count);
});

it("계정 범위가 바뀌면 옛 목록을 즉시 숨기고 새 계정 응답만 표시", async () => {
  render(); await settle();
  const next = deferred<Creator[]>();
  vi.mocked(api.creators).mockReturnValue(next.promise);
  render({ contextKey: "account-two" });
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain("불러오는 중");
  next.resolve(b); await settle();
  expect(rows()).toEqual(["B creator9"]);
});

it("미확인에서는 이벤트도 조회하지 않고 선택을 유지, 준비 완료 뒤 조회", async () => {
  render({ ready: false, activeUid: "a-mine" }); await settle();
  event(); broadcast(); await settle();
  expect(api.creators).not.toHaveBeenCalled();
  expect(onFilter).not.toHaveBeenCalled();
  expect(host.textContent).toBe("");
  render({ ready: true }); await settle();
  expect(rows()).toEqual(["A mine4", "A other2"]);
  expect(onFilter).not.toHaveBeenCalled();
});

it("미확인으로 전환한 뒤 도착한 이전 응답은 표시·선택을 바꾸지 않는다", async () => {
  const old = deferred<Creator[]>();
  vi.mocked(api.creators).mockReturnValue(old.promise);
  render({ activeUid: "a-mine" });
  render({ ready: false });
  old.resolve(b); await settle();
  expect(rows()).toEqual([]);
  expect(onFilter).not.toHaveBeenCalled();
});

it("공간 A 요청이 B보다 늦어도 B 결과를 덮지 않는다", async () => {
  const old = deferred<Creator[]>();
  vi.mocked(api.creators).mockImplementation(async (_tab, _project, filter) =>
    filter?.workspace_ids?.includes("a") ? old.promise : b);
  render();
  render({ workspaceFilter: { workspace_ids: ["b"] } }); await settle();
  expect(rows()).toEqual(["B creator9"]);
  old.resolve(a); await settle();
  expect(rows()).toEqual(["B creator9"]);
});

it("같은 창과 다른 창의 변경을 갱신하며 같은 범위의 역순 응답도 버린다", async () => {
  render(); await settle();
  const older = deferred<Creator[]>();
  const newer = deferred<Creator[]>();
  vi.mocked(api.creators).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const count = vi.mocked(api.creators).mock.calls.length;
  event(); broadcast();
  expect(api.creators).toHaveBeenCalledTimes(count + 2);
  newer.resolve([{ ...a[1], count: 12 }]); await settle();
  expect(rows()).toEqual(["A mine12"]);
  older.resolve([{ ...a[1], count: 8 }]); await settle();
  expect(rows()).toEqual(["A mine12"]);
});

it.each([500, 409])("%i 오류는 이전 집계를 숨기고 재시도를 제공하며 선택은 유지", async (status) => {
  render({ activeUid: "a-mine" }); await settle();
  vi.mocked(api.creators).mockRejectedValueOnce(new HttpError(status, "read failed"));
  event(); await settle();
  expect(rows()).toEqual([]);
  expect(onFilter).not.toHaveBeenCalled();
  expect(host.textContent?.includes("공유 서버 업데이트가 필요합니다")).toBe(status === 409);
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("다시 시도"));
  expect(retry).toBeDefined();
  act(() => retry!.click()); await settle();
  expect(rows()).toEqual(["A mine4", "A other2"]);
});

it("확정된 새 집계에서 선택 생성자가 사라진 경우에만 필터를 해제", async () => {
  render({ activeUid: "a-mine" }); await settle();
  const next = deferred<Creator[]>();
  vi.mocked(api.creators).mockReturnValueOnce(next.promise);
  event();
  expect(onFilter).not.toHaveBeenCalled();
  next.resolve([a[0]]); await settle();
  expect(onFilter).toHaveBeenCalledWith(undefined);
  expect(rows()).toEqual(["A other2"]);
});

it("선택한 생성자는 집계 조건을 줄이지 않고 클릭 선택·해제가 유지", async () => {
  render({ activeUid: "a-mine" }); await settle();
  expect(rows()).toHaveLength(2);
  const count = vi.mocked(api.creators).mock.calls.length;
  render({ activeUid: "a-other" }); await settle();
  expect(api.creators).toHaveBeenCalledTimes(count);
  expect(rows()).toHaveLength(2);
  act(() => (host.querySelector('button[title="a-other"]') as HTMLButtonElement).click());
  expect(onFilter).toHaveBeenLastCalledWith(undefined);
  act(() => (host.querySelector('button[title="a-mine"]') as HTMLButtonElement).click());
  expect(onFilter).toHaveBeenLastCalledWith("a-mine");
  expect(api.creators).toHaveBeenLastCalledWith("team", "project", { workspace_ids: ["a"] });
});

it("프로젝트 전환은 재조회하고 내 작업도 공간 조건과 사라진 선택 해제를 적용", async () => {
  render(); await settle();
  render({ projectId: "project-new" }); await settle();
  expect(api.creators).toHaveBeenLastCalledWith("team", "project-new", { workspace_ids: ["a"] });
  render({ tab: "my", activeUid: "missing" }); await settle();
  expect(api.creators).toHaveBeenLastCalledWith("my", "project-new", { workspace_ids: ["a"] }, undefined);
  expect(onFilter).toHaveBeenCalledWith(undefined);
});

it("내 작업은 폴더·미분류 변경을 조회 키에 포함하고 늦은 이전 폴더 집계를 버린다", async () => {
  const old = deferred<Creator[]>();
  vi.mocked(api.creators).mockImplementation(async (_tab, _project, _scope, folder) =>
    folder === "ep/old" ? old.promise : b);
  render({ tab: "my", folderPath: "ep/old" }); await settle();
  render({ projectId: "none", folderPath: "ep/new" }); await settle();
  expect(api.creators).toHaveBeenLastCalledWith("my", "none", { workspace_ids: ["a"] }, "ep/new");
  expect(rows()).toEqual(["B creator9"]);
  old.resolve(a); await settle(); expect(rows()).toEqual(["B creator9"]);
});

it("내 작업 휴지통에서도 일반 생성자 숫자를 조회하지 않으며 선택을 유지", async () => {
  render({ tab: "my", deletedOnly: true, activeUid: "old-creator" }); await settle();
  event(); broadcast(); await settle();
  expect(api.creators).not.toHaveBeenCalled(); expect(onFilter).not.toHaveBeenCalled();
  expect(rows()).toEqual([]); expect(host.textContent).toContain("생성자 필터 해제");
  render({ deletedOnly: false }); await settle(); expect(api.creators).toHaveBeenCalledOnce();
});

it("내 작업의 범위 미지원 응답은 기존 숫자 대신 로컬 업데이트 안내를 보여준다", async () => {
  render({ tab: "my" }); await settle(); expect(rows()).toHaveLength(2);
  vi.mocked(api.creators).mockRejectedValueOnce(new HttpError(409, "scope unavailable"));
  render({ folderPath: "other" }); await settle();
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain("로컬 앱 업데이트");
});

it("언마운트 뒤에는 변경 알림 구독을 제거", async () => {
  render(); await settle();
  expect(broadcastListeners.size).toBe(1);
  act(() => root.render(null));
  const count = vi.mocked(api.creators).mock.calls.length;
  event(); broadcast(); await settle();
  expect(broadcastListeners.size).toBe(0);
  expect(api.creators).toHaveBeenCalledTimes(count);
});

it("공유 휴지통은 일반 건수를 조회하지 않고 기존 생성자 선택을 명시적으로 해제할 수 있다", async () => {
  render({ deletedOnly: true, activeUid: "deleted-only-creator" }); await settle();
  event(); broadcast(); await settle();
  expect(api.creators).not.toHaveBeenCalled();
  expect(onFilter).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain("생성자 필터 해제");
  act(() => host.querySelector("button")!.click());
  expect(onFilter).toHaveBeenCalledWith(undefined);
  render({ activeUid: undefined }); await settle();
  expect(host.textContent).toBe("");
});

it("휴지통 진입 전 늦은 집계를 무시하고 일반 라이브러리 복귀 시 재조회한다", async () => {
  render({ activeUid: "a-mine" }); await settle();
  const delayed = deferred<Creator[]>();
  vi.mocked(api.creators).mockReturnValueOnce(delayed.promise);
  event();
  render({ deletedOnly: true }); await settle();
  delayed.resolve([]); await settle();
  expect(onFilter).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
  render({ deletedOnly: false }); await settle();
  expect(rows()).toEqual(["A mine4", "A other2"]);
  expect(onFilter).not.toHaveBeenCalled();
});

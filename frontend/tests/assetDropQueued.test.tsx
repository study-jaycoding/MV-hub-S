// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), status: vi.fn(), flash: vi.fn(), download: vi.fn(),
  projects: vi.fn(), tree: vi.fn(), meta: vi.fn(), epoch: 0 }));
vi.mock("../src/api", () => ({ api: { uploadAssets: mocks.upload, assetSyncStatus: mocks.status,
  assetProjects: mocks.projects, assetTree: mocks.tree, assetMeta: mocks.meta,
  assetFileUrl: (project: string, path: string) => `/api/assets/file?project=${project}&path=${encodeURIComponent(path)}`,
  assetThumbUrl: (project: string, path: string) => `/api/assets/thumb?project=${project}&path=${encodeURIComponent(path)}`,
} }));
vi.mock("../src/lib/flash", () => ({ flashMsg: mocks.flash }));
vi.mock("../src/lib/download", () => ({ downloadOne: mocks.download }));
vi.mock("../src/app/operationContext", () => ({ captureSubmissionScope: () => {
  const epoch = mocks.epoch;
  return { isCurrent: () => epoch === mocks.epoch, operation: { accountNamespace: "test", serverOrigin: "test", authority: "local", workspaceId: null, sessionEpoch: epoch } };
}, OperationContextChangedError: class extends Error {} }));
import { useAssetDropImport } from "../src/components/assets/useAssetDropImport";
import { LocalImportCards } from "../src/components/assets/LocalImportCards";
import { useAssetProjectData } from "../src/components/assets/useAssetProjectData";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const queued = (id: string) => ({ saved: [], skipped: [], queued: [{ sync_id: id, sync_state: "queued",
  file_path: `asset:imports|${id}.png`, name: `${id}.png`, asset_content_id: `sha256:${id}` }] });
const row = (id: string, state: string) => ({ sync_id: id, state, project_name: "P" });
let root: Root;
let zone: ReturnType<typeof useAssetDropImport>;
let imported: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
function Host({ project = "P" }: { project?: string }) { zone = useAssetDropImport({ project, dir: "refs", onImported: imported }); return null; }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function drop(name: string) {
  await act(async () => {
    zone.onZoneDrop({ preventDefault() {}, dataTransfer: {
      types: ["Files"], files: [new File([name], name, { lastModified: 1 })], items: [],
    } } as never);
    await flush();
  });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("alert", vi.fn());
  mocks.upload.mockReset(); mocks.status.mockReset(); mocks.flash.mockReset(); mocks.epoch = 0;
  mocks.download.mockReset(); mocks.download.mockResolvedValue(true); mocks.projects.mockReset(); mocks.tree.mockReset(); mocks.meta.mockReset(); localStorage.clear();
  mocks.status.mockResolvedValue({ destinations: [] });
  imported = vi.fn(); host = document.createElement("div"); root = createRoot(host);
  act(() => root.render(<Host />));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("queued는 완료로 알리지 않고 ready 확인 뒤 한 번 새로고침한다", async () => {
  mocks.upload.mockResolvedValue(queued("one"));
  mocks.status.mockResolvedValue({ destinations: [row("one", "queued")] });
  await drop("one.png");
  expect(imported).toHaveBeenCalledTimes(1);
  expect(mocks.flash).not.toHaveBeenCalledWith(expect.stringContaining("보관 완료"));
  mocks.status.mockResolvedValue({ destinations: [row("one", "ready")] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(imported).toHaveBeenCalledTimes(2);
  expect(mocks.flash).toHaveBeenLastCalledWith("1건 선택한 폴더에 보관 완료");
  const count = mocks.status.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.status).toHaveBeenCalledTimes(count);
});

it("이전 완료 갱신과 새 반입이 겹쳐도 새 대기 ID를 보존한다", async () => {
  const firstStatus = deferred<{ destinations: ReturnType<typeof row>[] }>();
  const secondUpload = deferred<ReturnType<typeof queued>>();
  const firstRefresh = deferred<void>();
  mocks.upload.mockResolvedValueOnce(queued("one")).mockReturnValueOnce(secondUpload.promise);
  mocks.status.mockReturnValueOnce(firstStatus.promise).mockResolvedValue({ destinations: [row("two", "queued")] });
  imported.mockImplementationOnce(() => undefined).mockImplementationOnce(() => firstRefresh.promise);
  await drop("one.png");
  await drop("two.png");
  await act(async () => { firstStatus.resolve({ destinations: [row("one", "ready")] }); await flush(); });
  expect(imported).toHaveBeenCalledTimes(2);
  await act(async () => {
    secondUpload.resolve(queued("two"));
    await Promise.resolve();
    firstRefresh.resolve();
    await flush();
  });
  mocks.status.mockResolvedValue({ destinations: [row("two", "ready")] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(imported).toHaveBeenCalledTimes(4);
  expect(mocks.flash.mock.calls.filter(([text]) => String(text).includes("보관 완료"))).toHaveLength(2);
});

it("프로젝트를 옮겨 반입해도 앞 프로젝트와 새 프로젝트의 완료를 각각 갱신한다", async () => {
  mocks.upload.mockResolvedValueOnce(queued("one")).mockResolvedValueOnce(queued("two"));
  await drop("one.png");
  act(() => root.render(<Host project="Q" />));
  await drop("two.png");
  imported.mockClear();
  mocks.status.mockResolvedValue({ destinations: [row("one", "ready"), { ...row("two", "ready"), project_name: "Q" }] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(imported.mock.calls).toEqual([["P"], ["Q"]]);
  expect(mocks.flash.mock.calls.filter(([text]) => String(text).includes("보관 완료"))).toHaveLength(2);
});

it.each(["resolve", "reject"])("계정 전환 후 늦은 업로드 %s는 알림·새로고침을 하지 않는다", async (outcome) => {
  const upload = deferred<ReturnType<typeof queued>>();
  mocks.upload.mockReturnValue(upload.promise);
  await drop("one.png"); mocks.epoch++;
  await act(async () => {
    if (outcome === "resolve") upload.resolve(queued("one")); else upload.reject(new Error("offline"));
    await flush();
  });
  expect(imported).not.toHaveBeenCalled(); expect(mocks.flash).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
});

it("계정 전환 뒤 늦게 도착한 ready는 새 화면을 갱신하지 않는다", async () => {
  const status = deferred<{ destinations: ReturnType<typeof row>[] }>();
  mocks.upload.mockResolvedValue(queued("one")); mocks.status.mockReturnValue(status.promise);
  await drop("one.png"); mocks.epoch++;
  await act(async () => { status.resolve({ destinations: [row("one", "ready")] }); await flush(); });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(mocks.flash).not.toHaveBeenCalledWith(expect.stringContaining("보관 완료"));
});

it("목록 갱신을 기다리는 사이 계정이 바뀌면 대기 예약·이전 계정 알림을 보내지 않는다", async () => {
  const refresh = deferred<void>();
  imported.mockReturnValue(refresh.promise); mocks.upload.mockResolvedValue(queued("one"));
  await drop("one.png"); mocks.epoch++;
  await act(async () => { refresh.resolve(); await flush(); });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.flash).not.toHaveBeenCalled();
});

it.each(["failed", "unknown"])("%s 상태는 보관 완료로 알리지 않는다", async (state) => {
  mocks.upload.mockResolvedValue(queued("one")); mocks.status.mockResolvedValue({ destinations: [row("one", state)] });
  await drop("one.png");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(mocks.flash).not.toHaveBeenCalledWith(expect.stringContaining("보관 완료"));
});

it("로컬 카드는 서버 목록 갱신보다 먼저 노출하고 갱신 실패 때 보존한다", async () => {
  const refresh = deferred<void>();
  imported.mockReturnValueOnce(refresh.promise).mockReturnValue(false);
  mocks.upload.mockResolvedValue(queued("one")); mocks.status.mockResolvedValue({ destinations: [row("one", "ready")] });
  await drop("one.png");
  expect(zone.localImports.map(item => item.localPath)).toEqual(["one.png"]);
  await act(async () => { refresh.resolve(); await flush(); });
  expect(zone.localImports).toHaveLength(1);
  expect(mocks.flash).not.toHaveBeenCalledWith(expect.stringContaining("보관 완료"));
  imported.mockReturnValue(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(zone.localImports).toHaveLength(0);
});

it("예약 등록 실패도 로컬 파일은 보존하고 계정 전환 시 숨긴다", async () => {
  mocks.upload.mockResolvedValue({ ...queued("one"), queued: [{ ...queued("one").queued[0], sync_id: undefined, sync_state: "registration_failed" }] });
  await drop("one.png");
  expect(zone.localImports[0]).toMatchObject({ localPath: "one.png", state: "registration_failed" });
  expect(mocks.status).not.toHaveBeenCalled();
  mocks.epoch++;
  await act(async () => { window.dispatchEvent(new Event("storage")); });
  expect(zone.localImports).toHaveLength(0);
});

it("임시 카드의 미리보기·참조 드래그·다운로드는 실제 imports 경로를 사용하며 선택 이벤트를 넘기지 않는다", () => {
  const preview = vi.fn(), parentMouse = vi.fn(), parentKey = vi.fn();
  const item = { id: "one", syncId: "one", project: "ServerProject", dir: "Assets/CH", localPath: "local.png", name: "원본.png",
    type: "image" as const, assetContentId: "sha256:one", state: "registration_failed", current: () => true };
  act(() => root.render(<div onMouseDown={parentMouse} onKeyDown={parentKey}>
    <LocalImportCards items={[item]} onPreview={preview} />
  </div>));
  expect(host.textContent).toContain("보관 예약 실패");
  act(() => host.querySelector<HTMLButtonElement>('.asset-local-thumb')!.click());
  expect(preview.mock.calls[0][0].url).toBe("/api/assets/file?project=imports&path=local.png");
  const transfer = { setData: vi.fn(), effectAllowed: "" };
  const drag = new Event("dragstart", { bubbles: true }); Object.defineProperty(drag, "dataTransfer", { value: transfer });
  act(() => host.querySelector('.asset-local-ref')!.dispatchEvent(drag));
  const payload = JSON.parse(transfer.setData.mock.calls.find(([kind]) => kind === DRAG_TYPES.asset)![1]);
  expect(payload[0]).toMatchObject({ project: "imports", path: "local.png", file_path: "asset:imports|local.png" });
  act(() => host.querySelector<HTMLButtonElement>('.asset-local-actions button')!.click());
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith("/api/assets/file?project=imports&path=local.png", "원본.png", undefined, false,
    expect.objectContaining({ assertCurrent: expect.any(Function), context: expect.objectContaining({ accountNamespace: "test" }) }));
  act(() => {
    host.querySelector('.asset-local-card')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    host.querySelector('.asset-local-thumb')!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }));
  });
  expect(parentMouse).not.toHaveBeenCalled(); expect(parentKey).not.toHaveBeenCalled();
  localStorage.setItem(STORAGE_KEYS.assetsDrag, "another owner");
  act(() => host.querySelector('.asset-local-ref')!.dispatchEvent(new Event("dragend", { bubbles: true })));
  expect(localStorage.getItem(STORAGE_KEYS.assetsDrag)).toBe("another owner");
  act(() => host.querySelector('.asset-local-ref')!.dispatchEvent(drag));
  act(() => root.render(null));
  expect(localStorage.getItem(STORAGE_KEYS.assetsDrag)).toBeNull();
});

it("계정 변경 뒤 아직 화면에 남은 카드는 새 미리보기·드래그·다운로드를 시작하지 않는다", () => {
  let active = true;
  const preview = vi.fn();
  const item = { id: "one", project: "P", dir: "refs", localPath: "local.png", name: "local.png", type: "image" as const,
    assetContentId: "sha256:one", state: "queued", current: () => active };
  act(() => root.render(<LocalImportCards items={[item]} onPreview={preview} />));
  active = false;
  const transfer = { setData: vi.fn(), effectAllowed: "" };
  const drag = new Event("dragstart", { bubbles: true, cancelable: true }); Object.defineProperty(drag, "dataTransfer", { value: transfer });
  act(() => {
    host.querySelector<HTMLButtonElement>('.asset-local-thumb')!.click();
    host.querySelector<HTMLButtonElement>('.asset-local-actions button')!.click();
    host.querySelector('.asset-local-ref')!.dispatchEvent(drag);
  });
  expect(preview).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled(); expect(transfer.setData).not.toHaveBeenCalled();
  expect(drag.defaultPrevented).toBe(true); expect(localStorage.getItem(STORAGE_KEYS.assetsDrag)).toBeNull();
});

it("로컬 카드 다운로드의 문맥 중단 거절은 처리하고 이전 계정 오류 알림은 띄우지 않는다", async () => {
  const download = deferred<boolean>(); mocks.download.mockReturnValue(download.promise);
  let active = true;
  const item = { id: "one", project: "P", dir: "refs", localPath: "local.png", name: "local.png", type: "image" as const,
    assetContentId: "sha256:one", state: "queued", current: () => active };
  act(() => root.render(<LocalImportCards items={[item]} onPreview={() => {}} />));
  act(() => host.querySelector<HTMLButtonElement>('.asset-local-actions button')!.click());
  active = false;
  await act(async () => { download.reject(new Error("context changed")); await flush(); });
  expect(mocks.flash).not.toHaveBeenCalled();
});

it("프로젝트 갱신은 트리·메타 조회 실패를 false로 돌려준다", async () => {
  mocks.projects.mockResolvedValue({ projects: ["P"], default: "P" }); mocks.tree.mockResolvedValue({ children: [] }); mocks.meta.mockResolvedValue({});
  let data!: ReturnType<typeof useAssetProjectData>;
  function DataHost() { data = useAssetProjectData({}); return null; }
  await act(async () => { root.render(<DataHost />); await flush(); });
  let success: boolean | undefined;
  await act(async () => { success = await data.refreshProjectData("P", true); });
  expect(success).toBe(true);
  mocks.tree.mockRejectedValueOnce(new Error("tree unavailable"));
  await act(async () => { success = await data.refreshProjectData("P", true); });
  expect(success).toBe(false);
  mocks.meta.mockRejectedValueOnce(new Error("metadata unavailable"));
  await act(async () => { success = await data.refreshProjectData("P", true); });
  expect(success).toBe(false);
});

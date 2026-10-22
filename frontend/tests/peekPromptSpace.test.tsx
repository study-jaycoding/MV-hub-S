// @vitest-environment jsdom
// 캔버스 '생성 결과' 창의 선택 막대에도 Draft 단추(Jay 2026-10-22 — 창에서 Draft 생성물을 골라도 Draft 메뉴가 안 나왔다: 창의 막대에 처리기가
// 넘어가지 않았다). 캔버스 선택 막대와 같은 처리·바쁨/완료 표시. 폴더 창 공간 분리는 App 전체가 얽혀 실제 크롬으로 확인한다.
// 계정 메뉴의 '워크스페이스 잔액' 칸 → 대시보드는 여기서 본다(격리 서버엔 크레딧 정보가 없어 그 칸이 안 그려진다).
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/components/AccountMenu";
import { SceneVariantPopup, type VariantDraftControls } from "../src/components/scene/SceneVariantPopup";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, _ref) => <>{props.data.map(props.children)}</>) };
});
vi.mock("../src/api", () => ({ api: {
  thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path, prefetchGenComments: () => {},
  workspaces: () => Promise.resolve([{ id: "ws-me", name: null, plan_type: "team", credits: 1200, is_selected: true, user_role: "owner" }]),
  projects: () => Promise.resolve({ projects: [] }),
} }));
vi.mock("../src/components/ManageAccount", () => ({ ManageAccount: () => <div className="manage-float" /> }));
vi.mock("../src/components/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/useOutsideDragSelect", () => ({ useOutsideDragSelect: () => {} }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));

const noop = () => {};
const generation = (id: string, draft: boolean): Generation => ({
  id, worker_id: "worker", worker_name: null, prompt: id, display_prompt: null, model: draft ? "seedance_2_5" : "nano_banana_flash",
  params: draft ? { draft: true } : {}, job_id: `job-${id}`, color: null,
  status: "done", error: null, created_at: "2026-10-22 00:00:00", tags: [], auto_tags: [], references: [],
  assets: [{ id: `asset-${id}`, generation_id: id, type: draft ? "video" : "image", file_path: `/${id}.mp4`, thumbnail_path: null, source_url: null, cached: true }],
  shared: false, parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0, has_unread: false,
  local_only: false, creator_uid: null, creator_name: null, is_mine: true, workspace_scope: "personal", workspace_id: null,
  workspace_name: null, project_id: null, deleted: false,
} as Generation);
const gens = [generation("d", true), generation("n", false)];
let root: Root;
let host: HTMLDivElement;

function props(selected: string[], variantDraft?: VariantDraftControls): ComponentProps<typeof SceneVariantPopup> {
  return {
    card: { id: "card", kind: "generation", genId: "d", genIds: ["d", "n"], x: 0, y: 0 }, total: 2, sceneId: "scene",
    generations: gens, dimIds: new Set(), disabledIds: new Set(), projects: [], autoTagOptions: [],
    view: { scale: 1, layout: "grid", groupByDate: false, fill: true },
    ui: { selectedIds: new Set(selected), setSelected: noop, resolveHighlightedIds: new Set(), scrollRequest: null, gripDragging: false, setGripDragging: noop },
    gen: { onBulkTags: noop, onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop },
    actions: { setCardMenu: noop, setCardVariant: noop, pruneVariants: noop, latestCard: () => undefined, variantDraft },
  };
}
const render = (selected: string[], variantDraft?: VariantDraftControls) =>
  act(() => root.render(<SceneVariantPopup {...props(selected, variantDraft)} />));
const draftButton = () => host.querySelector<HTMLButtonElement>(".folder-peek-selbar .sb-draft");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("Draft 생성물 하나를 고르면 창의 선택 막대에 Draft 단추 — 누르면 캔버스 선택 막대와 같은 처리로 간다", () => {
  const finish = vi.fn();
  render(["d"], { finish, busy: () => false, done: () => false });
  expect(draftButton()).not.toBeNull();
  act(() => { draftButton()!.click(); });
  expect(finish).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }));
});

it("Draft 가 아니거나 둘을 고르면 단추가 없고, 처리기를 안 넘기면(예전) 단추가 없다", () => {
  const controls = { finish: vi.fn(), busy: () => false, done: () => false };
  render(["n"], controls);
  expect(draftButton()).toBeNull();
  render(["d", "n"], controls);
  expect(draftButton()).toBeNull();
  render(["d"]);
  expect(draftButton()).toBeNull();
});

it("요청 중·이미 만든 Draft 는 단추가 잠긴다(캔버스 선택 막대와 같은 표시)", () => {
  render(["d"], { finish: vi.fn(), busy: (id) => id === "d", done: () => false });
  expect(draftButton()?.disabled).toBe(true);
  render(["d"], { finish: vi.fn(), busy: () => false, done: (id) => id === "d" });
  expect(draftButton()?.disabled).toBe(true);
});

async function openAccountMenu(onOpenManage?: () => void) {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  await act(async () => root.render(
    <AccountMenu provider={null} onProviderUpdated={noop} onWorkspaceSwitched={noop} onWorkspaceContextChange={noop}
      workspaceContext={{ scope: "personal", id: null, name: null }} onOpenManage={onOpenManage} />,
  ));
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  await act(async () => {}); // 메뉴를 열 때의 목록 조회
  return document.querySelector<HTMLElement>(".acct-pop .acct-credits")!;
}

it("잔액 칸을 누르면(Enter 포함) 대시보드를 열고 메뉴를 닫는다 · 머리를 누르면 '내 계정'", async () => {
  const openManage = vi.fn();
  const credits = await openAccountMenu(openManage);
  expect(credits.getAttribute("role")).toBe("button");
  act(() => { credits.click(); });
  expect(openManage).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".acct-pop")).toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  act(() => { document.querySelector(".acct-pop .acct-credits")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(openManage).toHaveBeenCalledTimes(2);
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  act(() => { document.querySelector<HTMLElement>(".acct-pop .acct-head-btn")!.click(); });
  expect(document.querySelector(".manage-float")).not.toBeNull();
});

it("대시보드를 쓸 수 없는 계정은 잔액 칸이 눌리지 않는다", async () => {
  const credits = await openAccountMenu();
  expect(credits).not.toBeNull();
  expect(credits.getAttribute("role")).toBeNull();
  expect(credits.classList.contains("acct-credits-btn")).toBe(false);
});

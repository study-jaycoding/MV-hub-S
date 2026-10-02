// @vitest-environment jsdom
// 관리자 창 탭(2026-10-02) — 탭 순서, '업데이트' 탭이 업데이트 관리를 그리고 '공유 서버' 탭에서는 빠졌는지,
// '프로젝트' 탭이 창을 넓히고(wide) 프로젝트 대화상자가 열린 동안 Esc 는 대화상자만 닫는지(입력 보존).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sharedServerStatus: vi.fn(), members: vi.fn(), listAccounts: vi.fn(),
  projects: vi.fn(), allProjectMembers: vi.fn(), projectFolderLinks: vi.fn(), workspaceOptions: vi.fn(),
  workspaceMembers: vi.fn(), creditPlanSettings: vi.fn(),
  adminList: vi.fn(), latestRelease: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
vi.mock("../src/lib/useManageCaps", () => ({
  useManageCaps: () => ({ loaded: true, authOff: false, system: true, createProject: true, grantRole: true, readAll: true }),
}));
vi.mock("../src/lib/updateNotices", () => ({ updateNoticeApi: { adminList: mocks.adminList } }));
vi.mock("../src/lib/releaseUpdate", () => ({ getLatestReleaseMetadata: mocks.latestRelease }));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
// 백업 위치 확인창은 '열림·닫힘' 신호만 흉내 낸다 — 관리자 창이 그 신호로 Esc·바깥 클릭을 넘기는지 본다
vi.mock("../src/components/admin/BackupReplicaSection", () => ({
  BackupReplicaSection: ({ onDialogOpenChange }: { onDialogOpenChange?: (open: boolean) => void }) => (
    <span>
      <button className="fake-backup-open" onClick={() => onDialogOpenChange?.(true)}>open</button>
      <button className="fake-backup-close" onClick={() => onDialogOpenChange?.(false)}>close</button>
    </span>
  ),
}));
vi.mock("../src/components/admin/AssetRegistryTab", () => ({ AssetRegistryTab: () => null }));

import { AdminWindow } from "../src/components/AdminWindow";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.sharedServerStatus.mockResolvedValue({
    url: "http://server:8010", server_name: "MV", is_admin: true, elevated: false, elevated_as: null, super_admin_expires_at: null,
  });
  mocks.members.mockResolvedValue([{ uid: "user_jay", name: "Jay", email: "jay@mv.com", global_roles: ["admin", "product_manager"] }]);
  mocks.listAccounts.mockResolvedValue([]);
  mocks.projects.mockResolvedValue({ projects: [{ id: "p", name: "뻘뻘뻘", workspace_id: "ws", workspace_name: "WS", kind: "team" }] });
  mocks.allProjectMembers.mockResolvedValue({});
  mocks.projectFolderLinks.mockResolvedValue({ links: {} });
  mocks.workspaceOptions.mockResolvedValue({ workspaces: [{ id: "ws", name: "WS", member_count: 0 }] });
  mocks.workspaceMembers.mockResolvedValue({ members: [] });
  mocks.creditPlanSettings.mockReturnValue(new Promise(() => {})); // 크레딧 칸은 '불러오는 중' 그대로 둔다
  mocks.adminList.mockResolvedValue([
    { id: "n1", version: "2026.10.01-0906", file: "MVHub-2026.10.01-0906.zip", released_at: "", pinned: false,
      announcement_revision: 1, announced_at: null, unread: false, sha256: "aaa" },
  ]);
  mocks.latestRelease.mockResolvedValue({ version: "2026.10.03-1420", sha256: "bbb" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (onClose = vi.fn()) => {
  await act(async () => {
    root.render(<AdminWindow account={{ email: "jay@mv.com", creator_uid: "user_jay" } as never} localHub onClose={onClose} />);
  });
  await settle();
  return onClose;
};
const tabLabels = () => [...host.querySelectorAll(".admin-tab")].map((b) => b.textContent);
const clickTab = async (label: string) => {
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".admin-tab")].find((b) => b.textContent === label)!.click(); });
  await settle();
};
const pressEscape = async () => {
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
};

it("관리자에게 탭이 정해진 순서로 보인다", async () => {
  await mount();
  expect(tabLabels()).toEqual(["승인", "멤버 · 전역 역할", "공유 서버", "업데이트", "프로젝트", "에셋 리스트"]);
});

it("업데이트 관리는 '업데이트' 탭에만 있고, 그 탭을 열 때 읽는다", async () => {
  await mount();
  await clickTab("공유 서버");
  expect(host.textContent).toContain("공유 서버 이름·주소");
  expect(host.textContent).not.toContain("업데이트 관리");
  expect(mocks.adminList).not.toHaveBeenCalled();
  await clickTab("업데이트");
  expect(mocks.adminList).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("업데이트 관리");
  expect(host.textContent).toContain("최신 업데이트 v2026.10.03-1420 등록");
  expect(host.textContent).toContain("v2026.10.01-0906");
  expect(host.textContent).toContain("재공지");
});

it("프로젝트 탭은 창을 넓히고 프로젝트 목록을 창 안에 그린다(옛 오버레이 없음)", async () => {
  await mount();
  const win = host.querySelector(".admin-window")!;
  expect(win.classList.contains("wide")).toBe(false);
  await clickTab("프로젝트");
  expect(win.classList.contains("wide")).toBe(true);
  expect(win.textContent).toContain("뻘뻘뻘");
  expect(host.querySelector(".manage-proj-overlay")).toBeNull();
  await clickTab("업데이트");
  expect(win.classList.contains("wide")).toBe(false);
});

it("프로젝트 대화상자가 열려 있으면 Esc 는 대화상자만 닫고, 다음 Esc 에 관리자 창이 닫힌다", async () => {
  const onClose = await mount();
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-add")!.click(); });
  await settle();
  expect(host.querySelector(".admin-project-dialog")).not.toBeNull();
  await pressEscape();
  expect(host.querySelector(".admin-project-dialog")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("백업 위치 확인창이 열려 있으면 Esc·바깥 클릭이 관리자 창을 닫지 않는다(입력하던 비밀번호 보존)", async () => {
  const onClose = await mount();
  await clickTab("공유 서버");
  await act(async () => { host.querySelector<HTMLButtonElement>(".fake-backup-open")!.click(); });
  await pressEscape();
  await act(async () => { host.querySelector(".admin-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { host.querySelector<HTMLButtonElement>(".fake-backup-close")!.click(); });
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

// @vitest-environment jsdom
// 조작 점검 7회차(2026-10-11) — R13 관리자 창: 멤버 칸·글 칸에서 누른 Esc 가 관리자 창을 통째로 닫았다.
//  · 글 칸(멤버 검색·공유 서버 이름/주소)의 Esc 는 칸을 벗어나기만 한다 — 한 번 더 누르면 창이 닫힌다(적던 글이 남는다).
//  · 프로젝트 탭의 👥 멤버 칸은 겹이다 — Esc 는 그 칸만 닫는다(멤버 추가 창 → 멤버 칸 → 관리자 창 순서).
//  · 머리의 🔑 확인 창도 따로 겹이다 — 멤버 칸이 열린 채 띄워도 Esc 는 앞의 확인 창부터 닫는다.
// 틀은 tests/adminWindowTabs.test.tsx 와 같다(실제 AdminWindow 를 붙인다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";

const mocks = vi.hoisted(() => ({
  sharedServerStatus: vi.fn(), members: vi.fn(), listAccounts: vi.fn(),
  projects: vi.fn(), allProjectMembers: vi.fn(), projectMembers: vi.fn(), projectFolderLinks: vi.fn(), workspaceOptions: vi.fn(),
  workspaceMembers: vi.fn(), creditPlanSettings: vi.fn(),
  adminList: vi.fn(), latestRelease: vi.fn(), packages: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
vi.mock("../src/lib/useManageCaps", () => ({
  useManageCaps: () => ({ loaded: true, authOff: false, system: true, createProject: true, grantRole: true, readAll: true }),
}));
vi.mock("../src/lib/updateNotices", () => ({
  updateNoticeApi: { adminList: mocks.adminList, adminItem: () => Promise.reject(new HttpError(404, "404", "업데이트 항목이 없습니다")) },
}));
vi.mock("../src/lib/releaseUpdate", () => ({
  getLatestReleaseMetadata: mocks.latestRelease,
  listReleasePackages: mocks.packages,
  getReleaseUpdateStatus: () => Promise.resolve({ install_mode: "release", current_version: "", state: "up_to_date" }),
}));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
vi.mock("../src/components/admin/BackupReplicaSection", () => ({ BackupReplicaSection: () => null }));
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
  mocks.projectMembers.mockResolvedValue([]);
  mocks.projectFolderLinks.mockResolvedValue({ links: {} });
  mocks.workspaceOptions.mockResolvedValue({ workspaces: [{ id: "ws", name: "WS", member_count: 0 }] });
  mocks.workspaceMembers.mockResolvedValue({ members: [] });
  mocks.creditPlanSettings.mockReturnValue(new Promise(() => {}));
  mocks.adminList.mockResolvedValue([]);
  mocks.latestRelease.mockResolvedValue(null);
  mocks.packages.mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => {
  const onClose = vi.fn();
  await act(async () => {
    root.render(<AdminWindow account={{ email: "jay@mv.com", creator_uid: "user_jay" } as never} localHub onClose={onClose} />);
  });
  await settle();
  return onClose;
};
const clickTab = async (label: string) => {
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".admin-tab")].find((b) => b.textContent === label)!.click(); });
  await settle();
};
// 실제 키처럼 초점이 놓인 자리에서 난다.
const pressEscape = async () => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
};
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("멤버 검색칸의 Esc 는 칸을 벗어나기만 한다 — 검색어는 남고, 한 번 더 누르면 창이 닫힌다", async () => {
  const onClose = await mount();
  await clickTab("멤버 · 전역 역할");
  const search = host.querySelector<HTMLInputElement>(".member-search input")!;
  type(search, "jay");
  await pressEscape();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(search);
  expect(search.value).toBe("jay");
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

// STAGE2-WEB-HIDDEN: '공유 서버' 탭을 숨겨 닿지 못한다 — 탭 코드를 지우는 커밋에서 함께 지운다.
it.skip("공유 서버 이름·주소 칸의 Esc 도 같다 — 저장 안 한 글이 창과 함께 사라지지 않는다", async () => {
  const onClose = await mount();
  await clickTab("공유 서버");
  const name = host.querySelector<HTMLInputElement>('input[placeholder^="서버 이름"]')!;
  const address = host.querySelector<HTMLInputElement>('input[placeholder^="예: http"]')!;
  type(name, "새 이름");
  type(address, "http://new:8010");
  await pressEscape(); // 주소 칸에서
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(address);
  expect(name.value).toBe("새 이름"); // 첫 Esc 는 칸을 벗어나기만 — 적던 글은 둘 다 남는다
  expect(address.value).toBe("http://new:8010");
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("👥 멤버 칸이 열려 있으면 Esc 는 그 칸만 닫는다 — 멤버 추가 창 → 멤버 칸 → 관리자 창 순서", async () => {
  const onClose = await mount();
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
  await settle();
  expect(host.querySelector(".project-members-panel")).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>(".project-member-add-button")!.click(); });
  await settle();
  expect(host.querySelector(".project-member-add-dialog")).not.toBeNull();

  await pressEscape(); // 멤버 추가 창(검색칸에 초점)
  expect(host.querySelector(".project-member-add-dialog")).toBeNull();
  expect(host.querySelector(".project-members-panel")).not.toBeNull();
  await pressEscape(); // 멤버 칸
  expect(host.querySelector(".project-members-panel")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pressEscape(); // 관리자 창
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("멤버 칸이 열린 채 🔑 확인을 띄우면 Esc 는 앞의 확인 창부터 닫는다 — 뒤의 멤버 칸은 그대로다", async () => {
  const onClose = await mount();
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
  await settle();
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-key")!.click(); });
  await settle();
  expect(host.querySelector(".admin-elev")).not.toBeNull();

  await pressEscape(); // 확인 창(비밀번호 칸에 초점)
  expect(host.querySelector(".admin-elev")).toBeNull();
  expect(host.querySelector(".project-members-panel")).not.toBeNull();
  await pressEscape(); // 멤버 칸
  expect(host.querySelector(".project-members-panel")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pressEscape(); // 관리자 창
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("글 칸 밖(단추·빈 곳)의 Esc 는 전처럼 바로 창을 닫는다", async () => {
  const onClose = await mount();
  await clickTab("멤버 · 전역 역할");
  act(() => host.querySelector<HTMLButtonElement>(".role-chip")!.focus());
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

// ── 승인 확인 창 + 🔑 확인 창(2026-10-11 Codex 리뷰) ──
//  둘은 같은 층(z-index 300)이고 승인 확인 창이 문서에서 뒤라 화면에서는 🔑 창 위에 보인다. 🔑 를 따로 겹으로 뺀 뒤로는 Esc 가
//  앞의 승인 확인 창을 두고 🔑 만 닫았다(🔑 를 연 채 Tab 으로 뒤의 '비밀번호 초기화'를 눌러 띄우는 길).
const withAccount = () => mocks.listAccounts.mockResolvedValue([{ email: "a@mv.com", name: "A", status: "approved", hidden: false }]);
const click = async (selector: string) => {
  await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
  await settle();
};
const approval = () => host.querySelector(".admin-confirm:not(.admin-elev)");

it.each([
  ["🔑 를 먼저 열고 승인 확인 창을", [".admin-key", ".admin-mini-btn"]],
  ["승인 확인 창을 먼저 열고 🔑 를", [".admin-mini-btn", ".admin-key"]],
  // STAGE2-WEB-HIDDEN: ["(공유 서버 탭) 🔑 를 먼저 열고 공지 확인 창을", [".admin-key", '.settings-action[title^="저장된 이름"]'], "공유 서버"],
])("%s 띄워도 Esc 는 화면에서 앞에 있는 승인 확인 창부터 닫는다 — 그다음 🔑, 그다음 창", async (_order, [first, second], tabLabel) => {
  withAccount();
  const onClose = await mount();
  if (tabLabel) await clickTab(tabLabel as string);
  await click(first);
  await click(second);
  expect(approval()).not.toBeNull();
  expect(host.querySelector(".admin-elev")).not.toBeNull();

  await pressEscape();
  expect(approval()).toBeNull();
  expect(host.querySelector(".admin-elev")).not.toBeNull();
  await pressEscape();
  expect(host.querySelector(".admin-elev")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
const tabStops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled"));
const tab = () => {
  const from = document.activeElement as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { from.dispatchEvent(event); });
  if (!event.defaultPrevented) {
    const all = tabStops();
    // 초점이 Tab 자리가 아니면(창의 뿌리) 문서 순서로 그 뒤의 첫 자리
    const next = all.includes(from) ? all[all.indexOf(from) + 1] : all.find((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
    act(() => (next ?? all[0]).focus());
  }
  return document.activeElement as HTMLElement;
};

it.each([
  ["🔑 확인 창", ".admin-key", ".admin-elev"],
  ["승인 확인 창", ".admin-mini-btn", ".admin-confirm:not(.admin-elev)"],
])("%s이 떠 있는 동안 Tab 은 그 창 안에서만 돈다 — 뒤의 단추에 닿아 다른 확인 창을 겹쳐 띄우지 못한다. 닫으면 연 단추로 돌아간다", async (_name, opener, dialog) => {
  withAccount();
  await mount();
  const button = host.querySelector<HTMLButtonElement>(opener)!;
  act(() => button.focus());
  await click(opener);
  const box = host.querySelector<HTMLElement>(dialog)!;
  expect(box.contains(document.activeElement)).toBe(true);
  const visited = Array.from({ length: 20 }, tab);
  expect(visited.filter((at) => !box.contains(at)).map((at) => at.className || at.tagName)).toEqual([]);
  await pressEscape();
  expect(host.querySelector(dialog)).toBeNull();
  expect(document.activeElement).toBe(button);
});

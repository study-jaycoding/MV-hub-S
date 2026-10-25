// @vitest-environment jsdom
// 관리자 창 탭(2026-10-02) — 탭 순서, '업데이트' 탭이 업데이트 관리를 그리는지('공유 서버' 탭은 2026-10-23 서버 관리 창으로 옮겨 없앰),
// '프로젝트' 탭이 창을 넓히고(wide) 프로젝트 대화상자가 열린 동안 Esc 는 대화상자만 닫는지(입력 보존).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

const mocks = vi.hoisted(() => ({
  sharedServerStatus: vi.fn(), members: vi.fn(), listAccounts: vi.fn(),
  projects: vi.fn(), allProjectMembers: vi.fn(), projectFolderLinks: vi.fn(), workspaceOptions: vi.fn(),
  workspaceMembers: vi.fn(), creditPlanSettings: vi.fn(),
  adminList: vi.fn(), latestRelease: vi.fn(), packages: vi.fn(),
  setMemberGlobalRoles: vi.fn(), projectMembers: vi.fn(), setProjectRoles: vi.fn(),
  getPlanning: vi.fn(), projectFolder: vi.fn(), setAccountStatus: vi.fn(),
  reorderProjects: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), sharedServerDeElevate: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
vi.mock("../src/lib/useManageCaps", () => ({
  useManageCaps: () => ({ loaded: true, authOff: false, system: true, createProject: true, grantRole: true, readAll: true }),
}));
vi.mock("../src/lib/updateNotices", () => ({
  // 표지·후보의 공지를 단건으로도 찾는다(목록 밖) — 여기서는 "아직 등록 안 됨"(404)
  updateNoticeApi: { adminList: mocks.adminList, adminItem: () => Promise.reject(new HttpError(404, "404", "업데이트 항목이 없습니다")) },
}));
vi.mock("../src/lib/releaseUpdate", () => ({
  getLatestReleaseMetadata: mocks.latestRelease,
  listReleasePackages: mocks.packages, // 줄 = NAS 의 모든 판(2026-10-05)
  // 업데이트 탭이 이 PC 판을 함께 읽는다(후보 먼저 설치 단추, 2026-10-03).
  getReleaseUpdateStatus: () => Promise.resolve({ install_mode: "release", current_version: "", state: "up_to_date" }),
}));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
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
  mocks.latestRelease.mockResolvedValue({
    version: "2026.10.03-1420", file: "MVHub-2026.10.03-1420.zip", sha256: "bbb", size: 1, created_at: "", source: "candidate",
    candidate_error: null, published: { version: "2026.10.01-0906", sha256: "aaa", file: "MVHub-2026.10.01-0906.zip" },
    published_state: "ok", pending: true,
  });
  mocks.packages.mockResolvedValue(["2026.10.03-1420", "2026.10.01-0906"].map((version) =>
    ({ file: `MVHub-${version}.zip`, version, size: 1, modified: "" })));
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

it("관리자에게 탭이 정해진 순서로 보인다 — '공유 서버' 탭은 서버 관리 창으로 옮겨 없앴다(2단계)", async () => {
  await mount();
  expect(tabLabels()).toEqual(["승인", "멤버 · 전역 역할", "프로젝트", "에셋 리스트", "업데이트"]);
});

it("'업데이트' 탭은 열 때 읽고, 팀 배포 단추 없이 [이 PC에 먼저 설치]만 둔다(팀 배포는 서버 관리 창 [릴리스])", async () => {
  await mount();
  expect(mocks.adminList).not.toHaveBeenCalled();
  await clickTab("업데이트");
  expect(mocks.adminList).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("업데이트 관리");
  expect(host.textContent).toContain("서버 관리 창 [릴리스]");
  expect(mocks.packages).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("v2026.10.03-1420");
  expect(host.textContent).toContain("새 후보 · 배포 전");
  expect(host.textContent).toContain("v2026.10.01-0906");
  const labels = [...host.querySelectorAll(".admin-update-row button")].map((b) => b.textContent);
  expect(labels).toEqual(["이 PC에 먼저 설치"]);
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

// ── 12회차(조작 규칙 39): 처리 중인 저장은 다시 받지 않는다. 역할 저장은 역할 목록 전체를 덮어쓰고 응답은 멤버 목록 전체를 갈아 끼운다 ──
it("전역 역할 — 한 멤버를 저장하는 동안에는 모든 멤버의 칩이 잠긴다(다른 멤버를 눌러 잠금을 옮길 수 없다)", async () => {
  const members = [
    { uid: "user_jay", name: "Jay", email: "jay@mv.com", global_roles: ["admin", "product_manager"] },
    { uid: "user_b", name: "B", email: "b@mv.com", global_roles: [] },
  ];
  mocks.members.mockResolvedValue(members);
  let finish!: (value: unknown) => void;
  mocks.setMemberGlobalRoles.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await mount();
  await clickTab("멤버 · 전역 역할");
  const chips = () => [...host.querySelectorAll<HTMLButtonElement>(".admin-table .role-chip")];
  const rowChips = (email: string) =>
    [...[...host.querySelectorAll("tr")].find((row) => row.textContent?.includes(email))!.querySelectorAll<HTMLButtonElement>(".role-chip")];
  expect(chips().length).toBeGreaterThan(2);
  expect(chips().some((chip) => chip.disabled)).toBe(false);
  await act(async () => { rowChips("b@mv.com")[0].click(); });
  expect(mocks.setMemberGlobalRoles).toHaveBeenCalledTimes(1);
  expect(chips().every((chip) => chip.disabled)).toBe(true); // 누른 멤버만이 아니라 전부 — 전엔 Jay 의 칩이 열려 있어 잠금이 옮겨 갔다
  await act(async () => { rowChips("jay@mv.com")[0].click(); rowChips("b@mv.com")[1].click(); });
  expect(mocks.setMemberGlobalRoles).toHaveBeenCalledTimes(1);
  await act(async () => { finish(members); });
  await settle();
  expect(chips().some((chip) => chip.disabled)).toBe(false);
});

it("프로젝트 역할 — 저장 중에는 멤버를 바꾸는 단추(역할 칩·✕·+ 추가)가 전부 잠기고, 멤버 칸을 닫았다 열어도 잠겨 있다", async () => {
  const projectMembers = [{ uid: "u1", name: "A", roles: ["creator"] }, { uid: "u2", name: "B", roles: [] }];
  mocks.projectMembers.mockResolvedValue(projectMembers);
  let finish!: (value: unknown) => void;
  mocks.setProjectRoles.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await mount();
  await clickTab("프로젝트");
  const toggleMembers = async () => {
    await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
    await settle();
  };
  await toggleMembers();
  const changers = () =>
    [...host.querySelectorAll<HTMLButtonElement>(".project-members-panel :is(.role-chip, .project-member-remove, .project-member-add-button)")];
  expect(changers().length).toBeGreaterThan(4);
  expect(changers().some((button) => button.disabled)).toBe(false);
  await act(async () => { host.querySelector<HTMLButtonElement>(".project-members-panel .role-chip")!.click(); });
  expect(mocks.setProjectRoles).toHaveBeenCalledTimes(1);
  expect(changers().every((button) => button.disabled)).toBe(true); // 전엔 칩이 열려 있어, 하나 더 누르면 낡은 목록으로 덮어 먼저 준 역할이 사라졌다
  await toggleMembers(); // 닫고
  expect(host.querySelector(".project-members-panel")).toBeNull();
  await toggleMembers(); // 다시 연다 — 새로 만들어진 칸도 잠겨 있다
  expect(changers().length).toBeGreaterThan(4);
  expect(changers().every((button) => button.disabled)).toBe(true);
  await act(async () => { finish(projectMembers); });
  await settle();
  expect(changers().some((button) => button.disabled)).toBe(false);
});

it("프로젝트 역할 — 저장 중에 다른 탭을 다녀와도 잠겨 있고, 끝나면 멤버 칸을 새로 읽는다(응답은 사라진 패널이 받았다)", async () => {
  // Codex 코드 리뷰: 탭을 바꾸면 프로젝트 패널이 통째로 새로 만들어진다 — 잠금이 패널의 state 면 그때 풀리고, 새로 읽은 목록은 반영 전의 것일 수 있다.
  const before = [{ uid: "u1", name: "A", roles: ["creator"] }];
  const after = [{ uid: "u1", name: "A", roles: ["creator", "supervisor"] }];
  mocks.projectMembers.mockResolvedValue(before);
  let finish!: (value: unknown) => void;
  mocks.setProjectRoles.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await mount();
  await clickTab("프로젝트");
  const toggleMembers = async () => {
    await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
    await settle();
  };
  const chips = () => [...host.querySelectorAll<HTMLButtonElement>(".project-members-panel .role-chip")];
  await toggleMembers();
  await act(async () => { chips().find((chip) => !chip.classList.contains("on"))!.click(); }); // 역할 하나를 더 준다 — 응답이 안 온다
  expect(mocks.setProjectRoles).toHaveBeenCalledTimes(1);
  await clickTab("에셋 리스트");
  await clickTab("프로젝트"); // 패널이 새로 만들어졌다
  await toggleMembers(); // 서버는 아직 반영 전의 목록을 준다
  expect(chips().length).toBeGreaterThan(0);
  expect(chips().every((chip) => chip.disabled)).toBe(true);
  expect(chips().filter((chip) => chip.classList.contains("on"))).toHaveLength(1);
  mocks.projectMembers.mockResolvedValue(after);
  const reads = mocks.projectMembers.mock.calls.length;
  await act(async () => { finish(after); });
  await settle();
  expect(mocks.projectMembers.mock.calls.length).toBe(reads + 1); // 끝난 것을 보고 다시 읽었다
  expect(chips().some((chip) => chip.disabled)).toBe(false);
  expect(chips().filter((chip) => chip.classList.contains("on"))).toHaveLength(2); // 방금 저장된 역할이 보인다 — 여기서 누른 것이 그것을 덮지 않는다
});

it("역할 저장은 화면의 목록이 아니라 서버의 지금 값에 '바꾼 것만' 얹는다 — 화면이 낡았어도 그사이 저장된 역할을 지우지 않는다", async () => {
  // Codex 코드 리뷰(세 번): 잠금은 화면과 같이 사라진다(탭 왕복·창 닫았다 열기·다시 읽기 전의 틈·열 때 먼저 보이는 캐시).
  //  그래서 잠금에 기대지 않는다 — 저장은 한 줄로 서고(lib/saveQueue), 차례가 오면 지금 값을 읽어 거기서 계산한다.
  const stale = [
    { uid: "user_jay", name: "Jay", email: "jay@mv.com", global_roles: ["admin", "product_manager"] },
    { uid: "user_b", name: "B", email: "b@mv.com", global_roles: [] },
  ];
  const fresh = [stale[0], { ...stale[1], global_roles: ["production_director"] }]; // 그사이 Director 가 저장됐다(화면에는 아직 없다)
  mocks.members.mockResolvedValueOnce(stale).mockResolvedValue(fresh);
  mocks.setMemberGlobalRoles.mockImplementation(async (_uid: string, roles: string[]) => [stale[0], { ...stale[1], global_roles: roles }]);
  await mount();
  await clickTab("멤버 · 전역 역할");
  const globalChips = () => [...[...host.querySelectorAll("tr")].find((row) => row.textContent?.includes("b@mv.com"))!.querySelectorAll<HTMLButtonElement>(".role-chip")];
  const lit = (chips: HTMLButtonElement[]) => chips.filter((button) => button.classList.contains("on")).map((button) => button.textContent);
  expect(lit(globalChips())).toEqual([]);
  await act(async () => { globalChips().find((button) => button.textContent === "Member")!.click(); });
  await settle();
  expect(mocks.setMemberGlobalRoles).toHaveBeenCalledExactlyOnceWith("user_b", ["production_director", "member"]); // 전엔 ["member"] — Director 가 지워졌다
  expect(lit(globalChips())).toEqual(["Director", "Member"]);
  mocks.members.mockResolvedValue([stale[0], { ...stale[1], global_roles: ["member"] }]); // Director 는 그사이 다른 곳에서 빠졌다
  await act(async () => { globalChips().find((button) => button.textContent === "Director")!.click(); }); // 빼려던 것이 이미 없다
  await settle();
  expect(mocks.setMemberGlobalRoles).toHaveBeenCalledTimes(1); // 저장을 보내지 않고 화면만 맞춘다
  expect(lit(globalChips())).toEqual(["Member"]);

  // 프로젝트 역할도 같다
  const before = [{ uid: "u1", name: "A", roles: ["creator"] }];
  mocks.projectMembers.mockResolvedValueOnce(before).mockResolvedValue([{ uid: "u1", name: "A", roles: ["creator", "project_manager"] }]); // 그사이 PM 이 저장됐다
  mocks.setProjectRoles.mockImplementation(async (_pid: string, _uid: string, roles: string[]) => [{ uid: "u1", name: "A", roles }]);
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
  await settle();
  const projectChips = () => [...host.querySelectorAll<HTMLButtonElement>(".project-members-panel .role-chip")];
  const pressProject = async (label: string) => {
    await act(async () => { projectChips().find((button) => button.textContent === label)!.click(); });
    await settle();
  };
  expect(lit(projectChips())).toEqual(["Creator"]);
  await pressProject("Supervisor");
  expect(mocks.setProjectRoles).toHaveBeenCalledExactlyOnceWith("p", "u1", ["creator", "project_manager", "supervisor"]); // 전엔 ["creator", "supervisor"]
  expect(lit(projectChips())).toEqual(["PM", "Supervisor", "Creator"]);

  // 빼려던 것이 서버에 이미 없으면 저장을 보내지 않고 화면만 맞춘다
  mocks.projectMembers.mockResolvedValue([{ uid: "u1", name: "A", roles: ["creator", "supervisor"] }]);
  await pressProject("PM");
  expect(mocks.setProjectRoles).toHaveBeenCalledTimes(1);
  expect(lit(projectChips())).toEqual(["Supervisor", "Creator"]);
});

it("지금 값을 읽는 사이에 계정이 바뀌면 그 역할 저장은 보내지 않는다(새 계정의 이름으로 나가지 않게)", async () => {
  const list = [
    { uid: "user_jay", name: "Jay", email: "jay@mv.com", global_roles: ["admin", "product_manager"] },
    { uid: "user_b", name: "B", email: "b@mv.com", global_roles: [] },
  ];
  let finishRead!: (value: unknown) => void;
  mocks.members.mockResolvedValueOnce(list).mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
  await mount();
  await clickTab("멤버 · 전역 역할");
  const chips = () => [...[...host.querySelectorAll("tr")].find((row) => row.textContent?.includes("b@mv.com"))!.querySelectorAll<HTMLButtonElement>(".role-chip")];
  await act(async () => { chips().find((button) => button.textContent === "Member")!.click(); });
  try {
    localStorage.setItem(STORAGE_KEYS.activeAccount, "other@mv.com"); // 다른 탭에서 다른 계정으로 로그인했다
    await act(async () => { finishRead(list); });
    await settle();
    expect(mocks.setMemberGlobalRoles).not.toHaveBeenCalled();
    expect(chips().some((button) => button.disabled)).toBe(false); // 줄은 끝났다
  } finally {
    localStorage.removeItem(STORAGE_KEYS.activeAccount);
  }
});

it("프로젝트 멤버 — 그사이 빠진 멤버의 역할 칩은 그 멤버를 되살리지 않고, 추가는 이미 들어와 있는 멤버의 역할을 덮지 않는다", async () => {
  mocks.projectMembers.mockResolvedValue([{ uid: "u1", name: "A", roles: ["creator"] }]);
  mocks.workspaceMembers.mockResolvedValue({ members: [{ uid: "u9", name: "New", email: "new@mv.com", global_roles: ["member"] }] });
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  await mount();
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
  await settle();
  const panel = () => host.querySelector(".project-members-panel")!;
  // ① 화면에는 A 가 있는데 서버에서는 이미 빠졌다
  mocks.projectMembers.mockResolvedValue([]);
  await act(async () => { [...panel().querySelectorAll<HTMLButtonElement>(".role-chip")].find((button) => button.textContent === "Supervisor")!.click(); });
  await settle();
  expect(mocks.setProjectRoles).not.toHaveBeenCalled(); // 전엔 '역할 없는 멤버'로 보고 저장해 다시 들어왔다(제외 기록도 풀린다)
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("이미 프로젝트에서 빠진"));
  expect(panel().querySelectorAll(".project-member-card")).toHaveLength(0);
  // ② 추가 창의 후보는 열 때의 목록으로 걸렀다 — 그사이 다른 곳에서 먼저 넣고 역할을 고쳤다
  await act(async () => { panel().querySelector<HTMLButtonElement>(".project-member-add-button")!.click(); });
  await settle();
  await act(async () => { panel().querySelector<HTMLButtonElement>(".project-member-candidate")!.click(); });
  mocks.projectMembers.mockResolvedValue([{ uid: "u9", name: "New", roles: ["supervisor"] }]);
  await act(async () => { panel().querySelector<HTMLButtonElement>(".project-member-add-confirm")!.click(); });
  await settle();
  expect(mocks.setProjectRoles).not.toHaveBeenCalled(); // 전엔 기본 역할로 덮었다
  expect(panel().querySelector(".project-member-add-dialog")).toBeNull();
  expect([...panel().querySelectorAll<HTMLButtonElement>(".role-chip.on")].map((button) => button.textContent)).toEqual(["Supervisor"]);
});

it("프로젝트 멤버 — 지금 값을 읽는 사이·여럿을 넣는 사이에 계정이 바뀌면 남은 저장은 보내지 않는다", async () => {
  const one = [{ uid: "u1", name: "A", roles: ["creator"] }];
  mocks.projectMembers.mockResolvedValue(one);
  mocks.workspaceMembers.mockResolvedValue({ members: [
    { uid: "u8", name: "N8", email: "n8@mv.com", global_roles: ["member"] },
    { uid: "u9", name: "N9", email: "n9@mv.com", global_roles: ["member"] },
  ] });
  await mount();
  await clickTab("프로젝트");
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title^="멤버 역할"]')!.click(); });
  await settle();
  const panel = () => host.querySelector(".project-members-panel")!;
  try {
    // ① 역할 — 지금 값을 읽는 사이에 바뀌었다
    let finishRead!: (value: unknown) => void;
    mocks.projectMembers.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => { [...panel().querySelectorAll<HTMLButtonElement>(".role-chip")].find((button) => button.textContent === "Supervisor")!.click(); });
    localStorage.setItem(STORAGE_KEYS.activeAccount, "other@mv.com");
    await act(async () => { finishRead(one); });
    await settle();
    expect(mocks.setProjectRoles).not.toHaveBeenCalled();
    localStorage.removeItem(STORAGE_KEYS.activeAccount);
    // ② 둘을 추가 — 첫 저장이 가는 사이에 바뀌었다
    await act(async () => { panel().querySelector<HTMLButtonElement>(".project-member-add-button")!.click(); });
    await settle();
    await act(async () => { panel().querySelectorAll<HTMLButtonElement>(".project-member-candidate").forEach((button) => button.click()); });
    let finishFirst!: (value: unknown) => void;
    mocks.setProjectRoles.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    await act(async () => { panel().querySelector<HTMLButtonElement>(".project-member-add-confirm")!.click(); });
    await settle();
    expect(mocks.setProjectRoles).toHaveBeenCalledTimes(1);
    localStorage.setItem(STORAGE_KEYS.activeAccount, "other@mv.com");
    await act(async () => { finishFirst([...one, { uid: "u8", name: "N8", roles: ["creator"] }]); });
    await settle();
    expect(mocks.setProjectRoles).toHaveBeenCalledTimes(1); // 둘째는 보내지 않았다
  } finally {
    localStorage.removeItem(STORAGE_KEYS.activeAccount);
  }
});

// ── 28회차(Jay 결정 — "…중" 표시): ✎ 를 누른 뒤 응답(기획·폴더 조회)까지 아무 표시가 없어 또 눌렀다 ──
it("프로젝트 설정 창 — ✎ 의 조회가 도는 동안 그 줄의 ✎ 만 고리로 바뀌고 잠긴다(다른 줄은 그대로), 응답이 오면 창이 열리고 표시가 걷힌다 · 실패해도 걷힌다", async () => {
  mocks.projects.mockResolvedValue({ projects: [
    { id: "p", name: "첫째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
    { id: "q", name: "둘째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
  ] });
  mocks.projectFolder.mockResolvedValue({ project_id: "x", root_path: "", selected_path: "", tree: null });
  const waiting: Record<string, (value: unknown) => void> = {};
  const failing: Record<string, (reason: Error) => void> = {};
  mocks.getPlanning.mockImplementation((pid: string) => new Promise((resolve, reject) => { waiting[pid] = resolve; failing[pid] = reject; }));
  await mount();
  await clickTab("프로젝트");
  const settings = () => [...host.querySelectorAll<HTMLButtonElement>('.admin-pactions button[title="프로젝트 설정"]')];
  const hint = () => host.querySelector(".admin-pact-hint")?.textContent ?? null;
  await act(async () => { settings()[0].click(); });
  expect(settings()[0].disabled).toBe(true);
  expect(settings()[0].querySelector(".busy-ring")).not.toBeNull();
  expect(hint()).toBe("설정 불러오는 중…");
  expect(settings()[1].disabled).toBe(false); // 다른 줄은 그대로
  await act(async () => { settings()[0].click(); }); // 잠긴 단추 — 조회가 또 나가지 않는다
  expect(mocks.getPlanning).toHaveBeenCalledTimes(1);
  await act(async () => { failing.p(new Error("500: 서버 오류")); }); // 실패 — 표시는 걷히고 ✎ 가 돌아온다
  await settle();
  expect(hint()).toBeNull();
  expect(settings()[0].disabled).toBe(false);
  expect(settings()[0].textContent).toBe("✎");
  await act(async () => { settings()[0].click(); });
  expect(hint()).toBe("설정 불러오는 중…");
  await act(async () => { waiting.p({}); });
  await settle();
  expect(host.querySelector('.admin-project-dialog input[placeholder="프로젝트 이름"]')).not.toBeNull();
  expect(hint()).toBeNull();
  expect(settings()[0].disabled).toBe(false);
  // ✎ 를 누르고 응답 전에 '+ 새 프로젝트' — 순번이 넘어가므로 돌던 조회의 표시는 그 자리에서 걷힌다(그 조회의 finally 는 순번이 달라 안 걷는다)
  await pressEscape();
  await act(async () => { settings()[0].click(); });
  expect(hint()).toBe("설정 불러오는 중…");
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-add")!.click(); });
  expect(hint()).toBeNull();
  expect(settings()[0].disabled).toBe(false);
  await act(async () => { waiting.p({}); }); // 늦게 온 앞 조회 — 표시를 되살리지 않는다
  await settle();
  expect(hint()).toBeNull();
  // 첫째의 ✎ → 둘째의 ✎ → 첫째의 조회가 **먼저** 끝남: 표시는 둘째의 것이라 그대로다(순번이 다른 조회의 끝은 표시를 걷지 않는다)
  await pressEscape();
  await act(async () => { settings()[0].click(); });
  await act(async () => { settings()[1].click(); });
  expect(settings()[1].disabled).toBe(true);
  await act(async () => { failing.p(new Error("500: 서버 오류")); });
  await settle();
  expect(hint()).toBe("설정 불러오는 중…");
  expect(settings()[1].disabled).toBe(true);
  await act(async () => { waiting.q({}); });
  await settle();
  expect(host.querySelector<HTMLInputElement>('.admin-project-dialog input[placeholder="프로젝트 이름"]')?.value).toBe("둘째");
  expect(hint()).toBeNull();
});

// ── 13회차(조작 규칙 40): 늦게 온 조회 응답은 지금 대상의 것일 때만 화면에 넣는다 ──
it("프로젝트 설정 창 — 늦게 온 앞 프로젝트의 조회가 그사이 연 다른 창(다른 프로젝트의 설정·새 프로젝트)을 갈아 끼우지 않는다", async () => {
  mocks.projects.mockResolvedValue({ projects: [
    { id: "p", name: "첫째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
    { id: "q", name: "둘째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
  ] });
  mocks.projectFolder.mockResolvedValue({ project_id: "x", root_path: "", selected_path: "", tree: null });
  const waiting: Record<string, (value: unknown) => void> = {};
  const failing: Record<string, (reason: Error) => void> = {};
  mocks.getPlanning.mockImplementation((pid: string) => new Promise((resolve, reject) => { waiting[pid] = resolve; failing[pid] = reject; }));
  await mount();
  await clickTab("프로젝트");
  const settings = () => [...host.querySelectorAll<HTMLButtonElement>('.admin-pactions button[title="프로젝트 설정"]')];
  const dialogName = () => host.querySelector<HTMLInputElement>('.admin-project-dialog input[placeholder="프로젝트 이름"]')?.value;
  await act(async () => { settings()[0].click(); }); // 첫째의 ✎ — 조회가 안 끝난다
  await act(async () => { settings()[1].click(); }); // 그사이 둘째의 ✎
  await settle();
  await act(async () => { waiting.q({}); });
  await settle();
  expect(dialogName()).toBe("둘째");
  await act(async () => { waiting.p({}); }); // 첫째의 조회가 이제 끝났다
  await settle();
  expect(dialogName()).toBe("둘째"); // 전엔 창이 첫째로 바뀌고 적던 글이 사라졌다(저장하면 첫째에 저장된다)
  await pressEscape();
  expect(dialogName()).toBeUndefined();
  // ✎ 를 누르고 응답 전에 '+ 새 프로젝트'
  await act(async () => { settings()[0].click(); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-add")!.click(); });
  await settle();
  expect(dialogName()).toBe("");
  await act(async () => { waiting.p({}); });
  await settle();
  expect(dialogName()).toBe(""); // 새 프로젝트 창 그대로다
  await pressEscape();
  // 늦게 온 앞 조회의 실패도 그 위에 알리지 않는다
  await act(async () => { settings()[0].click(); });
  await act(async () => { settings()[1].click(); });
  await settle();
  await act(async () => { waiting.q({}); });
  await settle();
  await act(async () => { failing.p(new Error("offline")); });
  await settle();
  expect(dialogName()).toBe("둘째");
  expect(host.textContent).not.toContain("프로젝트 설정을 불러오지 못했습니다");
});

it("승인 탭의 '숨긴 계정 보기' — 켰다 바로 꺼도 목록은 지금의 체크를 따른다(늦게 온 앞 조회가 덮지 않는다)", async () => {
  const visible = [{ email: "shown@mv.com", name: "보임", status: "approved" }];
  const withHidden = [...visible, { email: "hidden@mv.com", name: "숨김", status: "approved", hidden: true }];
  const pending: Array<{ hidden: boolean; resolve: (value: unknown) => void }> = [];
  mocks.listAccounts.mockResolvedValueOnce(visible)
    .mockImplementation((_status: unknown, hidden: boolean) => new Promise((resolve) => { pending.push({ hidden, resolve }); }));
  await mount();
  const toggle = () => host.querySelector<HTMLInputElement>(".admin-hidden-toggle input")!;
  const names = () => [...host.querySelectorAll(".admin-table .admin-mname")].map((item) => item.textContent);
  expect(names()).toEqual(["보임"]);
  await act(async () => { toggle().click(); }); // 켠다 — pending[0](hidden=true)
  await act(async () => { toggle().click(); }); // 바로 끈다 — pending[1](hidden=false)
  expect(pending.map((item) => item.hidden)).toEqual([true, false]);
  await act(async () => { pending[1].resolve(visible); });
  await settle();
  await act(async () => { pending[0].resolve(withHidden); }); // 켰을 때의 조회가 늦게 왔다
  await settle();
  expect(toggle().checked).toBe(false);
  expect(names()).toEqual(["보임"]); // 전엔 체크는 꺼졌는데 숨긴 계정이 보였다
  // 늦게 온 앞 조회의 실패도 지금 목록을 비우지 않는다
  mocks.listAccounts.mockImplementation((_status: unknown, hidden: boolean) =>
    new Promise((resolve, reject) => { pending.push({ hidden, resolve: (value) => (value instanceof Error ? reject(value) : resolve(value)) }); }));
  await act(async () => { toggle().click(); }); // pending[2](true)
  await act(async () => { toggle().click(); }); // pending[3](false)
  await act(async () => { pending[3].resolve(visible); });
  await settle();
  await act(async () => { pending[2].resolve(new Error("offline")); });
  await settle();
  expect(names()).toEqual(["보임"]);
  // 승인 상태를 바꾸는 사이에 체크를 켰다 — 끝난 뒤의 재조회는 **지금의** 체크로 묻는다(누른 순간의 체크가 아니라)
  let finishStatus!: (value: unknown) => void;
  mocks.setAccountStatus.mockReturnValue(new Promise((resolve) => { finishStatus = resolve; }));
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-seg-pending")!.click(); });
  await act(async () => { toggle().click(); }); // pending[4](true)
  await act(async () => { pending[4].resolve(withHidden); });
  await settle();
  await act(async () => { finishStatus({}); });
  await settle();
  expect(pending[5].hidden).toBe(true); // 전엔 누른 순간의 체크(꺼짐)로 물어, 체크는 켜졌는데 숨긴 계정이 사라졌다
});

it("프로젝트 표의 순서 손잡이 — 손잡이 밖에서 떼면 줄이 끌리는 채로 남지 않는다(lib/useDragEndReset.useHandleRelease)", async () => {
  await mount();
  await clickTab("프로젝트");
  const handle = host.querySelector<HTMLElement>(".admin-table .proj-drag-handle")!;
  const row = handle.closest("tr")!;
  await act(async () => { handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(row.draggable).toBe(true);
  await act(async () => { document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(row.draggable).toBe(false);
});

// ── 14회차(조작 규칙 41): 조작이 실패했으면 화면이 성공한 것처럼 남지 않는다 ──
const twoProjects = () => [
  { id: "p", name: "첫째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
  { id: "q", name: "둘째", workspace_id: "ws", workspace_name: "WS", kind: "team" },
];
const projectNames = () => [...host.querySelectorAll(".admin-table .admin-pname-text")].map((node) => node.textContent);
const projectRow = (name: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>(".admin-table tr")].find((tr) => tr.querySelector(".admin-pname-text")?.textContent === name)!;
const dragProject = async (from: string, to: string) => {
  await act(async () => { projectRow(from).querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await act(async () => { projectRow(from).dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: {} })); });
  await act(async () => { projectRow(to).dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: {} })); });
};

it("프로젝트 표의 순서 — 저장에 실패하면 끌기 전 순서로 되돌리고 알린다. 그사이 목록을 다시 읽었으면 그것을 둔다", async () => {
  mocks.projects.mockResolvedValue({ projects: twoProjects() });
  let fail!: (reason: Error) => void;
  const heldSave = () => new Promise((_, reject) => { fail = reject; });
  mocks.reorderProjects.mockReturnValueOnce(heldSave());
  await mount();
  await clickTab("프로젝트");
  await dragProject("둘째", "첫째");
  expect(projectNames()).toEqual(["둘째", "첫째"]); // 화면은 먼저 바뀐다
  expect(mocks.reorderProjects).toHaveBeenCalledExactlyOnceWith(["q", "p"]);
  // 저장이 도는 동안의 다음 끌기는 받지 않는다 — 겹친 두 저장이 다 실패하면 둘째는 '저장 안 된 첫째의 순서'로 되돌린다(Codex 코드 리뷰)
  await dragProject("첫째", "둘째");
  expect(projectNames()).toEqual(["둘째", "첫째"]);
  expect(mocks.reorderProjects).toHaveBeenCalledTimes(1);
  await act(async () => { fail(new Error("502: 서버에 닿지 않습니다")); });
  await settle();
  expect(projectNames()).toEqual(["첫째", "둘째"]); // 전엔 실패하면 목록을 다시 읽었고, 그것도 실패하면 목록이 비었다
  expect(host.textContent).toContain("순서를 저장하지 못했습니다 — 원래 순서로 되돌렸습니다. 서버에 닿지 않습니다"); // 앞머리(Error·상태코드)는 뗀다
  // 저장되면 그대로다
  mocks.reorderProjects.mockResolvedValueOnce({ ok: true });
  await dragProject("둘째", "첫째");
  await settle();
  expect(projectNames()).toEqual(["둘째", "첫째"]);
  // 저장을 기다리는 사이에 목록을 다시 읽었다(보관) — 실패해도 옛 순서로 덮지 않는다
  mocks.reorderProjects.mockReturnValueOnce(heldSave());
  await dragProject("첫째", "둘째");
  mocks.updateProject.mockResolvedValueOnce({});
  mocks.projects.mockResolvedValue({ projects: [...twoProjects(), { id: "r", name: "셋째", workspace_id: "ws", workspace_name: "WS", kind: "team" }] });
  await act(async () => { projectRow("둘째").querySelector<HTMLButtonElement>(".admin-pact-archive")!.click(); });
  await settle();
  expect(projectNames()).toEqual(["첫째", "둘째", "셋째"]);
  await act(async () => { fail(new Error("offline")); });
  await settle();
  expect(projectNames()).toEqual(["첫째", "둘째", "셋째"]);
});

// 20회차(조작 규칙 45 의 남은 자리): 끄는 줄을 '몇 번째'로 들고 있어, 끄는 사이 목록을 다시 읽으면 그 번호 자리에 온 다른 프로젝트가 옮겨졌다.
it("프로젝트 표의 순서 — 끄는 사이 목록을 다시 읽어 순서가 달라져도 잡은 프로젝트가 옮겨진다", async () => {
  const third = { id: "r", name: "셋째", workspace_id: "ws", workspace_name: "WS", kind: "team" };
  mocks.projects.mockResolvedValue({ projects: [...twoProjects(), third] });
  mocks.reorderProjects.mockResolvedValue({ ok: true });
  mocks.updateProject.mockResolvedValue({});
  await mount();
  await clickTab("프로젝트");
  expect(projectNames()).toEqual(["첫째", "둘째", "셋째"]);
  await act(async () => { projectRow("둘째").querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await act(async () => { projectRow("둘째").dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: {} })); });
  // 끄는 사이 목록을 다시 읽었다 — 다른 관리자가 순서를 바꿔 놓았다(다시 읽기는 보관 단추의 뒤처리로 일으킨다)
  mocks.projects.mockResolvedValue({ projects: [third, ...twoProjects()] });
  await act(async () => { projectRow("셋째").querySelector<HTMLButtonElement>(".admin-pact-archive")!.click(); });
  await settle();
  expect(projectNames()).toEqual(["셋째", "첫째", "둘째"]);
  expect(projectRow("둘째").classList.contains("row-dragging")).toBe(true); // 전엔 번호 1 자리에 온 '첫째'가 끌리는 줄이었다
  await act(async () => { projectRow("셋째").dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: {} })); });
  await settle();
  expect(mocks.reorderProjects).toHaveBeenCalledExactlyOnceWith(["q", "r", "p"]); // 전엔 '첫째'가 옮겨져 ["p", "r", "q"]
});

it("프로젝트 보관·삭제 — 실패하면 알리고 목록은 다시 읽지 않는다(전엔 받는 곳이 없어 눌러도 아무 일도 없는 것처럼 보였다)", async () => {
  await mount();
  await clickTab("프로젝트");
  const lists = mocks.projects.mock.calls.length;
  // 실제 요청 실패와 같은 모양(lib/http 의 HttpError) — 글로 바꾸면 앞에 상태코드가 붙는다("…403: 권한이 없습니다"). 안내에는 서버가 준 글만 붙인다
  //  (격리 실측이 짚었다: 줄 끝에 "HttpError: 500: …" 이 그대로 보였다 — `new Error("…")` 로 흉내 낸 시험은 못 봤다).
  mocks.updateProject.mockRejectedValueOnce(new HttpError(403, "403: 권한이 없습니다", "권한이 없습니다"));
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-pact-archive")!.click(); });
  await settle();
  expect(mocks.updateProject).toHaveBeenCalledExactlyOnceWith("p", { archived: true });
  expect(host.querySelectorAll(".admin-note-sub")[1].textContent).toBe("보관하지 못했습니다. 권한이 없습니다");
  vi.stubGlobal("confirm", vi.fn(() => true));
  mocks.deleteProject.mockRejectedValueOnce(new Error("500: boom"));
  await act(async () => { host.querySelector<HTMLButtonElement>('.admin-pactions button[title="삭제"]')!.click(); });
  await settle();
  expect(host.textContent).toContain("'뻘뻘뻘' 을(를) 삭제하지 못했습니다. boom");
  expect(projectNames()).toEqual(["뻘뻘뻘"]);
  expect(mocks.projects.mock.calls.length).toBe(lists);
});

it("프로젝트 목록 다시 읽기에 실패해도 받아 둔 목록은 그대로 두고 알린다(전엔 프로젝트가 전부 '없음'으로 보였다)", async () => {
  await mount();
  await clickTab("프로젝트");
  mocks.updateProject.mockResolvedValueOnce({});
  mocks.projects.mockRejectedValueOnce(new Error("502: 서버에 닿지 않습니다"));
  await act(async () => { host.querySelector<HTMLButtonElement>(".admin-pact-archive")!.click(); }); // 보관은 됐고, 그 뒤의 다시 읽기가 실패한다
  await settle();
  expect(projectNames()).toEqual(["뻘뻘뻘"]);
  expect(host.querySelector(".admin-empty")).toBeNull();
  expect(host.textContent).toContain("프로젝트 목록을 불러오지 못했습니다. 서버에 닿지 않습니다");
});

it("슈퍼 관리자 해제(🔑) — 해제를 확인하지 못했으면 열쇠를 켜진 채 두고 알린다(상태를 다시 읽다 실패해 '해제됨'으로 그리지 않는다)", async () => {
  const status = (elevated: boolean) => ({
    url: "http://server:8010", server_name: "MV", is_admin: true, elevated, elevated_as: elevated ? "jay@mv.com" : null,
    super_admin_expires_at: elevated ? Math.floor(Date.now() / 1000) + 600 : null,
  });
  mocks.sharedServerStatus.mockResolvedValue(status(true));
  const alerts = vi.fn();
  vi.stubGlobal("alert", alerts);
  await mount();
  const key = () => host.querySelector<HTMLButtonElement>(".admin-key")!;
  expect(key().classList.contains("on")).toBe(true);
  const lookups = mocks.sharedServerStatus.mock.calls.length;
  mocks.sharedServerStatus.mockRejectedValue(new Error("502")); // 서버에 닿지 않는다 — 상태 조회도 실패한다
  mocks.sharedServerDeElevate.mockRejectedValueOnce(new Error("502"));
  await act(async () => { key().click(); });
  await settle();
  expect(alerts).toHaveBeenCalledExactlyOnceWith("슈퍼 관리자 해제를 확인하지 못했습니다 — 다시 눌러 주세요.");
  expect(key().classList.contains("on")).toBe(true); // 전엔 여기서 꺼졌다 — 요청은 닿지 않았는데 화면만 꺼진다
  expect(mocks.sharedServerStatus.mock.calls.length).toBe(lookups);
  // 해제되면 상태를 다시 읽어 끈다
  mocks.sharedServerDeElevate.mockResolvedValueOnce({});
  mocks.sharedServerStatus.mockResolvedValue(status(false));
  await act(async () => { key().click(); });
  await settle();
  expect(key().classList.contains("on")).toBe(false);
  expect(alerts).toHaveBeenCalledTimes(1);
});

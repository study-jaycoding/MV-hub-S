// @vitest-environment jsdom
// 관리자 창 탭(2026-10-02) — 탭 순서, '업데이트' 탭이 업데이트 관리를 그리고 '공유 서버' 탭에서는 빠졌는지,
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
  setMemberGlobalRoles: vi.fn(), setSharedServerUrl: vi.fn(), projectMembers: vi.fn(), setProjectRoles: vi.fn(),
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

it("관리자에게 탭이 정해진 순서로 보인다", async () => {
  await mount();
  expect(tabLabels()).toEqual(["승인", "멤버 · 전역 역할", "프로젝트", "공유 서버", "에셋 리스트", "업데이트"]);
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
  expect(mocks.packages).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("v2026.10.03-1420");
  expect(host.textContent).toContain("새 후보 · 배포 전");
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
  await clickTab("공유 서버");
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

it("공유 서버 이름·주소 저장 — 저장 중에는 다시 보내지 않고 두 칸을 잠근다(늦은 응답이 고쳐 친 이름을 덮지 않게)", async () => {
  let finish!: (value: unknown) => void;
  mocks.setSharedServerUrl.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await mount();
  await clickTab("공유 서버");
  const save = () => [...host.querySelectorAll<HTMLButtonElement>("button.settings-action")].find((button) => /^저장/.test(button.textContent || ""))!;
  const fields = () => [host.querySelector<HTMLInputElement>('input[placeholder^="서버 이름"]')!, host.querySelector<HTMLInputElement>('input[placeholder^="예: http"]')!];
  expect(fields().map((field) => field.readOnly)).toEqual([false, false]);
  await act(async () => { save().click(); });
  await act(async () => { save().click(); }); // 응답 전에 한 번 더
  expect(mocks.setSharedServerUrl).toHaveBeenCalledTimes(1);
  expect(fields().map((field) => field.readOnly)).toEqual([true, true]);
  expect(save().textContent).toBe("저장 중…");
  await act(async () => { finish({ url: "http://server:8010", server_name: "MV" }); });
  await settle();
  expect(fields().map((field) => field.readOnly)).toEqual([false, false]);
  await act(async () => { save().click(); }); // 끝난 뒤에는 다시 받는다
  expect(mocks.setSharedServerUrl).toHaveBeenCalledTimes(2);
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

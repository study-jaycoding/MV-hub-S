// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTreeView } from "../src/components/common/FolderTreeView";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { FilterSidebar } from "../src/components/FilterSidebar";
import { HttpError } from "../src/lib/http";
import { APP_EVENTS } from "../src/lib/appEvents";
import { setLang } from "../src/lib/i18n";
import type { Filters, Project } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn(), fresh: vi.fn(),
  base: vi.fn(), ack: vi.fn(), creators: vi.fn(), projects: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
  teamFreshAll: mocks.fresh, creators: mocks.creators, projects: mocks.projects,
} }));
vi.mock("../src/lib/teamSeen", () => ({ subscribeTeamSeen: () => () => {}, getTeamSeenVersion: () => 0,
  getTeamBase: mocks.base, isAckedFor: () => false, ackTeamFreshKeys: mocks.ack }));
const noop = () => {};
let root: Root, host: HTMLDivElement;
let serial = 0;
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); setLang("en");
  mocks.base.mockReturnValue(null); mocks.fresh.mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.unstubAllGlobals(); });

it.each([
  [{ final: 1, held: 2, shared: 5 }, "★1 · R2 · 8"],
  [{ final: 0, held: 2, shared: 5 }, "R2 · 7"],
  [{ final: 0, held: 1, shared: 1 }, "R1 · 2"],
  [{ final: 0, held: 1, shared: 0 }, "R1 · 1"],
  [{ final: 1, held: 0, shared: 1 }, "★1 · 2"],
  [{ final: 1, held: 1, shared: 1 }, "★1 · R1 · 3"],
  [{ final: 1, held: 0, shared: 0 }, "★1 · 1"],
  [{ final: 0, held: 0, shared: 5 }, "5"],
  [{ final: 0, held: 0, shared: 0 }, "-"],
] as const)("폴더 상태 표시 %j → %s", (reviewCounts, text) => {
  const total = reviewCounts.final + reviewCounts.held + reviewCounts.shared;
  act(() => root.render(<FolderTreeView nodes={[{ name: "shot", path: "shot",
    count: total, reviewCounts }]} onSelect={noop} />));
  const badge = host.querySelector(".folder-tree-count")!;
  expect(badge.textContent).toBe(text);
  expect(badge.getAttribute("aria-label")).toBe(`Final ${reviewCounts.final} · On hold ${reviewCounts.held} · Total ${total} (including subfolders)`);
  expect(host.querySelector("strong.folder-review-total")?.textContent).toBe(text === "-" ? undefined : String(total));
  act(() => setLang("ko"));
  expect(badge.getAttribute("aria-label")).toBe(`최종 ${reviewCounts.final}개 · 보류 ${reviewCounts.held}개 · 전체 ${total}개 (하위 폴더 포함)`);
});

it("상세 부재는 Total로 명시하고 기존 용도의 숫자 배지는 그대로 둔다", () => {
  act(() => root.render(<FolderTreeView nodes={[{ name: "old", path: "old", count: 8, reviewCounts: null },
    { name: "workspace", path: "workspace", count: 8 }]} onSelect={noop} />));
  expect([...host.querySelectorAll(".folder-tree-count")].map(e=>e.textContent)).toEqual(["Total 8", "8"]);
  expect(host.querySelector("strong")).toBeNull();
});

function fixture() {
  const id = `review-count-${++serial}`;
  const state = { project_id: id, root_path: "fixture", selected_path: "", tree: {
    path: "", name: "Render", children: [{ path: "shot", name: "shot", children: [], count: 999 }],
  } };
  mocks.links.mockResolvedValue({ links: { [id]: state } }); mocks.folder.mockResolvedValue(state);
  const props: ComponentProps<typeof ProjectSection> = { projects: [{ id, name: "Project", count: 8 } as Project],
    unassignedCount: 0, archivedCount: 0, activeId: id, tab: "team", showReviewCounts: true,
    deletedOnly: false, onFilter: noop, onViewDeleted: noop, countContextKey: "account-A" };
  const response = (shared = 5) => ({ counts: { [id]: { shot: 3 + shared } },
    review_counts: { [id]: { shot: { final: 1, held: 2, shared } } } });
  return { props, response };
}
const badges = () => [...host.querySelectorAll(".folder-tree-count")].map(e=>e.textContent);

it("공유 상태 변경 알림으로 서버 전체 집계와 상태별 값을 함께 갱신한다", async () => {
  const { props, response } = fixture(); mocks.counts.mockResolvedValue(response());
  await act(async () => root.render(<ProjectSection {...props} />));
  expect(badges()).toEqual(["★1 · R2 · 8"]);
  mocks.counts.mockResolvedValue(response(6));
  await act(async () => window.dispatchEvent(new Event(APP_EVENTS.libraryChanged)));
  expect(badges()).toEqual(["★1 · R2 · 9"]);
  expect(host.querySelector(".proj-tree-wrap .proj-count")?.textContent).toBe("8"); // 프로젝트 전체 합계는 별도 계약.
});

it("같은 프로젝트라도 계정/탭 변경 때 이전 개수와 늦은 응답을 버린다", async () => {
  const { props, response } = fixture(); let resolveOld!: (value: ReturnType<typeof response>) => void;
  mocks.counts.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(<ProjectSection {...props} />));
  mocks.counts.mockResolvedValue(response(1));
  await act(async () => root.render(<ProjectSection {...props} countContextKey="account-B" />));
  expect(badges()).toEqual(["★1 · R2 · 4"]);
  await act(async () => resolveOld(response(100))); expect(badges()).toEqual(["★1 · R2 · 4"]);
  mocks.counts.mockResolvedValue(response());
  await act(async () => root.render(<ProjectSection {...props} tab="my" />));
  expect(badges()).toEqual(["8"]); // 잘못 포함된 review_counts도 my에서는 무시.
});

it("확인 전 문맥에는 이전 숫자를 숨기고 쿼리를 보내지 않는다", async () => {
  const { props, response } = fixture(); mocks.counts.mockResolvedValue(response());
  await act(async () => root.render(<ProjectSection {...props} />)); expect(badges()).toHaveLength(1);
  mocks.counts.mockClear();
  await act(async () => root.render(<ProjectSection {...props} countQueryReady={false} />));
  expect(badges()).toEqual([]); expect(mocks.counts).not.toHaveBeenCalled();
});

it("구서버 상세 누락은 전체 합계로 표시하고 캔버스 옵트아웃은 기존 숫자를 유지한다", async () => {
  const { props, response } = fixture(); mocks.counts.mockResolvedValue({ counts: response().counts });
  await act(async () => root.render(<ProjectSection {...props} />)); expect(badges()).toEqual(["Total 8"]);
  mocks.counts.mockResolvedValue(response());
  await act(async () => root.render(<ProjectSection {...props} showReviewCounts={false} />));
  expect(badges()).toEqual(["8"]);
});

function creatorFixture() {
  const { props, response } = fixture(); const id = props.projects[0].id;
  props.unassignedCount = 40;
  const selected = (uid: string, shared = 1) => ({ ...response(shared), creator_filter_uid: uid,
    project_counts: { [id]: 3 + shared + 2 }, unassigned_count: 2 }); // 폴더 미지정 2개도 프로젝트 합계에 포함.
  mocks.counts.mockImplementation(async (_ids, _tab, uid) => uid ? selected(uid) : response());
  return { props, selected, id };
}
const projectCount = () => host.querySelector(".proj-tree-wrap .proj-count")?.textContent;
const unassignedCount = () => host.querySelector(".proj-unassigned .proj-count")?.textContent;

it("실제 생성자 버튼 클릭/해제가 폴더 상태별 수량·프로젝트·미분류에 함께 전달된다", async () => {
  const { props, id } = creatorFixture();
  mocks.creators.mockResolvedValue([{ uid: "alice", name: "Alice", count: 9 }, { uid: "bob", name: "Bob", count: 4 }]);
  function Sidebar() {
    const [filters, setFilters] = useState<Filters>({ tab: "team" });
    return <FilterSidebar projects={props.projects} unassignedCount={40} archivedCount={0}
      filters={filters} onChange={patch => setFilters(prev => ({ ...prev, ...patch }))}
      facets={{ auto_tags: [], tags: [], colors: [], workers: [] }}
      colorDots={[]} colorFilter={new Set()} onToggleColor={noop} armedAutoTags={new Set()}
      onToggleAutoTag={noop} onAddAutoTag={noop} onDeleteAutoTag={noop} workspaceChips={[]}
      onToggleWorkspaceChip={noop} onRemoveWorkspaceChip={noop} onCreatorChanged={noop} />;
  }
  await act(async () => root.render(<Sidebar />)); expect(badges()).toEqual(["★1 · R2 · 8"]);
  await act(async () => host.querySelector<HTMLButtonElement>('.creator-pick[title="alice"]')!.click());
  expect(mocks.counts).toHaveBeenLastCalledWith([id], "team", "alice");
  expect(badges()).toEqual(["★1 · R2 · 4"]); expect(projectCount()).toBe("6"); expect(unassignedCount()).toBe("2");
  await act(async () => host.querySelector<HTMLButtonElement>('.creator-pick[title="alice"]')!.click());
  expect(badges()).toEqual(["★1 · R2 · 8"]); expect(projectCount()).toBe("8"); expect(unassignedCount()).toBe("40");
});

it("생성자 전환 중 이전 숫자를 숨기고 늦은 응답과 이전 생성자의 오류를 무시한다", async () => {
  const { props, selected } = creatorFixture(); let resolveA!: (r: ReturnType<typeof selected>) => void;
  mocks.counts.mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }));
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" />));
  expect(badges()).toEqual([]); expect(projectCount()).toBe("—"); expect(unassignedCount()).toBe("—");
  await act(async () => root.render(<ProjectSection {...props} creatorUid="bob" />));
  expect(badges()).toEqual(["★1 · R2 · 4"]);
  await act(async () => resolveA(selected("alice", 50))); expect(badges()).toEqual(["★1 · R2 · 4"]);
  let rejectB!: (r: Error) => void;
  mocks.counts.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectB = reject; }));
  await act(async () => window.dispatchEvent(new Event(APP_EVENTS.libraryChanged)));
  await act(async () => root.render(<ProjectSection {...props} />));
  await act(async () => rejectB(new HttpError(409, "old scope")));
  expect(badges()).toEqual(["★1 · R2 · 8"]); expect(host.querySelector('[role="status"]')).toBeNull();
});

it("선택 중 집계 실패/구서버이면 0 또는 전체값으로 바꾸지 않고 안내·재조회를 제공한다", async () => {
  const { props, selected } = creatorFixture();
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" />));
  mocks.counts.mockRejectedValue(new HttpError(409, "unsupported"));
  await act(async () => window.dispatchEvent(new Event(APP_EVENTS.libraryChanged)));
  expect(badges()).toEqual([]); expect(projectCount()).toBe("—"); expect(unassignedCount()).toBe("—");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Update the app and shared server");
  mocks.counts.mockResolvedValue(selected("alice", 0));
  await act(async () => host.querySelector<HTMLButtonElement>('[role="status"] button')!.click());
  expect(badges()).toEqual(["★1 · R2 · 3"]); expect(host.querySelector('[role="status"]')).toBeNull();
});

it("프로젝트가 없어도 선택 생성자의 미분류 수량은 조회하고 내 작업도 같은 필터를 보낸다", async () => {
  const { props } = creatorFixture();
  mocks.counts.mockResolvedValue({ counts: {}, project_counts: {}, unassigned_count: 0, creator_filter_uid: "alice" });
  await act(async () => root.render(<ProjectSection {...props} projects={[]} tab="my" creatorUid="alice" />));
  expect(mocks.counts).toHaveBeenLastCalledWith([], "my", "alice"); expect(unassignedCount()).toBe("0");
});

it("신규 +N과 모두 확인은 선택한 작성자만 포함하고 NULL 작성자와 타인을 제외한다", async () => {
  const { props, id } = creatorFixture(); mocks.base.mockReturnValue("since");
  mocks.fresh.mockResolvedValue([
    { id: "a", creator_uid: "alice", project_id: id, folder_path: "shot", shared_at: "today", ack_key: "job-a" },
    { id: "b", creator_uid: "bob", project_id: id, folder_path: "shot", shared_at: "today" },
    { id: "unknown", creator_uid: null, project_id: id, folder_path: "shot", shared_at: "today" },
  ]);
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" onFolderAction={noop} />));
  expect(host.querySelector(".folder-tree-newcount")?.textContent).toBe("+1");
  expect(host.querySelector(".proj-tree-wrap .proj-newcount")?.textContent).toBe("+1");
  act(() => host.querySelector(".proj-tree-wrap > .proj-row")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(document.querySelector(".tone-ack")?.textContent).toBe("모두 확인 (+1)");
  act(() => document.querySelector<HTMLButtonElement>(".tone-ack")!.click());
  expect(mocks.ack).toHaveBeenCalledWith([{ ackKey: "job-a", sharedAt: "today" }]);
});

it("신규 생성자 필드 누락은 선택 중 숨기고 해제 시 기존 전체 +N을 복원한다", async () => {
  const { props, id } = creatorFixture(); mocks.base.mockReturnValue("since");
  mocks.fresh.mockResolvedValue([{ id: "legacy", project_id: id, folder_path: "shot", shared_at: "today" }]);
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" />));
  expect(host.querySelector(".folder-tree-newcount")).toBeNull();
  await act(async () => root.render(<ProjectSection {...props} />));
  expect(host.querySelector(".folder-tree-newcount")?.textContent).toBe("+1");
});

it("생성자 변경 직후 이전 신규 배지는 숨기고 늦은 응답도 적용하지 않는다", async () => {
  const { props, id } = creatorFixture(); mocks.base.mockReturnValue("since");
  const item = (uid: string) => ({ id: uid, creator_uid: uid, project_id: id, folder_path: "shot", shared_at: "today" });
  let resolveOld!: (items: ReturnType<typeof item>[]) => void;
  mocks.fresh.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" />));
  let resolveCurrent!: (items: ReturnType<typeof item>[]) => void;
  mocks.fresh.mockReturnValueOnce(new Promise(resolve => { resolveCurrent = resolve; }));
  await act(async () => root.render(<ProjectSection {...props} creatorUid="bob" />));
  await act(async () => resolveOld([item("bob"), item("bob")]));
  expect(host.querySelector(".folder-tree-newcount")).toBeNull();
  await act(async () => resolveCurrent([item("bob")]));
  expect(host.querySelector(".folder-tree-newcount")?.textContent).toBe("+1");
});

it("보관함을 펼쳐도 보관 프로젝트의 전체 숫자를 선택 생성자의 수량으로 오인시키지 않는다", async () => {
  const { props, selected, id } = creatorFixture();
  mocks.projects.mockResolvedValue({ projects: [{ id: "archived", name: "Archived", archived: true, count: 999 }] });
  mocks.counts.mockImplementation(async (ids, _tab, uid) => ({ ...selected(uid),
    counts: Object.fromEntries(ids.map((pid: string) => [pid, {}])),
    project_counts: Object.fromEntries(ids.map((pid: string) => [pid, pid === "archived" ? 2 : 6])) }));
  await act(async () => root.render(<ProjectSection {...props} creatorUid="alice" archivedCount={1} />));
  await act(async () => host.querySelector<HTMLButtonElement>(".proj-archived-head")!.click());
  expect(mocks.counts).toHaveBeenLastCalledWith([id, "archived"], "team", "alice");
  expect(host.querySelector(".proj-row.archived .proj-count")?.textContent).toBe("2");
});

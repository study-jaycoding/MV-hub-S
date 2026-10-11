// @vitest-environment jsdom
// 늦게 온 조회 응답은 지금 대상의 것일 때만 화면에 넣는다(조작 규칙 40).
// 2026-10-12(조작 점검 13회차, Codex 전수 검토): 대상을 바꾸는 조작(프로젝트·팀·필터)이 조회를 새로 보내는데, 앞 조회의 응답이 뒤늦게 와서
//  새 대상의 화면에 옛 대상의 자료를 넣는 곳들. 응답 순서를 시험이 바꿔서 본다(앞의 것을 쥐고 있다가 나중에 끝낸다).
//  같은 규칙의 다른 자리: 관리자 창(tests/adminWindowTabs — 프로젝트 설정 창·'숨긴 계정 보기') · 히스토리 열기(tests/reentryGuards) ·
//  Assets 타일의 복사용 그림(tests/sourceLocationFeedback).
import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetComment, AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({
  assetComments: vi.fn(), markCommentsRead: vi.fn(), assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn(), assetMounts: vi.fn(),
  addAssetMount: vi.fn(), delAssetMount: vi.fn(), addAssetComment: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: mocks }));

import { MountManager } from "../src/components/assets/MountManager";
import { useAssetCommentActions } from "../src/components/assets/useAssetCommentActions";
import { useAssetProjectData } from "../src/components/assets/useAssetProjectData";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.markCommentsRead.mockResolvedValue(undefined);
  mocks.assetMeta.mockResolvedValue({});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

/** 시험이 쥐고 있는 응답들 — 부를 때마다 하나씩 쌓이고, 시험이 골라서 끝낸다. */
function held<T>() {
  const waiting: Array<{ resolve: (value: T) => void; reject: (reason: unknown) => void }> = [];
  return { waiting, next: () => new Promise<T>((resolve, reject) => { waiting.push({ resolve, reject }); }) };
}
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const comment = (id: string) => ({ id, text: id }) as unknown as AssetComment;

it("Assets 코멘트 — 대상은 프로젝트와 경로다: 프로젝트를 바꿔 같은 경로의 파일을 열면 앞 프로젝트의 늦은 응답이 섞이지 않는다", async () => {
  const lookups = held<AssetComment[]>();
  mocks.assetComments.mockImplementation(() => lookups.next());
  let panel!: { path: string | null; comments: AssetComment[] } & ReturnType<typeof useAssetCommentActions>;
  function Host({ project }: { project: string }) {
    const [path, setPath] = useState<string | null>(null);
    const [comments, setComments] = useState<AssetComment[]>([]);
    panel = { path, comments, ...useAssetCommentActions({ project, commentPath: path, setCommentPath: setPath, setComments, reconcile: async () => {} }) };
    return null;
  }
  act(() => root.render(<Host project="A" />));
  act(() => panel.openComments("shots/cut01.png")); // A 의 파일 — 응답이 안 온다
  expect(panel.path).toBe("shots/cut01.png");
  act(() => root.render(<Host project="B" />));
  expect(panel.path).toBeNull(); // 프로젝트를 바꾸면 패널이 닫힌다 — 열어 두면 새 코멘트가 새 프로젝트의 같은 경로에 달린다
  act(() => panel.openComments("shots/cut01.png")); // B 의, 경로가 같은 파일
  lookups.waiting[1].resolve([comment("b1")]);
  await settle();
  expect(panel.comments.map((item) => item.id)).toEqual(["b1"]);
  lookups.waiting[0].resolve([comment("a1"), comment("a2")]); // A 의 응답이 이제 왔다
  await settle();
  expect(panel.comments.map((item) => item.id)).toEqual(["b1"]); // 전엔 경로만 견줘 A 의 코멘트가 B 의 파일 아래에 붙었다
  // 늦은 실패도 지금 목록을 비우지 않는다
  act(() => panel.openComments("shots/cut02.png"));
  act(() => panel.openComments("shots/cut01.png"));
  lookups.waiting[3].resolve([comment("b1")]);
  await settle();
  lookups.waiting[2].reject(new Error("offline"));
  await settle();
  expect(panel.comments.map((item) => item.id)).toEqual(["b1"]);
});

// 2026-10-12 조작 점검 18회차(Codex 코드 리뷰): 패널을 닫는 일이 '그린 뒤'에 돌면, 새 프로젝트는 그려졌는데 패널은 아직 앞 프로젝트의 파일을
//  쥔 한 박자가 생긴다 — 그때의 전송이 새 프로젝트의 같은 경로로 나갔다. 닫는 일은 그리기 전에 끝낸다(useLayoutEffect).
it("Assets 코멘트 — 프로젝트를 바꾼 바로 그 순간의 전송도 새 프로젝트의 같은 경로로 나가지 않는다", async () => {
  mocks.assetComments.mockResolvedValue([]);
  mocks.addAssetComment.mockResolvedValue(undefined);
  let panel!: { path: string | null } & ReturnType<typeof useAssetCommentActions>;
  function Host({ project }: { project: string }) {
    const [path, setPath] = useState<string | null>(null);
    const [, setComments] = useState<AssetComment[]>([]);
    panel = { path, ...useAssetCommentActions({ project, commentPath: path, setCommentPath: setPath, setComments, reconcile: async () => {} }) };
    return null;
  }
  act(() => root.render(<Host project="A" />));
  act(() => panel.openComments("shots/cut01.png"));
  await settle();
  let sent!: Promise<boolean>;
  act(() => {
    flushSync(() => root.render(<Host project="B" />)); // 프로젝트가 바뀌어 그려졌다
    sent = panel.sendComment("쓰던 글", null, false); // 간격 0 — 지금 그려진 패널의 전송
  });
  expect(await sent).toBe(false);
  expect(mocks.addAssetComment).not.toHaveBeenCalled(); // 전엔 ("B", "shots/cut01.png") 로 나갔다
  expect(panel.path).toBeNull();
});

const projectList = (projects: string[]) => ({ projects, linked: [], default: projects[0] ?? "" });
const treeOf = (name: string) => ({ children: [{ name, path: name, type: "image" } as AssetNode] });
function mountProjectData() {
  let data!: ReturnType<typeof useAssetProjectData>;
  function Host({ workspaceId }: { workspaceId: string }) { data = useAssetProjectData({ workspaceId }); return null; }
  const show = (workspaceId: string) => act(() => root.render(<Host workspaceId={workspaceId} />));
  return { show, data: () => data };
}

it("Assets 폴더 목록 — 팀을 잇달아 바꾸면 가장 나중에 물은 팀의 목록만 받는다(늦게 온 앞 팀의 목록이 선택까지 옮기지 않는다)", async () => {
  const lists = held<ReturnType<typeof projectList>>();
  mocks.assetProjects.mockImplementation(() => lists.next());
  mocks.assetTree.mockImplementation(async (project: string) => treeOf(`${project}.png`));
  const view = mountProjectData();
  view.show("team-b"); // 조회 [0]
  view.show("team-c"); // 조회 [1]
  lists.waiting[1].resolve(projectList(["c-folder"]));
  await settle();
  expect([view.data().projects, view.data().project]).toEqual([["c-folder"], "c-folder"]);
  lists.waiting[0].resolve(projectList(["b-folder"])); // 앞 팀의 응답이 이제 왔다
  await settle();
  expect([view.data().projects, view.data().project]).toEqual([["c-folder"], "c-folder"]); // 전엔 b-folder 로 바뀌고 그 파일을 다시 열었다
  expect(view.data().tree.map((node) => node.name)).toEqual(["c-folder.png"]);
  // 늦은 실패도 지금 화면에 오류를 띄우지 않는다
  view.show("team-d"); // [2]
  view.show("team-c"); // [3]
  lists.waiting[3].resolve(projectList(["c-folder"]));
  await settle();
  lists.waiting[2].reject(new Error("offline"));
  await settle();
  expect(view.data().error).toBeNull();
});

it("Assets — 폴더가 하나도 없는 팀으로 옮기면 앞 팀의 화면을 비우고 '로딩…'이 남지 않는다", async () => {
  const trees = held<ReturnType<typeof treeOf>>();
  mocks.assetProjects.mockImplementation(async (workspaceId: string) => projectList(workspaceId === "team-a" ? ["a-folder"] : []));
  mocks.assetTree.mockImplementation(() => trees.next());
  const view = mountProjectData();
  view.show("team-a");
  await settle();
  expect([view.data().project, view.data().loading]).toEqual(["a-folder", true]); // 처음 여는 폴더 — 트리를 받는 중
  view.show("team-none");
  await settle();
  expect([view.data().project, view.data().loading, view.data().tree]).toEqual(["", false, []]); // 전엔 loading 이 true 로 남았다
  trees.waiting[0].resolve(treeOf("a.png")); // 앞 팀 폴더의 트리가 이제 왔다
  await settle();
  expect([view.data().loading, view.data().tree]).toEqual([false, []]);

  // 파일·메타가 보이던 폴더에서 옮겨도 비운다 — 그리고 비운 값이 앞 폴더의 캐시에 적히지 않는다(돌아가면 받아 둔 것이 바로 보인다)
  mocks.assetMeta.mockResolvedValue({ "a.png": { tags: ["keep"] } });
  view.show("team-a"); // trees.waiting[1]
  await settle();
  trees.waiting[1].resolve(treeOf("a.png"));
  await settle();
  expect([view.data().tree.map((node) => node.name), Object.keys(view.data().meta)]).toEqual([["a.png"], ["a.png"]]);
  view.show("team-none");
  await settle();
  expect([view.data().tree, view.data().meta]).toEqual([[], {}]);
  mocks.assetMeta.mockReturnValue(new Promise(() => {})); // 돌아가서 새로 받는 것은 안 끝난다 — 캐시만으로 보인다
  view.show("team-a"); // trees.waiting[2]
  await settle();
  expect([view.data().tree.map((node) => node.name), Object.keys(view.data().meta), view.data().loading]).toEqual([["a.png"], ["a.png"], false]);

  // 앞 폴더의 오류 글도 남기지 않는다
  trees.waiting[2].reject(new Error("offline"));
  await settle();
  expect(view.data().error).toContain("offline");
  view.show("team-none");
  await settle();
  expect(view.data().error).toBeNull();
});

// 2026-10-12 조작 점검 18회차(Codex 코드 리뷰, 조작 규칙 45): 폴더를 바꾸면 화면의 셀·저장은 곧바로 새 폴더로 나가는데, 파일·메타는 새
//  폴더의 응답이 올 때까지(받아 둔 것이 없으면 몇 초) 앞 폴더의 것이 남아 있었다 — 두 폴더에 같은 경로가 있으면 앞 폴더의 태그에 새 태그를
//  더한 목록이 새 폴더에 저장돼 그 폴더의 태그를 덮는다. 받아 둔 것이 있어도 '그린 뒤'에 갈아 끼워 한 박자 섞여 보였다.
it("Assets — 폴더를 바꾸는 순간 화면은 그 폴더의 것이다: 처음 여는 폴더면 앞 폴더의 파일·메타를 걷고, 받아 둔 폴더면 그것을 바로 보인다", async () => {
  const trees = held<ReturnType<typeof treeOf>>();
  const metas = held<Record<string, unknown>>();
  mocks.assetProjects.mockResolvedValue(projectList(["a-folder", "b-folder"]));
  mocks.assetTree.mockImplementation(() => trees.next());
  mocks.assetMeta.mockImplementation(() => metas.next());
  const view = mountProjectData();
  view.show("team");
  await settle(); // a-folder — 조회 [0]
  trees.waiting[0].resolve(treeOf("shot.png"));
  metas.waiting[0].resolve({ "shot.png": { tags: ["a-tag"] } });
  await settle();
  const seen = () => [view.data().project, view.data().tree.map((node) => node.name), view.data().meta];
  expect(seen()).toEqual(["a-folder", ["shot.png"], { "shot.png": { tags: ["a-tag"] } }]);
  expect(view.data().metaReady).toBe(true);

  act(() => {
    flushSync(() => view.data().setProject("b-folder")); // 처음 여는 폴더 — 조회 [1]은 아직 안 온다
    // 지금 그려진 화면 — 전엔 앞 폴더의 shot.png 와 그 태그(a-tag)가 b-folder 의 것처럼 남아 있었다
    expect(seen()).toEqual(["b-folder", [], {}]);
    expect([view.data().loading, view.data().metaReady]).toEqual([true, false]);
  });
  trees.waiting[1].resolve(treeOf("shot.png")); // 같은 경로의 파일이 b-folder 에도 있다 — 파일 목록이 메타보다 먼저 왔다
  await settle();
  // 파일은 보이지만 이 폴더의 메타는 아직 모른다 — 빈 메타와 '못 받음'을 가른다(이때 태그를 고치면 기존 태그가 지워진다)
  expect([seen(), view.data().metaReady]).toEqual([["b-folder", ["shot.png"], {}], false]);
  metas.waiting[1].resolve({ "shot.png": { tags: ["b-tag"] } });
  await settle();
  expect([seen(), view.data().metaReady]).toEqual([["b-folder", ["shot.png"], { "shot.png": { tags: ["b-tag"] } }], true]);

  act(() => {
    flushSync(() => view.data().setProject("a-folder")); // 받아 둔 폴더 — 다시 받는 조회 [2]는 안 끝난다
    // 걷은 빈 값이 앞 폴더의 캐시에 적히지 않았다(받아 둔 것이 그대로 보인다) · 그리기 전에 갈아 끼운다(b-tag 가 한 박자도 안 보인다)
    expect(seen()).toEqual(["a-folder", ["shot.png"], { "shot.png": { tags: ["a-tag"] } }]);
    expect([view.data().loading, view.data().metaReady]).toEqual([false, true]); // 받아 둔 메타로도 고칠 수 있다
  });
});
it("폴더 등록 창 — 팀을 잇달아 바꾸면 가장 나중에 물은 팀의 등록 목록만 받는다", async () => {
  const lists = held<{ mounts: Array<{ name: string; path: string; exists: boolean; auto: boolean }> }>();
  mocks.assetMounts.mockImplementation(() => lists.next());
  const show = (workspaceId: string) => act(() => root.render(<MountManager onClose={() => {}} onChanged={() => {}} workspaceId={workspaceId} />));
  const names = () => [...document.querySelectorAll(".mount-item-name")].map((item) => item.textContent);
  show("team-b");
  show("team-c");
  lists.waiting[1].resolve({ mounts: [{ name: "c-mount", path: "C:/c", exists: true, auto: false }] });
  await settle();
  expect(names()).toEqual(["c-mount"]);
  lists.waiting[0].resolve({ mounts: [{ name: "b-mount", path: "C:/b", exists: true, auto: false }] });
  await settle();
  expect(names()).toEqual(["c-mount"]);
});

it("폴더 등록 창 — 등록·해제 뒤에도 지금 팀의 목록만 보인다(그 응답은 팀으로 좁히지 않은 전체다 — 다시 묻는다)", async () => {
  // Codex 코드 리뷰: 등록·해제의 응답을 그대로 넣어, B 팀을 보는 중에 A 팀의 프로젝트 폴더(자동)까지 목록에 나타났다(늦은 응답이 아니어도).
  const mount = (name: string, auto = false) => ({ name, path: `C:/${name}`, exists: true, auto });
  const everything = { mounts: [mount("a-auto", true), mount("b-auto", true), mount("mine")] }; // 서버의 등록·해제 응답 = 모든 팀
  let teamB = [mount("b-auto", true)];
  mocks.assetMounts.mockImplementation(async (workspaceId: string) => ({ mounts: workspaceId === "team-b" ? teamB : [] }));
  mocks.addAssetMount.mockImplementation(async () => { teamB = [mount("b-auto", true), mount("mine")]; return everything; });
  mocks.delAssetMount.mockImplementation(async () => { teamB = [mount("b-auto", true)]; return { mounts: [mount("a-auto", true), mount("b-auto", true)] }; });
  vi.stubGlobal("confirm", () => true);
  const onChanged = vi.fn();
  act(() => root.render(<MountManager onClose={() => {}} onChanged={onChanged} workspaceId="team-b" />));
  await settle();
  const names = () => [...document.querySelectorAll(".mount-item-name")].map((item) => item.firstChild?.textContent);
  expect(names()).toEqual(["b-auto"]);
  const type = (selector: string, text: string) => act(() => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  type(".mount-input:not(.mount-name)", "C:/mine");
  type(".mount-input.mount-name", "mine");
  await act(async () => { document.querySelector<HTMLButtonElement>(".mount-form .settings-action")!.click(); });
  await settle();
  expect(names()).toEqual(["b-auto", "mine"]); // a-auto 가 끼지 않는다
  expect(mocks.assetMounts).toHaveBeenLastCalledWith("team-b");
  expect(onChanged).toHaveBeenCalledTimes(1);
  await act(async () => { document.querySelector<HTMLButtonElement>(".mount-del")!.click(); });
  await settle();
  expect(names()).toEqual(["b-auto"]);
  expect(onChanged).toHaveBeenCalledTimes(2);

  // 등록이 끝나기를 기다리는 사이 팀이 바뀌었다 — 끝난 뒤에는 지금 팀으로 묻고 지금의 onChanged 를 부른다(옛 팀의 조회를 새로 시작하지 않는다)
  let finishAdd!: (value: unknown) => void;
  mocks.addAssetMount.mockReturnValue(new Promise((resolve) => { finishAdd = resolve; }));
  type(".mount-input:not(.mount-name)", "C:/later");
  type(".mount-input.mount-name", "later");
  await act(async () => { document.querySelector<HTMLButtonElement>(".mount-form .settings-action")!.click(); });
  // 16회차(조작 규칙 43): 등록 중에는 두 칸이 잠긴다 — 끝나면 칸을 비우는데, 그사이 다음 폴더를 치고 있었으면 그 글까지 지워졌다
  const fields = () => [...document.querySelectorAll<HTMLInputElement>(".mount-input")].map((field) => field.readOnly);
  expect(fields()).toEqual([true, true]);
  const onChangedNow = vi.fn();
  act(() => root.render(<MountManager onClose={() => {}} onChanged={onChangedNow} workspaceId="team-c" />));
  await settle();
  await act(async () => { finishAdd(everything); });
  await settle();
  expect(fields()).toEqual([false, false]);
  expect(mocks.assetMounts).toHaveBeenLastCalledWith("team-c");
  expect([onChanged.mock.calls.length, onChangedNow.mock.calls.length]).toEqual([2, 1]);
  expect(names()).toEqual([]); // team-c 의 목록(비어 있다)
});

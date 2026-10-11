// @vitest-environment jsdom
// 조작이 실패했으면 화면이 성공한 것처럼 남지 않는다(조작 규칙 41).
// 2026-10-12(조작 점검 14회차, Codex 전수 검토): 실패를 삼키거나, 먼저 화면을 바꿔 놓고 실패해도 그대로 두는 곳들.
//  · 쓴 글은 **저장된 뒤에** 비운다(코멘트·답글·수정) — 전엔 보내자마자 비워, 서버가 실패하면 "전송 실패"만 뜨고 글이 사라졌다.
//  · 되돌리려던 조회까지 실패했으면 '되돌렸다'고 하지 않는다 — 화면에는 저장 안 된 값이 남아 있다.
//  · 받는 곳이 없던 실패는 알린다(캔버스에 놓은 파일·붙여 넣은 그림).
//  같은 규칙의 다른 자리: 태그(tests/tagSaveFailureSync) · 프로젝트 순서·보관·삭제·열쇠(tests/projectFolderMenu·adminWindowTabs) ·
//  Comfy 카드(tests/comfyLoadOrder) · 로그아웃(tests/hubAuthReady·seedanceSceneErrorsRender) · 저장 취소(tests/exportViewLayout).
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";
import type { AssetComment, AssetMeta, AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({
  addAssetComment: vi.fn(), editAssetComment: vi.fn(), assetComments: vi.fn(), markCommentsRead: vi.fn(),
  addGenComment: vi.fn(), editGenComment: vi.fn(), genComments: vi.fn(), genCommentsCached: vi.fn(),
  setAssetColorsBatch: vi.fn(), uploadReferenceFiles: vi.fn(), uploadCapture: vi.fn(),
  assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: {
  ...mocks,
  // 놓은 파일을 레퍼런스 카드로 만들 때 쓰는 주소 — 시험마다 비우지 않게 mocks 밖에 둔다
  assetThumbUrl: (project: string, path: string) => `/thumbs/${project}/${path}`,
  assetFileUrl: (project: string, path: string) => `/files/${project}/${path}`,
} }));

import { CommentPanel, type CommentPanelItem } from "../src/components/common/CommentPanel";
import { GenCommentPanel } from "../src/components/GenCommentPanel";
import { useAssetCommentActions } from "../src/components/assets/useAssetCommentActions";
import { EMPTY_ASSET_META } from "../src/components/assets/assetsViewModel";
import { useAssetMetaActions } from "../src/components/assets/useAssetMetaActions";
import { useAssetProjectData } from "../src/components/assets/useAssetProjectData";
import { useSceneClipboardDrop } from "../src/lib/useSceneClipboardDrop";

let host: HTMLDivElement;
let root: Root;
let flashes: string[];
const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  flashes = [];
  window.addEventListener(APP_EVENTS.flash, onFlash);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  window.removeEventListener(APP_EVENTS.flash, onFlash);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** 시험이 쥐고 있는 응답들 — 부를 때마다 하나씩 쌓이고, 시험이 골라서 끝낸다. */
function held<T>() {
  const waiting: Array<{ resolve: (value: T) => void; reject: (reason: unknown) => void }> = [];
  return { waiting, next: () => new Promise<T>((resolve, reject) => { waiting.push({ resolve, reject }); }) };
}
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
/** 그 칸에 글을 넣고(주면) Enter — 폼을 보낸다. */
const submit = (input: HTMLInputElement, text?: string) => act(() => {
  if (text !== undefined) input.value = text;
  input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

// ── 코멘트 패널(에셋·생성물 공통) ──
const item = (id: string): CommentPanelItem => ({ id, author: "me", author_name: id, text: id, created_at: "2026-10-12 04:00:00", parent_id: null });
type Send = (text: string, parentId: string | null | undefined, isPrivate: boolean) => Promise<boolean>;
type Edit = (id: string, text: string) => Promise<boolean>;
function showPanel(onSend: Send, onEdit: Edit = async () => true) {
  act(() => root.render(<CommentPanel comments={[item("c1"), item("c2")]} label="cut01.png" myId="me" panelRef={() => {}} pos={{ x: 0, y: 0 }}
    onHeadMouseDown={() => {}} onClose={() => {}} onSend={onSend} onEdit={onEdit} onDelete={() => {}} />));
}
/** 그 코멘트 줄의 단추 — 줄은 쓴 사람 이름(= id)으로 찾는다(고치는 동안에는 본문이 입력칸으로 바뀐다). */
const rowButton = (id: string, label: string) => {
  const row = [...host.querySelectorAll(".cmt-item")].find((node) => node.querySelector(".cmt-author")!.textContent === id)!;
  return [...row.querySelectorAll<HTMLButtonElement>(".cmt-acts button")].find((button) => button.textContent === label)!;
};

it("코멘트 — 전송에 실패하면 쓴 글이 남고, 저장된 뒤에야 비운다. 보내는 동안의 Enter 는 다시 보내지 않는다", async () => {
  const sends = held<boolean>();
  const onSend = vi.fn<Send>(() => sends.next());
  showPanel(onSend);
  const input = field("c")!;
  submit(input, "첫 글");
  expect(onSend).toHaveBeenCalledExactlyOnceWith("첫 글", undefined, false);
  expect([input.value, input.readOnly]).toEqual(["첫 글", true]); // 전엔 여기서 이미 비웠다
  submit(input); // 응답 전의 Enter — 전엔 '바로 비우기'가 막았다
  expect(onSend).toHaveBeenCalledTimes(1);
  sends.waiting[0].resolve(false);
  await settle();
  expect([input.value, input.readOnly]).toEqual(["첫 글", false]); // 다시 쓰지 않고 다시 보낼 수 있다
  submit(input);
  expect(onSend).toHaveBeenCalledTimes(2);
  sends.waiting[1].resolve(true);
  await settle();
  expect(input.value).toBe("");
  // 저장이 던져도(받는 쪽이 실패를 값으로 안 바꿨다) 실패로 본다 — 칸이 읽기 전용으로 굳지 않는다
  onSend.mockRejectedValueOnce(new Error("offline"));
  submit(input, "둘째 글");
  await settle();
  expect([input.value, input.readOnly]).toEqual(["둘째 글", false]);
});

it("답글 — 실패하면 답글 칸과 글이 남고 성공하면 닫힌다. 기다리는 사이 연 다른 글의 답글 칸은 닫지 않는다", async () => {
  const sends = held<boolean>();
  const onSend = vi.fn<Send>(() => sends.next());
  showPanel(onSend);
  act(() => rowButton("c1", "답글").click());
  submit(field("r")!, "답");
  expect(onSend).toHaveBeenCalledExactlyOnceWith("답", "c1", false);
  sends.waiting[0].resolve(false);
  await settle();
  expect(field("r")?.value).toBe("답"); // 전엔 칸이 닫히고 글이 사라졌다
  submit(field("r")!);
  sends.waiting[1].resolve(true);
  await settle();
  expect(field("r")).toBeNull();
  // c1 의 답글을 보내 놓고 c2 의 답글 칸을 열었다 — c1 이 저장돼도 c2 의 칸은 그대로다
  act(() => rowButton("c1", "답글").click());
  submit(field("r")!, "늦는 답");
  act(() => rowButton("c2", "답글").click());
  field("r")!.value = "c2 에 쓰는 중";
  sends.waiting[2].resolve(true);
  await settle();
  expect(field("r")?.value).toBe("c2 에 쓰는 중");
  // 같은 글의 답글 칸을 보내 놓고 Esc 로 닫았다가 다시 열었다 — 앞 전송이 저장돼도 지금 칸은 새 칸이다(닫지 않는다)
  submit(field("r")!, "먼저 보낸 답");
  act(() => { field("r")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(field("r")).toBeNull();
  act(() => rowButton("c2", "답글").click());
  field("r")!.value = "새로 쓰는 답";
  sends.waiting[3].resolve(true);
  await settle();
  expect(field("r")?.value).toBe("새로 쓰는 답"); // 전엔 글 id 만 견줘, 새로 연 칸이 닫히고 쓰던 글이 사라졌다
});

it("수정 — 실패하면 고치던 칸과 글이 남고 성공하면 닫힌다", async () => {
  const edits = held<boolean>();
  const onEdit = vi.fn<Edit>(() => edits.next());
  showPanel(async () => true, onEdit);
  act(() => rowButton("c1", "수정").click());
  expect(field("e")!.value).toBe("c1");
  submit(field("e")!, "고친 글");
  expect(onEdit).toHaveBeenCalledExactlyOnceWith("c1", "고친 글");
  edits.waiting[0].resolve(false);
  await settle();
  expect(field("e")?.value).toBe("고친 글"); // 전엔 칸이 닫혀 옛 글로 돌아갔다 — 고친 글은 사라진다
  submit(field("e")!);
  edits.waiting[1].resolve(true);
  await settle();
  expect(field("e")).toBeNull();
});

it("생성물 코멘트 — 서버가 거절하면 글이 남는다. 저장은 됐는데 목록 다시 읽기가 실패한 것은 실패가 아니다(글을 비운다)", async () => {
  mocks.genCommentsCached.mockReturnValue(null);
  mocks.genComments.mockResolvedValue([]);
  mocks.addGenComment.mockRejectedValueOnce(new Error("500: boom"));
  const onChanged = vi.fn();
  await act(async () => { root.render(<GenCommentPanel genId="g1" label="g1" myId="me" syncTick={0} onClose={() => {}} onChanged={onChanged} />); });
  const input = field("c")!;
  submit(input, "글");
  await settle();
  expect(input.value).toBe("글");
  expect(flashes).toEqual(["코멘트 전송 실패 — 다시 시도하세요"]);
  expect(onChanged).not.toHaveBeenCalled();
  mocks.addGenComment.mockResolvedValueOnce({});
  mocks.genComments.mockRejectedValueOnce(new Error("offline"));
  submit(input);
  await settle();
  expect(mocks.addGenComment).toHaveBeenLastCalledWith("g1", "글", undefined, false);
  expect(input.value).toBe("");
  expect(flashes).toHaveLength(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

// 생성물 패널은 다시 만들어지지 않고 고른 카드를 따라간다(입력칸이 그대로다). A 에 보낸 글이 실패해 남으면, 다시 보낼 때 B 에 달린다.
it("생성물 코멘트 — 전송 중에 다른 카드로 넘어갔으면 실패한 글을 남기지 않는다(다시 보내면 새 카드에 달린다)", async () => {
  mocks.genCommentsCached.mockReturnValue(null);
  mocks.genComments.mockResolvedValue([]);
  const sends = held<unknown>();
  mocks.addGenComment.mockImplementation(() => sends.next());
  const show = (genId: string) => act(async () => { root.render(<GenCommentPanel genId={genId} label={genId} myId="me" syncTick={0} onClose={() => {}} onChanged={() => {}} />); });
  await show("A");
  const input = field("c")!;
  submit(input, "A 에 쓴 글");
  await show("B"); // 응답 전에 다른 카드를 골랐다 — 패널이 따라간다
  expect(field("c")).toBe(input); // 같은 입력칸이다
  sends.waiting[0].reject(new Error("500: boom"));
  await settle();
  expect(flashes).toEqual(["코멘트 전송 실패 — 다시 시도하세요"]);
  expect([input.value, input.readOnly]).toEqual(["", false]);
  submit(input); // 남은 글이 없다 — 아무것도 나가지 않는다
  expect(mocks.addGenComment).toHaveBeenCalledExactlyOnceWith("A", "A 에 쓴 글", undefined, false);
  // 같은 카드에 머물렀으면 글이 남는다(위 시험) — 넘어간 뒤에 B 에 새로 쓴 글은 B 로 간다
  submit(input, "B 에 쓴 글");
  expect(mocks.addGenComment).toHaveBeenLastCalledWith("B", "B 에 쓴 글", undefined, false);
});

it("생성물 코멘트 수정 — 서버가 거절하면 고치던 칸과 글이 남고, 저장되면 닫힌다", async () => {
  const alerts = vi.fn();
  vi.stubGlobal("alert", alerts);
  mocks.genCommentsCached.mockReturnValue(null);
  mocks.genComments.mockResolvedValue([item("c1")]);
  await act(async () => { root.render(<GenCommentPanel genId="g1" label="g1" myId="me" syncTick={0} onClose={() => {}} onChanged={() => {}} />); });
  await settle();
  act(() => rowButton("c1", "수정").click());
  mocks.editGenComment.mockRejectedValueOnce(new Error("403: 남의 글"));
  submit(field("e")!, "고친 글");
  await settle();
  expect(field("e")?.value).toBe("고친 글");
  expect(alerts).toHaveBeenCalledExactlyOnceWith("Error: 403: 남의 글");
  mocks.editGenComment.mockResolvedValueOnce({});
  mocks.genComments.mockRejectedValueOnce(new Error("offline")); // 저장 뒤의 다시 읽기 실패 — 저장 실패가 아니다
  submit(field("e")!);
  await settle();
  expect(mocks.editGenComment).toHaveBeenLastCalledWith("c1", "고친 글");
  expect(field("e")).toBeNull();
  expect(alerts).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll(".cmt-author")].map((node) => node.textContent)).toEqual(["c1"]); // 다시 읽기에 실패해도 코멘트는 남는다
});

// 되돌려 확인에서 안 잡힌 변이가 드러낸 것: 다시 읽기가 실패하면 목록을 비웠다 — 저장은 됐는데 "아직 코멘트가 없습니다"가 된다.
//  비우던 까닭(다른 카드의 코멘트가 남지 않게)은 카드가 바뀌는 순간에 걷는 것으로 옮겼다.
it("생성물 코멘트 — 다시 읽기에 실패해도 보이던 코멘트는 남고, 다른 카드를 고르면 앞 카드의 코멘트를 바로 걷는다", async () => {
  mocks.genCommentsCached.mockReturnValue(null);
  const lookups = held<CommentPanelItem[]>();
  mocks.genComments.mockImplementation(() => lookups.next());
  const show = (genId: string, syncTick: number) =>
    act(async () => { root.render(<GenCommentPanel genId={genId} label={genId} myId="me" syncTick={syncTick} onClose={() => {}} onChanged={() => {}} />); });
  const shown = () => [...host.querySelectorAll(".cmt-author")].map((node) => node.textContent);
  await show("A", 0);
  lookups.waiting[0].resolve([item("a1")]);
  await settle();
  expect(shown()).toEqual(["a1"]);
  await show("A", 1); // 같은 카드를 다시 읽는다(동기화 신호) — 실패한다
  lookups.waiting[1].reject(new Error("offline"));
  await settle();
  expect(shown()).toEqual(["a1"]); // 전엔 비워졌다
  await show("B", 1); // 다른 카드를 골랐다 — 응답은 아직
  expect(shown()).toEqual([]); // 전엔 B 의 제목 아래 a1 이 보였다
  lookups.waiting[2].resolve([item("b1")]);
  await settle();
  expect(shown()).toEqual(["b1"]);
});

it("에셋 코멘트 — 전송·수정은 '저장됐는가'를 돌려준다(다시 읽기 실패는 저장 실패가 아니다)", async () => {
  const alerts = vi.fn();
  vi.stubGlobal("alert", alerts);
  let actions!: ReturnType<typeof useAssetCommentActions>;
  function Host() {
    const [path, setPath] = useState<string | null>("shots/cut01.png");
    const [, setComments] = useState<AssetComment[]>([]);
    actions = useAssetCommentActions({ project: "P", commentPath: path, setCommentPath: setPath, setComments, reconcile: async () => {} });
    return null;
  }
  act(() => root.render(<Host />));
  const run = async (task: () => Promise<boolean>) => { let saved!: boolean; await act(async () => { saved = await task(); }); await settle(); return saved; };
  mocks.assetComments.mockRejectedValue(new Error("offline")); // 저장 뒤의 다시 읽기는 계속 실패한다
  mocks.addAssetComment.mockRejectedValueOnce(new Error("500: boom"));
  expect(await run(() => actions.sendComment("글", null, false))).toBe(false);
  expect(flashes).toEqual(["코멘트 전송 실패 — 다시 시도하세요"]);
  mocks.addAssetComment.mockResolvedValueOnce({});
  expect(await run(() => actions.sendComment("글", null, false))).toBe(true);
  expect(flashes).toHaveLength(1);
  mocks.editAssetComment.mockRejectedValueOnce(new Error("403: 남의 글"));
  expect(await run(() => actions.editComment("c1", "고친 글"))).toBe(false);
  expect(alerts).toHaveBeenCalledExactlyOnceWith("Error: 403: 남의 글");
  mocks.editAssetComment.mockResolvedValueOnce({});
  expect(await run(() => actions.editComment("c1", "고친 글"))).toBe(true);
  expect(alerts).toHaveBeenCalledTimes(1);
});

it("에셋 코멘트 — 닫았다 같은 파일을 다시 열어 받은 코멘트를, 앞서 연 조회의 늦은 실패가 비우지 않는다", async () => {
  const lookups = held<AssetComment[]>();
  mocks.assetComments.mockImplementation(() => lookups.next());
  mocks.markCommentsRead.mockResolvedValue(undefined);
  let panel!: { comments: AssetComment[] } & ReturnType<typeof useAssetCommentActions>;
  function Host() {
    const [path, setPath] = useState<string | null>(null);
    const [comments, setComments] = useState<AssetComment[]>([]);
    panel = { comments, ...useAssetCommentActions({ project: "P", commentPath: path, setCommentPath: setPath, setComments, reconcile: async () => {} }) };
    return null;
  }
  act(() => root.render(<Host />));
  act(() => panel.openComments("shots/cut01.png")); // 조회 [0] — 응답 전에 닫았다가
  act(() => panel.openComments("shots/cut01.png")); // 같은 파일을 다시 연다 — 조회 [1]
  lookups.waiting[1].resolve([{ id: "c1", text: "c1" } as unknown as AssetComment]);
  await settle();
  expect(panel.comments.map((comment) => comment.id)).toEqual(["c1"]);
  lookups.waiting[0].reject(new Error("offline"));
  await settle();
  expect(panel.comments.map((comment) => comment.id)).toEqual(["c1"]); // 전엔 대상이 같아 가드를 지나 목록을 비웠다
});

// ── 되돌리지 못했으면 '되돌렸다'고 하지 않는다 ──
it("에셋 색·태그 — 저장에 실패해 서버 값을 다시 읽었는데 그것도 실패했으면 '되돌렸다'고 하지 않는다", async () => {
  const reloadMeta = vi.fn(async () => true);
  let meta!: ReturnType<typeof useAssetMetaActions>;
  function Host() {
    const filesRef = useRef([{ name: "a.png", path: "a.png", type: "image" } as AssetNode]);
    const metaRef = useRef<Record<string, AssetMeta>>({});
    const [, setMeta] = useState<Record<string, AssetMeta>>({});
    const [, setActiveTags] = useState(new Set<string>());
    meta = useAssetMetaActions({ project: "P", filesRef, metaRef, selected: new Set(), activeTags: new Set(), setMeta, setActiveTags, reloadMeta });
    return null;
  }
  act(() => root.render(<Host />));
  mocks.setAssetColorsBatch.mockResolvedValueOnce({});
  act(() => meta.colorAssets(["a.png"], "#0000ff"));
  await settle();
  expect(reloadMeta).not.toHaveBeenCalled(); // 저장된 것은 다시 읽지 않는다 — 갚을 복구가 없다
  mocks.setAssetColorsBatch.mockRejectedValue(new Error("502: 서버에 닿지 않습니다"));
  act(() => meta.colorAssets(["a.png"], "#ff0000"));
  await settle();
  expect(flashes).toEqual(["변경 적용 실패 — 서버 상태로 되돌렸습니다"]);
  reloadMeta.mockResolvedValueOnce(false); // 되돌리려던 조회도 실패했다
  act(() => meta.colorAssets(["a.png"], "#00ff00"));
  await settle();
  expect(flashes).toHaveLength(2);
  expect(flashes[1]).toContain("되돌리지도 못했습니다");
  expect(flashes[1]).not.toContain("되돌렸습니다");
});

// Codex 코드 리뷰: 되돌리려 다시 읽는 사이에 새 편집이 끼면 그 화면을 지키려고 낙관적 사본을 통째로 다시 올린다 — 거기엔 실패한 값도
//  들어 있다. 전엔 그 자리에서 "서버 상태로 되돌렸습니다"라고 했고, 뒤의 저장이 성공하면 다시 읽지 않아 실패한 값이 화면에 남았다.
it("에셋 색 — 되돌리려 다시 읽는 사이에 다른 파일을 칠하면, 그 저장이 끝난 뒤에 다시 읽어 실패한 색을 걷어낸다(그때 알린다)", async () => {
  const server: Record<string, AssetMeta> = {};
  const reads = held<void>();
  let view!: { meta: Record<string, AssetMeta> } & ReturnType<typeof useAssetMetaActions>;
  function Host() {
    const filesRef = useRef(["a.png", "b.png"].map((path) => ({ name: path, path, type: "image" }) as AssetNode));
    const [meta, setMeta] = useState<Record<string, AssetMeta>>({});
    const metaRef = useRef(meta);
    metaRef.current = meta; // AssetsView 와 같은 배선
    const [, setActiveTags] = useState(new Set<string>());
    const reloadMeta = useCallback(async () => { await reads.next(); setMeta({ ...server }); return true; }, []);
    view = { meta, ...useAssetMetaActions({ project: "P", filesRef, metaRef, selected: new Set(), activeTags: new Set(), setMeta, setActiveTags, reloadMeta }) };
    return null;
  }
  act(() => root.render(<Host />));
  const colors = () => ["a.png", "b.png"].map((path) => view.meta[path]?.color ?? null);
  mocks.setAssetColorsBatch.mockImplementation(async (_project: string, paths: string[], color: string | null) => {
    if (paths.includes("a.png")) throw new Error("500: boom"); // a 의 저장은 실패한다
    for (const path of paths) server[path] = { ...EMPTY_ASSET_META, color };
  });
  act(() => view.colorAssets(["a.png"], "#ff0000"));
  await settle();
  expect(colors()).toEqual(["#ff0000", null]); // 화면에는 먼저 칠했다 — 저장은 실패했고, 되돌리려는 조회 [0] 이 돌고 있다
  expect(reads.waiting).toHaveLength(1);
  act(() => view.colorAssets(["b.png"], "#00ff00")); // 그사이 다른 파일을 칠했다
  reads.waiting[0].resolve();
  await settle();
  expect(colors()[1]).toBe("#00ff00"); // 새 편집의 화면은 지킨다
  expect(mocks.setAssetColorsBatch).toHaveBeenCalledTimes(2); // b 의 저장이 나갔다(성공)
  expect(flashes).toEqual([]); // 아직 되돌린 것이 아니다 — 알리지 않는다
  expect(reads.waiting).toHaveLength(2); // b 가 저장된 뒤 다시 읽는다
  reads.waiting[1].resolve();
  await settle();
  expect(colors()).toEqual([null, "#00ff00"]); // 실패한 a 의 색이 걷혔다(전엔 남았다)
  expect(flashes).toEqual(["변경 적용 실패 — 서버 상태로 되돌렸습니다"]);
});

it("에셋 메타 다시 받기(reloadMeta)는 '받았는가'를 돌려준다 — 위 안내가 이것을 본다", async () => {
  mocks.assetProjects.mockResolvedValue({ projects: ["P"], linked: [], default: "P" });
  mocks.assetTree.mockResolvedValue({ children: [] });
  mocks.assetMeta.mockResolvedValue({});
  let data!: ReturnType<typeof useAssetProjectData>;
  function Host() { data = useAssetProjectData({ workspaceId: "team" }); return null; }
  act(() => root.render(<Host />));
  await settle();
  const reload = async () => { let got!: boolean; await act(async () => { got = await data.reloadMeta("P"); }); return got; };
  expect(await reload()).toBe(true);
  mocks.assetMeta.mockRejectedValueOnce(new Error("offline"));
  expect(await reload()).toBe(false);
});

// ── 캔버스에 놓은 파일·붙여 넣은 그림 ──
function mountBoardDrop() {
  let handlers!: ReturnType<typeof useSceneClipboardDrop>;
  let sceneIdRef!: { current: string };
  const setCards = vi.fn();
  function Host() {
    sceneIdRef = useRef("s");
    handlers = useSceneClipboardDrop({
      frozenRef: useRef(false), sceneIdRef, cardsRef: useRef<SceneCard[]>([]), edgesRef: useRef<SceneEdge[]>([]),
      selectedRef: useRef(new Set<string>()), lastMouseRef: useRef({ x: 10, y: 10, over: true }), scrollRef: useRef<HTMLDivElement | null>(null),
      setCards, setEdges: () => {}, setSelected: () => {}, toCanvas: (x, y) => ({ x, y }), reconcileGenerationRefs: (cards) => cards,
      persist: () => {}, cardWidth: 100, cardHeight: 100,
    });
    return null;
  }
  act(() => root.render(<Host />));
  return { handlers: () => handlers, setCards, sceneIdRef: () => sceneIdRef };
}
const png = () => new File(["x"], "shot.png", { type: "image/png" });

it("캔버스에 놓은 파일 — 들이지 못했으면 알린다(전엔 콘솔에만 남았다)", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const board = mountBoardDrop();
  const drop = () => act(() => {
    board.handlers().onDrop({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10, shiftKey: false,
      dataTransfer: { types: ["Files"], files: [png()], items: [] } } as never);
  });
  mocks.uploadReferenceFiles.mockRejectedValueOnce(new Error("offline"));
  drop();
  await settle();
  expect(flashes).toEqual(["파일을 캔버스에 넣지 못했습니다 — 다시 놓아 주세요."]);
  mocks.uploadReferenceFiles.mockResolvedValueOnce({ saved: [] });
  drop();
  await settle();
  expect(flashes).toHaveLength(1); // 들어간 것은 알리지 않는다
});

// 15회차(조작 규칙 42): 여러 파일을 놓았을 때 일부만 들어가도, 하나도 안 들어가도 아무 말이 없었다.
it("캔버스에 놓은 여러 파일 — 들어가지 않은 파일은 수와 이름으로 알린다(미디어가 아닌 것·서버가 건너뛴 것) · 그사이 씬이 바뀌었으면 그것도", async () => {
  const board = mountBoardDrop();
  const drop = (files: File[]) => act(() => {
    board.handlers().onDrop({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10, shiftKey: false,
      dataTransfer: { types: ["Files"], files, items: [] } } as never);
  });
  const note = new File(["x"], "note.txt", { type: "text/plain" });
  const saved = (name: string) => ({ project: "imports", path: name, name, type: "image" });
  // 미디어가 아닌 파일만 놓았다 — 올리지도 않는다. 전엔 아무 반응이 없었다
  drop([note]);
  await settle();
  expect(mocks.uploadReferenceFiles).not.toHaveBeenCalled();
  expect(flashes).toEqual(["1개 파일은 캔버스에 넣지 못했습니다(이미지·영상·오디오가 아니거나, 비었거나, 너무 큽니다) — note.txt"]);
  // 셋을 놓았는데 하나는 미디어가 아니고 하나는 서버가 건너뛰었다(빈 파일)
  mocks.uploadReferenceFiles.mockResolvedValueOnce({ saved: [saved("shot.png")], skipped: ["empty.png"] });
  drop([png(), new File([], "empty.png", { type: "image/png" }), note]);
  await settle();
  expect((mocks.uploadReferenceFiles.mock.calls[0][0] as File[]).map((file) => file.name)).toEqual(["shot.png", "empty.png"]);
  expect(board.setCards).toHaveBeenCalledTimes(1); // 들어간 것은 들어갔다
  expect(flashes[1]).toBe("2개 파일은 캔버스에 넣지 못했습니다(이미지·영상·오디오가 아니거나, 비었거나, 너무 큽니다) — note.txt, empty.png");
  // 전부 들어갔으면 알리지 않는다
  mocks.uploadReferenceFiles.mockResolvedValueOnce({ saved: [saved("shot.png")], skipped: [] });
  drop([png()]);
  await settle();
  expect(flashes).toHaveLength(2);
  // 이름은 셋까지만 적는다
  drop(["a", "b", "c", "d"].map((name) => new File(["x"], `${name}.txt`, { type: "text/plain" })));
  await settle();
  expect(flashes.pop()).toBe("4개 파일은 캔버스에 넣지 못했습니다(이미지·영상·오디오가 아니거나, 비었거나, 너무 큽니다) — a.txt, b.txt, c.txt …");
  // 올리는 사이 씬을 바꿨다 — 파일은 가져왔지만 캔버스에는 넣지 않는다. 전엔 말없이 사라졌다.
  //  건너뛴 파일도 있으면 **한 번에** 알린다 — 토스트는 마지막 문구만 남겨, 둘로 내면 앞의 것이 곧바로 덮인다(Codex 코드 리뷰).
  const upload = held<{ saved: ReturnType<typeof saved>[]; skipped: string[] }>();
  mocks.uploadReferenceFiles.mockImplementationOnce(() => upload.next());
  drop([png(), new File([], "empty.png", { type: "image/png" })]);
  board.sceneIdRef().current = "other-scene";
  upload.waiting[0].resolve({ saved: [saved("shot.png")], skipped: ["empty.png"] });
  await settle();
  expect(board.setCards).toHaveBeenCalledTimes(2); // 더 넣지 않았다
  expect(flashes.slice(2)).toEqual([
    "1개 파일을 가져왔지만, 그사이 씬이 바뀌어 캔버스에는 넣지 않았습니다 — Assets 에서 끌어 넣으세요." +
      " · 1개 파일은 캔버스에 넣지 못했습니다(이미지·영상·오디오가 아니거나, 비었거나, 너무 큽니다) — empty.png",
  ]);
});

it("캔버스에 붙여 넣은 그림 — 들이지 못했으면 알린다", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mountBoardDrop();
  mocks.uploadCapture.mockRejectedValueOnce(new Error("offline"));
  const image = png();
  act(() => {
    document.body.dispatchEvent(Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { items: [{ type: "image/png", getAsFile: () => image }], getData: () => "" },
    }));
  });
  await settle();
  expect(mocks.uploadCapture).toHaveBeenCalledExactlyOnceWith(image);
  expect(flashes).toEqual(["붙여 넣은 그림을 캔버스에 넣지 못했습니다 — 다시 붙여 넣어 주세요."]);
});

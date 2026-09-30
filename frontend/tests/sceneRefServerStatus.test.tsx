// 서버에 없는 레퍼런스(Jay 2026-09-29) — 서버 판정 → 가게 → 실제 SceneBoard·ReferenceCard 까지 한 번에 본다.
// @vitest-environment jsdom
import { act, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { relinkKey, relinkSceneAssetRefs, resetRelinkSessionForTest } from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene, type SceneRef } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 바꾸는 것은 생성물 읽기와 자동 매칭 응답뿐 — SceneBoard·ReferenceCard·판정 가게는 실제 코드다.
const fixture = vi.hoisted(() => ({
  data: null as unknown as SceneGenDataApi,
  locate: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
vi.mock("../src/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/api")>();
  return {
    ...mod,
    api: {
      ...mod.api,
      locateAssets: (...args: unknown[]) => fixture.locate(...args),
      uploadReferenceFiles: (...args: unknown[]) => fixture.upload(...args),
    },
  };
});

const noop = () => {};
type SceneBoardActionRef = NonNullable<ComponentProps<typeof SceneBoard>["actionRef"]>;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear();
  sessionStorage.clear();
  resetRelinkSessionForTest(); // 판정 기억은 모듈 캐시 — 시험마다 새 세션처럼
  fixture.locate.mockReset();
  fixture.upload.mockReset();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop,
    missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const ref = (file_path: string, name: string): SceneRef => ({ file_path, type: "image", name });
const cardEl = (id: string) => host.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
const refScene = (id: string, workspaceId: string, cards: { id: string; refs: SceneRef[] }[]): Scene =>
  ({
    id, name: "씬", created_at: 0, edges: [], workspace: { id: workspaceId, name: "가" },
    cards: cards.map((c, i) => ({ id: c.id, kind: "reference", x: i * 200, y: 0, refs: c.refs })),
  }) as unknown as Scene;

it("서버에 없는 참조는 빨간 테두리 + 안내, 이 PC 에만 있는 참조는 테두리 없이 그림 + 오른쪽 위 마크", async () => {
  const scene = refScene("offserver", "ws-1", [
    { id: "missing", refs: [ref("asset:Q|CH/gone.png", "gone.png")] },
    { id: "local", refs: [ref("asset:imports|mine.png", "mine.png")] },
    { id: "ok", refs: [ref("asset:P|ok.png", "ok.png")] },
    { id: "multi", refs: [ref("asset:P|ok.png", "ok.png"), ref("asset:Q|two.png", "two.png")] },
  ]);
  saveScenes(null, [scene]);
  fixture.locate.mockResolvedValue({
    fixed: [],
    unresolved: [],
    missing: ["asset:Q|CH/gone.png", "asset:Q|two.png"],
    local: ["asset:imports|mine.png"],
  });
  await relinkSceneAssetRefs();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });

  // 받은 사람 — 빨간 테두리 + 붉은 빗금 + 이유와 파일 이름. 썸네일은 부르지 않는다.
  const missing = cardEl("missing");
  expect(missing.classList.contains("off-server")).toBe(true);
  expect(missing.querySelector(".scene-ref-offmsg")?.textContent).toBe("서버에 없음gone.png");
  expect(missing.querySelector(".scene-refthumb-ph.off-server")).not.toBeNull();
  expect(missing.querySelector("img, video")).toBeNull();

  // 가진 사람 — 그림은 그대로 + 오른쪽 위 마크. 빨간 테두리는 없다(Jay 2026-09-29 — 마크만 유지)
  const local = cardEl("local");
  expect(local.classList.contains("off-server")).toBe(false);
  expect(local.querySelector("img")).not.toBeNull();
  expect(local.querySelector(".scene-ref-offmark")?.getAttribute("title")).toContain("이 PC 에만");
  expect(local.querySelector(".scene-ref-offmsg")).toBeNull();

  // 서버에 있는 참조 — 아무 표시 없음
  const ok = cardEl("ok");
  expect(ok.classList.contains("off-server")).toBe(false);
  expect(ok.querySelector(".scene-ref-offmark, .scene-ref-offmsg")).toBeNull();

  // 여러 장 카드(옛 씬) — 없는 칸만 붉은 빗금 + 작은 아이콘(글씨 없음)
  const multi = cardEl("multi");
  expect(multi.classList.contains("off-server")).toBe(true);
  expect(multi.querySelectorAll(".scene-refthumb-ph.off-server")).toHaveLength(1);
  expect(multi.querySelector(".scene-ref-offmini")).not.toBeNull();
  expect(multi.querySelector(".scene-ref-offmsg")).toBeNull();
});

it("로컬 파일을 끌어다 놓으면 프로젝트를 고르지 않아도 이 PC 에 두고 자동 복구를 부른다 — 표시는 서버 답으로만(2026-09-29)", async () => {
  const scene = refScene("dropscene", "ws-drop", []);
  saveScenes(null, [scene]);
  fixture.upload.mockResolvedValue({
    saved: [{ project: "imports", path: "mine-drop.png", name: "mine-drop.png", type: "image", sha256: "s", bytes: 3 }],
    skipped: [],
  });
  const onLocalRefsAdded = vi.fn();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} onLocalRefsAdded={onLocalRefsAdded} />);
  });

  const file = new File(["png"], "mine-drop.png", { type: "image/png" });
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(drop, {
    clientX: 20,
    clientY: 20,
    shiftKey: false,
    dataTransfer: { files: [file], items: [], types: ["Files"], getData: () => "" },
  });
  await act(async () => {
    host.querySelector(".scene-board")!.dispatchEvent(drop);
  });

  expect(fixture.upload).toHaveBeenCalledWith([file]); // 프로젝트 없이 — 이 PC 설치 폴더로
  const card = host.querySelector<HTMLElement>(".scene-card-ref");
  expect(card).not.toBeNull();
  // 서버가 확인하기 전에는 '이 PC에만'을 켜지 않는다 — NAS 에 있는 파일도 답이 올 때까지 빨갛게 보였다
  expect(card?.classList.contains("off-server")).toBe(false);
  expect(card?.querySelector(".scene-ref-offmark")).toBeNull();
  expect(onLocalRefsAdded).toHaveBeenCalledTimes(1);
});

it("자동 복구 답은 열린 캔버스의 메모리 카드에 입혀진다 — 치던 글도, 이은 참조도 남는다(2026-09-29)", async () => {
  const scene = {
    id: "relink-board", name: "씬", created_at: 0, edges: [],
    cards: [
      { id: "r1", kind: "reference", x: 0, y: 0, refs: [ref("asset:imports|a.png", "a.png")] },
      { id: "t1", kind: "text", x: 300, y: 0, text: "처음" },
    ],
  } as unknown as Scene;
  const onChange = vi.fn();
  const actionRef: SceneBoardActionRef = { current: null };
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={onChange} actionRef={actionRef} />);
  });
  expect(actionRef.current?.sceneId).toBe("relink-board");

  // 텍스트 카드에 글을 친다 — 저장은 아직 디바운스 중이다
  await act(async () => {
    cardEl("t1").querySelector(".scene-textview-inline")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const textarea = cardEl("t1").querySelector("textarea")!;
  onChange.mockClear();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "복구 중에 친 글");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).not.toHaveBeenCalled();

  let changed = 0;
  await act(async () => {
    changed = actionRef.current!.applyAssetRelink(
      new Map([[relinkKey("", "asset:imports|a.png"), { project: "P", path: "CH/a.png" }]]),
    );
  });

  expect(changed).toBe(1);
  // 친 글을 먼저 한 단계로 저장하고, 그 위에 복구를 입힌다 — 둘 다 남는다
  expect(onChange).toHaveBeenCalledTimes(2);
  const saved = onChange.mock.calls[1][0] as Partial<Scene>;
  expect(saved.cards!.find((c) => c.id === "t1")!.text).toBe("복구 중에 친 글");
  expect(saved.cards!.find((c) => c.id === "r1")!.refs![0].file_path).toBe("asset:P|CH/a.png");
  expect((cardEl("t1").querySelector("textarea") as HTMLTextAreaElement).value).toBe("복구 중에 친 글");
});

it("자동 복구 뒤 Ctrl+Z·Ctrl+Shift+Z 는 사용자 편집만 오간다 — 참조는 계속 원본 경로(2026-09-29)", async () => {
  const scene = {
    id: "relink-undo", name: "씬", created_at: 0, edges: [],
    cards: [
      { id: "r1", kind: "reference", x: 0, y: 0, refs: [ref("asset:imports|a.png", "a.png")] },
      { id: "t1", kind: "text", x: 300, y: 0, text: "처음" },
    ],
  } as unknown as Scene;
  const onChange = vi.fn();
  const actionRef: SceneBoardActionRef = { current: null };
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={onChange} actionRef={actionRef} />);
  });
  const saved = () => (onChange.mock.lastCall![0] as Partial<Scene>).cards!;
  const refPath = () => saved().find((c) => c.id === "r1")!.refs![0].file_path;
  const text = () => saved().find((c) => c.id === "t1")!.text;
  const press = (shiftKey: boolean) =>
    act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey, bubbles: true }));
    });

  // 사용자 편집 한 단계 — 글을 고치고 편집을 끝낸다
  await act(async () => {
    cardEl("t1").querySelector(".scene-textview-inline")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  const textarea = cardEl("t1").querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "고친 글");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => textarea.blur());
  expect(text()).toBe("고친 글");

  await act(async () => {
    actionRef.current!.applyAssetRelink(
      new Map([[relinkKey("", "asset:imports|a.png"), { project: "P", path: "CH/a.png" }]]),
    );
  });
  expect(refPath()).toBe("asset:P|CH/a.png");

  await press(false); // Ctrl+Z — 글만 되돌아가고, 참조는 옛 사본으로 돌아가지 않는다
  expect(text()).toBe("처음");
  expect(refPath()).toBe("asset:P|CH/a.png");

  await press(true); // Ctrl+Shift+Z — 글이 다시 오고, 참조는 그대로
  expect(text()).toBe("고친 글");
  expect(refPath()).toBe("asset:P|CH/a.png");
});

it("'레퍼런스 찾기' 단추 — 이 씬으로 찾기를 부르고, 도는 동안 개수와 '대기 중단'을 보이며, 다시 누르면 기다리기만 멈춘다(2026-09-29)", async () => {
  const scene = refScene("find-scene", "ws-f", [
    { id: "r1", refs: [ref("asset:imports|a.png", "a.png"), ref("asset:Q|b.png", "b.png")] },
    { id: "r2", refs: [ref("asset:Q|b.png", "b.png")] },
  ]);
  let finish = () => {};
  const onFindRefs = vi.fn(
    (_sceneId: string, _signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} onFindRefs={onFindRefs} />);
  });
  const button = () => [...host.querySelectorAll<HTMLButtonElement>(".scene-io-btn")].at(-1)!;
  expect(button().textContent).toBe("레퍼런스 찾기");

  await act(async () => button().click());
  expect(onFindRefs).toHaveBeenCalledTimes(1);
  expect(onFindRefs.mock.calls[0][0]).toBe("find-scene");
  const signal = onFindRefs.mock.calls[0][1];
  expect(button().textContent).toBe("◌ 레퍼런스 2개 찾는 중… · 대기 중단"); // 같은 토큰은 한 번만 센다
  expect(host.querySelector(".scene-io-panel")!.classList.contains("io-hidden")).toBe(false); // 도는 동안 숨지 않는다

  await act(async () => button().click()); // 대기 중단
  expect(signal.aborted).toBe(true);
  expect(onFindRefs).toHaveBeenCalledTimes(1);

  await act(async () => finish());
  expect(button().textContent).toBe("레퍼런스 찾기");
});

it("씬 전환 첫 렌더에는 핸들이 아직 옛 씬을 말한다 — 새 씬 id 로 온 복구 답이 옛 카드를 새 씬에 쓰지 않게(Codex)", async () => {
  // 씬 A→B 로 바꾸는 첫 렌더에는 cards 가 아직 A 다(동기화는 useEffect). 그 커밋의 핸들이 B 를 말하면,
  // 활성 씬(B) 확인을 통과해 A 의 카드에 답을 입히고 B 로 저장한다. 같은 커밋의 레이아웃 효과로 들여다본다.
  const sceneOf = (id: string) =>
    ({
      id, name: id, created_at: 0, edges: [],
      cards: [{ id: `${id}-r`, kind: "reference", x: 0, y: 0, refs: [ref(`asset:imports|${id}.png`, `${id}.png`)] }],
    }) as unknown as Scene;
  const actionRef: SceneBoardActionRef = { current: null };
  const seen: (string | null)[] = [];
  function Probe() {
    useLayoutEffect(() => {
      seen.push(actionRef.current?.sceneId ?? null); // SceneBoard 다음 형제 — 같은 커밋에서 핸들이 묶인 뒤 본다
    });
    return null;
  }
  const board = (scene: Scene) => (
    <>
      <SceneBoard scene={scene} onChange={noop} actionRef={actionRef} />
      <Probe />
    </>
  );
  await act(async () => {
    root.render(board(sceneOf("A")));
  });
  seen.length = 0;
  await act(async () => {
    root.render(board(sceneOf("B")));
  });

  expect(seen[0]).toBe("A"); // 전환 첫 커밋 — cards 가 아직 A 이므로 핸들도 A
  expect(actionRef.current?.sceneId).toBe("B"); // 동기화가 끝난 뒤에야 B(형제 Probe 는 그 커밋에 다시 안 돈다)
});

it("다른 공간으로 물어본 판정은 이 캔버스에 번지지 않는다", async () => {
  saveScenes(null, [refScene("asked", "ws-a", [{ id: "a", refs: [ref("asset:Q|elsewhere.png", "elsewhere.png")] }])]);
  fixture.locate.mockResolvedValue({ fixed: [], unresolved: [], missing: ["asset:Q|elsewhere.png"], local: [] });
  await relinkSceneAssetRefs();

  const other = refScene("other", "ws-b", [{ id: "b", refs: [ref("asset:Q|elsewhere.png", "elsewhere.png")] }]);
  await act(async () => {
    root.render(<SceneBoard scene={other} onChange={noop} />);
  });
  expect(cardEl("b").classList.contains("off-server")).toBe(false);
  expect(cardEl("b").querySelector(".scene-ref-offmsg")).toBeNull();
});

it("리스트도 같은 판정 — 첫 장이 서버에 없으면 붉은 빗금 + 아이콘·테두리 빨강, 이 PC 에만 있으면 오른쪽 위 마크만", async () => {
  const scene = {
    id: "listscene", name: "씬", created_at: 0, workspace: { id: "ws-l", name: "가" },
    cards: [
      { id: "lr-miss", kind: "reference", x: 0, y: 0, refs: [ref("asset:Q|list-gone.png", "list-gone.png")] },
      { id: "lr-local", kind: "reference", x: 0, y: 200, refs: [ref("asset:imports|list-mine.png", "list-mine.png")] },
      { id: "lr-ok", kind: "reference", x: 0, y: 400, refs: [ref("asset:P|list-ok.png", "list-ok.png")] },
      { id: "L", kind: "list", x: 300, y: 0 },
      { id: "L2", kind: "list", x: 600, y: 0 },
      { id: "L3", kind: "list", x: 900, y: 0 },
    ],
    edges: [
      { id: "e1", from: "lr-miss", to: "L" },
      { id: "e2", from: "lr-local", to: "L" },
      { id: "e3", from: "lr-ok", to: "L" },
      { id: "e4", from: "lr-ok", to: "L2" },
      { id: "e5", from: "lr-local", to: "L3" },
    ],
  } as unknown as Scene;
  saveScenes(null, [scene]);
  fixture.locate.mockResolvedValue({
    fixed: [],
    unresolved: [],
    missing: ["asset:Q|list-gone.png"],
    local: ["asset:imports|list-mine.png"],
  });
  await relinkSceneAssetRefs();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });

  expect(cardEl("L").classList.contains("off-server")).toBe(true);
  expect(cardEl("L2").classList.contains("off-server")).toBe(false); // 서버에 다 있는 리스트는 그대로
  // 이 PC 에만 있는 레퍼런스만 든 리스트 — 테두리는 그대로, 그 칸의 마크만(Jay 2026-09-29)
  expect(cardEl("L3").classList.contains("off-server")).toBe(false);
  expect(cardEl("L3").querySelector(".scene-listthumb .scene-ref-offmark")).not.toBeNull();
  const cells = [...cardEl("L").querySelectorAll<HTMLElement>(".scene-listthumb")];
  expect(cells).toHaveLength(3);
  const [miss, local, ok] = cells;
  expect(miss.querySelector(".scene-listthumb-ph.off-server")).not.toBeNull();
  expect(miss.querySelector(".scene-ref-offmini")).not.toBeNull();
  expect(miss.querySelector("img")).toBeNull();
  expect(local.querySelector("img")).not.toBeNull();
  expect(local.querySelector(".scene-ref-offmark")?.getAttribute("title")).toContain("이 PC 에만");
  expect(ok.querySelector("img")).not.toBeNull();
  expect(ok.querySelector(".scene-ref-offmark, .scene-ref-offmini")).toBeNull();
});

it("판정 보류도 빨간 테두리 + 이유(후보 여럿·사본), 판정 못 끝냄은 회색 '확인 못 함'이고 빨강이 아니다(Jay 2026-09-30)", async () => {
  const scene = refScene("held", "ws-1", [
    { id: "multi", refs: [ref("asset:뻘뻘뻘_RnD|CH/m/a.png", "a.png")] },
    { id: "copy", refs: [ref("asset:imports|copy.png", "copy.png")] },
    { id: "slow", refs: [ref("asset:Q|slow.png", "slow.png")] },
  ]);
  saveScenes(null, [scene]);
  fixture.locate.mockResolvedValue({
    fixed: [],
    unresolved: ["asset:뻘뻘뻘_RnD|CH/m/a.png", "asset:imports|copy.png", "asset:Q|slow.png"],
    missing: [],
    local: [],
    incomplete: ["asset:Q|slow.png"],
    held: {
      "asset:뻘뻘뻘_RnD|CH/m/a.png": { why: "multiple", count: 2, projects: ["RnD", "뻘뻘뻘"] },
      "asset:imports|copy.png": { why: "copy_name", count: 1, projects: ["뻘뻘뻘"] },
    },
  });
  await relinkSceneAssetRefs();
  await act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });

  const multi = cardEl("multi");
  expect(multi.classList.contains("off-server")).toBe(true);
  expect(multi.querySelector(".scene-ref-offmsg")?.textContent).toBe(
    "연결 안 됨 · 후보 2곳RnD · 뻘뻘뻘 에 같은 파일워크스페이스를 고르면 이어짐a.png",
  );
  expect(multi.querySelector("img, video")).toBeNull(); // 썸네일을 부르지 않는다

  const copy = cardEl("copy");
  expect(copy.classList.contains("off-server")).toBe(true);
  expect(copy.querySelector(".scene-ref-offmsg b")?.textContent).toBe("사본 · 서버에 같은 이름");

  const slow = cardEl("slow");
  expect(slow.classList.contains("off-server")).toBe(false); // 없는지 모른다 — 빨강 아님
  expect(slow.querySelector(".scene-ref-checkmsg b")?.textContent).toBe("확인 못 함");
});

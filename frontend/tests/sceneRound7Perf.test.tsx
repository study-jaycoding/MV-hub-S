// @vitest-environment jsdom
// 조작 점검 7회차(성능) — 캔버스 끌기의 '다시 그리기'와 끄는 동안의 스타일.
//  R2-a  `.scene-board.dragging .scene-card { pointer-events: none }` 한 줄이 끌기의 시작·끝마다 6천여 요소의 스타일을 다시 계산했다
//        (2026-10-11 격리 실측 각 40~55ms). 규칙을 없애고 포인터 캡처로 바꿨다(동작은 sceneCardGroupMove.test.tsx) — 여기서는 그런
//        규칙이 돌아오지 않는지만 본다.
//  R1-a  한 장만 끌어도 걸음마다 보드의 카드 컴포넌트가 전부 다시 그려졌다(412장 씬 실측: 컴포넌트 651개).
//        원인은 둘이었다 — ① 카드 컴포넌트가 memo 가 아니었다 ② SceneBoard 가 걸음마다 새 함수·새 묶음 객체를 넘겼다.
//        ① 다섯 종류(레퍼런스·머리글·모델·Set·생성)를 memo 로('카드 단위' 시험) ② 보드가 넘기는 함수의 정체성을 고정('보드' 시험).
//        다른 카드의 위치로 순서를 정하는 카드(텍스트·리스트·뷰·렌더·입출력·Comfy)는 memo 가 아니다 — 다른 카드가 움직이면 다시 그린다.
//        memo 의 위험은 '받은 값이 같아 안 그렸는데 화면은 달라져야 했던' 경우다 — 맨 아래 묶음이 길마다 본다.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { GenerationCard, type HistPass } from "../src/components/scene/cards/GenerationCard";
import { HeadCard } from "../src/components/scene/cards/HeadCard";
import { ModelCard } from "../src/components/scene/cards/ModelCard";
import { ReferenceCard } from "../src/components/scene/cards/ReferenceCard";
import { SetCard } from "../src/components/scene/cards/SetCard";
import { _resetGenerationViewsForTest, recordGenerationView } from "../src/lib/generationViews";
import type { SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 커밋마다 '이번에 다시 그려진 컴포넌트'를 이름별로 센다 — React 가 개발 도구에 커밋을 알리는 자리에 건다(격리 실측이 쓰는 방법과 같다).
//  react-dom 을 읽기 전에 있어야 해서 hoisted 로 둔다.
const rc = vi.hoisted(() => {
  type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null };
  const state = { rendered: {} as Record<string, number>, commits: [] as Record<string, number>[], seen: new WeakSet<object>() };
  // 이름 끝의 숫자는 뗀다 — `const X = memo(function X() {})` 의 안쪽 함수는 변환기가 X2 로 바꿔 놓는다
  const nameOf = (type: unknown): string => {
    const t = type as { name?: string; displayName?: string; render?: { name?: string } } | null;
    return ((t && (t.displayName || t.name || t.render?.name)) || "?").replace(/\d+$/, "");
  };
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject: () => 1, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const now = new WeakSet<object>();
      const mine: Record<string, number> = {}; // 이 커밋 하나의 몫
      state.commits.push(mine);
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const fiber = stack.pop()!;
        now.add(fiber);
        // 지난 커밋의 나무에 없던 fiber = 이번 커밋이 손댄 자리. 그중 함수가 실제로 돈 것(PerformedWork = 1)만 센다.
        //  tag: 0 함수 컴포넌트 · 11 forwardRef · 15 memo(비교 함수 없는 것). 비교 함수 있는 memo(14)는 안쪽 함수 fiber(0)가 센다.
        if (!state.seen.has(fiber) && (fiber.flags & 1) && (fiber.tag === 0 || fiber.tag === 11 || fiber.tag === 15)) {
          const name = nameOf(fiber.type);
          state.rendered[name] = (state.rendered[name] || 0) + 1;
          mine[name] = (mine[name] || 0) + 1;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      state.seen = now;
    },
  };
  return state;
});
/** fn 을 돌리는 동안 다시 그려진 컴포넌트(이름 → 횟수). */
async function renderedDuring(fn: () => void | Promise<void>): Promise<Record<string, number>> {
  rc.rendered = {};
  await act(async () => { await fn(); });
  return { ...rc.rendered };
}

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
// 레퍼런스 카드가 그릴 때 읽는 두 저장소(서버 판정 · 어셋 버전)를 시험이 바꾼다 — 나머지는 실제 코드
const stores = vi.hoisted(() => {
  const make = () => {
    const listeners = new Set<() => void>();
    const store = { version: 0, subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      bump: () => { store.version += 1; listeners.forEach((cb) => cb()); } };
    return store;
  };
  return { status: make(), assets: make(), refStatus: undefined as string | undefined };
});
vi.mock("../src/lib/sceneAssetRelink", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  refServerStatus: () => stores.refStatus,
  subscribeRefServerStatus: stores.status.subscribe,
  getRefServerStatusVersion: () => stores.status.version,
}));
vi.mock("../src/lib/assetVersions", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  subscribeAssetVersions: stores.assets.subscribe,
  assetVersionsSnapshot: () => stores.assets.version,
}));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  localStorage.clear();
  sessionStorage.clear();
  stores.refStatus = undefined;
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── R2-a ──
it("끄는 동안의 표시(.scene-board.dragging)에 카드나 그 자손을 고르는 스타일 규칙을 달지 않는다 — 붙고 떼일 때마다 수천 요소를 다시 계산한다", () => {
  const dir = fileURLToPath(new NodeURL("../src/styles/", import.meta.url));
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(dir + file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{/g)) {
      for (const selector of match[1].split(",")) {
        // `.scene-board.dragging` 뒤에 무엇이든 이어지면(자손·자식·형제) 그 클래스의 변화가 아래 요소들을 다시 계산시킨다
        if (/\.scene-board[^\s>+~]*\.dragging[^\s>+~]*\s*[\s>+~]\s*\S/.test(selector) || /\.dragging[^\s>+~]*\.scene-board[^\s>+~]*\s*[\s>+~]\s*\S/.test(selector))
          offenders.push(`${file}: ${selector.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

// ── R1-a ① 카드 단위 — 부모가 다시 그려져도, 받은 값이 그대로면 카드는 다시 그려지지 않는다 ──
let rerenderParent: () => void = noop;
function Parent({ children }: { children: () => React.ReactNode }) {
  const [, bump] = useState(0);
  rerenderParent = () => bump((n) => n + 1);
  return <>{children()}</>;
}
const show = (children: () => React.ReactNode) => act(async () => { root.render(<Parent>{children}</Parent>); });

it("레퍼런스 카드: 받은 값이 그대로면 다시 그려지지 않는다 — 서버 판정·어셋 버전이 바뀌면(그릴 때 읽는 저장소) 스스로 다시 그린다", async () => {
  const props: ComponentProps<typeof ReferenceCard> = {
    card: { id: "r1", kind: "reference", x: 0, y: 0, refs: [{ file_path: "asset:p|a.png", type: "image", name: "a.png" }] } as SceneCard,
    fill: true, workspaceId: "ws", getGen: () => undefined, onOutPortDown: noop,
  };
  let current = props;
  await show(() => <ReferenceCard {...current} />);
  expect(host.querySelector(".scene-ref-offmark")).toBeNull();
  expect(await renderedDuring(() => rerenderParent())).not.toHaveProperty("ReferenceCard");

  // 서버 판정이 도착했다(이 PC 에만 있음) — 보드가 다시 그려 주지 않아도 카드가 표시를 단다
  stores.refStatus = "local";
  expect(await renderedDuring(() => stores.status.bump())).toMatchObject({ ReferenceCard: 1 });
  expect(host.querySelector(".scene-ref-offmark")).not.toBeNull();
  // 어셋 원본이 바뀌어 버전이 올랐다 — 썸네일 주소를 다시 만든다
  expect(await renderedDuring(() => stores.assets.bump())).toMatchObject({ ReferenceCard: 1 });
  // 받은 값이 바뀌면 다시 그린다
  current = { ...props, fill: false };
  expect(await renderedDuring(() => rerenderParent())).toMatchObject({ ReferenceCard: 1 });
  current = { ...props, fill: false, card: { ...props.card, x: 22 } };
  expect(await renderedDuring(() => rerenderParent())).toMatchObject({ ReferenceCard: 1 });
});

it("생성 카드: 묶음 객체(hist·actions·tagEdit)는 걸음마다 새로 와도 안의 값이 그대로면 다시 그려지지 않는다 — 안의 값 하나라도 바뀌면 다시 그린다", async () => {
  const hist: HistPass = {
    disabledIds: new Set(), typeFilter: "all", colorFilter: new Set(), tagFilter: new Set(), sharedOnly: false, commentOnly: false,
    finalOnly: false, folderSel: null, sConfirm: null, onSClick: noop, onSDouble: noop, onSConfirmYes: noop, onSConfirmNo: noop,
  };
  const actions: ComponentProps<typeof GenerationCard>["actions"] = {
    setCardMenu: noop, setCardBatch: noop, orchestrateGenerate: async () => {}, showGenerateBar: true, onOutPortDown: noop, onResizeDown: noop,
  };
  const tagEdit: ComponentProps<typeof GenerationCard>["tagEdit"] = {
    active: false, hasAutoTags: false, autoTagOptions: [], applyCardTags: noop, applyCardAutoTags: noop, close: noop,
  };
  const laneDelta = () => 0;
  const getNodePreview = () => noop;
  const card = { id: "g1", kind: "generation", x: 0, y: 0 } as SceneCard;
  type Plain = Partial<Pick<ComponentProps<typeof GenerationCard>, "waiting" | "genMissing" | "lastViewed" | "selectedOnly" | "height">>;
  let patch: { hist?: Partial<HistPass>; actions?: Partial<typeof actions>; tagEdit?: Partial<typeof tagEdit>; sel?: boolean; card?: SceneCard; plain?: Plain } = {};
  await show(() => (
    <GenerationCard
      card={patch.card ?? card} sel={patch.sel ?? false} g={null} showNode={false} waiting={false} genMissing={false} width={152} height={130}
      fill selectedOnly laneDelta={laneDelta} getNodePreview={getNodePreview}
      hist={{ ...hist, ...patch.hist }} actions={{ ...actions, ...patch.actions }} tagEdit={{ ...tagEdit, ...patch.tagEdit }}
      {...patch.plain}
    />
  ));
  // 묶음 객체는 부모가 그릴 때마다 새로 만들어진다(SceneBoard 가 그렇게 넘긴다) — 안의 값은 같다
  expect(await renderedDuring(() => rerenderParent())).not.toHaveProperty("GenerationCard");
  const changes: (typeof patch)[] = [
    { sel: true }, // 고른 카드 — Generate 막대가 뜬다
    { sel: true, actions: { showGenerateBar: false } },
    { hist: { sConfirm: { id: "x", kind: "share" } } },
    { hist: { disabledIds: new Set(["x"]) } },
    { hist: { onSClick: () => {} } }, // 함수가 바뀌면 다시 그린다(낡은 함수를 쥐고 있지 않게)
    { tagEdit: { active: true } },
    { actions: { onOutPortDown: () => {} } },
    { plain: { waiting: true } }, // 앞의 Comfy 가 도는 중 — '생성중'으로 덮는다
    { plain: { lastViewed: true } },
    { plain: { genMissing: true } },
    { plain: { selectedOnly: false } },
    { plain: { height: 66 } },
    { sel: true, card: { ...card, batchCount: 3 } },
  ];
  for (const change of changes) {
    patch = {}; // 처음 값으로 되돌리고 — 다음 변경 하나만 달라지게
    await renderedDuring(() => rerenderParent());
    patch = change;
    expect(await renderedDuring(() => rerenderParent()), JSON.stringify(Object.keys(change))).toMatchObject({ GenerationCard: 1 });
    expect(await renderedDuring(() => rerenderParent()), "같은 값으로 다시").not.toHaveProperty("GenerationCard");
  }
  expect(host.querySelector(".scene-cardgen-n")?.textContent).toBe("3"); // 마지막으로 받은 카드를 그렸다
});

it("머리글·모델·Set 카드: 받은 값이 그대로면 다시 그려지지 않고, 카드가 바뀌면 다시 그린다", async () => {
  let text = "제목";
  const head = (): SceneCard => ({ id: "h1", kind: "head", x: 0, y: 0, text } as SceneCard);
  let headCard = head();
  const model = { id: "m1", kind: "model", x: 0, y: 0, modelCfg: { model: "nano", modelName: "Nano", type: "image", params: {} } } as unknown as SceneCard;
  const set = { id: "s1", kind: "set", x: 0, y: 0 } as SceneCard;
  await show(() => (
    <>
      <HeadCard card={headCard} sel={false} editing={false} colorPopId={null} setEditTextId={noop} setColorPopId={noop}
        setNodeText={noop} setNodeFontSize={noop} setNodeColor={noop} flushPending={noop} />
      <ModelCard card={model} onOutPortDown={noop} onResizeDown={noop} />
      <SetCard card={set} setFolder={noop} setTagsText={noop} flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
    </>
  ));
  const again = await renderedDuring(() => rerenderParent());
  expect([again.HeadCard, again.ModelCard, again.SetCard]).toEqual([undefined, undefined, undefined]);
  text = "바뀐 제목";
  headCard = head();
  const changed = await renderedDuring(() => rerenderParent());
  expect([changed.HeadCard, changed.ModelCard, changed.SetCard]).toEqual([1, undefined, undefined]);
  expect(host.querySelector(".scene-headnode-text")?.textContent).toBe("바뀐 제목");
});

// ── R1-a ② 보드 — 움직인 카드만 다시 그린다 ──
const boardCard = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
const grab = (id: string, x: number, y: number) => act(async () => {
  boardCard(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
});
const dragTo = (x: number, y: number) => {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 1 }));
  frames.splice(0).forEach((cb) => cb(0));
};
const gen = (id: string, patch: Record<string, unknown> = {}) => ({
  id, status: "done", prompt: id, tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true, is_final: false,
  is_held: false, color: null, comment_count: 0, has_unread: false, created_at: "2026-10-11 00:00:00", sort_ts: 1,
  assets: [{ id: `asset-${id}`, generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: null, source_url: null, cached: true }],
  ...patch,
});
// 생성물 자료가 바뀌었다(도착·색·상태) — 보드가 다음에 그릴 때 읽는다
const setGens = (items: Record<string, unknown>) => {
  fixture.data = { ...fixture.data, genData: items, genDataRef: { current: items } } as unknown as SceneGenDataApi;
};
const ref = (id: string, x: number, y = 0, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "reference", x, y, refs: [{ file_path: `asset:p|${id}.png`, type: "image", name: id, ...extra }] });

it("보드에서 한 장을 한 걸음 끌면 움직인 카드와, 다른 카드의 위치를 읽는 카드만 다시 그려진다", async () => {
  setGens({ gen1: gen("gen1") });
  const scene = {
    id: "S", name: "S", created_at: 0, groups: [],
    cards: [
      ref("r1", 0), ref("r2", 220), ref("r3", 440),
      { id: "h1", kind: "head", x: 0, y: 330, text: "제목" }, { id: "h2", kind: "head", x: 220, y: 330, text: "제목" },
      { id: "g1", kind: "generation", x: 0, y: 660, genId: "gen1", genIds: ["gen1"] }, { id: "g2", kind: "generation", x: 220, y: 660 },
      { id: "m1", kind: "model", x: 440, y: 660 }, { id: "s1", kind: "set", x: 660, y: 660 },
      { id: "t1", kind: "text", x: 660, y: 0, text: "글" }, { id: "l1", kind: "list", x: 880, y: 0 },
    ],
    edges: [{ id: "e1", from: "r2", to: "g2" }, { id: "e2", from: "g1", to: "l1" }],
  };
  await act(async () => { root.render(<SceneBoard scene={scene as never} onChange={noop} />); });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await grab("r1", 30, 30);
  await renderedDuring(() => dragTo(74, 30)); // 첫 걸음(끌기 시작 — 끄는 중 상태가 켜진다)
  const step = await renderedDuring(() => dragTo(118, 52)); // 걸음 하나: r1 만 움직인다
  // 한 장 끌기는 전의 길이다 — 걸음마다 left/top 을 쓴다(translate 로 그리는 길은 고른 카드 40장부터 — 파일 끝의 묶음).
  expect([boardCard("r1").style.left, boardCard("r1").style.translate || ""]).toEqual(["88px", ""]);
  // 움직인 r1 과 그 안의 썸네일, 그리고 다른 카드의 자리로 순서를 정하는 카드(텍스트·리스트)만.
  //  전엔 전부였다(레퍼런스 3·머리글 2·생성 2·모델 1·Set 1 — 412장 씬 실측 651개): SceneBoard 가 걸음마다 새 함수·객체를 넘겼다.
  expect({
    ReferenceCard: step.ReferenceCard, MediaThumbnail: step.MediaThumbnail, HeadCard: step.HeadCard, GenerationCard: step.GenerationCard,
    HistoryBoardNode: step.HistoryBoardNode, ModelCard: step.ModelCard, SetCard: step.SetCard, TextCard: step.TextCard, ListCard: step.ListCard,
  }).toEqual({
    ReferenceCard: 1, MediaThumbnail: 1, HeadCard: undefined, GenerationCard: undefined, HistoryBoardNode: undefined,
    ModelCard: undefined, SetCard: undefined, TextCard: 1, ListCard: 1,
  });
});

// 저장한 조각을 씬에 합쳐 다시 내려 주는 부모(App 의 patchActiveScene 과 같다 — 카드 배열은 보드가 준 그 객체다).
//  받는 값을 바꾸거나(setBoardProps) 씬은 그대로 두고 다시 그릴(rerenderBoard) 수 있다.
type BoardProps = ComponentProps<typeof SceneBoard>;
let setBoardProps: (patch: Partial<BoardProps>) => void = noop;
let rerenderBoard: () => void = noop;
function AppLike({ first, initial = {} }: { first: Record<string, unknown>; initial?: Partial<BoardProps> }) {
  const [scene, setScene] = useState(first);
  const [extra, setExtra] = useState(initial);
  const [, bump] = useState(0);
  setBoardProps = (patch) => setExtra((previous) => ({ ...previous, ...patch }));
  rerenderBoard = () => bump((n) => n + 1);
  return <SceneBoard scene={scene as never} onChange={(patch) => setScene((previous) => ({ ...previous, ...(patch as object) }))} {...extra} />;
}

it("전부 고른 끌기는 걸음마다 다시 그리지 않고, 놓는 순간의 커밋은 한 번뿐이다 — 부모에게서 돌아온 같은 씬으로 상태를 다시 넣지 않는다", async () => {
  const text = (id: string, x: number) => ({ id, kind: "text", x, y: 0, text: id });
  await act(async () => {
    root.render(<AppLike first={{ id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [text("a", 0), text("b", 220), text("c", 440)] }} />);
  });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  const commitsDuring = async (fn: () => void) => {
    rc.commits.length = 0;
    await act(async () => { fn(); });
    return rc.commits.map((commit) => commit.TextCard ?? 0); // 커밋마다 다시 그려진 카드 수
  };
  await commitsDuring(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true })));
  await grab("a", 30, 30);
  expect(await commitsDuring(() => dragTo(74, 30))).toEqual([3]); // 첫 걸음: '끄는 중' 상태가 켜진다
  expect(await commitsDuring(() => dragTo(118, 52))).toEqual([]); // 그 뒤의 걸음: 캔버스 층만 민다(커밋 없음)
  expect(await commitsDuring(() => dragTo(162, 74))).toEqual([]);
  // 놓는 순간: 좌표를 넣는 커밋 한 번. 전엔 그 뒤에 카드를 하나도 안 그리는 커밋이 한 번 더 있었다([3, 0]) — 씬 동기화 effect 가
  //  부모에게서 돌아온 같은 배열로 setCards·setEdges·setGroups 를 다시 불러 보드 함수(본문 전체)가 한 번 더 돌았다(편집할 때마다).
  expect(await commitsDuring(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 162, clientY: 74 })))).toEqual([3]);
  expect(boardCard("a").style.left).toBe("132px");
});

it("부모가 내용이 다른 씬을 내려 주면(생성 결과 바인딩 등 밖에서 바뀜) 전처럼 받아들인다 — 건너뛰는 것은 같은 객체일 때뿐이다(길이가 같아도 새 배열이면 넣는다)", async () => {
  const text = (id: string, x: number, body = id) => ({ id, kind: "text", x, y: 0, text: body });
  const group = (w: number) => ({ id: "gA", name: "A", cardIds: ["b"], rect: { x: 176, y: -44, w, h: 330 } });
  let scene: Record<string, unknown> = {
    id: "S", name: "S", created_at: 0, cards: [text("a", 0), text("b", 220)], edges: [{ id: "e1", from: "a", to: "b" }], groups: [group(330)],
  };
  let setScene: (next: Record<string, unknown>) => void = noop;
  function Outside() {
    const [current, set] = useState(scene);
    setScene = set;
    return <SceneBoard scene={current as never} onChange={noop} />;
  }
  await act(async () => { root.render(<Outside />); });
  // 한 번에 하나씩만 새 배열로 바꾼다(나머지 둘은 같은 객체 그대로) — 셋 다 따로 견주는지 본다
  const replace = (part: Record<string, unknown>) => act(async () => { scene = { ...scene, ...part }; setScene(scene); });
  const frame = () => host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"]')!;

  await replace({ cards: [text("a", 440, "바뀜"), text("b", 220)] }); // 카드: 장수는 같고 한 장의 자리와 글만 다르다
  expect(boardCard("a").style.left).toBe("440px");
  expect(boardCard("a").textContent).toContain("바뀜");
  await replace({ edges: [{ id: "e2", from: "b", to: "a" }] }); // 연결선: 개수는 같고 다른 선이다
  expect([!!host.querySelector('path[data-edge="e1"]'), !!host.querySelector('path[data-edge="e2"]')]).toEqual([false, true]);
  expect(frame().style.width).toBe("330px");
  await replace({ groups: [group(440)] }); // 그룹: 개수는 같고 네모만 다르다
  expect(frame().style.width).toBe("440px");
  expect(boardCard("a").style.left).toBe("440px"); // 앞에서 받은 것은 그대로다
});

// ── R1-a ③ 보드 — memo 가 과해 낡은 값을 보이지 않는다 ──
// 카드가 '받은 값이 그대로면 안 그린다'가 된 뒤로는, 보드의 변화가 그 카드가 받는 값에 실려 와야 화면이 따라온다. 길마다 본다.
//  색 칠하기(r/g/b)와 비활성(d)의 실제 키 → 저장 → 표시 길은 sceneColorBoard.test.tsx 가 실제 자료 훅으로 본다.
async function mountBoard(initial: Partial<BoardProps> = {}, gens: Record<string, unknown> = { gen1: gen("gen1") }) {
  setGens(gens);
  const first = {
    id: "S", name: "S", created_at: 0,
    cards: [
      ref("r1", 0), ref("r2", 220), { id: "h1", kind: "head", x: 220, y: 330, text: "제목" },
      { id: "g1", kind: "generation", x: 0, y: 660, genId: "gen1", genIds: ["gen1"] },
      { id: "g2", kind: "generation", x: 220, y: 660, genId: "gen2", genIds: ["gen2"], status: "pending" },
      { id: "g3", kind: "generation", x: 440, y: 660 },
      { id: "m1", kind: "model", x: 660, y: 660 }, { id: "s1", kind: "set", x: 880, y: 660 }, { id: "t1", kind: "text", x: 660, y: 0, text: "글" },
    ],
    edges: [{ id: "e1", from: "r1", to: "g3" }, { id: "e2", from: "t1", to: "g3" }],
    groups: [{ id: "gA", name: "A", cardIds: ["r2", "h1"], rect: { x: 176, y: -44, w: 330, h: 500 } }],
  };
  await act(async () => { root.render(<AppLike first={first} initial={initial} />); });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
}
const inCard = (id: string, selector: string) => boardCard(id)?.querySelector<HTMLElement>(selector) ?? null;
// 카드 고르기 = 누르고 떼기
const click = (target: Element, init: MouseEventInit = {}) => act(async () => {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5, clientY: 5, ...init }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 5, clientY: 5, ...init }));
});
const press = (init: KeyboardEventInit) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const tap = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
// React 가 다루는 입력칸에 글을 넣는다(값을 직접 쓰면 React 가 모른다)
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("선택과 '혼자 선택' — 머리글의 조절 단추, 생성 카드의 Generate 막대, 완료 결과의 선택 표시가 선택을 따라온다", async () => {
  await mountBoard({ onGenerateCard: vi.fn() as never });
  await click(boardCard("h1"));
  expect(inCard("h1", ".scene-headnode-ctrls")).not.toBeNull();
  await click(boardCard("g3")); // 생성 카드 하나만 골랐다
  expect(inCard("h1", ".scene-headnode-ctrls")).toBeNull();
  expect(inCard("g3", ".scene-cardgen-bar")).not.toBeNull();
  await click(boardCard("g1"), { ctrlKey: true }); // 둘이 됐다 — Generate 막대는 혼자 골랐을 때만
  expect(inCard("g3", ".scene-cardgen-bar")).toBeNull();
  expect(inCard("g1", ".linb-node")!.classList.contains("sel")).toBe(true);
  await press({ key: "Escape" });
  expect(inCard("g1", ".linb-node")!.classList.contains("sel")).toBe(false);
});

it("생성 진행과 결과 도착 — 진행 표시가 상태를 따라 바뀌고, 완료되면 결과 노드가 뜬다. 색·비활성이 바뀌면 노드가 따라 칠해진다", async () => {
  const gen1 = gen("gen1");
  await mountBoard({}, { gen1 });
  const waiting = () => inCard("g2", ".scene-card-genbody")!;
  expect(waiting().className).toContain("status-pending"); // 자료가 아직 없다 — 카드의 상태로 그린다
  setGens({ gen1, gen2: gen("gen2", { status: "running", assets: [] }) });
  await act(async () => { rerenderBoard(); });
  expect(waiting().className).toContain("status-running");
  setGens({ gen1, gen2: gen("gen2") });
  await act(async () => { rerenderBoard(); });
  expect(inCard("g2", '.linb-node[data-id="gen2"]')).not.toBeNull();
  expect(boardCard("g2").classList.contains("has-node")).toBe(true);

  // 색을 칠했다(r/g/b) — 그 생성물의 자료가 새 객체로 온다
  expect(inCard("g1", ".linb-colorbar")).toBeNull();
  setGens({ gen1: { ...gen1, color: "#ff5722" }, gen2: gen("gen2") });
  await act(async () => { rerenderBoard(); });
  expect(inCard("g1", ".linb-colorbar")!.style.background).toBe("rgb(255, 87, 34)");
  // 비활성으로 돌렸다(d) — 비활성 목록이 새 Set 으로 온다
  expect(inCard("g1", ".linb-node")!.classList.contains("disabled")).toBe(false);
  fixture.data = { ...fixture.data, disabledIds: new Set(["gen1"]) } as unknown as SceneGenDataApi;
  await act(async () => { rerenderBoard(); });
  expect(inCard("g1", ".linb-node")!.classList.contains("disabled")).toBe(true);
  expect(inCard("g2", ".linb-node")!.classList.contains("disabled")).toBe(false);
});

// 15회차(조작 규칙 42): '비활성 숨기기'는 그리기에서만 뺀다 — d 로 숨긴 카드가 선택에 남아, 다음에 고른 카드의 삭제·색·복사·끌기에 같이 걸렸다.
const hideGray = async (on: boolean) => { await act(async () => { setBoardProps({ grayOn: on }); }); };
const disable = async (...genIds: string[]) => {
  fixture.data = { ...fixture.data, disabledIds: new Set(genIds) } as unknown as SceneGenDataApi; // d — 비활성 목록이 새 Set 으로 온다
  await act(async () => { rerenderBoard(); });
};
it("비활성 숨기기 — d 로 가려진 카드는 선택에서 빠진다(다음에 고른 카드의 삭제에 같이 지워지지 않는다)", async () => {
  await mountBoard({ grayOn: true }, { gen1: gen("gen1"), gen2: gen("gen2") });
  await click(boardCard("g1"));
  await disable("gen1"); // 숨기기가 켜져 있어 g1 은 그려지지 않는다
  expect(boardCard("g1")).toBeNull();
  await click(boardCard("g2"), { ctrlKey: true });
  await press({ key: "Delete" });
  expect(boardCard("g2")).toBeNull();
  await hideGray(false);
  expect(boardCard("g1")).not.toBeNull(); // 전엔 보이지 않는 g1 도 같이 지워졌다
});

it("비활성 숨기기 — 이미 숨어 있던 카드를 Ctrl+A 로 고른 것은, 다른 카드가 새로 가려져도 선택에 남는다(전체 선택은 숨은 카드까지다)", async () => {
  await mountBoard({ grayOn: true }, { gen1: gen("gen1"), gen2: gen("gen2") });
  await disable("gen1");
  await press({ key: "a", ctrlKey: true }); // 숨은 g1 까지 전부
  await disable("gen1", "gen2"); // g2 가 새로 가려졌다 — g2 만 선택에서 빠진다
  await press({ key: "Delete" });
  await hideGray(false);
  expect(boardCard("g1")).toBeNull(); // Ctrl+A 로 고른 숨은 카드는 지워진다(전부터의 약속)
  expect(boardCard("g2")).not.toBeNull(); // 방금 가려진 것은 지워지지 않는다
  expect(boardCard("r1")).toBeNull(); // 보이던 나머지는 고른 대로 지워졌다
});

// 15회차(조작 규칙 42): 보드는 고른 결과 카드의 생성물을 App 의 선택바로 올리는데, 다시 올릴지를 id 로만 견줬다 — 고른 채로 공유를 풀거나
//  등급을 바꿔도 선택바는 옛 객체를 쥐고 있어, [팀 공유]가 "공유할 항목이 없습니다"처럼 옛 상태로 대상을 가렸다.
it("고른 카드의 자료가 바뀌면 선택바에 올린 생성물도 새것으로 바뀐다 — id 가 같아도. 자료가 그대로면 다시 올리지 않는다", async () => {
  const onSelectionGens = vi.fn();
  const shared = gen("gen1", { shared: true });
  await mountBoard({ onSelectionGens }, { gen1: shared });
  await click(boardCard("g1"));
  expect(onSelectionGens).toHaveBeenLastCalledWith([shared]);
  const calls = onSelectionGens.mock.calls.length;
  // 다른 카드의 자료만 바뀌었다(자료 묶음은 새 객체, 고른 카드의 자료는 그대로) — App 을 다시 깨우지 않는다.
  //  안 거르면 카드를 끄는 걸음·남의 생성 진행마다 선택바가 다시 그려진다.
  const other = gen("gen2");
  setGens({ gen1: shared, gen2: other });
  await act(async () => { rerenderBoard(); });
  expect(onSelectionGens).toHaveBeenCalledTimes(calls);
  const unshared = { ...shared, shared: false }; // 카드의 S 로 공유를 풀었다 — 그 생성물의 자료가 새 객체로 온다
  setGens({ gen1: unshared, gen2: other });
  await act(async () => { rerenderBoard(); });
  expect(onSelectionGens).toHaveBeenCalledTimes(calls + 1);
  expect(onSelectionGens.mock.calls.at(-1)![0][0]).toBe(unshared); // 전엔 옛 객체(shared: true)가 남았다
});

it("서버 판정 도착 — 레퍼런스 카드에 '이 PC 에만' 표시가 달리고, 서버에 없으면 빨간 테두리가 된다", async () => {
  await mountBoard();
  expect(inCard("r1", ".scene-ref-offmark")).toBeNull();
  stores.refStatus = "local";
  await act(async () => { stores.status.bump(); });
  expect(inCard("r1", ".scene-ref-offmark")).not.toBeNull();
  stores.refStatus = "missing";
  await act(async () => { stores.status.bump(); });
  expect(boardCard("r1").classList.contains("off-server")).toBe(true);
  expect(inCard("r1", ".scene-ref-offmark")).toBeNull();
});

it("태그 편집 — # 로 고른 생성 카드에 편집기가 뜨고, 적용은 그때의 핸들러로 가고(부모가 바꿔 끼운 뒤에도), Esc 로 닫힌다", async () => {
  const first = vi.fn();
  await mountBoard({ onSetTags: first });
  await click(boardCard("g1"));
  await press({ key: "#" });
  const input = () => inCard("g1", ".scene-tagpop .cs-tag-input") as HTMLInputElement | null;
  expect(input()).not.toBeNull();
  const add = async (tag: string) => {
    await type(input()!, tag);
    await act(async () => { input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  };
  await add("하나");
  expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ id: "gen1" }), ["하나"]);
  // 부모가 핸들러를 바꿔 끼웠다 — 생성 카드는 다시 그려지지 않아도(받은 값이 같다) 다음 적용은 새 핸들러로 간다
  const second = vi.fn();
  expect(await renderedDuring(() => setBoardProps({ onSetTags: second }))).not.toHaveProperty("GenerationCard");
  await add("둘");
  expect(second).toHaveBeenLastCalledWith(expect.objectContaining({ id: "gen1" }), ["하나", "둘"]); // 편집기가 방금 단 태그를 쥐고 있다
  expect(first).toHaveBeenCalledTimes(1);
  await act(async () => { input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(inCard("g1", ".scene-tagpop")).toBeNull();
});

it("툴바 필터 — 조건에 안 맞는 결과 노드가 흐려지고, 풀면 돌아온다", async () => {
  await mountBoard();
  const node = () => inCard("g1", ".linb-node")!;
  expect(node().classList.contains("dimmed")).toBe(false);
  await act(async () => { setBoardProps({ typeFilter: "video" }); });
  expect(node().classList.contains("dimmed")).toBe(true);
  await act(async () => { setBoardProps({ typeFilter: "all" }); });
  expect(node().classList.contains("dimmed")).toBe(false);
});

it("공유 확인 — S 를 누르면 그 결과 노드에 확인이 뜨고, 아니오로 닫힌다", async () => {
  await mountBoard();
  const share = [...boardCard("g1").querySelectorAll<HTMLElement>(".linb-ov-top .linb-ov-btn")].find((button) => button.textContent?.trim() === "S")!;
  await tap(share);
  await act(async () => { await new Promise((done) => setTimeout(done, 280)); }); // 한 번 누름과 두 번 누름을 가르는 시간(220ms)
  expect(inCard("g1", ".sconfirm")).not.toBeNull();
  await tap(inCard("g1", ".sconfirm .cs-final-no")!);
  expect(inCard("g1", ".sconfirm")).toBeNull();
});

it("마지막으로 본 표시 — 크게 열어 본 카드에 표시가 달리고, 다른 카드를 열면 옮겨 간다", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
    new Response(JSON.stringify(init?.method === "PUT" ? { recorded: true } : { card: {}, last_card_id: null }), { headers: { "Content-Type": "application/json" } })));
  try {
    await mountBoard();
    expect(host.querySelector(".last-viewed-badge")).toBeNull();
    await act(async () => { await recordGenerationView("gen1", { sceneId: "S", cardId: "g1" }); });
    expect(inCard("g1", ".last-viewed-badge")).not.toBeNull();
    await act(async () => { await recordGenerationView("gen2", { sceneId: "S", cardId: "g2" }); });
    expect([!!inCard("g1", ".last-viewed-badge"), !!inCard("g2", ".last-viewed-badge")]).toEqual([false, true]);
  } finally {
    _resetGenerationViewsForTest();
  }
});

it("카드 크기 조절 — 줄인 높이에 맞춰 카드와 입력 포트의 자리가 따라온다", async () => {
  await mountBoard();
  const portTop = () => inCard("g3", ".scene-port.in.lane-model")!.style.top;
  const before = portTop();
  expect(before).toBe("calc(50% - 39px)"); // 기본 높이 130: 레인 간격 26 → 맨 위 레인은 가운데에서 39 위
  await act(async () => {
    inCard("g3", ".scene-resize")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 600, clientY: 800 }));
  });
  await act(async () => { dragTo(600, 600); }); // 높이를 최소(66)까지 줄인다
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 600, clientY: 600 })); });
  expect(boardCard("g3").style.height).toBe("66px");
  expect(portTop()).toBe("calc(50% - 25px)"); // 간격 (66 − 16) ÷ 3 → 맨 위 레인은 25 위
});

it("배치 수 — 늘리기를 잇달아 눌러도 그때그때의 카드에서 센다(카드가 다시 그려져 다음 누름이 새 값을 본다)", async () => {
  await mountBoard({ onGenerateCard: vi.fn() as never });
  await click(boardCard("g3"));
  const count = () => inCard("g3", ".scene-cardgen-n")!.textContent;
  const more = () => inCard("g3", '.scene-cardgen-step[title="배치 늘리기"]')!;
  expect(count()).toBe("1");
  await tap(more());
  await tap(more());
  expect(count()).toBe("3");
});

it("머리글 글 고치기 — 두 번 눌러 연 입력칸의 글이 글자마다 카드에 들어가고, 벗어나면 저장된다", async () => {
  const saved: Record<string, unknown>[] = [];
  await mountBoard({ onChange: ((patch: Record<string, unknown>) => saved.push(patch)) as never });
  await act(async () => { inCard("h1", ".scene-headnode-text")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  const box = () => inCard("h1", ".scene-headnode-edit") as HTMLTextAreaElement;
  await type(box(), "새");
  await type(box(), "새 제목");
  expect(box().value).toBe("새 제목");
  await act(async () => { box().dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); // React 의 onBlur
  expect(inCard("h1", ".scene-headnode-text")!.textContent).toBe("새 제목");
  const cards = [...saved].reverse().find((patch) => "cards" in patch)?.cards as { id: string; text?: string }[] | undefined;
  expect(cards?.find((item) => item.id === "h1")?.text).toBe("새 제목");
});

it("레퍼런스의 원본 정보 — 휠 클릭은 그 순간의 생성물 자료를 본다(카드가 그려진 뒤에 도착한 자료도)", async () => {
  const onInfo = vi.fn();
  setGens({ gen1: gen("gen1") });
  const first = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [ref("r1", 0, 0, { file_path: "/media/late.png", source_gen_id: "late" })] };
  await act(async () => { root.render(<AppLike first={first} initial={{ onInfo }} />); });
  const late = gen("late");
  setGens({ gen1: gen("gen1"), late }); // 레퍼런스 카드가 그려진 뒤에 원본 생성물의 자료가 왔다
  expect(await renderedDuring(() => rerenderBoard())).not.toHaveProperty("ReferenceCard"); // 카드는 다시 그려지지 않는다(받은 값이 같다)
  await act(async () => {
    inCard("r1", ".scene-refthumb")!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, clientX: 3, clientY: 4 }));
  });
  expect(onInfo).toHaveBeenCalledWith(expect.objectContaining({ kind: "generation", gen: late }));
});

it("연결 — 고른 카드에 닿은 선이 켜지고, 출력 포트를 잡으면 임시 선이 뜨고, 놓은 카드로 이어진다", async () => {
  await mountBoard();
  const line = (id: string) => host.querySelector(`path[data-edge="${id}"]`)!.nextElementSibling!;
  expect(line("e1").classList.contains("idle")).toBe(true);
  await click(boardCard("r1"));
  expect(line("e1").classList.contains("onsel")).toBe(true);
  expect(line("e2").classList.contains("idle")).toBe(true);
  await press({ key: "Escape" });
  expect(line("e1").classList.contains("idle")).toBe(true);

  // 모델 카드의 출력 포트를 잡아 끈다 — 임시 선이 뜨고 보드가 '연결 중'이 된다
  const edgeCount = () => host.querySelectorAll("path[data-edge]").length;
  const before = edgeCount();
  await act(async () => {
    inCard("m1", ".scene-port.out")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 700, clientY: 700 }));
  });
  await act(async () => { dragTo(500, 700); });
  expect(host.querySelector(".scene-edge.temp")).not.toBeNull();
  expect(host.querySelector(".scene-board")!.classList.contains("wiring")).toBe(true);
  // g3 위에 놓는다(브라우저의 '그 자리의 요소' 찾기를 흉내 낸다)
  (document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => boardCard("g3");
  try {
    await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 500, clientY: 700 })); });
  } finally {
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  }
  expect(host.querySelector(".scene-edge.temp")).toBeNull();
  expect(edgeCount()).toBe(before + 1);
});

it("그룹 접기·펴기와 끌어 넣기 — 접으면 멤버 카드가 사라지고 펴면 다시 그려지며, 천천히 끌어 넣은 카드는 놓을 때 그룹에 든다", async () => {
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock); // 끄는 속도를 시험이 정한다(빠르면 '이탈'로 본다)
  // 그룹 틀이 카드를 품었는지는 좌표로 본다 — 카드·그룹의 style 좌표를 화면 위치로 쓴다(확대 100%·이동 0)
  await mountBoard();
  const group = () => host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"]')!;
  const count = () => group().querySelector(".scene-group-count")!.textContent;
  expect(count()).toBe("2");
  await tap(group().querySelector(".scene-group-btn")!);
  expect(group().classList.contains("collapsed")).toBe(true);
  expect([boardCard("r2"), boardCard("h1")]).toEqual([null, null]);
  await tap(group().querySelector(".scene-group-btn")!);
  expect(inCard("r2", ".scene-refthumb")).not.toBeNull();
  expect(inCard("h1", ".scene-headnode-text")!.textContent).toBe("제목");

  // 모델 카드를 그룹 틀(x 176..506, y −44..456) 안으로 천천히 끌어 놓는다 — 놓을 때 그 그룹에 든다
  await grab("m1", 700, 700);
  clock += 2000;
  await act(async () => { dragTo(260, 240); });
  clock += 2000;
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 260, clientY: 240 })); });
  expect(count()).toBe("3");
});

// ── 3·4단계 — 여러 장을 고른 끌기에서 끄는 카드의 속을 다시 그리지 않는다 ──
// 좌표는 걸음마다 상태에 들어가 카드 객체가 걸음마다 새것이 된다. 그대로 넘기면 움직이는 카드의 속(레퍼런스 158장이면 썸네일까지 316개)이
//  걸음마다 다시 그려진다. 속은 자리(x·y)를 읽지 않으므로, 끄는 동안 '자리만 다른 같은 카드'가 오면 앞서 넘긴 객체를 그대로 넘긴다.
//  위험은 '자리만 다른 것으로 잘못 보아 낡은 내용을 쥐는' 경우다 — 값이 바뀜·필드가 생김·필드가 없어짐을 길마다 본다.
//  이 그리기는 고른 카드 40장 이상을 끌 때만 켜진다(조건과 바깥 틀·끝내는 길은 sceneCardGroupMove.test.tsx).
const INNER = ["ReferenceCard", "HeadCard", "GenerationCard", "ModelCard", "SetCard"] as const;
/** 다시 그려진 memo 카드(이름 → 횟수) — 안 그려진 종류는 빠진다. */
const innerRenders = (step: Record<string, number>) => Object.fromEntries(INNER.filter((name) => step[name]).map((name) => [name, step[name]]));
const dropAt = (x: number, y: number) => { window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y })); };
/** 같이 고를 글 카드 n 장(f0 …)과 고르지 않을 한 장(zz) — 보려는 카드와 합쳐 고른 카드가 40장이 되게 채운다. */
const fillers = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind: "text", x: 2200 + (i % 10) * 220, y: Math.floor(i / 10) * 220, text: `글${i}` })),
  { id: "zz", kind: "text", x: 0, y: 4400, text: "남는 카드" },
];
/** 보드의 카드를 전부 고른 뒤 zz 만 뺀다(전부 고르면 판 밀기라 이 길이 아니다). */
const pickAllButZz = async () => {
  await press({ key: "a", code: "KeyA", ctrlKey: true });
  await click(boardCard("zz"), { ctrlKey: true });
};
const outerOf = (id: string) => [boardCard(id).style.left, boardCard(id).style.translate || "", boardCard(id).hasAttribute("data-layer-move")];

it("고른 카드 40장을 끄는 동안 카드의 속은 다시 그려지지 않는다(첫 걸음부터) — 놓을 때 한 번, 새 좌표의 카드를 받아 다시 그린다", async () => {
  setGens({ gen1: gen("gen1") });
  const scene = {
    id: "S", name: "S", created_at: 0, edges: [], groups: [],
    cards: [
      ref("r1", 0), ref("r2", 220), { id: "h1", kind: "head", x: 0, y: 330, text: "제목" },
      { id: "g1", kind: "generation", x: 220, y: 330, genId: "gen1", genIds: ["gen1"] },
      { id: "m1", kind: "model", x: 0, y: 660 }, { id: "s1", kind: "set", x: 220, y: 660 },
      ...fillers(34),
    ],
  };
  await act(async () => { root.render(<SceneBoard scene={scene as never} onChange={noop} />); });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(40);
  await grab("r1", 30, 30);
  const first = await renderedDuring(() => dragTo(74, 30)); // 첫 걸음 — 끄는 중 상태가 켜진다
  const step = await renderedDuring(() => dragTo(118, 52));
  expect([innerRenders(first), innerRenders(step)]).toEqual([{}, {}]);
  expect([outerOf("r1"), outerOf("g1")]).toEqual([["0px", "88px 22px", true], ["220px", "88px 22px", true]]);
  const drop = await renderedDuring(() => dropAt(118, 52));
  expect(innerRenders(drop)).toEqual({ ReferenceCard: 2, HeadCard: 1, GenerationCard: 1, ModelCard: 1, SetCard: 1 });
  expect(outerOf("r1")).toEqual(["88px", "", false]);
});

it("끄는 중에 카드의 내용이 바뀌면 그 카드 속을 바로 다시 그리고, 그 뒤의 걸음에서도 새 내용을 쥔다 — 필드가 생기거나 없어진 것도 내용이 바뀐 것이다", async () => {
  const head = (patch: Record<string, unknown> = {}) => ({ id: "h1", kind: "head", x: 0, y: 0, text: "가", fontSize: 48, ...patch });
  const others = fillers(39);
  let scene: Record<string, unknown> = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [head(), ...others] };
  let setScene: (next: Record<string, unknown>) => void = noop;
  function Outside() {
    const [current, set] = useState(scene);
    setScene = set;
    return <SceneBoard scene={current as never} onChange={noop} />;
  }
  await act(async () => { root.render(<Outside />); });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  // 다른 창의 편집·늦게 온 결과처럼, 부모가 내용이 다른 카드를 내려 준다(자리는 저장된 옛 자리 그대로다)
  const arrive = (card: Record<string, unknown>) => renderedDuring(() => { scene = { ...scene, cards: [card, ...others] }; setScene(scene); });
  const step = (x: number) => renderedDuring(() => dragTo(x, 30));
  const text = () => inCard("h1", ".scene-headnode-text")!;
  const look = () => [text().textContent, text().style.fontSize, text().style.color];
  const plain = look()[2]; // 색을 안 준 머리글의 기본 색

  await grab("h1", 30, 30);
  expect((await step(74)).HeadCard).toBeUndefined();
  expect(outerOf("h1")).toEqual(["0px", "44px 0px", true]);
  expect(look()).toEqual(["가", "48px", plain]);

  expect((await arrive(head({ text: "나" }))).HeadCard).toBe(1); // 값이 바뀌었다
  expect(look()).toEqual(["나", "48px", plain]);
  expect((await step(118)).HeadCard).toBeUndefined(); // 그 뒤의 걸음 — 다시 그리지 않고
  expect(look()).toEqual(["나", "48px", plain]); // 새 내용을 그대로 쥔다
  expect(outerOf("h1")).toEqual(["0px", "88px 0px", true]);

  expect((await arrive(head({ text: "나", color: "#ff0000" }))).HeadCard).toBe(1); // 필드가 생겼다
  expect(look()).toEqual(["나", "48px", "rgb(255, 0, 0)"]);
  expect((await step(162)).HeadCard).toBeUndefined();
  expect(look()).toEqual(["나", "48px", "rgb(255, 0, 0)"]);

  const noSize: Record<string, unknown> = head({ text: "나", color: "#ff0000" });
  delete noSize.fontSize;
  expect((await arrive(noSize)).HeadCard).toBe(1); // 필드가 없어졌다(값이 undefined 가 된 것이 아니라 키가 없다)
  expect(look()).toEqual(["나", "32px", "rgb(255, 0, 0)"]);
  expect((await step(206)).HeadCard).toBeUndefined();
  expect(look()).toEqual(["나", "32px", "rgb(255, 0, 0)"]);

  await act(async () => { dropAt(206, 30); });
  expect(look()).toEqual(["나", "32px", "rgb(255, 0, 0)"]);
  expect(outerOf("h1")).toEqual(["176px", "", false]);
});

it("끄는 중에 id 가 같은 카드가 있는 씬으로 바꾸면 옛 끌기의 것이 넘어가지 않는다 — 표식·translate 가 없고, 카드 속은 새 씬의 카드를 받는다", async () => {
  const open = (id: string, x: number) => renderedDuring(() => {
    const scene = { id, name: id, created_at: 0, edges: [], groups: [], cards: [{ id: "h1", kind: "head", x, y: 0, text: "가" }, ...fillers(39)] };
    root.render(<SceneBoard scene={scene as never} onChange={noop} />);
  });
  await open("S", 0);
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  await grab("h1", 30, 30);
  await act(async () => { dragTo(74, 30); });
  expect(outerOf("h1")).toEqual(["0px", "44px 0px", true]);
  const switched = await open("T", 440); // 내용은 같고 자리만 다른, id 가 같은 카드들
  expect(outerOf("h1")).toEqual(["440px", "", false]);
  expect(host.querySelectorAll(".scene-card[data-layer-move]").length).toBe(0);
  expect(switched.HeadCard).toBe(1); // 옛 씬에서 쥐고 있던 카드가 아니라 새 씬의 카드를 받았다
});

it("여러 장을 끌어 놓는 순간의 커밋도 한 번뿐이다 — 새 좌표가 들어가는 그 커밋에서 translate 와 표식이 같이 빠진다", async () => {
  await act(async () => {
    root.render(<AppLike first={{ id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: fillers(40) }} />);
  });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  const commitsDuring = async (fn: () => void) => {
    rc.commits.length = 0;
    await act(async () => { fn(); });
    return rc.commits.length;
  };
  await grab("f0", 2230, 30);
  expect(await commitsDuring(() => dragTo(2274, 30))).toBe(1);
  expect(await commitsDuring(() => dragTo(2318, 30))).toBe(1); // 걸음마다 커밋 한 번 — 좌표가 들어가고 바깥 틀의 translate 가 같이 바뀐다
  expect(outerOf("f0")).toEqual(["2200px", "88px 0px", true]);
  expect(await commitsDuring(() => dropAt(2318, 30))).toBe(1);
  expect(outerOf("f0")).toEqual(["2288px", "", false]);
});

// 끄는 동안 속에 다시 안 넘기는 것은 '자리만 다른 카드' 하나뿐이다 — 카드 밖에서 오는 값(생성물 자료·비활성 목록…)은 끄는 중에도 그대로 넘어간다.
it("끄는 중에 카드 밖의 값이 바뀌면 끌리는 카드의 속도 따라온다 — 결과가 도착하면 노드가 뜨고, 색·비활성이 바뀌면 따라 칠해진다", async () => {
  const gen1 = gen("gen1");
  setGens({}); // g1 의 결과가 아직 없다
  const first = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [{ id: "g1", kind: "generation", x: 0, y: 0, genId: "gen1", genIds: ["gen1"] }, ...fillers(39)] };
  await act(async () => { root.render(<AppLike first={first} />); });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  await grab("g1", 30, 30);
  await act(async () => { dragTo(74, 30); });
  expect([outerOf("g1"), inCard("g1", ".linb-node")]).toEqual([["0px", "44px 0px", true], null]);
  setGens({ gen1 });
  await act(async () => { rerenderBoard(); });
  expect(inCard("g1", '.linb-node[data-id="gen1"]')).not.toBeNull(); // 끌리는 카드에 결과가 떴다
  setGens({ gen1: { ...gen1, color: "#ff5722" } });
  await act(async () => { rerenderBoard(); });
  expect(inCard("g1", ".linb-colorbar")!.style.background).toBe("rgb(255, 87, 34)");
  fixture.data = { ...fixture.data, disabledIds: new Set(["gen1"]) } as unknown as SceneGenDataApi;
  await act(async () => { rerenderBoard(); });
  expect(inCard("g1", ".linb-node")!.classList.contains("disabled")).toBe(true);
  await act(async () => { dragTo(118, 30); }); // 끌기는 이어진다
  expect(outerOf("g1")).toEqual(["0px", "88px 0px", true]);
  await act(async () => { dropAt(118, 30); });
  expect(outerOf("g1")).toEqual(["88px", "", false]);
  expect(inCard("g1", ".linb-node")!.classList.contains("disabled")).toBe(true);
});

it("끄는 중에 선택이 풀리면(Esc) 같은 커밋에서 원래 그리기로 돌아간다 — 그 뒤로는 카드 속이 실제 카드를 받는다(걸음마다 다시 그려진다)", async () => {
  await act(async () => {
    root.render(<AppLike first={{ id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [{ id: "h1", kind: "head", x: 0, y: 0, text: "가" }, ...fillers(39)] }} />);
  });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await pickAllButZz();
  await grab("h1", 30, 30);
  await act(async () => { dragTo(74, 30); });
  expect((await renderedDuring(() => dragTo(118, 30))).HeadCard).toBeUndefined(); // 켜져 있는 동안 — 속은 그대로
  expect(outerOf("h1")).toEqual(["0px", "88px 0px", true]);
  rc.commits.length = 0;
  await press({ key: "Escape", code: "Escape" }); // 끄는 중의 Esc — 선택이 풀린다
  expect(rc.commits.length).toBe(1); // 선택이 풀리는 그 커밋 하나에서
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(0);
  expect([outerOf("h1"), host.querySelectorAll(".scene-card[data-layer-move]").length]).toEqual([["88px", "", false], 0]); // left 가 지금 좌표다
  const after = await renderedDuring(() => dragTo(162, 30)); // 끌기는 이어진다 — 전의 길(걸음마다 새 카드를 넘긴다)
  expect([after.HeadCard, outerOf("h1")]).toEqual([1, ["132px", "", false]]);
  await act(async () => { dropAt(162, 30); });
  expect(outerOf("h1")).toEqual(["132px", "", false]);
});

it("끄는 카드의 표식(data-layer-move)에는 캔버스 층과 같은 값 0 애니메이션이 걸린다 — 끝없이 돌지 않고, 그 기능을 모르는 브라우저에서는 걸지 않는다", () => {
  const css = readFileSync(fileURLToPath(new NodeURL("../src/styles/scene.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].includes("[data-layer-move]"));
  expect(rules.length).toBe(1); // 표식을 고르는 규칙은 하나뿐이다 — 카드의 자손을 고르는 규칙을 따로 달지 않는다
  const [, selector, body] = rules[0];
  expect(selector.split(",").map((part) => part.trim()).sort()).toEqual([".scene-canvas[data-layer-move]", ".scene-card[data-layer-move]"]);
  expect(body).toMatch(/animation:\s*scene-layer-noop\s/);
  expect(body).toMatch(/animation-composition:\s*add/);
  expect(body).not.toMatch(/infinite/);
  // @supports (animation-composition: add) 블록 바로 안에 있다 — 모르는 브라우저에서 이 애니메이션은 inline translate 를 덮어 카드가 안 움직인다
  const opened = css.lastIndexOf("@supports (animation-composition: add)", rules[0].index);
  expect(opened).toBeGreaterThanOrEqual(0);
  const between = css.slice(css.indexOf("{", opened) + 1, rules[0].index);
  expect((between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length).toBe(0);
});

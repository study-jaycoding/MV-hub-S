import { describe, expect, it } from "vitest";
import {
  appendSceneReferenceCards,
  buildSelectedConnections,
  copySceneSelection,
  moveCardsFromOrigins,
  partitionSceneDropFiles,
  pasteSceneClipboard,
  resizeSceneCard,
  scenePasteIntent,
  shouldRestoreRecipeFromDrop,
  shouldStartListReorder,
  updateSceneEjectedCards,
} from "../src/lib/sceneInteractions";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const card = (
  id: string,
  kind: SceneCard["kind"],
  x: number,
  y: number,
  extra: Partial<SceneCard> = {},
): SceneCard => ({ id, kind, x, y, ...extra });

const idSequence = (...ids: string[]) => {
  let index = 0;
  return () => ids[index++];
};

describe("partitionSceneDropFiles", () => {
  it("JSON 파일만 드롭하면 첫 파일을 씬 불러오기로 분류한다", () => {
    const first = { name: "scene.json" };
    const second = { name: "backup.JSON" };

    expect(partitionSceneDropFiles([first, second])).toEqual({
      sceneFile: first,
      mediaFiles: [],
    });
  });

  it("JSON과 미디어를 함께 드롭하면 JSON은 무시하고 미디어 업로드를 우선한다", () => {
    const image = { name: "image.png" };
    const video = { name: "clip.mp4" };

    expect(partitionSceneDropFiles([{ name: "scene.json" }, image, video])).toEqual({
      sceneFile: null,
      mediaFiles: [image, video],
    });
  });
});

describe("scenePasteIntent", () => {
  it("새 캡처 이미지는 내부 노드 복사본보다 우선한다", () => {
    expect(scenePasteIntent("20:image/png", "10:image/png", 2)).toBe("image");
  });

  it("이미 사용한 캡처가 그대로면 최근에 복사한 노드를 붙여넣는다", () => {
    expect(scenePasteIntent("20:image/png", "20:image/png", 2)).toBe("nodes");
  });

  it("복사한 노드가 없으면 같은 캡처 이미지도 다시 붙여넣을 수 있다", () => {
    expect(scenePasteIntent("20:image/png", "20:image/png", 0)).toBe("image");
    expect(scenePasteIntent(null, null, 0)).toBe("none");
  });
});

describe("shouldStartListReorder", () => {
  it("리스트만 단독 선택했을 때만 내부 썸네일 순서 변경을 시작한다", () => {
    expect(shouldStartListReorder(new Set(["list"]), "list")).toBe(true);
    expect(shouldStartListReorder(new Set(["list", "other"]), "list")).toBe(false);
    expect(shouldStartListReorder(new Set(["other"]), "list")).toBe(false);
  });
});

describe("appendSceneReferenceCards", () => {
  it("선택 생성카드 왼쪽의 다음 입력 슬롯에 레퍼런스를 놓고 연결한다", () => {
    const cards = [
      card("existing", "reference", 0, 0),
      card("target", "generation", 440, 220),
    ];
    const edges: SceneEdge[] = [{ id: "old-edge", from: "existing", to: "target" }];
    const appended = appendSceneReferenceCards({
      cards,
      edges,
      refs: [{ file_path: "asset:demo|image.png", type: "image", name: "image.png" }],
      center: { x: 0, y: 0 },
      connectToGenerationIds: ["target"],
      makeId: idSequence("new-card", "new-edge"),
      cardWidth: 220,
      cardHeight: 132,
    });

    expect(appended.createdCards).toEqual([
      expect.objectContaining({ id: "new-card", kind: "reference", x: 176, y: 374 }),
    ]);
    expect(appended.edges.at(-1)).toEqual({
      id: "new-edge",
      from: "new-card",
      to: "target",
    });
    expect(appended.connectedTargetIds).toEqual(["target"]);
  });

  it("연결 대상이 없으면 지정한 중심에 카드만 배치한다", () => {
    const appended = appendSceneReferenceCards({
      cards: [],
      edges: [],
      refs: [
        { file_path: "first.png", type: "image" },
        { file_path: "second.png", type: "image" },
      ],
      center: { x: 330, y: 198 },
      makeId: idSequence("first", "second"),
      cardWidth: 220,
      cardHeight: 132,
    });

    expect(appended.createdCards.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "first", x: 110, y: 132 },
      { id: "second", x: 330, y: 132 },
    ]);
    expect(appended.edges).toEqual([]);
    expect(appended.connectedTargetIds).toEqual([]);
  });
});

describe("moveCardsFromOrigins", () => {
  it("잡은 카드를 격자에 맞추고 선택 카드의 상대 간격을 유지한다", () => {
    const cards = [
      card("anchor", "text", 0, 0),
      card("selected", "generation", 44, 22),
      card("untouched", "reference", 200, 300),
    ];
    const origins = {
      anchor: { x: 0, y: 0 },
      selected: { x: 44, y: 22 },
    };

    const moved = moveCardsFromOrigins(cards, origins, "anchor", origins.anchor, 31, 33);

    expect(moved.changed).toBe(true);
    expect({ dx: moved.dx, dy: moved.dy }).toEqual({ dx: 22, dy: 44 });
    expect(moved.cards.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "anchor", x: 22, y: 44 },
      { id: "selected", x: 66, y: 66 },
      { id: "untouched", x: 200, y: 300 },
    ]);
  });

  it("손떨림이 같은 격자 안이면 이동하지 않고 기존 배열을 그대로 돌려준다", () => {
    const cards = [card("anchor", "text", 0, 0)];
    const result = moveCardsFromOrigins(
      cards,
      { anchor: { x: 0, y: 0 } },
      "anchor",
      { x: 0, y: 0 },
      7,
      8,
    );

    expect(result.changed).toBe(false);
    expect(result.cards).toBe(cards);
  });
});

describe("updateSceneEjectedCards", () => {
  const frames = new Map([["member", { x: 0, y: 0, w: 100, h: 100 }]]);

  it("프레임 밖이어도 느린 이동이면 그룹 이탈로 표시하지 않는다", () => {
    const current = new Set<string>();
    const result = updateSceneEjectedCards(
      current,
      frames,
      new Map([["member", { x: 120, y: 50 }]]),
      2,
      3,
    );

    expect(result.changed).toBe(false);
    expect(result.ejected).toBe(current);
    expect([...result.ejected]).toEqual([]);
  });

  it("빠르게 프레임 밖으로 나가면 이탈하고 다시 안으로 들어오면 복귀한다", () => {
    const outside = updateSceneEjectedCards(
      new Set(),
      frames,
      new Map([["member", { x: 120, y: 50 }]]),
      4,
      3,
    );
    expect([...outside.ejected]).toEqual(["member"]);

    const inside = updateSceneEjectedCards(
      outside.ejected,
      frames,
      new Map([["member", { x: 50, y: 50 }]]),
      0,
      3,
    );
    expect(inside.changed).toBe(true);
    expect([...inside.ejected]).toEqual([]);
  });
});

describe("resizeSceneCard", () => {
  it("화면 이동량을 줌으로 보정한 뒤 격자에 맞춰 크기를 바꾼다", () => {
    const cards = [card("target", "generation", 0, 0)];
    const resized = resizeSceneCard({
      cards,
      cardId: "target",
      startSize: { w: 220, h: 132 },
      clientDelta: { x: 30, y: 50 },
      zoom: 0.5,
      minSize: { w: 110, h: 66 },
    });

    expect(resized.changed).toBe(true);
    expect(resized.size).toEqual({ w: 286, h: 242 });
    expect(resized.cards[0]).toEqual(expect.objectContaining({ w: 286, h: 242 }));
  });

  it("기본 크기 안에서 발생한 손떨림은 명시적 크기나 빈 undo를 만들지 않는다", () => {
    const cards = [card("target", "generation", 0, 0)];
    const resized = resizeSceneCard({
      cards,
      cardId: "target",
      startSize: { w: 220, h: 132 },
      clientDelta: { x: 5, y: 5 },
      zoom: 1,
      minSize: { w: 110, h: 66 },
    });

    expect(resized.changed).toBe(false);
    expect(resized.cards).toBe(cards);
    expect(resized.cards[0].w).toBeUndefined();
  });

  it("아주 작게 줄여도 최소 크기보다 작아지지 않는다", () => {
    const resized = resizeSceneCard({
      cards: [card("target", "generation", 0, 0, { w: 220, h: 132 })],
      cardId: "target",
      startSize: { w: 220, h: 132 },
      clientDelta: { x: -1000, y: -1000 },
      zoom: 1,
      minSize: { w: 110, h: 66 },
    });

    expect(resized.size).toEqual({ w: 110, h: 66 });
  });
});

describe("buildSelectedConnections", () => {
  it("공간 순서대로 연결하고 이미 존재하는 선은 중복 생성하지 않는다", () => {
    const cards = [
      card("ref", "reference", 0, 0),
      card("gen", "generation", 100, 0),
      card("list", "list", 200, 0),
    ];
    const edges: SceneEdge[] = [{ id: "existing", from: "ref", to: "gen" }];

    expect(
      buildSelectedConnections(cards, edges, ["list", "ref", "gen"], idSequence("new-edge")),
    ).toEqual([{ id: "new-edge", from: "gen", to: "list" }]);
  });

  it("왼쪽에서 오른쪽 방향이 불가능하면 허용되는 반대 방향으로 연결한다", () => {
    const cards = [
      card("gen", "generation", 0, 0),
      card("ref", "reference", 100, 0),
    ];

    expect(buildSelectedConnections(cards, [], ["gen", "ref"], idSequence("edge"))).toEqual([
      { id: "edge", from: "ref", to: "gen" },
    ]);
  });

  it("카드 좌표가 같으면 기존 선택 순서를 연결 순서로 유지한다", () => {
    const cards = [
      card("first-in-array", "generation", 0, 0),
      card("first-selected", "reference", 0, 0),
    ];

    expect(
      buildSelectedConnections(
        cards,
        [],
        ["first-selected", "first-in-array"],
        idSequence("edge"),
      ),
    ).toEqual([{ id: "edge", from: "first-selected", to: "first-in-array" }]);
  });
});

describe("copySceneSelection / pasteSceneClipboard", () => {
  it("내부 선과 외부 입력만 복사하고 새 id·채널·위치를 일관되게 재매핑한다", () => {
    const cards = [
      card("external", "reference", -100, 0),
      card("output", "output", 0, 0),
      card("input", "input", 100, 0, { channel: "output" }),
      card("downstream", "generation", 200, 0),
      card("blocker", "head", 44, 44),
    ];
    const edges: SceneEdge[] = [
      { id: "incoming", from: "external", to: "input", role: "ref" },
      { id: "internal", from: "output", to: "input" },
      { id: "outgoing", from: "input", to: "downstream" },
    ];
    const clipboard = copySceneSelection(cards, edges, ["output", "input"]);

    expect(clipboard.edges.map((edge) => edge.id)).toEqual(["internal"]);
    expect(clipboard.inEdges.map((edge) => edge.id)).toEqual(["incoming"]);

    const pasted = pasteSceneClipboard(
      cards,
      edges,
      clipboard,
      idSequence("new-output", "new-input", "new-internal", "new-incoming"),
    );

    expect(pasted.shift).toBe(88);
    expect([...pasted.pastedCardIds]).toEqual(["new-output", "new-input"]);
    expect(
      pasted.cards
        .filter((item) => pasted.pastedCardIds.has(item.id))
        .map(({ id, x, y, channel }) => ({ id, x, y, channel })),
    ).toEqual([
      { id: "new-output", x: 88, y: 88, channel: undefined },
      { id: "new-input", x: 188, y: 88, channel: "new-output" },
    ]);
    expect(pasted.edges.slice(-2)).toEqual([
      { id: "new-internal", from: "new-output", to: "new-input" },
      {
        id: "new-incoming",
        from: "external",
        to: "new-input",
        role: "ref",
      },
    ]);
    expect(pasted.nextClipboard.cards.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: "output", x: 88, y: 88 },
      { id: "input", x: 188, y: 88 },
    ]);
  });

  it("기준점(at)이 있으면 상대 배치를 유지한 채 묶음 중심을 그 지점에 맞춰 붙인다", () => {
    const cards = [card("a", "reference", 0, 0), card("b", "generation", 100, 0)];
    const clipboard = copySceneSelection(cards, [], ["a", "b"]);
    const pasted = pasteSceneClipboard(
      cards,
      [],
      clipboard,
      idSequence("new-a", "new-b"),
      undefined,
      { x: 500, y: 300, cardWidth: 100, cardHeight: 60 },
    );

    // 묶음 bbox = (0,0)~(200,60) → 중심 (100,30) → 기준점 (500,300)까지 dx=400, dy=270.
    // 기존 카드와 안 겹치므로 어긋내기(shift) 없이 정확히 그 지점에 붙는다.
    expect(pasted.shift).toBe(0);
    expect(
      pasted.cards
        .filter((item) => pasted.pastedCardIds.has(item.id))
        .map(({ id, x, y }) => ({ id, x, y })),
    ).toEqual([
      { id: "new-a", x: 400, y: 270 },
      { id: "new-b", x: 500, y: 270 },
    ]);
  });

  it("기준점 자리에 기존 카드가 겹치면 그때만 어긋나게 민다", () => {
    const cards = [card("occupied", "reference", 450, 270)];
    const clipboard: ReturnType<typeof copySceneSelection> = {
      cards: [card("a", "reference", 0, 0)],
      edges: [],
      inEdges: [],
    };
    const pasted = pasteSceneClipboard(cards, [], clipboard, idSequence("new-a"), undefined, {
      x: 500,
      y: 300,
      cardWidth: 100,
      cardHeight: 60,
    });

    // 카드 한 장 bbox 중심 (50,30) → (500,300) 이동 시 (450,270)이 기존 카드와 정확히 겹침
    // → 한 칸(그리드 2배 = 44) 어긋나서 붙는다.
    expect(pasted.shift).toBe(44);
    const copied = pasted.cards.find((item) => item.id === "new-a");
    expect({ x: copied?.x, y: copied?.y }).toEqual({ x: 494, y: 314 });
  });

  it("리스트와 레퍼런스를 함께 복사하면 리스트 전용 순서 id도 새 카드 id로 바꾼다", () => {
    const cards = [
      card("ref", "reference", 0, 0),
      card("list", "list", 100, 0, { listOrder: ["ref"] }),
    ];
    const edges: SceneEdge[] = [{ id: "edge", from: "ref", to: "list" }];
    const clipboard = copySceneSelection(cards, edges, ["ref", "list"]);
    const pasted = pasteSceneClipboard(
      cards,
      edges,
      clipboard,
      idSequence("new-ref", "new-list", "new-edge"),
    );

    expect(pasted.cards.find((item) => item.id === "new-list")?.listOrder).toEqual(["new-ref"]);
  });

  it("렌더 카드와 생성카드를 함께 복사하면 '렌더 제외' 목록도 새 카드 id로 바꾼다", () => {
    // 안 바꾸면 옛 번호를 가리켜 빼놨던 체크가 전부 풀린 채 붙는다.
    const cards = [
      card("gen1", "generation", 0, 0),
      card("gen2", "generation", 100, 0),
      card("render", "render", 200, 0, { unchecked: ["gen2", "outside"] }),
    ];
    const clipboard = copySceneSelection(cards, [], ["gen1", "gen2", "render"]);
    const pasted = pasteSceneClipboard(
      cards,
      [],
      clipboard,
      idSequence("new-gen1", "new-gen2", "new-render"),
    );

    // 같이 복사된 것은 새 번호로, 이번 복사에 없던 것(outside)은 원래 카드를 가리키므로 그대로.
    expect(pasted.cards.find((item) => item.id === "new-render")?.unchecked).toEqual([
      "new-gen2",
      "outside",
    ]);
  });

  it("붙여넣은 생성카드는 설정만 오고 쌓인 결과는 딸려오지 않는다", () => {
    const cards = [
      card("gen", "generation", 0, 0, {
        genId: "g2",
        genIds: ["g1", "g2"],
        status: "done",
        prompt: "고양이",
        pendingGenerationAttempts: [{ attemptId: "a1", createdAt: 1 }],
      }),
    ];
    const clipboard = copySceneSelection(cards, [], ["gen"]);
    const pasted = pasteSceneClipboard(cards, [], clipboard, idSequence("new-gen"));

    const copied = pasted.cards.find((item) => item.id === "new-gen");
    expect(copied?.genIds).toEqual([]);
    expect(copied?.genId).toBeNull();
    expect(copied?.pendingGenerationAttempts).toEqual([]);
    expect(copied?.status).toBe("empty"); // 결과 0개인데 "완료"로 보이는 유령 카드 방지
    expect(copied?.prompt).toBe("고양이"); // 설정은 그대로 온다
    // 원본은 건드리지 않는다
    expect(cards[0].genIds).toEqual(["g1", "g2"]);
  });

  it("붙여넣은 comfy 카드는 워크플로는 남고 실행 결과만 비워진다", () => {
    const cards = [
      card("comfy", "comfy", 0, 0, {
        genIds: ["g1"],
        comfyCfg: {
          name: "wf.json",
          content: "{}",
          paramValues: { "n|seed": 7 },
          outputs: [{ kind: "image", url: "u" }],
          status: "done",
          error: "이전 오류",
        },
      }),
    ];
    const clipboard = copySceneSelection(cards, [], ["comfy"]);
    const pasted = pasteSceneClipboard(cards, [], clipboard, idSequence("new-comfy"));

    const cfg = pasted.cards.find((item) => item.id === "new-comfy")?.comfyCfg;
    expect(cfg?.name).toBe("wf.json");
    expect(cfg?.paramValues).toEqual({ "n|seed": 7 });
    expect(cfg?.outputs).toEqual([]);
    expect(cfg?.status).toBe("idle");
    expect(cfg?.error).toBeNull();
    expect(pasted.cards.find((item) => item.id === "new-comfy")?.genIds).toEqual([]);
  });

  it("다른 씬에서 외부 입력 소스가 없으면 유령 연결을 복원하지 않는다", () => {
    const clipboard = {
      cards: [card("copied", "generation", 0, 0)],
      edges: [],
      inEdges: [{ id: "old", from: "missing-source", to: "copied" }],
    };

    const pasted = pasteSceneClipboard([], [], clipboard, idSequence("new-card"));

    expect(pasted.edges).toEqual([]);
  });
});

describe("각인 파일 드롭 — 레시피 복원 판단", () => {
  const one = ["clip.mp4"];

  it("한 개만 놓으면 레시피 복원을 시도한다", () => {
    expect(shouldRestoreRecipeFromDrop(one, { hasHandler: true })).toBe(true);
  });

  it("Shift 를 누르고 놓으면 각인을 보지 않고 레퍼런스로 넣는다", () => {
    // 우리 결과물을 다시 재료(레퍼런스)로 쓰는 흐름이 막히면 안 된다.
    expect(shouldRestoreRecipeFromDrop(one, { hasHandler: true, shiftKey: true })).toBe(false);
  });

  it("여러 개를 놓으면 시도하지 않는다(씬 탭이 여러 개 열리는 것 방지)", () => {
    expect(shouldRestoreRecipeFromDrop(["a.png", "b.png"], { hasHandler: true })).toBe(false);
  });

  it("복원 핸들러가 없는 화면에서는 종전 동작 그대로", () => {
    expect(shouldRestoreRecipeFromDrop(one, { hasHandler: false })).toBe(false);
  });
});

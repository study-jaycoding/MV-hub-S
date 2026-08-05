import { describe, expect, it } from "vitest";
import {
  buildSelectedConnections,
  copySceneSelection,
  moveCardsFromOrigins,
  partitionSceneDropFiles,
  pasteSceneClipboard,
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

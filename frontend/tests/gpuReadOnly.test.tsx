// @vitest-environment jsdom
// GPU 보기 모드의 카드 읽기 형태(mode:"read") — 덧판·숨은 측정 칸이 쓴다. 변경 요소(편집 입력·포트·크기 손잡이·복사·순서·태그·실행·재사용/@/재생성·
//  공유 S·T·C·폴더 창)가 0 이고, 미리보기·정보 같은 읽기만 남는다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 readonly).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceCard } from "../src/components/scene/cards/ReferenceCard";
import { TextCard } from "../src/components/scene/cards/TextCard";
import { ModelCard } from "../src/components/scene/cards/ModelCard";
import { HeadCard } from "../src/components/scene/cards/HeadCard";
import { ListCard } from "../src/components/scene/cards/ListCard";
import { SetCard } from "../src/components/scene/cards/SetCard";
import { GenerationCard } from "../src/components/scene/cards/GenerationCard";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import type { SceneCard } from "../src/lib/scenes";
import type { Generation } from "../src/types";

vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// 변경 요소 — 이 중 하나라도 읽기 형태에 있으면 실패
const EDIT_SELECTORS = [
  ".scene-port", ".scene-resize", ".scene-copy-btn", "textarea", "input", "[contenteditable]", ".scene-headnode-ctrls",
  ".linb-ov-grip", ".linb-ov-bot", ".s-anchor", ".scene-cardgen-bar", ".scene-tagpop", ".scene-listrow-grip", ".scene-setnode-clear",
  "button.scene-multi-badge", "[draggable='true']",
];
const editCount = () => EDIT_SELECTORS.reduce((n, s) => n + host.querySelectorAll(s).length, 0);
const gen = (patch: Partial<Generation> = {}): Generation => ({
  id: "g1", prompt: "a cat", status: "done", shared: true, is_final: false, is_mine: true, tags: ["t"], auto_tags: [], deleted: false,
  assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/media/a.png", thumbnail_path: null }], references: [], created_at: "2026-11-11",
  folder_path: "proj/shots", ...patch,
} as unknown as Generation);
const filters = { disabledIds: new Set<string>(), typeFilter: "all" as const, colorFilter: new Set<string>(), tagFilter: new Set<string>(), sharedOnly: false,
  commentOnly: false, finalOnly: false, folderSel: null };

describe("카드 읽기 형태 — 변경 요소 0", () => {
  it("레퍼런스·글·모델·제목·세트", () => {
    const ref = { id: "r", kind: "reference", x: 0, y: 0, refs: [{ type: "image", file_path: "asset:p|a.png", name: "a.png" }] } as unknown as SceneCard;
    const text = { id: "t", kind: "text", x: 0, y: 0, text: "hello" } as unknown as SceneCard;
    const model = { id: "m", kind: "model", x: 0, y: 0, modelCfg: { model: "seedance", modelName: "Seedance", params: { resolution: "720p" } } } as unknown as SceneCard;
    const head = { id: "h", kind: "head", x: 0, y: 0, text: "1장" } as unknown as SceneCard;
    const set = { id: "s", kind: "set", x: 0, y: 0, setCfg: { folder: { projectId: "p", projectName: "Proj", path: "a/b" }, tagsText: "#x, y" } } as unknown as SceneCard;
    act(() => root.render(
      <>
        <ReferenceCard mode="read" card={ref} fill workspaceId="ws" getGen={() => undefined} />
        <TextCard mode="read" card={text} cardsById={new Map([["t", text]])} resolvedEdges={[]} genData={{}} />
        <ModelCard mode="read" card={model} />
        <HeadCard mode="read" card={head} />
        <SetCard mode="read" card={set} />
      </>,
    ));
    expect(editCount()).toBe(0);
    expect(host.textContent).toContain("hello");
    expect(host.textContent).toContain("1장");
    expect(host.textContent).toContain("Proj");
  });

  it("글 카드 읽기 형태는 더블클릭으로 편집에 들어가지 않는다", () => {
    const text = { id: "t", kind: "text", x: 0, y: 0, text: "hello" } as unknown as SceneCard;
    act(() => root.render(<TextCard mode="read" card={text} cardsById={new Map([["t", text]])} resolvedEdges={[]} genData={{}} />));
    act(() => host.querySelector(".scene-textview-inline")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(host.querySelector("[contenteditable]")).toBeNull();
  });

  it("리스트 — 줄 고르기·결과 창·복사/@ 단추 없이, 줄 미리보기는 남는다", () => {
    const g = { id: "c1", kind: "generation", x: 0, y: 0, genId: "g1", genIds: ["g1", "g2"] } as unknown as SceneCard;
    const list = { id: "l", kind: "list", x: 0, y: 0 } as unknown as SceneCard;
    const preview = vi.fn();
    act(() => root.render(
      <ListCard mode="read" card={list} cardsById={new Map([["c1", g], ["l", list]])} resolvedEdges={[{ id: "e", from: "c1", to: "l" }] as never}
        genData={{ g1: gen() }} disabledIds={new Set()} missingIds={new Set()} cardWidth={260} workspaceId="ws" getNodePreview={() => preview} />,
    ));
    expect(editCount()).toBe(0);
    act(() => (host.querySelector(".scene-listrow-view") as HTMLElement).click());
    expect(preview).toHaveBeenCalledTimes(1); // 읽기(크게 보기)는 그대로
  });

  it("생성 카드(완료 결과 노드) — 정보(ⓘ)·미리보기만, S·T·C·재사용·⤓·@·↻·포트·Generate 없음", () => {
    const card = { id: "c", kind: "generation", x: 0, y: 0, genId: "g1", genIds: ["g1", "g2"] } as unknown as SceneCard;
    const onInfo = vi.fn();
    act(() => root.render(
      <GenerationCard mode="read" card={card} g={gen()} variantCount={2} showNode waiting={false} genMissing={false} width={260} height={260} fill
        getNodePreview={() => () => {}} hist={{ ...filters, onInfo }} />,
    ));
    expect(editCount()).toBe(0);
    expect(host.querySelector(".scene-multi-badge")?.textContent).toContain("2"); // 결과 수는 보이되 누를 수 없다(span)
    const info = host.querySelector<HTMLButtonElement>(".ov-info")!;
    act(() => info.click());
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll(".linb-ov-btn")].map((b) => b.textContent)).toEqual([""]); // ⓘ 아이콘 하나뿐
  });

  it("HistoryBoardNode 읽기 갈래는 폴더 이름표가 있어도 우클릭 폴더 창을 걸지 않는다", () => {
    act(() => root.render(
      <HistoryBoardNode mode="read" generation={gen()} x={0} y={0} width={200} height={200} isRoot={false} isSelected={false} onLine={false} offLine={false}
        fill disabled={false} typeFilter="all" sharedOnly={false} commentOnly={false} finalOnly={false} onPreview={() => {}} onInfo={() => {}} folderChip="shots" />,
    ));
    const node = host.querySelector(".linb-node")!;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { node.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(editCount()).toBe(0);
  });
});

describe("편집 형태는 그대로", () => {
  it("모델 카드 편집 형태에는 포트·크기 손잡이가 있다", () => {
    const model = { id: "m", kind: "model", x: 0, y: 0 } as unknown as SceneCard;
    act(() => root.render(<ModelCard card={model} onOutPortDown={() => {}} onResizeDown={() => {}} />));
    expect(host.querySelectorAll(".scene-port, .scene-resize")).toHaveLength(2);
  });
});

// @vitest-environment jsdom
// 레퍼런스 종류 색 통일·오디오 표시(Jay 2026-10-29 확정 시안) — 이미지 파랑 · 영상 라임 · 오디오 보라.
//  · 레퍼런스 줄: 번호 알약이 종류 클래스를 갖고, 역할 배지는 없으며, 시작·끝 이미지(seedance)만 번호 앞 S·E 칸. 오디오 칸은 음표.
//  · 캔버스 리스트: 칸 번호도 종류 클래스, 오디오(생성물·레퍼런스)는 빗금 대신 음표 타일.
//  · 캔버스 텍스트 노드: 알약이 종류 클래스를 갖고 @simage·@eimage 는 이미지 N 의 썸네일, 연결 없는 번호는 글자 그대로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightRefTray, type SpotlightTrayRef } from "../src/components/spotlight/SpotlightRefTray";
import { ListCard } from "../src/components/scene/cards/ListCard";
import { TextCard } from "../src/components/scene/cards/TextCard";
import { emptySeedanceTokenRoles, seedanceTokenRoles } from "../src/lib/seedancePrompt";
import type { SceneCard, SceneEdge, SceneRef } from "../src/lib/scenes";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const noop = () => {};
const ref = (name: string, type: string): SceneRef => ({ type, name, file_path: `/fixtures/${name}`, thumb: type === "audio" ? null : `/fixtures/${name}` });

it("레퍼런스 줄 — 번호 알약 = 종류 클래스 · 역할 배지 없음 · 시작·끝만 S·E 칸 · 오디오 칸은 음표", () => {
  const trayRefs = [ref("a.png", "image"), ref("b.png", "image"), ref("c.png", "image"), ref("v.mp4", "video"), ref("s.wav", "audio")]
    .map((r, i) => ({ ...r, uid: `u${i}`, role: "", thumb: r.thumb || "" }) as SpotlightTrayRef);
  const tray = (model: string, text: string) => (
    <SpotlightRefTray trayRefs={trayRefs} model={model} liveSeedanceRoles={text ? seedanceTokenRoles(text) : emptySeedanceTokenRoles()}
      onDragOver={noop} onDrop={noop} onKeyDown={noop} onReorder={noop} onRemove={noop} onClearAll={noop} />
  );
  const nums = () => [...host.querySelectorAll<HTMLElement>(".sl-reftray-num")];
  act(() => root.render(tray("seedance_2_5", "@simage2 @eimage3 @image1")));
  expect(nums().map((n) => n.textContent)).toEqual(["1", "S2", "E3", "1", "1"]);
  expect(nums().map((n) => ["image", "video", "audio"].find((k) => n.classList.contains(k)))).toEqual(["image", "image", "image", "video", "audio"]);
  expect(nums().map((n) => n.classList.contains("se"))).toEqual([false, true, true, false, false]);
  expect(nums()[0].classList.contains("omni")).toBe(true); // 역할은 번호 알약의 클래스로 남는다
  expect(host.querySelector(".sl-reftray-role")).toBeNull();
  expect(host.querySelector(".sl-reftray-ph.audio")?.textContent).toBe("🎵");
  // seedance 가 아니면 S·E 도 역할 클래스도 없다(번호 색만)
  act(() => root.render(tray("nano_banana", "@simage2")));
  expect(host.querySelector(".sl-reftray-num-role")).toBeNull();
  expect(nums()[1].className).toBe("sl-reftray-num image");
});

it("캔버스 리스트 — 칸 번호 = 종류 클래스, 오디오 레퍼런스·오디오 생성물은 음표 타일", () => {
  const cards: SceneCard[] = [
    { id: "list", kind: "list", x: 0, y: 0 },
    { id: "r1", kind: "reference", x: 0, y: 0, refs: [ref("a.png", "image")] },
    { id: "r2", kind: "reference", x: 0, y: 10, refs: [ref("v.mp4", "video")] },
    { id: "r3", kind: "reference", x: 0, y: 20, refs: [ref("s.wav", "audio")] },
    { id: "g1", kind: "generation", x: 0, y: 30, genId: "gen-audio" },
  ];
  const edges: SceneEdge[] = ["r1", "r2", "r3", "g1"].map((from) => ({ id: `e-${from}`, from, to: "list" }));
  const genData = {
    "gen-audio": { id: "gen-audio", assets: [{ type: "audio", file_path: "/media/song.mp3" }] },
  } as unknown as Record<string, Generation>;
  act(() => root.render(
    <ListCard card={cards[0]} cardsById={new Map(cards.map((c) => [c.id, c]))} resolvedEdges={edges} genData={genData}
      disabledIds={new Set()} rowSel={{ listId: "", cids: new Set() }} reorderFrom={null} cardWidth={240} workspaceId="personal"
      toggleRowSel={noop} startReorder={noop} getNodePreview={() => noop} setCardMenu={noop} addListAsReference={noop}
      onOutPortDown={noop} onResizeDown={noop} />,
  ));
  const cells = [...host.querySelectorAll<HTMLElement>(".scene-listthumb")];
  expect(cells.map((c) => c.querySelector(".scene-listthumb-n")!.className)).toEqual([
    "scene-listthumb-n k-image", "scene-listthumb-n k-video", "scene-listthumb-n k-audio", "scene-listthumb-n k-audio",
  ]);
  expect(cells.map((c) => c.querySelector(".scene-listthumb-n")!.textContent)).toEqual(["1", "2", "3", "4"]);
  expect(cells.map((c) => !!c.querySelector(".audio-tile .audio-glyph"))).toEqual([false, false, true, true]);
  expect(host.querySelector(".scene-listthumb-ph")).toBeNull(); // 오디오가 빈 빗금으로 보이던 것
});

it("캔버스 텍스트 노드 — 종류별 알약 · @simage/@eimage 는 이미지 N 썸네일 · 오디오는 음표 · 연결 없는 번호는 글자", () => {
  const cards: SceneCard[] = [
    { id: "t", kind: "text", x: 0, y: 0, text: "@simage2 에서 <<<eimage1>>> 로, @image3 @video1 @audio1 @image9" },
    { id: "r1", kind: "reference", x: 0, y: 0, refs: [ref("a.png", "image"), ref("b.png", "image"), ref("c.png", "image")] },
    { id: "r2", kind: "reference", x: 0, y: 10, refs: [ref("v.mp4", "video"), ref("s.wav", "audio")] },
  ];
  const edges: SceneEdge[] = [{ id: "e1", from: "r1", to: "t" }, { id: "e2", from: "r2", to: "t" }];
  act(() => root.render(
    <TextCard card={cards[0]} cardsById={new Map(cards.map((c) => [c.id, c]))} resolvedEdges={edges} genData={{}} editing={false}
      caretPosRef={{ current: new Map() }} setEditTextId={noop} setSelected={noop} setNodeText={noop} flushPending={noop}
      onOutPortDown={noop} onResizeDown={noop} />,
  ));
  const toks = [...host.querySelectorAll<HTMLElement>(".scene-inlinetok")];
  expect(toks.map((t) => [t.className, t.textContent])).toEqual([
    ["scene-inlinetok k-start", "@simage2"],
    ["scene-inlinetok k-end", "<<<eimage1>>>"],
    ["scene-inlinetok k-image", "@image3"],
    ["scene-inlinetok k-video", "@video1"],
    ["scene-inlinetok k-audio", "🎵@audio1"],
  ]);
  expect(toks[0].querySelector("img")!.getAttribute("src")).toContain("b.png"); // 시작 = 이미지 2번
  expect(toks[1].querySelector("img")!.getAttribute("src")).toContain("a.png"); // 끝 = 이미지 1번
  expect(toks[4].querySelector(".tok-audio")).not.toBeNull();
  expect(host.querySelector(".scene-textview-inline")!.textContent).toContain("@image9"); // 연결 없는 번호는 알약 없이 글자
});

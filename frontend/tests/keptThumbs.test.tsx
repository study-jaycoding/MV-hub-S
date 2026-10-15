// @vitest-environment jsdom
// 70·71회차 격리 실측 — 씬을 떠나면 캔버스 카드의 썸네일 그림을 아무것도 쥐고 있지 않아, 다시 열 때 카드가 먼저 서고 그림은 디스크 캐시에서
//  다시 받아 0.1초쯤 뒤에 찼다(빈 썸네일 95ms·그림 요청 88). 그려진(load 끝난) 캔버스 썸네일만 최근 300장 쥔다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { MediaThumbnail } from "../src/components/MediaThumbnail";
import type { Generation } from "../src/types";
import { clearKeptThumbs, keepThumb, keptThumbSources } from "../src/lib/keptThumbs";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearKeptThumbs();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); clearKeptThumbs(); });

const load = (img: Element) => act(() => { img.dispatchEvent(new Event("load")); });

it("keeps a canvas thumbnail only once it has loaded — and keeps it after the card unmounts", () => {
  act(() => root.render(<MediaThumbnail thumb="/thumb/a.jpg" isVideo={false} keep fallback={null} />));
  expect(keptThumbSources()).toEqual([]); // 화면 밖·아직 안 그린 그림은 미리 받지 않는다
  load(host.querySelector("img")!);
  act(() => root.render(<div />)); // 씬을 떠났다
  expect(keptThumbSources()).toEqual(["/thumb/a.jpg"]);
});

it("keeps the poster of a video card (the hidden probe image)", () => {
  act(() => root.render(<MediaThumbnail thumb="/thumb/v.jpg" isVideo src="/media/v.mp4" keep fallback={null} />));
  load(host.querySelector("img")!);
  expect(keptThumbSources()).toEqual(["/thumb/v.jpg"]);
});

it("does not keep anything for thumbnails outside the canvas (keep off)", () => {
  act(() => root.render(<MediaThumbnail thumb="/thumb/lib.jpg" isVideo={false} fallback={null} />));
  load(host.querySelector("img")!);
  expect(keptThumbSources()).toEqual([]);
});

// Codex 리뷰 P2 — 썸네일이 깨져 원본으로 다시 받은 큰 그림·큰 그림은 쥐지 않는다(300장 상한만으로는 크기가 막히지 않는다)
it("does not keep the original fetched after a broken thumbnail, nor any large picture", () => {
  act(() => root.render(<MediaThumbnail thumb="/thumb/b.jpg" src="/api/assets/file?p=orig.png" isVideo={false} retrySrcOnThumbError keep fallback={null} />));
  act(() => { host.querySelector("img")!.dispatchEvent(new Event("error")); }); // 썸네일 깨짐 → 원본으로
  expect(host.querySelector("img")!.getAttribute("src")).toBe("/api/assets/file?p=orig.png");
  load(host.querySelector("img")!);
  act(() => root.render(<MediaThumbnail thumb="/thumb/huge.jpg" isVideo={false} keep fallback={null} />));
  const huge = host.querySelector("img")!;
  Object.defineProperty(huge, "naturalWidth", { value: 2048 });
  Object.defineProperty(huge, "naturalHeight", { value: 1152 });
  load(huge);
  expect(keptThumbSources()).toEqual([]);
});

it("seeing the same picture again does not make another Image", () => {
  const Real = window.Image;
  let made = 0;
  vi.stubGlobal("Image", function Counted(this: unknown, ...args: ConstructorParameters<typeof Image>) { made += 1; return new Real(...args); });
  for (let i = 0; i < 5; i += 1) keepThumb("/t/same.jpg");
  expect(made).toBe(1);
});

// Codex 리뷰 P2 — 실제 캔버스 카드가 keep 을 켠다(MediaThumbnail 에 직접 주는 시험만으로는 카드에서 빠져도 모른다)
it("a real canvas generation card keeps its thumbnail once loaded", () => {
  const noop = () => {};
  const gen = { id: "g1", prompt: "fixture", created_at: "2026-10-16T00:00:00Z", status: "done", shared: false, is_final: false, is_mine: true,
    assets: [{ type: "image", file_path: "/media/g1.png" }], references: [], tags: [], auto_tags: [] } as unknown as Generation;
  act(() => root.render(<HistoryBoardNode generation={gen} x={0} y={0} width={180} height={180} isRoot={false} isSelected={false} onLine={false}
    offLine={false} fill disabled={false} typeFilter="all" sharedOnly={false} commentOnly={false} finalOnly={false} sConfirm={null}
    onSClick={noop} onSDouble={noop} onSConfirmYes={noop} onSConfirmNo={noop} onPreview={noop} onInfo={noop} onRegenerate={noop} />));
  const img = host.querySelector("img")!;
  load(img);
  expect(keptThumbSources()).toEqual([img.getAttribute("src")]);
});

it.each(["scene/cards/ReferenceCard.tsx", "scene/cards/ComfyCard.tsx"])("the canvas %s card turns keep on for its thumbnail", (file) => {
  const source = readFileSync(new NodeURL(`../src/components/${file}`, import.meta.url), "utf8");
  const blocks = source.split("<MediaThumbnail").slice(1).map((block) => block.slice(0, block.indexOf("/>")));
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(block).toMatch(/\n\s*keep\b/);
});

it("holds the latest 300 — seeing one again makes it the newest, the oldest is let go first", () => {
  for (let i = 0; i < 300; i += 1) keepThumb(`/t/${i}.jpg`);
  keepThumb("/t/0.jpg"); // 다시 봤다 — 가장 최근으로
  keepThumb("/t/new.jpg"); // 하나 넘침 — 가장 오래 안 본 /t/1 을 놓는다
  const held = keptThumbSources();
  expect([held.length, held.includes("/t/0.jpg"), held.includes("/t/1.jpg"), held.at(-1)]).toEqual([300, true, false, "/t/new.jpg"]);
});

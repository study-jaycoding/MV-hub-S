// @vitest-environment jsdom
// 70·71회차 격리 실측 — 씬을 떠나면 캔버스 카드의 썸네일 그림을 아무것도 쥐고 있지 않아, 다시 열 때 카드가 먼저 서고 그림은 디스크 캐시에서
//  다시 받아 0.1초쯤 뒤에 찼다(빈 썸네일 95ms·그림 요청 88). 그려진(load 끝난) 캔버스 썸네일만 최근 300장 쥔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaThumbnail } from "../src/components/MediaThumbnail";
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

it("holds the latest 300 — seeing one again makes it the newest, the oldest is let go first", () => {
  for (let i = 0; i < 300; i += 1) keepThumb(`/t/${i}.jpg`);
  keepThumb("/t/0.jpg"); // 다시 봤다 — 가장 최근으로
  keepThumb("/t/new.jpg"); // 하나 넘침 — 가장 오래 안 본 /t/1 을 놓는다
  const held = keptThumbSources();
  expect([held.length, held.includes("/t/0.jpg"), held.includes("/t/1.jpg"), held.at(-1)]).toEqual([300, true, false, "/t/new.jpg"]);
});

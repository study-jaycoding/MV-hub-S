// @vitest-environment jsdom
// 크게 보기의 자리 표시 — 원본(Higgsfield CDN)이 오는 동안 창이 비어 있던 것(2026-09-20 실측: 첫 바이트 ~0.9초,
// 영상은 2~3초). 연 곳이 이미 띄운 썸네일을 그림은 바탕·영상은 표지로 깔고, 원본이 오면 걷는다.
// 계약: 썸네일이 없으면 종전과 같은 마크업 · 원본이 뜨면 자리 표시가 사라진다 · 격자는 카드와 같은 썸네일 URL 을 넘긴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fitPreviewBox, MediaPreview } from "../src/components/MediaPreview";
import { previewTargetFromGenerations } from "../src/lib/generationGrid";
import { thumbOf } from "../src/lib/media";
import type { Generation, PreviewTarget } from "../src/types";

vi.mock("../src/lib/generationViews", () => ({ recordGenerationView: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let images: FakeImage[];
class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 512;
  naturalHeight = 288;
  fetchPriority = "";
  src = "";
  constructor() {
    images.push(this);
  }
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  images = [];
  vi.stubGlobal("Image", FakeImage);
  Object.assign(window, { innerWidth: 1000, innerHeight: 1000 });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const show = (target: PreviewTarget) => act(() => root.render(<MediaPreview target={target} onClose={() => {}} />));
const thumbLoaded = () => act(() => images.filter((im) => im.src === "/t.jpg").forEach((im) => im.onload?.()));

// 51회차(Codex 검토): 끌어 옮긴 뒤 브라우저를 확대하거나 창을 줄이면 머리(제목·닫기·받기)가 화면 밖에 남아 다시 잡을 수 없었다.
it("크게 보기 창은 끌어도, 창이 줄어도 머리가 화면 안에 남는다", () => {
  const size = (name: "offsetWidth" | "offsetHeight", value: number) =>
    vi.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("media-preview") ? value : 0; });
  size("offsetWidth", 600); size("offsetHeight", 400);
  try {
    show({ url: "/o.png", type: "image", name: "n" });
    const box = () => host.querySelector<HTMLElement>(".media-preview")!;
    act(() => { host.querySelector(".info-head")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 500, clientY: 10 })); });
    act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 5000, clientY: 10, buttons: 1 })); }); // 오른쪽 끝 너머로(누른 채)
    act(() => { window.dispatchEvent(new MouseEvent("pointerup", { clientX: 5000, clientY: 10 })); });
    expect(box().style.transform).toContain("calc(-50% + 720px)"); // 왼쪽 = 200 + x ≤ 1000 − 80
    act(() => { Object.assign(window, { innerWidth: 500 }); window.dispatchEvent(new Event("resize")); }); // 확대·창 줄임
    expect(box().style.transform).toContain("calc(-50% + 470px)"); // 왼쪽 = −50 + x ≤ 500 − 80 — 전엔 720 그대로라 머리가 밖에 있었다
  } finally {
    vi.restoreAllMocks();
  }
});

it("자리 표시 크기는 원본이 놓일 상자(78vw × 74vh)에 썸네일 비율로 맞춘다", () => {
  expect(fitPreviewBox(512, 288, 1000, 1000)).toEqual({ w: 780, h: 439 }); // 가로가 먼저 닿는다
  expect(fitPreviewBox(288, 512, 1000, 1000)).toEqual({ w: 416, h: 740 }); // 세로가 먼저 닿는다
  expect(fitPreviewBox(400, 300, 1000, 1000, false)).toEqual({ w: 400, h: 300 }); // 키우지 않기
  expect(fitPreviewBox(4000, 2000, 1000, 1000, false)).toEqual({ w: 780, h: 390 }); // 큰 것은 똑같이 줄인다
});

it("그림: 썸네일을 원본 크기로 먼저 깔고, 원본이 뜨면 걷는다", () => {
  show({ url: "/o.png", type: "image", name: "n", thumb: "/t.jpg" });
  expect(host.querySelector(".media-preview-ph")).toBeNull(); // 썸네일 크기를 알기 전에는 깔지 않는다
  thumbLoaded();
  const ph = host.querySelector<HTMLImageElement>(".media-preview-ph")!;
  expect(ph.getAttribute("src")).toBe("/t.jpg");
  expect([ph.style.width, ph.style.height]).toEqual(["780px", "439px"]);
  const original = host.querySelector<HTMLImageElement>('.media-preview-stack img[alt="n"]')!;
  expect(original.getAttribute("src")).toBe("/o.png");
  act(() => { original.dispatchEvent(new Event("load")); });
  expect(host.querySelector(".media-preview-ph")).toBeNull();
  expect(host.querySelector('img[alt="n"]')).not.toBeNull();
});

it("영상: 썸네일이 표지가 되고, 재생 정보가 오면 영상의 실제 크기로, 재생이 시작되면 고정 크기를 푼다", () => {
  show({ url: "/o.mp4", type: "video", name: "n", thumb: "/t.jpg" });
  thumbLoaded();
  const video = host.querySelector("video")!;
  expect(video.getAttribute("poster")).toBe("/t.jpg");
  expect([video.style.width, video.style.height]).toEqual(["780px", "439px"]);
  // 표지를 보여 주는 동안 영상의 제 크기는 표지 크기다 — 여기서 고정 크기를 풀면 창이 썸네일 크기로 줄어든다(브라우저 실측).
  Object.defineProperties(video, { videoWidth: { value: 400 }, videoHeight: { value: 300 } });
  act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
  expect([video.style.width, video.style.height]).toEqual(["400px", "300px"]); // 상자보다 작은 영상은 키우지 않는다(종전 CSS 와 같음)
  act(() => { video.dispatchEvent(new Event("playing")); });
  expect(video.style.width).toBe("");
});

it("썸네일이 없으면 종전 마크업 그대로다 — 감싸는 칸도 자리 표시도 표지도 없다", () => {
  show({ url: "/o.png", type: "image", name: "n" });
  expect(host.querySelector(".media-preview-body")!.innerHTML).toBe('<img src="/o.png" alt="n" draggable="false">');
  expect(images.filter((im) => im.src === "/t.jpg")).toHaveLength(0);
  show({ url: "/o.mp4", type: "video", name: "n", thumb: null });
  expect(host.querySelector("video")!.hasAttribute("poster")).toBe(false);
});

it("←/→ 로 넘기면 앞 장의 자리 표시가 남지 않는다", () => {
  const items = [
    { url: "/a.png", type: "image" as const, name: "a", thumb: "/t.jpg" },
    { url: "/b.png", type: "image" as const, name: "b" },
  ];
  show({ ...items[0], items, index: 0 });
  thumbLoaded();
  expect(host.querySelector(".media-preview-ph")).not.toBeNull();
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })); });
  expect(host.querySelector(".media-preview-ph")).toBeNull();
  expect(host.querySelector('img[alt="b"]')!.getAttribute("src")).toBe("/b.png");
});

// 56회차(Codex): 격자처럼 Alt+←/→ 는 브라우저의 뒤로/앞으로(앱의 화면 기록)다 — 크게 보기만 장 넘기기로 가로챘다.
it("Alt+←/→ 는 장을 넘기지 않고 브라우저에 맡긴다", () => {
  const items = [
    { url: "/a.png", type: "image" as const, name: "a" },
    { url: "/b.png", type: "image" as const, name: "b" },
  ];
  show({ ...items[0], items, index: 0 });
  const event = new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, cancelable: true });
  act(() => { window.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(false);
  expect(host.querySelector('img[alt="a"]')).not.toBeNull();
});

it("A→B→A 로 돌아오면 A 의 원본이 다시 뜰 때까지 자리 표시가 다시 깔린다", () => {
  const items = [
    { url: "/a.png", type: "image" as const, name: "a", thumb: "/t.jpg" },
    { url: "/b.png", type: "image" as const, name: "b", thumb: "/t.jpg" },
  ];
  const go = (key: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
  show({ ...items[0], items, index: 0 });
  thumbLoaded();
  act(() => { host.querySelector('img[alt="a"]')!.dispatchEvent(new Event("load")); });
  expect(host.querySelector(".media-preview-ph")).toBeNull();
  go("ArrowRight");
  go("ArrowLeft");
  expect(host.querySelector(".media-preview-ph")).not.toBeNull(); // 새로 마운트된 A 는 아직 안 떴다
});

it("격자는 카드가 띄운 것과 같은 썸네일 URL 을 넘긴다(같은 폭) — 달라지면 캐시에서 안 뜬다", () => {
  const gen = (id: string) =>
    ({ id, prompt: "p", assets: [{ id: `a-${id}`, type: "image", file_path: `/media/${id}.png`, thumbnail_path: null }] }) as unknown as Generation;
  const gens = [gen("g1"), gen("g2")];
  const target = previewTargetFromGenerations(gens, gens[1], 256)!;
  expect(target.thumb).toBe(thumbOf(gens[1], 256));
  expect(target.thumb).not.toBe(thumbOf(gens[1], 512));
  expect(target.items!.map((it) => it.thumb)).toEqual(gens.map((g) => thumbOf(g, 256)));
});

it("창 뒤의 단추에 초점이 남아 있어도 Space·Enter 는 이 창의 것이다 — 그 단추를 다시 누르지 않는다. 창 안 단추·글자 입력은 그대로", () => {
  // 2026-10-10 실측: 컷 정보의 썸네일(단추)로 크게 보기를 열면 초점이 그 단추에 남고, Space 가 그 단추를 다시 눌러 보던 장이 처음 것으로
  //  돌아갔다(기록이 한 겹 더 쌓여 Esc 도 두 번 필요했다).
  const opener = document.createElement("button");
  const typing = document.createElement("input");
  document.body.append(opener, typing);
  try {
    show({ url: "/a.png", type: "image", name: "a" });
    const press = (key: string, target: EventTarget) => {
      const event = new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(press(" ", opener)).toBe(true);
    expect(press("Enter", opener)).toBe(true);
    expect(press(" ", document.body)).toBe(true);
    expect(press(" ", host.querySelector(".media-preview button")!)).toBe(false); // 창 안 단추는 그 단추가 받는다
    expect(press(" ", typing)).toBe(false); // 글자 입력(코멘트 패널 등)
  } finally {
    opener.remove();
    typing.remove();
  }
});

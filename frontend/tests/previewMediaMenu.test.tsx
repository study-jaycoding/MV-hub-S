// @vitest-environment jsdom
// 크게 보기 우클릭(Jay 2026-10-22): 그냥 우클릭 = 앱 메뉴(캡쳐·저장 + 단축키 표시) · Ctrl = 바로 캡쳐 · Ctrl+Shift = 바로 저장 ·
// Alt = 브라우저 원래 메뉴. 메뉴 바깥 누름·Esc 는 메뉴만 닫고 크게 보기는 남는다. 그림을 실제로 뜨는 것은 격리 크롬 실측이 맡는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewTarget } from "../src/types";

const capture = vi.hoisted(() => ({
  copyPng: vi.fn(async (_png: Promise<Blob>) => "ok" as const),
  saveBlobAs: vi.fn(async (_blob: Promise<Blob>, _name: string) => "saved" as const),
  imagePng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  videoFramePng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));
vi.mock("../src/lib/mediaCapture", () => capture);
vi.mock("../src/lib/generationViews", () => ({ recordGenerationView: vi.fn() }));
vi.mock("../src/lib/download", async (original) => ({
  ...(await original<typeof import("../src/lib/download")>()),
  fetchBlob: vi.fn(async () => new Blob(["img"], { type: "image/png" })),
}));

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(capture).forEach((fn) => fn.mockClear());
  onClose = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function show(target: PreviewTarget) {
  const { MediaPreview } = await import("../src/components/MediaPreview");
  act(() => root.render(<MediaPreview target={target} onClose={onClose} />));
}
const media = () => host.querySelector<HTMLElement>(".media-preview-body video, .media-preview-body img, .media-preview-body audio")!;
function rightClick(init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 200, ...init });
  act(() => { media().dispatchEvent(event); });
  return event;
}
const menu = () => document.body.querySelector(".preview-menu");
const rows = () => [...document.body.querySelectorAll(".preview-menu-item")].map((row) => [row.querySelector("span")?.textContent, row.querySelector("kbd")?.textContent]);
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

const IMAGE: PreviewTarget = { url: "/o.png", type: "image", name: "n" };
const VIDEO: PreviewTarget = { url: "https://cdn.example/v.mp4", type: "video", name: "v", genId: "gen-12345678" };

describe("크게 보기 우클릭", () => {
  it("이미지·영상의 그냥 우클릭은 앱 메뉴(이름 + 단축키)를 띄우고 브라우저 메뉴를 막는다", async () => {
    await show(IMAGE);
    expect(rightClick().defaultPrevented).toBe(true);
    expect(rows()).toEqual([["이미지 캡쳐", "Ctrl+우클릭"], ["이미지 저장", "Ctrl+Shift+우클릭"]]);
    act(() => { document.body.querySelector(".preview-menu-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await show(VIDEO);
    rightClick();
    expect(rows()).toEqual([["프레임 캡쳐", "Ctrl+우클릭"], ["프레임 저장", "Ctrl+Shift+우클릭"]]);
  });

  it("Shift+우클릭·Alt+우클릭은 브라우저 원래 메뉴 — 막지도 띄우지도 않는다(윈도 크롬은 Alt 를 누른 채면 메뉴를 닫아 Shift 가 확실한 길)", async () => {
    await show(VIDEO);
    expect(rightClick({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(rightClick({ altKey: true }).defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(capture.copyPng).not.toHaveBeenCalled();
    expect(capture.saveBlobAs).not.toHaveBeenCalled();
  });

  it("Ctrl+우클릭은 메뉴 없이 바로 캡쳐, Ctrl+Shift+우클릭은 바로 저장(영상 = 그 시각의 PNG 이름)", async () => {
    await show(VIDEO);
    expect(rightClick({ ctrlKey: true }).defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(capture.copyPng).toHaveBeenCalledTimes(1);
    expect(capture.videoFramePng).toHaveBeenCalledTimes(1);
    rightClick({ ctrlKey: true, shiftKey: true });
    expect(menu()).toBeNull();
    expect(capture.saveBlobAs).toHaveBeenCalledTimes(1);
    expect(capture.saveBlobAs.mock.calls[0][1]).toBe("v-gen-1234_0.00s.png");
    await settle();
  });

  it("이미지 저장은 원본 그대로의 이름으로, 메뉴 줄을 누르면 그 동작 뒤 메뉴가 닫힌다", async () => {
    await show(IMAGE);
    rightClick();
    act(() => { (document.body.querySelectorAll<HTMLButtonElement>(".preview-menu-item")[1]).click(); });
    expect(menu()).toBeNull();
    expect(capture.saveBlobAs.mock.calls[0][1]).toBe("n.png");
    rightClick();
    act(() => { document.body.querySelector<HTMLButtonElement>(".preview-menu-item")!.click(); });
    expect(capture.copyPng).toHaveBeenCalledTimes(1);
    expect(capture.imagePng).toHaveBeenCalledWith("/o.png", "n");
    await settle();
  });

  it("메뉴 바깥 누름·Esc 는 메뉴만 닫는다 — 크게 보기는 남고, 다음 Esc 에 닫힌다", async () => {
    await show(IMAGE);
    rightClick();
    act(() => { document.body.querySelector(".preview-menu-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    rightClick();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("키보드로도 쓴다 — 열면 첫 줄에 초점, ↑↓·Tab 은 메뉴 안에서 돌고, 줄 위의 Enter·Space 는 영상 재생 키가 가로채지 않는다", async () => {
    await show(VIDEO);
    rightClick();
    const items = [...document.body.querySelectorAll<HTMLButtonElement>(".preview-menu-item")];
    expect(document.activeElement).toBe(items[0]);
    act(() => { items[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[1]);
    act(() => { items[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(items[0]);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { items[0].focus(); });
    act(() => { items[1].focus(); items[1].dispatchEvent(tab); }); // 끝 줄의 Tab → 첫 줄(창 뒤로 새지 않는다)
    expect(document.activeElement).toBe(items[0]);
    for (const key of ["Enter", " "]) {
      const press = new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : "Enter", bubbles: true, cancelable: true });
      act(() => { items[0].dispatchEvent(press); });
      expect(press.defaultPrevented).toBe(false); // 막으면 Enter 는 안 먹고 Space 는 영상 재생/정지가 된다
    }
  });

  it("오디오는 손대지 않는다", async () => {
    await show({ url: "/a.mp3", type: "audio", name: "a" });
    expect(rightClick().defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });
});

describe("클립보드·저장(lib/mediaCapture 실물)", () => {
  const real = () => vi.importActual<typeof import("../src/lib/mediaCapture")>("../src/lib/mediaCapture");
  const png = new Blob(["png"], { type: "image/png" });

  it("CDN 영상은 누른 순간의 시각으로 CORS 사본을 옮겨 뜬다 — 사본을 읽는 사이 원본이 흘러가도", async () => {
    const { videoFramePng } = await real();
    const video = document.createElement("video");
    Object.defineProperties(video, {
      videoWidth: { value: 854 }, videoHeight: { value: 480 },
      currentSrc: { value: "https://cdn.example/v.mp4" }, currentTime: { value: 1.5, writable: true },
    });
    let encodes = 0;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (done: BlobCallback) {
      encodes += 1;
      if (encodes === 1) throw new DOMException("tainted", "SecurityError"); // 보이는 영상은 다른 출처라 막힌다
      done(png);
    });
    const copies: HTMLVideoElement[] = [];
    const make = document.createElement.bind(document);
    const create = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = make(tag);
      if (tag === "video") {
        Object.defineProperty(element, "currentTime", { value: 0, writable: true });
        Object.defineProperty(element, "load", { value: () => {} });
        copies.push(element as HTMLVideoElement);
      }
      return element;
    }) as typeof document.createElement);
    try {
      const task = videoFramePng(video);
      await vi.waitFor(() => expect(copies).toHaveLength(1));
      video.currentTime = 9; // 사본을 읽는 동안 원본은 계속 재생된다
      const [copy] = copies;
      expect(copy.crossOrigin).toBe("anonymous");
      expect(copy.src).toBe("https://cdn.example/v.mp4");
      copy.dispatchEvent(new Event("loadedmetadata"));
      await vi.waitFor(() => expect(copy.currentTime).toBe(1.5));
      copy.dispatchEvent(new Event("seeked"));
      expect(await task).toBe(png);
    } finally {
      create.mockRestore();
      toBlob.mockRestore();
      getContext.mockRestore();
    }
  });

  it("저장 창이 있으면 그 파일에 쓰고, 취소면 cancelled, 그림을 못 만들면 쓰던 것을 버린다", async () => {
    const { saveBlobAs } = await real();
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    vi.stubGlobal("showSaveFilePicker", picker);
    expect(await saveBlobAs(Promise.resolve(png), "a.png")).toBe("saved");
    expect(picker).toHaveBeenCalledWith({ suggestedName: "a.png" });
    expect(writable.write).toHaveBeenCalledWith(png);
    expect(await saveBlobAs(Promise.reject(new Error("x")), "b.png")).toBe("failed");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    picker.mockRejectedValueOnce(new DOMException("cancel", "AbortError"));
    expect(await saveBlobAs(Promise.resolve(png), "c.png")).toBe("cancelled");
  });

  it("저장 창이 없는 환경은 그 이름으로 내려받는다", async () => {
    const { saveBlobAs } = await real();
    vi.stubGlobal("showSaveFilePicker", undefined);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download); });
    try {
      expect(await saveBlobAs(Promise.resolve(png), "d.png")).toBe("downloaded");
      expect(clicks).toEqual(["d.png"]);
    } finally {
      click.mockRestore();
    }
  });

  it("클립보드 실패는 까닭을 가른다 — 그림을 못 만듦(media) / 브라우저가 막음(clipboard)", async () => {
    const { copyPng } = await real();
    vi.stubGlobal("ClipboardItem", class { constructor(public items: unknown) {} });
    const write = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { write } });
    expect(await copyPng(Promise.resolve(png))).toBe("ok");
    write.mockRejectedValueOnce(new Error("denied"));
    expect(await copyPng(Promise.resolve(png))).toBe("clipboard");
    write.mockRejectedValueOnce(new Error("blob rejected"));
    expect(await copyPng(Promise.reject(new Error("load")))).toBe("media");
    vi.stubGlobal("ClipboardItem", undefined);
    expect(await copyPng(Promise.resolve(png))).toBe("clipboard");
  });
});

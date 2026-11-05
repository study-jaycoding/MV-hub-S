// @vitest-environment jsdom
// 크게 보기 우클릭(Jay 2026-10-22): 그냥 우클릭 = 앱 메뉴(캡쳐·저장 + 단축키 표시) · Ctrl = 바로 캡쳐 · Ctrl+Shift = 바로 저장 ·
// Alt = 브라우저 원래 메뉴. 메뉴 바깥 누름·Esc 는 메뉴만 닫고 크게 보기는 남는다. 그림을 실제로 뜨는 것은 격리 크롬 실측이 맡는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
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

// 머리줄 수정 단추 — 결과 종류에 맞는 것 하나만(생성 정보 창과 같은 규칙 · Jay 2026-10-28). 받는 쪽(PartialEditHost)은 mode 로 창을 고른다.
describe("크게 보기 수정 단추", () => {
  const editButton = () => host.querySelector<HTMLButtonElement>(".preview-edit-btn");

  it("영상은 [영상 수정] → mode=video, 이미지는 [이미지 수정] → mode=image 로 쏘고 창을 닫는다", async () => {
    const sent: unknown[] = [];
    const listen = (e: Event) => sent.push((e as CustomEvent).detail);
    window.addEventListener(APP_EVENTS.partialEdit, listen);
    try {
      await show(VIDEO);
      expect(editButton()?.textContent).toBe("🖌 영상 수정");
      act(() => editButton()!.click());
      expect(sent).toEqual([{ genId: "gen-12345678", mode: "video" }]);
      expect(onClose).toHaveBeenCalledTimes(1);
      await show({ ...IMAGE, genId: "gen-image" });
      expect(editButton()?.textContent).toBe("🖌 이미지 수정");
      act(() => editButton()!.click());
      expect(sent).toEqual([{ genId: "gen-12345678", mode: "video" }, { genId: "gen-image", mode: "image" }]);
      expect(onClose).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(APP_EVENTS.partialEdit, listen);
    }
  });

  it("오디오와 생성물이 아닌 파일(genId 없음)에는 수정 단추가 없다", async () => {
    await show({ url: "/a.mp3", type: "audio", name: "a", genId: "gen-audio" });
    expect(editButton()).toBeNull();
    await show(IMAGE);
    expect(editButton()).toBeNull();
    await show({ ...VIDEO, genId: undefined });
    expect(editButton()).toBeNull();
  });
});

// 머리줄 맨 왼쪽 C(Jay 2026-11-05) — 색은 카드 C 와 같은 규칙(없음 = 테두리 · 있음 = 라임 · 새 코멘트 = 호박색). 누르거나 c → 코멘트 모드,
//  떠 있는 동안 크게 보기의 키는 쉰다. 생성물만(에셋·오디오는 1단계 밖), 그림을 아는 허브만.
describe("크게 보기 코멘트 C", () => {
  const cButton = () => host.querySelector<HTMLButtonElement>(".cm-cbtn");
  const modal = () => document.body.querySelector(".cm-modal");
  let restore: (() => void)[] = [];
  beforeEach(async () => {
    const { api } = await import("../src/api");
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    setHubFeatures(["comment_drawings_v1"]);
    const counts = vi.spyOn(api, "commentCounts").mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, id === "gen-new" ? { comment_count: 1, has_unread: true } : id === "gen-12345678" ? { comment_count: 2, has_unread: false } : { comment_count: 0, has_unread: false }])));
    const list = vi.spyOn(api, "genComments").mockResolvedValue([]);
    restore = [() => counts.mockRestore(), () => list.mockRestore(), () => setHubFeatures([])];
  });
  afterEach(() => restore.forEach((undo) => undo()));

  it("상태는 그 장의 코멘트 수 — 있음 = on, 새 코멘트 = alert, 없음 = 테두리", async () => {
    await show(VIDEO);
    await settle();
    expect(cButton()?.className).toBe("lin-board-btn cm-cbtn on");
    expect(cButton()?.title).toBe("코멘트 2개 (c)");
    expect(host.querySelector(".preview-head-actions")!.firstElementChild).toBe(cButton()); // 맨 왼쪽
    await show({ ...IMAGE, genId: "gen-new" });
    await settle();
    expect(cButton()?.className).toBe("lin-board-btn cm-cbtn alert");
    await show({ ...IMAGE, genId: "gen-empty" });
    await settle();
    expect(cButton()?.className).toBe("lin-board-btn cm-cbtn");
    expect(cButton()?.title).toBe("코멘트 달기 (c)");
  });

  it("오디오·에셋(genId 없음)·그림을 모르는 허브에는 C 가 없다", async () => {
    await show({ url: "/a.mp3", type: "audio", name: "a", genId: "gen-audio" });
    expect(cButton()).toBeNull();
    await show(IMAGE);
    expect(cButton()).toBeNull();
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    setHubFeatures([]);
    await show({ ...VIDEO, genId: "gen-other" });
    expect(cButton()).toBeNull();
  });

  it("c 를 누르면 코멘트 모드가 뜨고, 그동안 ←/→ 는 크게 보기 장을 넘기지 않는다 · Esc 는 코멘트 모드만 닫는다", async () => {
    const items = [{ ...VIDEO, url: "/a.mp4", genId: "gen-a" }, { ...VIDEO, url: "/b.mp4", genId: "gen-b" }];
    await show({ ...items[0], items, index: 0 });
    await settle();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true })); });
    expect(modal()).not.toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(host.querySelector(".preview-count")?.textContent?.trim()).toBe("1/2");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(modal()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await settle();
  });

  it("코멘트 창의 그림을 누르면 보고 있는 크게 보기가 받아 원본 위에 겹친다(띠 = 작성자·시각·끄기)", async () => {
    await show(VIDEO);
    await settle();
    const view = { genId: "gen-12345678", commentId: "c1", author: "팀원 A",
      drawing: { id: "d1", idx: 0, kind: "video" as const, width: 854, height: 480, time_sec: 1.5, has_thumb: false, content_hash: "h", v: 1 as const } };
    const event = new CustomEvent(APP_EVENTS.commentDrawingView, { detail: view, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true); // 받았다 — 코멘트 창은 크게 보기를 새로 열지 않는다
    expect(host.querySelector(".cm-viewing")?.textContent).toContain("팀원 A");
    expect(host.querySelector(".cm-viewing")?.textContent).toContain("1.50초");
    const other = new CustomEvent(APP_EVENTS.commentDrawingView, { detail: { ...view, genId: "gen-other" }, cancelable: true });
    act(() => { window.dispatchEvent(other); });
    expect(other.defaultPrevented).toBe(false); // 다른 생성물의 그림은 받지 않는다
    act(() => { host.querySelector<HTMLButtonElement>(".cm-viewing button")!.click(); });
    expect(host.querySelector(".cm-viewing")).toBeNull();
    await settle();
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

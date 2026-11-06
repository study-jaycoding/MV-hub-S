// @vitest-environment jsdom
// 크게 보기 우클릭(Jay 2026-10-22): 그냥 우클릭 = 앱 메뉴(캡쳐·저장 + 단축키 표시) · Ctrl = 바로 캡쳐 · Ctrl+Shift = 바로 저장 ·
// Alt = 브라우저 원래 메뉴. 메뉴 바깥 누름·Esc 는 메뉴만 닫고 크게 보기는 남는다. 그림을 실제로 뜨는 것은 격리 크롬 실측이 맡는다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
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
vi.mock("../src/lib/generationViews", () => ({ recordGenerationView: vi.fn(), TEAM_SCOPE: "@team" }));
vi.mock("../src/lib/download", async (original) => ({
  ...(await original<typeof import("../src/lib/download")>()),
  fetchBlob: vi.fn(async () => new Blob(["img"], { type: "image/png" })),
  downloadGeneration: vi.fn(),
  downloadOne: vi.fn(),
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

// 앱이 크게 보기에 넘기는 카드 동작(AppOverlays previewCardActions) — 이것을 받은 생성물에만 Ctrl 카드가 뜬다
const actions = () => ({
  canFinalize: () => false, onReview: vi.fn(), onPublish: vi.fn(), onUnpublish: vi.fn(), onFinalize: vi.fn(), onUnfinalize: vi.fn(),
  onSetTags: vi.fn(), onSetAutoTags: vi.fn(), autoTagOptions: [], onRegenerate: vi.fn(), onImport: vi.fn(), onInfo: vi.fn(),
  onOpenComments: vi.fn(), onOpenFolder: vi.fn(), myCreatorUid: "me",
});
async function show(target: PreviewTarget, cardActions?: ReturnType<typeof actions>) {
  const { MediaPreview } = await import("../src/components/MediaPreview");
  act(() => root.render(<MediaPreview target={target} onClose={onClose} cardActions={cardActions} />));
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

  it("이름은 이미지·영상 모두 [Edit] — 영상은 mode=video, 이미지는 mode=image 로 쏘고 창을 닫는다", async () => {
    const sent: unknown[] = [];
    const listen = (e: Event) => sent.push((e as CustomEvent).detail);
    window.addEventListener(APP_EVENTS.partialEdit, listen);
    try {
      await show(VIDEO);
      expect(editButton()?.textContent).toBe("🖌 Edit");
      act(() => editButton()!.click());
      expect(sent).toEqual([{ genId: "gen-12345678", mode: "video" }]);
      expect(onClose).toHaveBeenCalledTimes(1);
      await show({ ...IMAGE, genId: "gen-image" });
      expect(editButton()?.textContent).toBe("🖌 Edit");
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

// 코멘트 모드(Jay 2026-11-05) — c 키·Ctrl 카드의 C 로 연다(머리줄 C 는 시안 ⑩에서 뺐다). 떠 있는 동안 크게 보기의 키는 쉰다.
//  생성물만(에셋·오디오는 1단계 밖), 그림을 아는 허브만.
describe("크게 보기 코멘트 모드", () => {
  const modal = () => document.body.querySelector(".cm-modal");
  const pressC = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true })); });
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

  it("머리줄 = [Edit] [History] 만 — 코멘트 C·다운로드는 없다(Ctrl 카드 단추에 있다)", async () => {
    const { MediaPreview } = await import("../src/components/MediaPreview");
    act(() => root.render(<MediaPreview target={VIDEO} onClose={onClose} onOpenInBoard={vi.fn()} cardActions={actions()} />));
    await settle();
    const head = [...host.querySelectorAll(".preview-head-actions button")].map((b) => b.textContent);
    expect(head).toEqual(["🖌 Edit", "⧉ History"]);
    expect(host.querySelector(".cm-cbtn, .preview-dl-btn")).toBeNull();
  });

  it("오디오만 머리줄에 받기 아이콘 단추(시안 ⑱) — 생성물은 앱 이름 규칙(downloadGeneration), 어셋은 파일 이름 그대로(downloadOne)", async () => {
    const { downloadGeneration, downloadOne } = await import("../src/lib/download");
    vi.mocked(downloadGeneration).mockClear();
    vi.mocked(downloadOne).mockClear();
    const dl = () => host.querySelector<HTMLButtonElement>(".preview-head-actions .preview-dl-btn");
    await show({ url: "/media/s.mp3", type: "audio", name: "신호음", genId: "gen-audio-1" });
    expect(dl()?.getAttribute("aria-label")).toBe("다운로드");
    expect(dl()?.textContent).toBe(""); // 글 없이 아이콘만
    act(() => dl()!.click());
    expect(downloadGeneration).toHaveBeenCalledWith("/media/s.mp3", "gen-audio-1", "신호음-gen-audi.mp3");
    await show({ url: "/files/p/bgm.mp3", type: "audio", name: "bgm.mp3", assetPath: "bgm.mp3" });
    act(() => dl()!.click());
    expect(downloadOne).toHaveBeenCalledWith("/files/p/bgm.mp3", "bgm.mp3");
    for (const t of [VIDEO, { ...IMAGE, genId: "gen-image" }]) {
      await show(t, actions());
      expect(dl()).toBeNull(); // 카드가 뜨는 이미지·영상은 Ctrl 카드 단추의 ⤓
    }
  });

  it("Ctrl 카드를 못 띄우는 이미지·영상도 머리줄 ⤓ 로 받는다 — 정보 창의 레퍼런스(genId·assetPath 없음)·카드 동작을 못 받은 생성물(Codex 묶음 리뷰 11-05)", async () => {
    const { downloadGeneration, downloadOne } = await import("../src/lib/download");
    vi.mocked(downloadGeneration).mockClear();
    vi.mocked(downloadOne).mockClear();
    const dl = () => host.querySelector<HTMLButtonElement>(".preview-head-actions .preview-dl-btn");
    await show({ url: "https://cdn.example/ref.mp4", type: "video", name: "source" });
    act(() => dl()!.click());
    expect(downloadOne).toHaveBeenCalledWith("https://cdn.example/ref.mp4", expect.any(String));
    await show(IMAGE);
    expect(dl()).not.toBeNull();
    await show(VIDEO); // genId 는 있지만 카드 동작을 못 받은 곳
    act(() => dl()!.click());
    expect(downloadGeneration).toHaveBeenCalledWith(VIDEO.url, VIDEO.genId, expect.any(String));
  });

  it("입력칸에서 누른 ←/→ 는 장을 넘기지 않는다(Ctrl 카드 태그 입력 등) — 입력칸 밖에서는 넘긴다(Codex 묶음 리뷰 11-05)", async () => {
    const items = [{ ...VIDEO, url: "/a.mp4", genId: "gen-a" }, { ...VIDEO, url: "/b.mp4", genId: "gen-b" }];
    await show({ ...items[0], items, index: 0 });
    await settle();
    const input = document.createElement("input");
    host.querySelector(".media-preview")!.append(input);
    const fromInput = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(fromInput); });
    expect(fromInput.defaultPrevented).toBe(false); // 커서 이동은 입력칸 몫
    expect(host.querySelector(".preview-count")?.textContent?.trim()).toBe("1/2");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(host.querySelector(".preview-count")?.textContent?.trim()).toBe("2/2");
    input.remove();
    await settle();
  });

  it("오디오·에셋(genId 없음)·그림을 모르는 허브에서는 c 가 코멘트 모드를 열지 않는다", async () => {
    await show({ url: "/a.mp3", type: "audio", name: "a", genId: "gen-audio" });
    pressC();
    expect(modal()).toBeNull();
    await show(IMAGE);
    pressC();
    expect(modal()).toBeNull();
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    setHubFeatures([]);
    await show({ ...VIDEO, genId: "gen-other" });
    pressC();
    expect(modal()).toBeNull();
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

// Ctrl 카드 단추(Jay 2026-11-05 시안 ⑩·⑪) — 누르고 있는 동안 원본 위에 격자 카드(생성물)·어셋 칸(등록된 그리기)이 뜬다.
//  뜬 단추를 누르면 떼도 남고, 단추 밖을 누르면 걷힌다. 카드의 C = 이 창의 코멘트 모드.
describe("크게 보기 Ctrl 카드 단추", () => {
  const GEN = { id: "g1", prompt: "운동장", shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-11-05",
    assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/media/g1.png", thumbnail_path: null }],
    references: [], tags: [], auto_tags: [], deleted: false, project_id: "p1", project_name: "P", folder_path: "e001/c0010",
    comment_count: 1, has_unread: true } as unknown as import("../src/types").Generation;
  const TARGET: PreviewTarget = { url: "/media/g1.png", type: "image", name: "운동장", genId: "g1" };
  const layer = () => host.querySelector<HTMLElement>(".mp-card-layer");
  const ctrl = (type: "keydown" | "keyup") =>
    act(() => { window.dispatchEvent(new KeyboardEvent(type, { key: "Control", ctrlKey: type === "keydown", bubbles: true })); });
  const press = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  let restore: (() => void)[] = [];
  beforeEach(async () => {
    const { api } = await import("../src/api");
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    setHubFeatures(["comment_drawings_v1"]);
    const getGen = vi.spyOn(api, "getGeneration").mockResolvedValue(GEN);
    const list = vi.spyOn(api, "genComments").mockResolvedValue([]);
    // 원본이 그려진 사각형 — jsdom 은 크기를 재지 않는다
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) } as DOMRect);
    const proto = HTMLImageElement.prototype;
    const nw = Object.getOwnPropertyDescriptor(proto, "naturalWidth");
    const nh = Object.getOwnPropertyDescriptor(proto, "naturalHeight");
    Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(proto, "naturalHeight", { configurable: true, get: () => 600 });
    restore = [() => getGen.mockRestore(), () => list.mockRestore(), () => rect.mockRestore(), () => setHubFeatures([]), () => {
      if (nw) Object.defineProperty(proto, "naturalWidth", nw);
      if (nh) Object.defineProperty(proto, "naturalHeight", nh);
    }];
  });
  afterEach(() => restore.forEach((undo) => undo()));

  async function showCard(target: PreviewTarget, cardActions?: ReturnType<typeof actions>) {
    const { MediaPreview } = await import("../src/components/MediaPreview");
    act(() => root.render(<MediaPreview target={target} onClose={onClose} cardActions={cardActions} />));
    await settle();
  }

  it("생성물: Ctrl 을 누르는 동안 카드 단추(S·T·C·ⓘ·⤓·@·↻·폴더)가 원본 사각형에 뜨고, 떼면 사라진다", async () => {
    await showCard(TARGET, actions());
    expect(layer()).toBeNull();
    ctrl("keydown");
    await settle();
    expect(layer()?.style.width).toBe("400px");
    expect([...layer()!.querySelectorAll(".card-tl button")].map((b) => b.textContent)).toEqual(["S", "T", "C"]);
    expect(layer()!.querySelector(".card-tl button:last-child")?.className).toContain("alert"); // 새 코멘트
    expect(layer()!.querySelector(".ov-info")).not.toBeNull();
    expect([...layer()!.querySelectorAll(".ov-bottom button")].map((b) => b.textContent)).toEqual(["⤓", "@", "↻"]);
    expect(layer()!.querySelector(".card-folder")?.textContent).toBe("e001 c0010");
    ctrl("keyup");
    expect(layer()).toBeNull();
  });

  it("카드의 C = 이 창의 코멘트 모드(그 동안 카드 단추는 걷힌다) · Ctrl 없이는 안 뜨고 cardActions 가 없으면 생성물엔 안 뜬다", async () => {
    await showCard(TARGET);
    ctrl("keydown");
    await settle();
    expect(layer()).toBeNull(); // 앱 동작을 못 받은 곳
    ctrl("keyup");
    const acts = actions();
    await showCard(TARGET, acts);
    ctrl("keydown");
    await settle();
    act(() => { layer()!.querySelector<HTMLButtonElement>(".card-tl button:last-child")!.click(); });
    expect(document.body.querySelector(".cm-modal")).not.toBeNull();
    expect(acts.onOpenComments).not.toHaveBeenCalled();
    expect(layer()).toBeNull();
    ctrl("keyup");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
  });

  it("뜬 단추를 누르면 Ctrl 을 떼도 남고, 단추 밖을 누르면 걷힌다", async () => {
    await showCard(TARGET, actions());
    ctrl("keydown");
    await settle();
    press(layer()!.querySelector(".card-drag-grip")!);
    ctrl("keyup");
    expect(layer()).not.toBeNull();
    press(host.querySelector(".info-head")!);
    expect(layer()).toBeNull();
  });

  it("어셋: 어셋 화면이 등록한 칸을 그 경로·사각형으로 그린다 — 등록이 없으면 뜨지 않는다", async () => {
    const { registerAssetPreviewCard } = await import("../src/components/MediaPreview");
    const ASSET: PreviewTarget = { url: "/files/p/bg/a.png", type: "image", name: "a.png", assetPath: "bg/a.png" };
    await showCard(ASSET);
    ctrl("keydown");
    await settle();
    expect(layer()).toBeNull();
    ctrl("keyup");
    const seen: unknown[] = [];
    let off = () => {};
    act(() => { off = registerAssetPreviewCard((item, box) => { seen.push([item.assetPath, box.width]); return <button className="asset-probe">S</button>; }); });
    ctrl("keydown");
    await settle();
    expect(layer()?.querySelector(".asset-probe")).not.toBeNull();
    expect(seen).toContainEqual(["bg/a.png", 400]);
    act(() => off());
    expect(layer()).toBeNull();
    ctrl("keyup");
  });

  // jsdom 은 CSS 를 겹쳐 계산하지 않아 규칙을 직접 본다 — 실제로 비치는지는 크롬 화면 확인(11-06 Jay 지적: 생성물 카드가 원본을 검게 덮음)
  it("생성물 카드의 안쪽 틀(.card-clip)과 상태 색까지 비워 원본이 비친다", () => {
    const css = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
    const rule = css.match(/\.mp-card-layer \.card, \.mp-card-layer \.card-clip \{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/background: transparent !important/);
    expect(rule?.[1]).toMatch(/box-shadow: none !important/);
    // 비우는 대상인 틀이 이름을 바꾸면 이 규칙이 헛돈다 — 틀이 아직 패널색 배경을 가진 .card-clip 인지 함께 본다
    const gen = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
    expect(gen).toMatch(/\.card-clip \{[^}]*background: var\(--panel\)/);
  });
});

// 카드 C(격자·캔버스·편집 풀) → 코멘트 그림 창(Jay 2026-11-05 시안 ⑮⑯) — 앱이 고르고(cardCommentOpensDrawing) AppOverlays 가 띄운다.
describe("카드 C → 코멘트 그림 창", () => {
  it("그림을 아는 허브의 이미지·영상만 새 창 — 오디오·미디어 없음·그림을 모르는 허브는 종전 작은 창", async () => {
    const { cardCommentOpensDrawing } = await import("../src/components/MediaPreview");
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    const of = (type?: string) => ({ assets: type ? [{ type }] : [] }) as unknown as import("../src/types").Generation;
    setHubFeatures(["comment_drawings_v1"]);
    try {
      expect([of("image"), of("video"), of("audio"), of()].map(cardCommentOpensDrawing)).toEqual([true, true, false, false]);
      setHubFeatures([]);
      expect(cardCommentOpensDrawing(of("image"))).toBe(false);
    } finally {
      setHubFeatures([]);
    }
  });

  it("AppOverlays 는 commentDraw 를 받으면 그 생성물의 코멘트 그림 창을 띄우고, 닫기는 onCommentDrawClose", async () => {
    const { api } = await import("../src/api");
    const list = vi.spyOn(api, "genComments").mockResolvedValue([]);
    const { AppOverlays } = await import("../src/components/app/AppOverlays");
    const noop = () => {};
    const closeDraw = vi.fn();
    const gen = { id: "g9", prompt: "달리기", assets: [{ id: "a", generation_id: "g9", type: "video", file_path: "/media/g9.mp4", thumbnail_path: null }],
      references: [], tags: [] } as unknown as import("../src/types").Generation;
    try {
      act(() => root.render(
        <AppOverlays adminOpen={false} localHub commentGenId={null} commentLabel="" commentDraw={gen} compareGens={null} info={null}
          myId="me" preview={null} projects={[]} syncTick={0} toast={null} onAdminClose={noop} onCloseOverlay={noop} onCommentClose={noop}
          onCommentDrawClose={closeDraw} onCompareClose={noop} onHistoryChanged={noop} onInfoClose={noop} onInfoOpenInBoard={noop}
          onInfoOpenCanvas={noop} onRecoveryRequeue={async () => true} onOpenInBoardFromPreview={noop} onPreview={noop} />,
      ));
      await settle();
      expect(document.body.querySelector(".cm-modal video")?.getAttribute("src")).toBe("/media/g9.mp4");
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(closeDraw).toHaveBeenCalled();
    } finally {
      list.mockRestore();
    }
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

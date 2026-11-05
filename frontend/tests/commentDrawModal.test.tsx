// @vitest-environment jsdom
// 크게 보기 코멘트 모드 창 — 그린 것은 원본 좌표계 획으로 comments-v2 에, 글만이면 옛 경로로. 실패하면 초안을 지키고 같은 id 로 다시 보낸다(C1).
// 영상은 프레임마다 그림 한 장(책갈피), 기준 시각은 처음 그릴 때의 시각. 설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  v2: vi.fn(),
  v1: vi.fn(async () => ({ id: "c-plain" })),
  list: vi.fn(async () => []),
  drawing: vi.fn(),
  thumb: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      if (name === "addGenCommentV2") return calls.v2;
      if (name === "addGenComment") return calls.v1;
      if (name === "genComments") return calls.list;
      if (name === "commentDrawing") return calls.drawing;
      if (name === "commentDrawingThumb") return calls.thumb;
      if (name === "genCommentsCached") return () => undefined;
      return () => new Promise(() => {});
    },
  }),
}));
vi.mock("../src/lib/mediaCapture", () => ({ videoFramePng: vi.fn(async () => { throw new Error("no frame in jsdom"); }) }));

import { CommentDrawModal } from "../src/components/comment/CommentDrawModal";
import { CommentDrawingStrip } from "../src/components/GenCommentPanel";
import { HttpError } from "../src/lib/http";
import type { GenComment } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); // 그리기는 건너뛰고 획 목록만 본다
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  localStorage.clear();
  Object.values(calls).forEach((fn) => fn.mockClear());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const canvas = () => document.querySelector<HTMLCanvasElement>(".partial-edit-stagebox canvas.is-drawing")!;
const pointer = (type: string, x: number, y: number) => act(() => {
  canvas().dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1 }));
});
const stroke = (x: number) => { pointer("pointerdown", x, 10); pointer("pointermove", x + 20, 30); pointer("pointerup", x + 20, 30); };
const textarea = () => document.querySelector<HTMLTextAreaElement>("textarea.cm-text")!;
const type = (value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea(), value);
  textarea().dispatchEvent(new Event("input", { bubbles: true }));
});
const sendButton = () => [...document.querySelectorAll<HTMLButtonElement>("button.sl-gen")][0];
const attached = () => document.querySelectorAll(".sl-reftray-item.cm-att").length;

function showImage(onSaved = vi.fn(), allowPrivate = true) {
  act(() => root.render(
    <CommentDrawModal genId="g1" type="image" url="/o.png" name="n" myId="u1" allowPrivate={allowPrivate} onClose={() => {}} onSaved={onSaved} />,
  ));
  const img = document.querySelector<HTMLImageElement>(".partial-edit-stagebox img")!;
  Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
  act(() => { img.dispatchEvent(new Event("load")); });
  return onSaved;
}

describe("코멘트 모드 — 이미지", () => {
  it("그린 것은 원본 좌표계(400×200) 획으로 comments-v2 에 — 그림 칸이 생기고, 달고 나면 초안을 비운다", async () => {
    calls.v2.mockImplementation(async (_gen: string, body: { id: string; drawings: { id: string; content_hash?: string }[] }) => ({
      id: body.id, result: "created", drawings: body.drawings.map((d) => ({ id: d.id, content_hash: d.content_hash ?? "x" })),
    }));
    const onSaved = showImage();
    expect(attached()).toBe(0);
    stroke(10);
    expect(attached()).toBe(1);
    type("조개 작게");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(calls.v1).not.toHaveBeenCalled();
    const [genId, body] = calls.v2.mock.calls[0];
    expect(genId).toBe("g1");
    expect(body.text).toBe("조개 작게");
    expect(body.private).toBe(false);
    expect(body.drawings).toHaveLength(1);
    const d = body.drawings[0];
    expect([d.kind, d.width, d.height, d.idx, d.time_sec, d.thumb_b64]).toEqual(["image", 400, 200, 0, null, null]);
    // 화면 200×100 → 작업 캔버스 400×200(원본) — 점·굵기는 원본 기준
    expect(d.strokes.items[0]).toMatchObject({ kind: "pen", points: [{ x: 20, y: 20 }, { x: 60, y: 60 }] });
    expect(d.content_hash).toMatch(/^[0-9a-f]{64}$/); // 브라우저가 계산해 보냈다(서버가 대조)
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(attached()).toBe(0);
    expect(textarea().value).toBe("");
  });

  it("실패하면 글·그림을 지키고, 다시 누르면 같은 코멘트 id·같은 그림 id 로 보낸다", async () => {
    calls.v2.mockRejectedValueOnce(new HttpError(502, "서버 연결 실패"));
    showImage();
    stroke(10);
    type("다시");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(attached()).toBe(1);
    expect(textarea().value).toBe("다시");
    calls.v2.mockImplementationOnce(async (_gen: string, body: { id: string; drawings: { id: string; content_hash?: string }[] }) => ({
      id: body.id, result: "created", drawings: body.drawings.map((d) => ({ id: d.id, content_hash: d.content_hash ?? "" })),
    }));
    await act(async () => { sendButton().click(); });
    await settle();
    const [first, second] = calls.v2.mock.calls.map((call) => call[1]);
    expect(second.id).toBe(first.id);
    expect(second.drawings[0].id).toBe(first.drawings[0].id);
    expect(second.drawings[0].content_hash).toBe(first.drawings[0].content_hash);
    expect(attached()).toBe(0);
  });

  it("앞서 보낸 것이 이미 저장된 뒤 고쳐 보내 409 가 나면, 다음엔 코멘트 id 와 그림 id 를 함께 새로 뽑는다", async () => {
    calls.v2.mockRejectedValueOnce(new HttpError(409, "comment_id_request_mismatch"));
    showImage();
    stroke(10);
    type("고친 글");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(attached()).toBe(1); // 초안은 그대로
    calls.v2.mockImplementationOnce(async (_gen: string, body: { id: string; drawings: { id: string; content_hash: string }[] }) => ({
      id: body.id, result: "created", drawings: body.drawings.map((d) => ({ id: d.id, content_hash: d.content_hash })),
    }));
    await act(async () => { sendButton().click(); });
    await settle();
    const [first, second] = calls.v2.mock.calls.map((call) => call[1]);
    expect(second.id).not.toBe(first.id);
    expect(second.drawings[0].id).not.toBe(first.drawings[0].id); // 그림 id 도 앞 코멘트가 가졌다 — 같이 바꾼다
  });

  it("서버 직결 화면(allowPrivate=false)에는 비공개 입력이 없고, 저장된 '비공개' 설정이 있어도 공개로 보낸다", async () => {
    localStorage.setItem("ch.cmt.private", "1");
    showImage(vi.fn(), false);
    expect(document.querySelector(".sl-chip")).toBeNull();
    type("서버 직결");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(calls.v1).toHaveBeenCalledWith("g1", "서버 직결", null, false);
  });

  it("저장된 것이 보낸 그림과 다르면 실패로 보고 초안을 지킨다", async () => {
    calls.v2.mockImplementation(async (_gen: string, body: { id: string }) => ({ id: body.id, result: "replayed", drawings: [] }));
    showImage();
    stroke(10);
    type("확인");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(attached()).toBe(1);
    expect(textarea().value).toBe("확인");
  });

  it("글만이면 옛 경로(옛 서버도 받는다), 글이 비면 보내지 않는다", async () => {
    showImage();
    stroke(10);
    expect(sendButton().disabled).toBe(true); // 글 1자 이상 필수(Jay)
    act(() => { (document.querySelector<HTMLButtonElement>(".sl-reftray-item.cm-att .sl-reftray-x")!).click(); });
    expect(attached()).toBe(0);
    type("글만");
    await act(async () => { sendButton().click(); });
    await settle();
    expect(calls.v1).toHaveBeenCalledWith("g1", "글만", null, false);
    expect(calls.v2).not.toHaveBeenCalled();
  });

  it("쓰던 것이 있으면 닫을 때 묻는다", async () => {
    const onClose = vi.fn();
    act(() => root.render(<CommentDrawModal genId="g1" type="image" url="/o.png" name="n" myId="u1" onClose={onClose} onSaved={() => {}} />));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    act(() => { document.querySelector<HTMLButtonElement>(".partial-edit-head .assets-x")!.click(); });
    expect(confirm).not.toHaveBeenCalled(); // 쓴 것이 없으면 묻지 않고 닫는다
    expect(onClose).toHaveBeenCalledTimes(1);
    type("버릴까");
    act(() => { document.querySelector<HTMLButtonElement>(".partial-edit-head .assets-x")!.click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1); // '아니오' — 남는다
  });
});

describe("코멘트 모드 — 영상", () => {
  it("프레임마다 그림 한 장, 기준 시각은 처음 그릴 때의 시각 — 다른 프레임으로 가도 그린 것이 책갈피로 남는다", async () => {
    calls.v2.mockImplementation(async (_gen: string, body: { id: string; drawings: { id: string; content_hash?: string }[] }) => ({
      id: body.id, result: "created", drawings: body.drawings.map((d) => ({ id: d.id, content_hash: d.content_hash ?? "" })),
    }));
    act(() => root.render(<CommentDrawModal genId="g1" type="video" url="/v.mp4" name="v" myId="u1" startTime={0.5} onClose={() => {}} onSaved={() => {}} />));
    const video = document.querySelector<HTMLVideoElement>(".partial-edit-stagebox video")!;
    let now = 0;
    Object.defineProperties(video, {
      videoWidth: { value: 400 }, videoHeight: { value: 200 }, duration: { value: 4 }, paused: { value: true },
      currentTime: { get: () => now, set: (v: number) => { now = v; } },
    });
    act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
    expect(now).toBe(0.5);
    stroke(10);
    expect(document.querySelectorAll(".cm-mark")).toHaveLength(1);
    act(() => { (document.querySelector<HTMLButtonElement>('.pe-trans button[aria-label="한 프레임 앞으로"]')!).click(); });
    expect(attached()).toBe(1); // 다음 프레임은 비어 있다 — 앞 프레임 그림은 칸에 남는다
    stroke(60);
    expect(document.querySelectorAll(".cm-mark")).toHaveLength(2);
    expect(attached()).toBe(2);
    expect([...document.querySelectorAll(".sl-reftray-item.cm-att .sl-reftray-name")].map((el) => el.textContent)).toEqual(["0.50초", "0.54초"]);
    type("두 프레임");
    await act(async () => { sendButton().click(); });
    await settle();
    const body = calls.v2.mock.calls[0][1];
    expect(body.drawings.map((d: { kind: string; idx: number; time_sec: number; thumb_b64: unknown }) => [d.kind, d.idx, d.time_sec, d.thumb_b64]))
      .toEqual([["video", 0, 0.5, null], ["video", 1, 0.5 + 1 / 24, null]]); // 미리보기를 못 뜨면 thumb 없이(정상 계약)
  });

  it("같은 24fps 칸의 다른 장면(60fps 영상)에서 다시 그리면 그 그림의 기준 시각 장면으로 맞춘다", async () => {
    act(() => root.render(<CommentDrawModal genId="g1" type="video" url="/v.mp4" name="v" myId="u1" startTime={1} onClose={() => {}} onSaved={() => {}} />));
    const video = document.querySelector<HTMLVideoElement>(".partial-edit-stagebox video")!;
    let now = 0;
    Object.defineProperties(video, {
      videoWidth: { value: 400 }, videoHeight: { value: 200 }, duration: { value: 4 }, paused: { value: true },
      currentTime: { get: () => now, set: (v: number) => { now = v; } },
    });
    act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
    stroke(10); // 1.000초에 그림
    now = 1.016; // 같은 칸(round(1.016×24) = 24)의 다음 장면 — 영상 자체가 옮겨 갔다
    act(() => { video.dispatchEvent(new Event("timeupdate")); });
    stroke(60); // 기준 장면으로 옮기기만 하고 이 누름은 그리지 않는다(장면이 뜨기 전)
    expect(now).toBe(1); // 보고 고치는 장면 = 저장되는 장면
    expect(attached()).toBe(1);
    const clear = () => document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="전체 지우기"]')!;
    act(() => { document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="되돌리기"]')!.click(); });
    expect(clear().disabled).toBe(true); // 획은 처음 하나뿐이었다
  });

  it("장면을 옮기는 중(seeking)에는 누름이 그리지 않는다", async () => {
    act(() => root.render(<CommentDrawModal genId="g1" type="video" url="/v.mp4" name="v" myId="u1" onClose={() => {}} onSaved={() => {}} />));
    const video = document.querySelector<HTMLVideoElement>(".partial-edit-stagebox video")!;
    let seeking = true;
    Object.defineProperties(video, {
      videoWidth: { value: 400 }, videoHeight: { value: 200 }, duration: { value: 4 }, paused: { value: true },
      seeking: { get: () => seeking },
    });
    act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
    stroke(10);
    expect(attached()).toBe(0);
    seeking = false;
    stroke(10);
    expect(attached()).toBe(1);
  });

  it("떠 있는 동안 방향키·Space 는 이 창이 갖고 뒤로 흘리지 않는다", async () => {
    act(() => root.render(<CommentDrawModal genId="g1" type="video" url="/v.mp4" name="v" myId="u1" onClose={() => {}} onSaved={() => {}} />));
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      for (const key of ["ArrowRight", " ", "[", "d"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        act(() => { document.body.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
      }
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });
});

// 지난 코멘트의 그림 줄(C5) — 화면에 보일 때만 받고, 권한 거절(thumb 포함)이면 걷고, 모르는 획 판은 그리지 않고 알린다.
describe("지난 코멘트 그림 줄", () => {
  const meta = { id: "d1", idx: 0, kind: "video" as const, width: 400, height: 200, time_sec: 1.5, has_thumb: true, content_hash: "h", v: 1 as const };
  const comment = { id: "c1", author: "u2", author_name: "팀원", text: "t", created_at: "", parent_id: null, drawings: [meta] } as GenComment;
  const body = (v: number) => ({ ...meta, comment_id: "c1", strokes: { v, items: [] } });
  const show = () => act(() => root.render(<CommentDrawingStrip comment={comment} bg={null} onOpen={() => {}} />));

  it("미리보기 요청이 403 이면 받은 획까지 걷는다(획만 남기지 않는다)", async () => {
    calls.drawing.mockResolvedValue(body(1));
    calls.thumb.mockRejectedValue(new HttpError(403, "권한 없음"));
    show();
    await settle();
    expect(document.querySelector(".cmt-att")).toBeNull();
  });

  it("미리보기를 연결 문제로 못 받으면 획만 보인다", async () => {
    calls.drawing.mockResolvedValue(body(1));
    calls.thumb.mockRejectedValue(new HttpError(502, "연결 실패"));
    show();
    await settle();
    expect(document.querySelector(".cmt-att canvas")).not.toBeNull();
    expect(document.querySelector(".cmt-att img")).toBeNull();
  });

  it("이 판이 모르는 획 판(v2)은 그리지 않고 '새 판에서 볼 수 있음'", async () => {
    calls.drawing.mockResolvedValue(body(2));
    show();
    await settle();
    expect(document.querySelector(".cmt-att canvas")).toBeNull();
    expect(document.querySelector(".cmt-att")?.textContent).toContain("새 판에서 볼 수 있음");
    expect(calls.thumb).not.toHaveBeenCalled();
  });

  it("화면 밖 그림은 보일 때까지 받지 않는다", async () => {
    let fire: (hit: boolean) => void = () => {};
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { fire = (hit) => callback([{ isIntersecting: hit }]); }
      observe() {}
      disconnect() {}
    });
    calls.drawing.mockResolvedValue(body(1));
    calls.thumb.mockResolvedValue(new Blob(["j"], { type: "image/jpeg" }));
    URL.createObjectURL = vi.fn(() => "blob:t");
    URL.revokeObjectURL = vi.fn();
    show();
    await settle();
    expect(calls.drawing).not.toHaveBeenCalled();
    act(() => fire(true));
    await settle();
    expect(calls.drawing).toHaveBeenCalledTimes(1);
  });
});

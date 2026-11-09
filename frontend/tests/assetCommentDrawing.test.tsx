// @vitest-environment jsdom
// 어셋(파일) 코멘트 그림 — 그림 창이 어셋 comments-v2 로 기대값과 함께 보내고, 받는 쪽 판정(stored_local·context_changed …)에 초안을 지킨다.
//  재시도 id 는 작성 의도가 바뀔 때만 새로, 처음 보낸 문맥과 다르면 보내지 않는다. 지난 그림 = 빈 책갈피 → 정확한 시각으로 보기용 탐색 뒤 겹침.
//  작은 창 [편집] 인계. 설계 docs/status/어셋코멘트그림_설계_2026-11-05.md §4·§6.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  v2: vi.fn(),
  v1: vi.fn(async () => ({ id: "c-plain" })),
  assetDrawing: vi.fn(),
  assetThumb: vi.fn(),
  genDrawing: vi.fn(),
}));
vi.mock("../src/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      if (name === "addAssetCommentV2") return calls.v2;
      if (name === "addAssetComment") return calls.v1;
      if (name === "assetCommentDrawing") return calls.assetDrawing;
      if (name === "assetCommentDrawingThumb") return calls.assetThumb;
      if (name === "commentDrawing") return calls.genDrawing;
      return () => new Promise(() => {});
    },
  }),
}));
vi.mock("../src/lib/mediaCapture", () => ({ videoFramePng: vi.fn(async () => { throw new Error("no frame in jsdom"); }) }));

import { invalidateOperationContext } from "../src/app/operationContext";
import { CommentDrawModal, type AssetCommentSide } from "../src/components/comment/CommentDrawModal";
import { CommentPanel } from "../src/components/common/CommentPanel";
import type { CommentWriteContext } from "../src/lib/commentTarget";
import { HttpError } from "../src/lib/http";
import type { AssetComment } from "../src/types";

const TARGET = { kind: "asset" as const, project: "P1", path: "shots/a.png" };
const relayCtx = (over: Partial<CommentWriteContext> = {}): CommentWriteContext => ({
  mode: "hub", expectAccount: "acct:u1@example.com", proxying: true, serverUrl: "http://srv:8010", serverAccount: "u1@example.com",
  allowPrivate: true, key: "k1", ...over,
});
const side = (comments: AssetComment[] = []): AssetCommentSide & { refresh: ReturnType<typeof vi.fn>; onSend: ReturnType<typeof vi.fn> } => ({
  comments, onSend: vi.fn(async () => true), onEdit: vi.fn(async () => true), onDelete: vi.fn(), refresh: vi.fn(),
});
const echo = async (body: { id: string; drawings: { id: string; content_hash: string }[] }) => ({
  id: body.id, result: "created", drawings: body.drawings.map((d) => ({ id: d.id, content_hash: d.content_hash })),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  localStorage.clear();
  Object.values(calls).forEach((fn) => fn.mockReset());
  calls.v1.mockResolvedValue({ id: "c-plain" });
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
const input = () => document.querySelector<HTMLInputElement>('.cm-side .cmt-input input[name="cd"]')!;
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const sendButton = () => document.querySelector<HTMLButtonElement>('.cm-side .cmt-input button[type="submit"]')!;
const send = async () => { await act(async () => { sendButton().click(); }); await settle(); };
const notice = () => document.querySelector(".cm-notice")?.textContent ?? "";
const hasInk = () => !document.querySelector<HTMLButtonElement>('.pe-dock button[aria-label="전체 지우기"]')!.disabled;

function showImage(props: Partial<Parameters<typeof CommentDrawModal>[0]> = {}) {
  const assetSide = side();
  act(() => root.render(
    <CommentDrawModal target={TARGET} type="image" url="/api/assets/file?project=P1&path=shots%2Fa.png" name="a.png" myId="u1"
      assetSide={assetSide} writeContext={relayCtx()} onClose={() => {}} onSaved={() => {}} {...props} />,
  ));
  const img = document.querySelector<HTMLImageElement>(".partial-edit-stagebox img")!;
  Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
  act(() => { img.dispatchEvent(new Event("load")); });
  return assetSide;
}

describe("어셋 그림 창 — 보내기", () => {
  it("그림이 있으면 어셋 comments-v2 로 — 정규화 전 project·path, 기대값(저장 대상·서버 주소·서버 계정), 계정 머리글", async () => {
    calls.v2.mockImplementation(echo);
    const assetSide = showImage({ initialText: "작은 창에서 쓰던 글" });
    expect(input().value).toBe("작은 창에서 쓰던 글"); // [편집] 인계
    stroke(10);
    await send();
    const [body, expect_] = calls.v2.mock.calls[0];
    expect(expect_).toBe("acct:u1@example.com");
    expect(body).toMatchObject({ project: "P1", path: "shots/a.png", text: "작은 창에서 쓰던 글", parent_id: null, private: false,
      expected_target: "server", expected_server_url: "http://srv:8010", expected_server_account: "u1@example.com" });
    expect(body.drawings[0]).toMatchObject({ kind: "image", width: 400, height: 200 });
    expect(calls.genDrawing).not.toHaveBeenCalled();
    expect(assetSide.refresh).toHaveBeenCalledTimes(1);
    expect(hasInk()).toBe(false);
    expect(input().value).toBe("");
  });

  it("비공개는 중계 중이어도 로컬 기대값 · 글만이면 옛 글 경로", async () => {
    calls.v2.mockImplementation(echo);
    showImage();
    act(() => { document.querySelector<HTMLInputElement>(".cm-side .cmt-opt input[type=checkbox]")!.click(); }); // 비공개(쓰기)
    stroke(10);
    type("내 메모");
    await send();
    expect(calls.v2.mock.calls[0][0]).toMatchObject({ private: true, expected_target: "local", expected_server_url: null, expected_server_account: null });
    type("글만");
    await send();
    expect(calls.v1).toHaveBeenCalledWith("P1", "shots/a.png", "글만", null, true);
  });

  it("stored_local — '이 PC 에 저장됨' 으로 초안을 지키고 같은 id 로 다시 눌러도 같은 판정, [팀에 새로 보내기] = 새 id", async () => {
    calls.v2.mockRejectedValue(new HttpError(409, "서버 연결 전에 …", "서버 연결 전에 …", { code: "stored_local", message: "…" }));
    showImage();
    stroke(10);
    type("팀에");
    await send();
    expect(notice()).toContain("이 PC 에 저장됨");
    expect([hasInk(), input().value]).toEqual([true, "팀에"]);
    await send();
    const [first, second] = calls.v2.mock.calls.map((call) => call[0]);
    expect(second.id).toBe(first.id); // 자동으로 id 를 바꾸지 않는다
    calls.v2.mockImplementation(echo);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".cm-notice button")].find((b) => b.textContent === "팀에 새로 보내기")!.click(); });
    await settle();
    const third = calls.v2.mock.calls[2][0];
    expect(third.id).not.toBe(first.id);
    expect(third.drawings[0].id).not.toBe(first.drawings[0].id);
    expect(hasInk()).toBe(false);
  });

  it("context_changed·server_update_needed — 초안 유지, 자동 id 갱신 없음", async () => {
    calls.v2.mockRejectedValueOnce(new HttpError(409, "x", "x", { code: "context_changed", message: "x" }));
    calls.v2.mockRejectedValueOnce(new HttpError(409, "y", "y", { code: "server_update_needed", message: "y" }));
    showImage();
    stroke(10);
    type("그대로");
    await send();
    expect(notice()).toContain("보내지 않았습니다");
    await send();
    expect(notice()).toContain("팀 서버 업데이트 뒤");
    const [first, second] = calls.v2.mock.calls.map((call) => call[0]);
    expect(second.id).toBe(first.id);
    expect([hasInk(), input().value]).toEqual([true, "그대로"]);
  });

  it("결과를 모르는 실패 뒤 같은 의도는 같은 id, 글을 고치면(의도가 바뀌면) 새 id", async () => {
    calls.v2.mockRejectedValueOnce(new HttpError(502, "서버 연결 실패"));
    calls.v2.mockRejectedValueOnce(new HttpError(502, "서버 연결 실패"));
    calls.v2.mockImplementation(echo);
    showImage();
    stroke(10);
    type("처음");
    await send();
    expect(notice()).toContain("결과를 모릅니다");
    await send();
    type("고친 글");
    await send();
    const [a, b, c] = calls.v2.mock.calls.map((call) => call[0]);
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(c.drawings[0].id).not.toBe(a.drawings[0].id);
  });

  it("글만 보내는 옛 길의 결과 모름은 '같은 코멘트로 확인' 이라 하지 않는다(id 가 없다)", async () => {
    calls.v1.mockRejectedValueOnce(new HttpError(502, "서버 연결 실패"));
    showImage();
    type("글만");
    await send();
    expect(notice()).toContain("두 번 생길 수 있습니다");
    expect(notice()).not.toContain("같은 코멘트로 확인");
  });

  it("보낸 뒤 계정·연결이 바뀌면 늦은 응답은 버리되 '결과를 확인하지 못함' 을 남긴다(초안 유지)", async () => {
    calls.v2.mockImplementationOnce(async (body: { id: string; drawings: { id: string; content_hash: string }[] }) => {
      invalidateOperationContext(); // 응답이 오기 전에 다른 창에서 계정이 바뀌었다
      return echo(body);
    });
    showImage();
    stroke(10);
    type("늦은 답");
    await send();
    expect(notice()).toContain("보낸 뒤 계정·연결이 바뀌어");
    expect([hasInk(), input().value]).toEqual([true, "늦은 답"]);
  });

  it("오른쪽 칸 답글은 보이는 비공개(쓰기) 체크를 따른다", async () => {
    const comments: AssetComment[] = [{ id: "c1", author: "u2", author_name: "팀원", text: "원글", created_at: "", parent_id: null }];
    const assetSide = side(comments);
    act(() => root.render(
      <CommentDrawModal target={TARGET} type="image" url="/x.png" name="a.png" myId="u1" assetSide={assetSide} writeContext={relayCtx()}
        onClose={() => {}} onSaved={() => {}} />,
    ));
    const reply = async (text: string) => {
      act(() => { [...document.querySelectorAll<HTMLButtonElement>(".cm-side .cmt-acts button")].find((b) => b.textContent === "답글")!.click(); });
      const field = document.querySelector<HTMLInputElement>('.cm-side input[name="r"]')!;
      field.value = text;
      await act(async () => { field.form!.requestSubmit(); });
    };
    await reply("공개 답");
    act(() => { document.querySelector<HTMLInputElement>(".cm-side .cmt-opt input[type=checkbox]")!.click(); }); // 비공개(쓰기) 켬
    await reply("비공개 답");
    expect(assetSide.onSend.mock.calls.map((call) => [call[0], call[2]])).toEqual([["공개 답", false], ["비공개 답", true]]);
  });

  it("처음 보낸 계정·저장 대상과 다르면 같은 id 로도 새 id 로도 보내지 않는다 · 문맥이 준비 안 됐으면 전송 단추가 잠긴다", async () => {
    calls.v2.mockRejectedValueOnce(new HttpError(502, "서버 연결 실패"));
    const assetSide = showImage();
    stroke(10);
    type("묶임");
    await send();
    act(() => root.render(
      <CommentDrawModal target={TARGET} type="image" url="/api/assets/file?project=P1&path=shots%2Fa.png" name="a.png" myId="u1"
        assetSide={assetSide} writeContext={relayCtx({ expectAccount: "acct:u2@example.com", serverAccount: "u2@example.com", key: "k2" })}
        onClose={() => {}} onSaved={() => {}} />,
    ));
    await send();
    expect(calls.v2).toHaveBeenCalledTimes(1);
    expect(notice()).toContain("처음 보낸 때와 계정·저장 위치가 다릅니다");
    act(() => root.render(
      <CommentDrawModal target={TARGET} type="image" url="/api/assets/file?project=P1&path=shots%2Fa.png" name="a.png" myId="u1"
        assetSide={assetSide} writeContext={null} onClose={() => {}} onSaved={() => {}} />,
    ));
    expect(sendButton().disabled).toBe(true);
  });

  it("오른쪽 칸 답글은 지금 경로(글만) — 서버 직결(allowPrivate=false)이면 저장된 비공개 선택과 상관없이 공개", async () => {
    localStorage.setItem("ch.cmt.private", "1");
    const comments: AssetComment[] = [{ id: "c1", author: "u2", author_name: "팀원", text: "원글", created_at: "", parent_id: null }];
    const assetSide = side(comments);
    act(() => root.render(
      <CommentDrawModal target={TARGET} type="image" url="/x.png" name="a.png" myId="u1" allowPrivate={false}
        assetSide={assetSide} writeContext={relayCtx({ mode: "server", allowPrivate: false })} onClose={() => {}} onSaved={() => {}} />,
    ));
    act(() => { [...document.querySelectorAll<HTMLButtonElement>(".cm-side .cmt-acts button")].find((b) => b.textContent === "답글")!.click(); });
    const reply = document.querySelector<HTMLInputElement>('.cm-side input[name="r"]')!;
    reply.value = "답";
    await act(async () => { reply.form!.requestSubmit(); });
    expect(assetSide.onSend).toHaveBeenCalledWith("답", "c1", false);
    expect(calls.v2).not.toHaveBeenCalled();
  });

  it("보내지 않은 답글이 있으면 닫을 때 묻는다", () => {
    const comments: AssetComment[] = [{ id: "c1", author: "u2", author_name: "팀원", text: "원글", created_at: "", parent_id: null }];
    const onClose = vi.fn();
    act(() => root.render(
      <CommentDrawModal target={TARGET} type="image" url="/x.png" name="a.png" myId="u1" assetSide={side(comments)} writeContext={relayCtx()}
        onClose={onClose} onSaved={() => {}} />,
    ));
    act(() => { [...document.querySelectorAll<HTMLButtonElement>(".cm-side .cmt-acts button")].find((b) => b.textContent === "답글")!.click(); });
    const reply = document.querySelector<HTMLInputElement>('.cm-side input[name="r"]')!;
    act(() => {
      reply.value = "쓰던 답글";
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { document.querySelector<HTMLButtonElement>(".partial-edit-head .assets-x")!.click(); });
    expect(document.querySelector(".host-exit-confirm")?.textContent).toContain("버릴까요");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("어셋 그림 창 — 영상 책갈피", () => {
  it("지난 그림 = 빈 동그라미(같은 칸이어도 따로), 누르면 정확한 time_sec 로 탐색하고 탐색이 끝난 뒤에 겹친다 — 어셋 경로로 받는다", async () => {
    calls.assetDrawing.mockResolvedValue({ id: "d1", comment_id: "c1", idx: 0, kind: "video", width: 400, height: 200, time_sec: 1.016,
      has_thumb: false, content_hash: "h", strokes: { v: 1, items: [] } });
    const meta = { id: "d1", idx: 0, kind: "video" as const, width: 400, height: 200, time_sec: 1.016, has_thumb: false, content_hash: "h", v: 1 as const };
    const comments: AssetComment[] = [{ id: "c1", author: "u2", author_name: "팀원 A", text: "여기", created_at: "", parent_id: null, drawings: [meta] }];
    act(() => root.render(
      <CommentDrawModal target={{ kind: "asset", project: "P1", path: "cuts/b.mp4" }} type="video" url="/v.mp4" name="b.mp4" myId="u1" startTime={1}
        assetSide={side(comments)} writeContext={relayCtx()} onClose={() => {}} onSaved={() => {}} />,
    ));
    const video = document.querySelector<HTMLVideoElement>(".partial-edit-stagebox video")!;
    let now = 0;
    Object.defineProperties(video, {
      videoWidth: { value: 400 }, videoHeight: { value: 200 }, duration: { value: 4 }, paused: { value: true },
      currentTime: { get: () => now, set: (v: number) => { now = v; } },
    });
    act(() => { video.dispatchEvent(new Event("loadedmetadata")); });
    stroke(10); // 1.000초에 그림 — 지난 그림(1.016초)과 같은 24fps 칸
    expect(document.querySelectorAll(".cm-mark.past")).toHaveLength(1);
    expect(document.querySelectorAll(".cm-mark:not(.past)")).toHaveLength(1);
    act(() => { document.querySelector<HTMLButtonElement>(".cm-mark.past")!.click(); });
    expect(now).toBe(1.016); // 작성용 칸 맞춤(1.000초)이 아니라 그 그림의 정확한 시각
    await settle();
    expect(document.querySelector(".cm-viewing")).toBeNull(); // 탐색이 끝나기 전에는 겹치지 않는다
    act(() => { video.dispatchEvent(new Event("seeked")); });
    await settle();
    expect(document.querySelector(".cm-viewing")?.textContent).toContain("팀원 A");
    expect(calls.assetDrawing).toHaveBeenCalledWith("c1", "d1", expect.anything());
    expect(calls.genDrawing).not.toHaveBeenCalled();
  });
});

describe("작은 코멘트 창 [편집]", () => {
  const panel = (onEditDraw?: (text: string) => boolean) => act(() => root.render(
    <CommentPanel comments={[]} label="a.png" myId="u1" panelRef={null} pos={null} onHeadMouseDown={() => {}} onClose={() => {}}
      onSend={async () => true} onEdit={async () => true} onDelete={() => {}} onEditDraw={onEditDraw} />,
  ));
  const drawButton = () => document.querySelector<HTMLButtonElement>(".cmt-input .cmt-draw-btn");

  it("넘길 곳이 없으면(옛 서버·오디오·준비 안 됨) [편집] 이 없다", () => {
    panel();
    expect(drawButton()).toBeNull();
  });

  it("입력칸과 [전송] 사이 — 누르면 쓰던 글을 넘기고, 넘긴 뒤에만 입력을 비운다", () => {
    let accept = false;
    const handed: string[] = [];
    panel((text) => { handed.push(text); return accept; });
    const field = document.querySelector<HTMLInputElement>('.cmt-input input[name="c"]')!;
    const buttons = [...document.querySelectorAll(".cmt-input button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["편집", "전송"]);
    field.value = "쓰던 글";
    act(() => { drawButton()!.click(); });
    expect(field.value).toBe("쓰던 글"); // 넘기지 못했으면 그대로
    accept = true;
    act(() => { drawButton()!.click(); });
    expect(handed).toEqual(["쓰던 글", "쓰던 글"]);
    expect(field.value).toBe("");
  });
});

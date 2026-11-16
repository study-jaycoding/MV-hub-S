// @vitest-environment jsdom
// MV Agent 그림 넣기(docs/status/MVAgent_그림넣기_2026-11-16.md 3-1) — 탐색기 파일 끌어오기·Ctrl+V 캡처를 프롬프트와 같은 업로드로
//  올려 imp/cap 레퍼런스 칩으로 · 보낼 때 그림 칩의 1024px 썸네일을 images 로 싣는다. 가짜는 바깥 경계(fetch)에만 둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "../src/components/agent-chat/AgentPanel";
import { setAuthToken } from "../src/lib/http";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; method: string; body?: unknown };
let calls: Call[];
let route: (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
// 바이트를 바로 넣는다 — jsdom 의 Blob 을 Node Response 에 넣으면 "[object Blob]" 글자가 된다
const jpeg = () => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const ENGINES = [{ id: "claude", available: true, version: "2.1.322", reason: null, state: "ready", subscription: "Max",
  efforts: ["low", "medium", "high"], models: [{ id: "opus", label: "Opus 5.5" }] }];
const PERSONAL = { scope: "personal", id: null, name: "개인" };
const gen = (id: string) => ({ id, prompt: `프롬프트 ${id}`, model: "m", status: "done", created_at: "2026-11-16T00:00:00",
  workspace_scope: "personal", workspace_id: null, assets: [{ id: `${id}-a`, type: "image", file_path: `/media/${id}.png` }] });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("ch.accountScope", "jay@example.com");
  calls = [];
  route = (c) => {
    if (c.path === "/session") return json({ secret: "s1", account_email: "jay@example.com", identity_key: "id-1", engines: ENGINES });
    if (c.path === "/api/assets/reference-import") return json({ saved: [{ project: "imports", path: "shot.png", name: "shot.png", type: "image" }], skipped: [] });
    if (c.path === "/api/assets/capture") return json({ project: "captures", path: "capture_1.png", name: "capture_1.png", type: "image" });
    if (c.path.startsWith("/api/assets/thumb") || c.path.startsWith("/api/media-thumb")) return jpeg();
    if (c.path === "/api/generations/g1") return json(gen("g1"));
    if (c.path === "/turns" && c.method === "POST") return json({ turn_id: "t1", conversation_id: "c1", status: "running" });
    if (c.path === "/turns/t1/events?after=0") return json({ events: [{ seq: 1, kind: "state", status: "done" }], status: "done", last_seq: 1 });
    return json({ detail: "Not Found" }, 404);
  };
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit = {}) => {
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { path: String(url).replace("/api/agent-chat", ""), method: init.method ?? "GET", body };
    calls.push(call);
    return Promise.resolve().then(() => route(call));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setAuthToken(null);
});

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};
const panel = () => host.querySelector<HTMLElement>(".agent-panel")!;
const input = () => host.querySelector<HTMLTextAreaElement>(".agent-input")!;
const texts = (selector: string) => [...host.querySelectorAll(selector)].map((el) => el.textContent);
const chipNames = () => texts(".agent-attach .agent-context-text b");
const chipKinds = () => texts(".agent-attach .agent-context-text small");
const notice = () => host.querySelector(".agent-notice")?.textContent ?? null;
const turnCalls = () => calls.filter((c) => c.path === "/turns" && c.method === "POST");
const render = async (workspace: unknown = PERSONAL, project?: string) => {
  act(() => root.render(<AgentPanel context={{ tab: "my", workspace, ...(project ? { project } : {}) } as never} contextLabel="개인" onClose={() => {}} />));
  await flush();
};
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = () => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
const file = (name: string, mime: string) => new File([new Uint8Array([1, 2, 3])], name, { type: mime });
const fireFiles = (kind: string, files: File[], extra: Record<string, string> = {}) => {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: {
    types: [...Object.keys(extra), "Files"], files, items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    getData: (k: string) => extra[k] ?? "", dropEffect: "none",
  } });
  act(() => { panel().dispatchEvent(event); });
  return event;
};
const dropFiles = async (files: File[], extra?: Record<string, string>) => {
  fireFiles("dragenter", files, extra);
  const event = fireFiles("drop", files, extra);
  await flush();
  return event;
};
/** 앱 끌기 형식(생성물·어셋) 놓기 */
const dropApp = (data: Record<string, string>) => {
  for (const kind of ["dragenter", "drop"]) {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: Object.keys(data), getData: (k: string) => data[k] ?? "", dropEffect: "none" } });
    act(() => { panel().dispatchEvent(event); });
  }
};
const paste = (items: { type: string; file?: File }[], text = "") => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    items: items.map((it) => ({ kind: it.file ? "file" : "string", type: it.type, getAsFile: () => it.file ?? null })),
    files: items.flatMap((it) => (it.file ? [it.file] : [])), types: items.map((it) => it.type), getData: (k: string) => (k === "text/plain" ? text : ""),
  } });
  act(() => { input().dispatchEvent(event); });
  return event;
};
const key = (kind: "keydown" | "keyup", k: string, opts: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent(kind, { key: k, bubbles: true, cancelable: true, ...opts });
  act(() => { input().dispatchEvent(event); });
  return event;
};

describe("MV Agent 그림 넣기", () => {
  it("탐색기 파일 놓기 → 프롬프트와 같은 imports 업로드(목적지 포함) → imp/cap 칩 · 그림은 'AI 가 봄', 영상은 '자료로만' · 못 받는 파일은 안내", async () => {
    route = ((base) => (c: Call) => (c.path === "/api/assets/reference-import"
      ? json({ saved: [{ project: "imports", path: "shot.png", name: "shot.png", type: "image" }, { project: "imports", path: "walk.mp4", name: "walk.mp4", type: "video" }], skipped: [] })
      : base(c)))(route);
    await render({ scope: "team", id: "team-a", name: "팀 A" }, "proj-1");
    const enter1 = fireFiles("dragenter", [file("shot.png", "image/png")]);
    expect([enter1.defaultPrevented, host.querySelector(".agent-drop")!.textContent]).toEqual([true, expect.stringContaining("내 PC 파일")]);
    const dropped = await dropFiles([file("shot.png", "image/png"), file("walk.mp4", "video/mp4"), file("notes.txt", "text/plain")]);
    expect(dropped.defaultPrevented).toBe(true);
    const upload = calls.find((c) => c.path === "/api/assets/reference-import")!;
    const form = upload.body as FormData;
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual(["shot.png", "walk.mp4"]);
    expect([form.get("target_project_id"), form.get("target_workspace_id")]).toEqual(["proj-1", "team-a"]);
    expect(chipNames()).toEqual(["shot.png", "walk.mp4"]);
    expect(chipKinds()).toEqual(["레퍼런스 · AI 가 봄", "영상 · 자료로만"]);
    expect(notice()).toBe("1개는 붙일 수 없어 뺐어요");
    type("이 그림 봐줘");
    enter();
    await flush();
    const body = turnCalls()[0].body as Record<string, unknown>;
    expect(body.attachments).toEqual([
      { kind: "asset", project: "imp/cap", path: "imports/shot.png", name: "shot.png" },
      { kind: "asset", project: "imp/cap", path: "imports/walk.mp4", name: "walk.mp4" },
    ]);
    expect(body.images).toEqual([{ index: 0, media_type: "image/jpeg", data: btoa(String.fromCharCode(...JPEG)) }]);
    const thumb = calls.find((c) => c.path.startsWith("/api/assets/thumb"))!.path;
    expect(new URL(thumb, "http://x").searchParams.get("w")).toBe("1024");
  });

  it("어셋 탭의 OS 끌기(파일 + x-ch-asset)는 지금처럼 어셋 칩 — 올리지 않는다", async () => {
    await render();
    await dropFiles([file("apple.png", "image/png")], { "application/x-ch-asset": JSON.stringify([{ project: "my-assets", path: "e001/apple.png", name: "apple.png", type: "image" }]) });
    expect(calls.some((c) => c.path === "/api/assets/reference-import")).toBe(false);
    expect([chipNames(), chipKinds()]).toEqual([["apple.png"], ["레퍼런스 · AI 가 봄"]]);
  });

  it("Ctrl+V 그림 → captures 업로드 → imp/cap 칩 · 글자 붙여넣기는 그대로 · 길게 누른 Ctrl+V 반복은 막음", async () => {
    await render();
    const pasted = paste([{ type: "image/png", file: file("image.png", "image/png") }]);
    expect(pasted.defaultPrevented).toBe(true);
    await flush();
    expect(calls.filter((c) => c.path === "/api/assets/capture")).toHaveLength(1);
    expect([chipNames(), chipKinds()]).toEqual([["capture_1.png"], ["레퍼런스 · AI 가 봄"]]);
    expect(key("keydown", "v", { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true); // 누른 채 반복 = 또 붙이지 않음
    key("keyup", "v", { ctrlKey: true });
    expect(key("keydown", "v", { ctrlKey: true, repeat: true }).defaultPrevented).toBe(false);
    const textPaste = paste([{ type: "text/plain" }], "그냥 글자");
    expect(textPaste.defaultPrevented).toBe(false);
    expect(calls.filter((c) => c.path === "/api/assets/capture")).toHaveLength(1);
    type("이거");
    enter();
    await flush();
    expect((turnCalls()[0].body as Record<string, unknown>).attachments).toEqual([{ kind: "asset", project: "imp/cap", path: "captures/capture_1.png", name: "capture_1.png" }]);
  });

  it("올리는 동안은 회색 칩·보내기 막힘 → 끝나면 보냄 · 못 받은 그림은 빼고 보낸 뒤 안내 · 조회한 생성물 그림도 첫 장을 보냄", async () => {
    const capture = deferred<Response>();
    route = ((base) => (c: Call) => {
      if (c.path === "/api/assets/capture") return capture.promise;
      if (c.path.startsWith("/api/assets/thumb") && c.path.includes("broken")) return json({ detail: "파일 없음" }, 404);
      return base(c);
    })(route);
    await render();
    dropApp({ "application/x-ch-gen": "g1" });
    dropApp({ "application/x-ch-asset": JSON.stringify([{ project: "my-assets", path: "broken.png", name: "broken.png", type: "image" }]) });
    await flush();
    paste([{ type: "image/png", file: file("image.png", "image/png") }]);
    await flush();
    expect(chipKinds()).toEqual(["생성물 · AI 가 봄", "레퍼런스 · AI 가 봄", "올리는 중"]);
    // 올리는 중 칩은 뺄 수 없다 — 중간 자리를 빼면 지운 파일이 다른 자리에 붙는다(독립 리뷰 1)
    expect([...host.querySelectorAll(".agent-attach")].map((el) => !!el.querySelector(".agent-context-x"))).toEqual([true, true, false]);
    type("셋 다 봐줘");
    enter();
    await flush();
    expect([turnCalls().length, notice()]).toEqual([0, "올리는 중인 그림이 끝나면 보낼 수 있어요"]);
    capture.resolve(json({ project: "captures", path: "capture_2.png", name: "capture_2.png", type: "image" }));
    await flush();
    enter();
    await flush();
    const body = turnCalls()[0].body as { images: { index: number }[] };
    expect(body.images.map((i) => i.index)).toEqual([0, 2]);
    expect(calls.some((c) => c.path.startsWith("/api/media-thumb") && c.path.includes("w=1024"))).toBe(true);
    expect(notice()).toBe("2번 그림은 불러오지 못해 AI 가 보지 못했어요");
  });

  it("조회 중인 생성물은 그림 없이 보내고 안내 · 썸네일을 받는 사이 공간이 바뀌면 보내지 않음 · 합계 6,000,000 바이트를 넘친 그림은 뺌", async () => {
    const lookup = deferred<Response>();
    route = ((base) => (c: Call) => (c.path === "/api/generations/g1" ? lookup.promise : base(c)))(route);
    await render();
    dropApp({ "application/x-ch-gen": "g1" });
    await flush();
    expect(chipKinds()).toEqual(["생성물 · 확인 중"]);
    type("이거");
    enter();
    await flush();
    expect((turnCalls()[0].body as Record<string, unknown>).images).toBeUndefined();
    expect(notice()).toBe("1번 그림은 불러오지 못해 AI 가 보지 못했어요");
    lookup.resolve(json(gen("g1")));
    await flush();

    // 조회에 실패한 생성물(종류 모름)도 그림 없이 보내고 안내(독립 리뷰 3)
    const broken = route;
    route = (c: Call) => (c.path === "/api/generations/g2" ? json({ detail: "서버 오류" }, 500) : broken(c));
    dropApp({ "application/x-ch-gen": "g2" });
    await flush();
    expect(chipKinds()).toEqual(["생성물 · 자료로만"]);
    type("이건");
    enter();
    await flush();
    expect((turnCalls()[1].body as Record<string, unknown>).images).toBeUndefined();
    expect(notice()).toBe("1번 그림은 불러오지 못해 AI 가 보지 못했어요");
    route = broken;

    // 받는 사이 공간이 바뀜 — 보내지 않는다
    const thumb = deferred<Response>();
    const beforeThumb = route;
    route = (c: Call) => (c.path.startsWith("/api/assets/thumb") ? thumb.promise : beforeThumb(c));
    dropApp({ "application/x-ch-asset": JSON.stringify([{ project: "my-assets", path: "a.png", name: "a.png", type: "image" }]) });
    await flush();
    type("이것도");
    enter();
    await flush();
    await render({ scope: "team", id: "team-a", name: null });
    thumb.resolve(jpeg());
    await flush();
    expect(turnCalls()).toHaveLength(2);

    // 합계 상한 — 1.4MB 그림 다섯 장이면 다섯째를 뺀다(4 × 1.4MB = 5.6MB, 5장 = 7MB > 6,000,000)
    const big = new Uint8Array(1_400_000);
    big.set([0xff, 0xd8, 0xff]);
    route = (c: Call) => (c.path.startsWith("/api/assets/thumb")
      ? new Response(big, { status: 200, headers: { "Content-Type": "image/jpeg" } }) : beforeThumb(c));
    dropApp({ "application/x-ch-asset": JSON.stringify(["1", "2", "3", "4", "5"].map((n) => ({ project: "my-assets", path: `${n}.png`, name: `${n}.png`, type: "image" }))) });
    await flush();
    type("다섯 장");
    enter();
    await flush(20);
    const last = turnCalls().at(-1)!.body as { images: { index: number }[] };
    expect(last.images.map((i) => i.index)).toEqual([0, 1, 2, 3]);
    expect(notice()).toBe("5번 그림은 불러오지 못해 AI 가 보지 못했어요");
  });

  it("올리는 사이 공간이 바뀌면 칩을 붙이지 않음 · 공간 미확정이면 붙여넣기를 올리지 않음 · 업로드 실패는 칩을 빼고 안내", async () => {
    const capture = deferred<Response>();
    const base = route;
    route = (c: Call) => (c.path === "/api/assets/capture" ? capture.promise : base(c));
    await render();
    paste([{ type: "image/png", file: file("image.png", "image/png") }]);
    await flush();
    expect(chipKinds()).toEqual(["올리는 중"]);
    await render({ scope: "team", id: "team-a", name: null });
    capture.resolve(json({ project: "captures", path: "late.png", name: "late.png", type: "image" }));
    await flush();
    expect(chipNames()).toEqual([]);

    await render({ scope: "unknown", id: null, name: null });
    const before = calls.filter((c) => c.path === "/api/assets/capture").length;
    paste([{ type: "image/png", file: file("image.png", "image/png") }]);
    await flush();
    expect([calls.filter((c) => c.path === "/api/assets/capture").length, notice()]).toEqual([before, "공간을 확인한 뒤 다시 붙여 주세요"]);

    route = (c: Call) => (c.path === "/api/assets/capture" ? json({ detail: "캡쳐가 너무 큽니다" }, 413) : base(c));
    await render();
    paste([{ type: "image/png", file: file("image.png", "image/png") }]);
    await flush();
    expect([chipNames(), notice()]).toEqual([[], expect.stringContaining("그림을 올리지 못했어요")]);
  });
});

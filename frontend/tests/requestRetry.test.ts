// Jay 결정 2A(10-15): 서버는 받았는데 답만 끊긴 뒤 다시 누르면 두 번 과금되던 것 — 허브가 재전송 계약(request_retry_v1)을 알리면
//  답이 없을 때(전송 TypeError·본문 끊김) 같은 요청표·같은 헤더로 한 번만 더 보낸다. HTTP 오류는 다시 보내지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { comfyApi } from "../src/lib/comfyApi";
import { ApiPausedError, HttpError, jsonFetch, NO_RESPONSE_MESSAGE } from "../src/lib/http";
import { setHubFeatures } from "../src/lib/hubFeatures";

const ok = (value: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(value) }) as unknown as Response;
const httpFail = (status: number) => ({ ok: false, status, headers: new Headers(), json: () => Promise.resolve({ detail: "x" }), text: () => Promise.resolve("x") }) as unknown as Response;
const lost = () => Promise.reject(new TypeError("Failed to fetch"));
const paused = () => Promise.reject(new ApiPausedError("paused")); // 관문(4B)이 다른 탭 로그아웃으로 멈췄다
const workspace = { scope: "team", id: "ws", name: "공간" } as const;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  setHubFeatures(["request_retry_v1"]);
});
afterEach(() => {
  setHubFeatures([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async <T,>(promise: Promise<T>) => {
  const result = promise.then((value) => ({ value }), (error: Error) => ({ error }));
  await vi.advanceTimersByTimeAsync(2000);
  return result;
};

describe("전송 층 재전송(jsonFetch retryNoResponse)", () => {
  it("답이 없으면 1초 뒤 같은 헤더·같은 본문으로 한 번 더 — 두 번째 답을 쓴다", async () => {
    fetchMock.mockImplementationOnce(lost).mockResolvedValueOnce(ok({ id: "g1" }));
    const out = await settle(jsonFetch("/api/gen-requests", { method: "POST", body: "{}" }, undefined, { retryNoResponse: true }));
    expect(out).toEqual({ value: { id: "g1" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]); // 변경 id·토큰까지 같은 헤더
  });

  it("본문을 다 못 읽어도 다시 받는다(서버는 이미 처리 — 같은 요청표면 처음 결과)", async () => {
    const broken = { ...ok(null), json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")) } as unknown as Response;
    fetchMock.mockResolvedValueOnce(broken).mockResolvedValueOnce(ok({ id: "g1" }));
    expect(await settle(jsonFetch("/x", { method: "POST" }, undefined, { retryNoResponse: true }))).toEqual({ value: { id: "g1" } });
  });

  it("두 번 다 본문이 끊겨도 '들어갔을 수 있다'로 실패한다(SyntaxError 그대로가 아니다)", async () => {
    const broken = () => ({ ...ok(null), json: () => Promise.reject(new SyntaxError("Unexpected end")) }) as unknown as Response;
    fetchMock.mockImplementation(() => Promise.resolve(broken()));
    const out = await settle(jsonFetch("/x", { method: "POST" }, undefined, { retryNoResponse: true }));
    expect((out as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP 오류는 다시 보내지 않는다 · 두 번 다 답이 없으면 '들어갔을 수 있다'로 실패 · 켜지 않으면 지금처럼", async () => {
    fetchMock.mockResolvedValueOnce(httpFail(500));
    const failed = await settle(jsonFetch("/x", { method: "POST" }, undefined, { retryNoResponse: true }));
    expect((failed as { error: Error }).error).toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset().mockImplementation(lost);
    const twice = await settle(jsonFetch("/x", { method: "POST" }, undefined, { retryNoResponse: true }));
    expect((twice as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockImplementation(lost);
    const off = await settle(jsonFetch("/x", { method: "POST" }));
    expect((off as { error: Error }).error).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Codex 61회차(2A×4B) — 첫 요청의 답이 끊긴 뒤 다시 보내기 직전에 멈추면, 첫 요청이 들어갔을 수 있다. 실패로 보이면 다시 눌러 두 번 과금된다.
describe("다시 보내기 전에 멈추면(다른 탭 로그아웃) 결과 불명을 유지", () => {
  it("jsonFetch: 둘째 전송이 멈춤으로 못 나가도 '들어갔을 수 있다' · 첫 전송부터 멈춤이면 보내지 않은 것(멈춤 그대로)", async () => {
    fetchMock.mockImplementationOnce(lost).mockImplementationOnce(paused);
    const out = await settle(jsonFetch("/api/gen-requests", { method: "POST", body: "{}" }, undefined, { retryNoResponse: true }));
    expect((out as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);

    fetchMock.mockReset().mockImplementation(paused);
    const before = await settle(jsonFetch("/api/gen-requests", { method: "POST", body: "{}" }, undefined, { retryNoResponse: true }));
    expect((before as { error: Error }).error).toBeInstanceOf(ApiPausedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Codex 62회차 — 허브는 업데이트 중·그사이 계정 바뀜이면 요청표를 보기 전에 409 로 거절한다. 다시 보낸 요청의 거절은 첫 요청이 안 됐다는 뜻이 아니다.
  it("jsonFetch: 다시 보낸 요청이 거절(409)돼도 '들어갔을 수 있다' — 답이 없었을 때도, 본문이 끊겼을 때도", async () => {
    fetchMock.mockImplementationOnce(lost).mockResolvedValueOnce(httpFail(409));
    const afterLost = await settle(jsonFetch("/api/gen-requests", { method: "POST", body: "{}" }, undefined, { retryNoResponse: true }));
    expect((afterLost as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);

    const broken = { ...ok(null), json: () => Promise.reject(new SyntaxError("Unexpected end")) } as unknown as Response;
    fetchMock.mockReset().mockResolvedValueOnce(broken).mockResolvedValueOnce(httpFail(409));
    const afterCut = await settle(jsonFetch("/api/gen-requests", { method: "POST", body: "{}" }, undefined, { retryNoResponse: true }));
    expect((afterCut as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);
  });

  it("Comfy [실행]: 다시 보낸 요청이 거절돼도 '들어갔을 수 있다'", async () => {
    fetchMock.mockImplementationOnce(lost).mockResolvedValueOnce(httpFail(409));
    const out = await settle(comfyApi.run("{}"));
    expect((out as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);
  });

  it("Comfy [실행]: 둘째 전송이 멈춤으로 못 나가도 '들어갔을 수 있다'", async () => {
    fetchMock.mockImplementationOnce(lost).mockImplementationOnce(paused);
    const out = await settle(comfyApi.run("{}"));
    expect((out as { error: Error }).error.message).toBe(NO_RESPONSE_MESSAGE);
  });
});

describe("생성 요청 — 허브 기능 표식이 있을 때만", () => {
  it("표식이 있으면 계정 헤더를 싣고 같은 요청표로 한 번 더 보낸다", async () => {
    fetchMock.mockImplementationOnce(lost).mockResolvedValueOnce(ok({ id: "g1", prompt: "p", assets: [] }));
    const out = await settle(api.prepareCreate({ prompt: "p", model: "m" }, workspace)());
    expect("value" in out).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
    expect(second.body).toBe(first.body); // 같은 idempotency_key
    expect((first.headers as Record<string, string>)["X-MVHub-Expect-Account"]).toBe("local");
  });

  it("옛 허브(표식 없음)엔 지금처럼 한 번만, 계정 헤더도 없이", async () => {
    setHubFeatures([]);
    fetchMock.mockImplementation(lost);
    await settle(api.prepareCreate({ prompt: "p", model: "m" }, workspace)());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("X-MVHub-Expect-Account");
  });
});

describe("Comfy [실행] — run_key", () => {
  it("답이 없으면 같은 run_key·같은 FormData 로 한 번 더 보낸다", async () => {
    fetchMock.mockImplementationOnce(lost).mockResolvedValueOnce(ok({ outputs: [] }));
    const out = await settle(comfyApi.run("{}"));
    expect(out).toEqual({ value: { outputs: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
    expect(second.body).toBe(first.body);
    expect((first.body as FormData).get("run_key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("옛 허브엔 run_key 없이 한 번만", async () => {
    setHubFeatures([]);
    fetchMock.mockImplementation(lost);
    await settle(comfyApi.run("{}"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1].body as FormData).get("run_key")).toBeNull();
  });
});

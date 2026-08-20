import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("general generation request idempotency", () => {
  it("한 제출 의도의 HTTP 재시도는 같은 키를 쓰고 새 의도는 새 키를 쓴다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    const workspace = { scope: "personal" as const, id: null, name: null };
    const body = { prompt: "same prompt", model: "nano" };

    const submitIntent = api.prepareCreate(body, workspace);
    await submitIntent();
    await submitIntent();
    await api.prepareCreate(body, workspace)();

    const requests = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)),
    );
    expect(requests[0].idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requests[1].idempotency_key).toBe(requests[0].idempotency_key);
    expect(requests[2].idempotency_key).not.toBe(requests[0].idempotency_key);
  });

  it("캔버스 제출에는 일반 멱등키를 추가하지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.prepareCreate(
      { prompt: "canvas", model: "nano" },
      { scope: "personal", id: null, name: null },
      {
        attempt_id: "attempt_1234567890_a",
        generation_id: "generation_1234567890_a",
        scene_id: "scene-a",
        card_id: "card-a",
      },
    )();

    const request = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(request.idempotency_key).toBeUndefined();
    expect(request.canvas_link.attempt_id).toBe("attempt_1234567890_a");
  });
});

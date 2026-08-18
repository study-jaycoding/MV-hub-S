import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../src/api";
import { setAccountScope } from "../src/lib/accountScope";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generation comment cache account boundary", () => {
  it("같은 생성물 id라도 다른 로그인 계정의 캐시를 보여주지 않는다", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { id: "c1", author: "u1", author_name: "A", text: "private-a", created_at: "", parent_id: null },
      ]),
    }));

    setAccountScope("a@example.com");
    await api.genComments("same-gen");
    expect(api.genCommentsCached("same-gen")?.[0]?.text).toBe("private-a");

    setAccountScope("b@example.com");
    expect(api.genCommentsCached("same-gen")).toBeUndefined();
  });
});

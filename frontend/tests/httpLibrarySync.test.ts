import { afterEach, expect, it, vi } from "vitest";
import { jsonFetch } from "../src/lib/http";
import {
  beginLibraryReload,
  consumeOwnDomainSync,
  decideLibrarySync,
  finishLibraryReload,
  LIBRARY_CLIENT_ID_HEADER,
  LIBRARY_MUTATION_ID_HEADER,
  MUTATION_DOMAINS_HEADER,
} from "../src/lib/librarySync";

afterEach(() => vi.unstubAllGlobals());

it("서버가 실제 변경 id를 확인한 요청만 후속 목록 reload의 범위로 기록한다", async () => {
  let sentOrigin: { client_id: string; mutation_id: string } | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sentOrigin = {
        client_id: headers[LIBRARY_CLIENT_ID_HEADER],
        mutation_id: headers[LIBRARY_MUTATION_ID_HEADER],
      };
      return Promise.resolve({
        ok: true,
        headers: new Headers({ [LIBRARY_MUTATION_ID_HEADER]: sentOrigin.mutation_id }),
        json: () => Promise.resolve({ ok: true }),
      });
    }),
  );

  await jsonFetch("/api/generations/g1/tags", { method: "PUT", body: "{}" });
  const reload = beginLibraryReload();
  finishLibraryReload(reload, true);

  expect(sentOrigin).not.toBeNull();
  expect(decideLibrarySync([sentOrigin!])).toBe("skip");
});

it("Assets 응답은 라이브러리 reload가 아니라 Assets 자기 알림으로 기록한다", async () => {
  let sentOrigin: { client_id: string; mutation_id: string } | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sentOrigin = {
        client_id: headers[LIBRARY_CLIENT_ID_HEADER],
        mutation_id: headers[LIBRARY_MUTATION_ID_HEADER],
      };
      return Promise.resolve({
        ok: true,
        headers: new Headers({
          [LIBRARY_MUTATION_ID_HEADER]: sentOrigin.mutation_id,
          [MUTATION_DOMAINS_HEADER]: "assets",
        }),
        json: () => Promise.resolve({ ok: true }),
      });
    }),
  );

  await jsonFetch("/api/assets/files/meta", { method: "PUT", body: "{}" });
  expect(beginLibraryReload().mutationIds.size).toBe(0);
  expect(consumeOwnDomainSync("assets", [sentOrigin!])).toBe(true);
});

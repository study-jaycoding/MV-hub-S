// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { getAuthToken, setAuthToken } from "../src/lib/http";
import { ColorScopeChangedError } from "../src/lib/generationColorState";

type Call = { ids: string[]; token: string | null; save: boolean; resolve: (response: Response) => void };
let calls: Call[];
let active: number;
let maximum: number;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `g-${i}`);
const assertA = () => { if (getAuthToken() !== "synthetic-A") throw new ColorScopeChangedError(); };
const empty = (save: boolean) => new Response(JSON.stringify(save ? { succeeded: [], failed: [] } : { items: {}, materials: {}, missing: [] }));
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function finish(index: number) { active--; calls[index].resolve(empty(calls[index].save)); }
beforeEach(() => {
  calls = []; active = 0; maximum = 0;
  setAuthToken("synthetic-A");
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const requested = body.gen_ids ?? body.items.map((item: { id: string }) => item.id);
    active++; maximum = Math.max(maximum, active);
    return new Promise<Response>(resolve => calls.push({ ids: requested, save: !!body.items, token: new Headers(init.headers).get("Authorization"), resolve }));
  }));
});
afterEach(() => { setAuthToken(null); vi.unstubAllGlobals(); });

it.each([1, 500, 501, 1200, 1501, 2001])("stable batch read %i preserves 500-page limit and at most three workers", async n => {
  const work = api.getGenerationsBatch(ids(n), assertA);
  await settle();
  expect(calls).toHaveLength(Math.min(3, Math.ceil(n / 500)));
  let completed = 0;
  while (completed < Math.ceil(n / 500)) { finish(completed++); await settle(); }
  await expect(work).resolves.toEqual({ items: {}, materials: {}, missing: [] });
  expect(calls.flatMap(call => call.ids)).toEqual(ids(n));
  expect(calls.every(call => call.ids.length <= 500 && call.token === "Bearer synthetic-A")).toBe(true);
  expect(maximum).toBe(Math.min(3, Math.ceil(n / 500)));
});
it.each([501, 1200, 1501, 2001])("read %i never sends a later page with the switched token", async n => {
  const work = api.getGenerationsBatch(ids(n), assertA).catch(error => error);
  await settle(); const started = calls.length;
  setAuthToken("synthetic-B");
  for (let i = 0; i < started; i++) finish(i);
  await settle();
  const outcome = await work;
  if (n > 1500) expect(outcome).toBeInstanceOf(ColorScopeChangedError);
  else expect(outcome).toEqual({ items: {}, materials: {}, missing: [] }); // all pages had already started as A
  expect(calls).toHaveLength(started);
  expect(calls.every(call => call.token === "Bearer synthetic-A")).toBe(true);
});
it.each([0, 1])("empty/single read %i preserves no-request/guard rejection contract", async n => {
  setAuthToken("synthetic-B");
  if (n) await expect(api.getGenerationsBatch(ids(n), assertA)).rejects.toBeInstanceOf(ColorScopeChangedError);
  else await expect(api.getGenerationsBatch([], assertA)).resolves.toEqual({ items: {}, materials: {}, missing: [] });
  expect(calls).toHaveLength(0);
});
it.each([500, 501, 1200])("stable save %i sends sequential batches of up to 500", async n => {
  const work = api.setColorsBatch(ids(n), "red", assertA);
  await settle();
  expect(calls).toHaveLength(1);
  for (let i = 0; i < Math.ceil(n / 500); i++) { finish(i); await settle(); }
  await expect(work).resolves.toEqual({ succeeded: [], failed: [] });
  expect(calls.flatMap(call => call.ids)).toEqual(ids(n));
  expect(maximum).toBe(1);
});
it.each([501, 1200])("save %i refuses a subsequent chunk after token change", async n => {
  const work = api.setColorsBatch(ids(n), "red", assertA).catch(error => error);
  await settle(); setAuthToken("synthetic-B"); finish(0); await settle();
  expect(await work).toBeInstanceOf(ColorScopeChangedError);
  expect(calls.map(call => call.ids.length)).toEqual([500]);
});

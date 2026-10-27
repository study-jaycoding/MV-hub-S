// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelParamsOut } from "../src/types";

const mocks = vi.hoisted(() => ({ modelParams: vi.fn(), estimateCost: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/modelCatalogCache", () => ({ fetchModelCatalog: async () => [] }));

const MODEL = "nano_banana_pro";
const START = 1_700_000_000_000;
const POLICY = { allowed: new Set<string>(), ready: false, initialModel: MODEL };
let hook: ReturnType<typeof import("../src/lib/useModels").useModels>;
let useModels: typeof import("../src/lib/useModels").useModels;
const views: Array<{ root: Root; element: HTMLDivElement }> = [];

function schema(saved = Date.now() / 1000, values = ["1k", "2k"]): ModelParamsOut {
  return { job_set_type: MODEL, type: "image", saved_at: saved, stale: false,
    params: [{ name: "resolution", type: "string", required: false, default: "1k", enum: values }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount(onError = vi.fn(), initialOpts?: Record<string, string | number | boolean>) {
  function Picker() {
    hook = useModels(onError, initialOpts ? { ...POLICY, initialOpts } : POLICY);
    return <span>{hook.cost}</span>;
  }
  const element = document.createElement("div");
  document.body.append(element);
  const view = { root: createRoot(element), element };
  views.push(view);
  await act(async () => { view.root.render(<Picker />); });
  return view;
}

async function close(view: typeof views[number]) {
  await act(async () => { view.root.unmount(); });
  view.element.remove();
  views.splice(views.indexOf(view), 1);
}

async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  mocks.modelParams.mockReset().mockImplementation(async () => schema());
  mocks.estimateCost.mockReset().mockImplementation(async () => ({ credits: 2, saved_at: Date.now() / 1000, stale: false }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ useModels } = await import("../src/lib/useModels"));
});

afterEach(async () => {
  for (const view of [...views]) await close(view);
  vi.useRealTimers();
});

describe("model metadata refresh", () => {
  it("shares cold requests and reuses fresh prices across picker instances", async () => {
    await mount();
    await mount();
    await tick(250);
    expect(mocks.modelParams).toHaveBeenCalledTimes(1);
    expect(mocks.estimateCost).toHaveBeenCalledTimes(1);
    expect(hook.cost).toBe(2);
  });

  it("shows expired prices immediately, joins the fresh request, and applies the new price", async () => {
    const first = await mount();
    await tick(250);
    await close(first);
    vi.setSystemTime(START + 12 * 3600_000 + 1000);
    const fresh = deferred<{ credits: number; saved_at: number; stale: boolean }>();
    mocks.estimateCost.mockImplementation((_model, _params, _prompt, waitFresh) => waitFresh
      ? fresh.promise : Promise.resolve({ credits: 2, saved_at: START / 1000, stale: true }));
    await mount();
    await mount();
    expect(hook.cost).toBe(2);
    await tick(1);
    expect(mocks.estimateCost).toHaveBeenCalledTimes(3);
    await act(async () => { fresh.resolve({ credits: 5, saved_at: Date.now() / 1000, stale: false }); });
    expect(hook.cost).toBe(5);
    expect(hook.costLoading).toBe(false);
  });

  it("keeps an old price after failure and does not make its timestamp fresh", async () => {
    const first = await mount();
    await tick(250);
    await close(first);
    vi.setSystemTime(START + 13 * 3600_000);
    mocks.estimateCost.mockRejectedValue(new Error("network"));
    const next = await mount();
    await tick();
    expect(hook.cost).toBe(2);
    expect(hook.costLoading).toBe(false);
    await close(next);
    await mount();
    await tick();
    expect(mocks.estimateCost).toHaveBeenCalledTimes(3);
  });

  it("does not apply a late response for another option", async () => {
    await mount();
    await tick(250);
    const late = deferred<{ credits: number; saved_at: number; stale: boolean }>();
    mocks.estimateCost.mockReturnValue(late.promise);
    await act(async () => { hook.setOpt("resolution", "2k"); });
    await tick(250);
    await act(async () => { hook.setOpt("resolution", "1k"); });
    expect(hook.cost).toBe(2);
    await act(async () => { late.resolve({ credits: 8, saved_at: Date.now() / 1000, stale: false }); });
    expect(hook.cost).toBe(2);
  });

  it("preserves values after a schema change and blocks invalid values until edited", async () => {
    const first = await mount();
    await close(first);
    vi.setSystemTime(START + 3600_001);
    const updated = deferred<ModelParamsOut>();
    mocks.modelParams.mockReturnValue(updated.promise);
    const onError = vi.fn();
    await mount(onError, { resolution: "2k" });
    expect(hook.optionValues.resolution).toBe("2k");
    await act(async () => { updated.resolve(schema(Date.now() / 1000, ["1k"])); });
    expect(hook.optionValues.resolution).toBe("2k");
    expect(hook.model).toBe(MODEL);
    expect(hook.paramsError).toBe(true);
    expect(hook.paramsModel).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => { hook.setOpt("resolution", "1k"); });
    expect(hook.paramsError).toBe(false);
    expect(hook.paramsModel).toBe(MODEL);
  });

  it("displays a server stale schema before fresh lookup and preserves edits made during that lookup", async () => {
    const updated = deferred<ModelParamsOut>();
    mocks.modelParams.mockImplementation((_model, fresh) => fresh ? updated.promise : Promise.resolve({ ...schema(START / 1000 - 7200), stale: true }));
    await mount();
    expect(hook.paramsModel).toBe(MODEL);
    expect(hook.optionValues.resolution).toBe("1k");
    await act(async () => { hook.setOpt("resolution", "2k"); });
    await act(async () => { updated.resolve(schema()); });
    expect(hook.optionValues.resolution).toBe("2k");
    expect(mocks.modelParams).toHaveBeenCalledTimes(2);
  });

  it("keeps the successful schema when the single fresh lookup fails", async () => {
    const onError = vi.fn();
    mocks.modelParams.mockImplementation((_model, fresh) => fresh
      ? Promise.reject(new Error("network"))
      : Promise.resolve({ ...schema(START / 1000 - 7200), stale: true }));
    await mount(onError);
    expect(hook.params[0].name).toBe("resolution");
    expect(hook.paramsModel).toBe(MODEL);
    expect(hook.optionValues.resolution).toBe("1k");
    expect(mocks.modelParams).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(mocks.modelParams).toHaveBeenCalledTimes(2);
  });

  it("ignores a response from the model that the user left", async () => {
    await mount();
    const late = deferred<ModelParamsOut>();
    mocks.modelParams.mockImplementation((model: string) => model === "gpt_image_2"
      ? late.promise : Promise.resolve(schema()));
    await act(async () => { hook.setModel("gpt_image_2"); });
    await act(async () => { hook.setModel(MODEL); });
    await act(async () => { late.resolve({ ...schema(), job_set_type: "gpt_image_2", params: [] }); });
    expect(hook.model).toBe(MODEL);
    expect(hook.paramsModel).toBe(MODEL);
    expect(hook.params[0].name).toBe("resolution");
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../src/types";

const mocks = vi.hoisted(() => ({
  models: vi.fn(),
  modelParams: vi.fn(),
  estimateCost: vi.fn(),
  observeDispatch: false,
  dispatched: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // 실제 React 상태를 유지하고 해제된 이름 리스너의 setter 호출만 관측한다.
    useState: (...args: Parameters<typeof actual.useState>) => {
      const [value, update] = actual.useState(...args);
      return [value, (next: Parameters<typeof update>[0]) => {
        if (mocks.observeDispatch) mocks.dispatched();
        update(next);
      }];
    },
  };
});

const CODE = "synthetic_new_model";
const MODELS: ModelInfo[] = [
  { job_set_type: CODE, display_name: "Canonical Audit Model", type: "image" },
];
let catalog: typeof import("../src/lib/modelCatalog");
const mounted: Array<{ root: Root; element: HTMLDivElement }> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mount(node: React.ReactNode) {
  const element = document.createElement("div");
  document.body.append(element);
  const item = { root: createRoot(element), element };
  mounted.push(item);
  await act(async () => { item.root.render(node); });
  return item;
}

async function unmount(item: (typeof mounted)[number]) {
  await act(async () => { item.root.unmount(); });
  item.element.remove();
  mounted.splice(mounted.indexOf(item), 1);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0); // 0도 첫 시도를 막지 않아야 한다.
  mocks.models.mockReset();
  mocks.modelParams.mockReset().mockResolvedValue({ params: [] });
  mocks.estimateCost.mockReset().mockResolvedValue({ credits: 0 });
  mocks.dispatched.mockReset();
  mocks.observeDispatch = false;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  catalog = await import("../src/lib/modelCatalog");
});

afterEach(async () => {
  for (const item of [...mounted]) await unmount(item);
  mocks.observeDispatch = false;
  vi.useRealTimers();
});

describe("표시명 카탈로그 실패 복구", () => {
  it("시각 0의 첫 100호출은 같은 Promise/HTTP에 합류하고 성공 이름은 유지한다", async () => {
    const gate = deferred<ModelInfo[]>();
    mocks.models.mockReturnValue(gate.promise);
    const pending = Array.from({ length: 100 }, () => catalog.ensureModelCatalog());
    expect(pending.every((value) => value === pending[0])).toBe(true);
    expect(mocks.models).toHaveBeenCalledTimes(1);
    gate.resolve(MODELS);
    await Promise.all(pending);
    expect(catalog.modelDisplayName(CODE)).toBe("Canonical Audit Model");
    vi.setSystemTime(120_000);
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "empty"])("%s 뒤 100연속 호출도 초당 한 시도, 다음 초에 복구한다", async (kind) => {
    mocks.models.mockImplementation(() => {
      if (mocks.models.mock.calls.length > 3) return Promise.resolve(MODELS);
      return kind === "failure" ? Promise.reject(new Error("synthetic unavailable")) : Promise.resolve([]);
    });
    for (let interval = 0; interval < 3; interval += 1) {
      vi.setSystemTime(interval * 1000);
      for (let call = 0; call < 100; call += 1) await catalog.ensureModelCatalog();
      expect(mocks.models).toHaveBeenCalledTimes(interval + 1);
      vi.setSystemTime(interval * 1000 + 999);
      await catalog.ensureModelCatalog();
      expect(mocks.models).toHaveBeenCalledTimes(interval + 1);
      expect(catalog.modelDisplayName("nano_banana_flash")).toBe("Nano Banana 2");
      expect(catalog.modelDisplayName("future_model_2_5")).toBe("Future Model 2.5");
      expect(catalog.modelDisplayName(null)).toBe("—");
    }
    vi.setSystemTime(3000);
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(4);
    expect(catalog.modelDisplayName(CODE)).toBe("Canonical Audit Model");
  });

  it("유효 표시명이 없는 비어있지 않은 원시 배열은 공용 TTL 후 재시도한다", async () => {
    // 공용 cache는 원시 배열.length를 기준으로 60초 캐시한다. 이름 쪽에서 우회하지 않는다.
    mocks.models.mockResolvedValueOnce([
      { job_set_type: CODE, display_name: "", type: "image" },
      { job_set_type: "", display_name: "No key", type: "image" },
      { job_set_type: " ", display_name: " ", type: "image" },
    ]).mockResolvedValueOnce(MODELS);
    await catalog.ensureModelCatalog();
    expect(catalog.modelDisplayName(CODE)).toBe("Synthetic New Model");
    vi.setSystemTime(1000);
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(1);
    vi.setSystemTime(60_000);
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(2);
    expect(catalog.modelDisplayName(CODE)).toBe("Canonical Audit Model");
  });

  it("한 개 이상 유효한 표시명이 있으면 맵을 채운 뒤 리스너를 한 번 통지한다", async () => {
    const gate = deferred<ModelInfo[]>();
    mocks.models.mockReturnValue(gate.promise);
    const renders = vi.fn();
    function Name() {
      const name = catalog.useModelDisplayName()(CODE);
      renders(name);
      return <span>{name}</span>;
    }
    const view = await mount(<Name />);
    expect(view.element.textContent).toBe("Synthetic New Model");
    await act(async () => {
      gate.resolve([...MODELS, { job_set_type: "ignored", display_name: "", type: "image" }]);
      await catalog.ensureModelCatalog();
    });
    expect(renders.mock.calls.map(([name]) => name)).toEqual(["Synthetic New Model", "Canonical Audit Model"]);
    await act(async () => { await catalog.ensureModelCatalog(); });
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("실패 중 폴백을 유지하고 다음 ensure 회복에서 마운트된 카드만 갱신한다", async () => {
    mocks.models.mockRejectedValueOnce(new Error("synthetic unavailable")).mockResolvedValueOnce(MODELS);
    const renders = vi.fn();
    function Name() {
      const name = catalog.useModelDisplayName()(CODE);
      renders(name);
      return <span>{name}</span>;
    }
    const view = await mount(<Name />);
    expect(renders).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1000);
    await act(async () => { await catalog.ensureModelCatalog(); });
    expect(view.element.textContent).toBe("Canonical Audit Model");
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("언마운트한 이름 리스너에는 응답 후 setter를 호출하지 않는다", async () => {
    const gate = deferred<ModelInfo[]>();
    mocks.models.mockReturnValue(gate.promise);
    function Name() { return <span>{catalog.useModelDisplayName()(CODE)}</span>; }
    const view = await mount(<Name />);
    await unmount(view);
    mocks.observeDispatch = true;
    await act(async () => {
      gate.resolve(MODELS);
      await catalog.ensureModelCatalog();
    });
    expect(mocks.dispatched).not.toHaveBeenCalled();
    expect(catalog.modelDisplayName(CODE)).toBe("Canonical Audit Model");
  });

  it("실패 뒤 스스로 폴링하지 않고 다음 mount에서 재시도한다", async () => {
    mocks.models.mockRejectedValueOnce(new Error("synthetic unavailable")).mockResolvedValueOnce(MODELS);
    await catalog.ensureModelCatalog();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.models).toHaveBeenCalledTimes(1);
    function Name() { return <span>{catalog.useModelDisplayName()(CODE)}</span>; }
    const view = await mount(<Name />);
    expect(mocks.models).toHaveBeenCalledTimes(2);
    expect(view.element.textContent).toBe("Canonical Audit Model");
  });

  it.each(["picker-first", "name-first"])("실제 picker/name 훅 동시 mount: %s도 목록 HTTP 하나", async (order) => {
    const gate = deferred<ModelInfo[]>();
    mocks.models.mockReturnValue(gate.promise);
    const { useModels } = await import("../src/lib/useModels");
    const onError = vi.fn();
    function Picker() {
      const { models } = useModels(onError, { allowed: new Set(), ready: false });
      return <span>{models[0]?.display_name ?? "picker waiting"}</span>;
    }
    function Name() { return <span>{catalog.useModelDisplayName()(CODE)}</span>; }
    const view = await mount(order === "picker-first" ? <><Picker /><Name /></> : <><Name /><Picker /></>);
    expect(mocks.models).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(MODELS);
      await catalog.ensureModelCatalog();
    });
    expect(view.element.textContent).toBe("Canonical Audit ModelCanonical Audit Model");
    expect(onError).not.toHaveBeenCalled();
  });

  it("이름 재시도 제한 중에도 picker를 새로 열면 명시적 재요청을 막지 않는다", async () => {
    mocks.models.mockRejectedValueOnce(new Error("synthetic unavailable")).mockResolvedValueOnce(MODELS);
    await catalog.ensureModelCatalog();
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(1);
    const { useModels } = await import("../src/lib/useModels");
    const onError = vi.fn();
    function Picker() {
      const { models } = useModels(onError, { allowed: new Set(), ready: false });
      return <span>{models[0]?.display_name}</span>;
    }
    const view = await mount(<Picker />);
    expect(mocks.models).toHaveBeenCalledTimes(2);
    expect(view.element.textContent).toBe("Canonical Audit Model");
    vi.setSystemTime(1000);
    await catalog.ensureModelCatalog();
    expect(mocks.models).toHaveBeenCalledTimes(2);
    expect(catalog.modelDisplayName(CODE)).toBe("Canonical Audit Model");
  });
});

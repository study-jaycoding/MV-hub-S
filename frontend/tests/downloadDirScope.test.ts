// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { saveToDownloadDir, writeIntoDir } from "../src/lib/downloadDir";

afterEach(() => vi.unstubAllGlobals());

it("does not create a file after account changes during folder permission", async () => {
  let current = true;
  const getFileHandle = vi.fn();
  const handle = {
    queryPermission: async () => "prompt",
    requestPermission: async () => { current = false; return "granted"; },
    getFileHandle,
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        request.result = { transaction: () => ({ objectStore: () => ({ get: () => {
          const get: Record<string, unknown> = {};
          queueMicrotask(() => { get.result = handle; (get.onsuccess as () => void)(); });
          return get;
        } }) }) };
        (request.onsuccess as () => void)();
      });
      return request;
    },
  });
  await expect(saveToDownloadDir("bundle.zip", new Blob(["bytes"]), () => {
    if (!current) throw new Error("context changed");
  })).rejects.toThrow("context changed");
  expect(getFileHandle).not.toHaveBeenCalled();
});

it("aborts the staged write when context changes while opening a writable", async () => {
  let current = true;
  const write = vi.fn();
  const abort = vi.fn();
  const dir = { getFileHandle: async (_name: string, options?: { create?: boolean }) => {
    if (!options?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    return { createWritable: async () => { current = false; return { write, abort }; } };
  } };
  await expect(writeIntoDir(dir, "bundle.zip", new Blob(["bytes"]), () => {
    if (!current) throw new Error("context changed");
  })).rejects.toThrow("context changed");
  expect(write).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledOnce();
});

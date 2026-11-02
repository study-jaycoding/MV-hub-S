// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SetCard } from "../src/components/scene/cards/SetCard";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import type { SceneCard } from "../src/lib/scenes";
import {
  encodeSceneFolderDrag,
  parseSceneFolderDrag,
  parseSceneSetTags,
  sceneSetTagsLine,
} from "../src/lib/sceneSet";

describe("sceneSet", () => {
  it("쉼표·줄바꿈 태그를 정리하고 중복을 제거한다", () => {
    expect(parseSceneSetTags(" hero, #night\nHero,  final ")).toEqual([
      "hero",
      "night",
      "final",
    ]);
  });

  it("줄바꿈으로 저장된 태그는 입력칸에 쉼표로 보여 합쳐지지 않고, 쉼표 값은 그대로다", () => {
    expect(sceneSetTagsLine("hero\nnight\r\n final")).toBe("hero, night, final");
    expect(parseSceneSetTags(sceneSetTagsLine("hero\nnight"))).toEqual(["hero", "night"]);
    expect(sceneSetTagsLine("hero, night")).toBe("hero, night");
  });

  it("옛 줄바꿈 태그를 열기만 해서는 저장값을 바꾸지 않고, 고치면 태그가 합쳐지지 않는다", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const noop = () => {};
    const setTagsText = vi.fn();
    const card = { id: "set", kind: "set", x: 0, y: 0, setCfg: { tagsText: "hero\nnight" } } as SceneCard;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(SetCard, { card, setFolder: noop, setTagsText, flushPending: noop, requestFit: noop, onOutPortDown: noop, onResizeDown: noop })));
    act(() => host.querySelector<HTMLElement>(".scene-setnode-tagview")!.click());
    const input = host.querySelector<HTMLInputElement>("input.scene-setnode-pill")!;
    expect(input.value).toBe("hero, night");
    expect(setTagsText).not.toHaveBeenCalled();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "hero, night, day");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(setTagsText).toHaveBeenCalledWith("set", "hero, night, day");
    expect(parseSceneSetTags(setTagsText.mock.calls[0][1])).toEqual(["hero", "night", "day"]);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("폴더 = 프로젝트 칩 하나 + 단계마다 칩 하나 · 지우기는 프로젝트 칩에(Jay 2026-11-02)", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const noop = () => {};
    const setFolder = vi.fn();
    const folder = { projectId: "p1", projectName: "뻘뻘뻘", path: "e060/c0030/render" };
    const card = { id: "set", kind: "set", x: 0, y: 0, setCfg: { folder } } as SceneCard;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(SetCard, { card, setFolder, setTagsText: noop, flushPending: noop, requestFit: noop, onOutPortDown: noop, onResizeDown: noop })));
    expect(host.querySelector(".scene-setnode-project-name")!.textContent).toBe("뻘뻘뻘");
    expect([...host.querySelectorAll(".scene-setnode-step .scene-setnode-tag")].map((el) => el.textContent)).toEqual(["e060", "c0030", "render"]);
    expect(host.querySelectorAll(".scene-setnode-sep")).toHaveLength(2); // 첫 칩 앞에는 › 가 없다
    act(() => host.querySelector<HTMLElement>(".scene-setnode-project .scene-setnode-clear")!.click());
    expect(setFolder).toHaveBeenCalledWith("set", undefined);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("폴더를 끌어 놓으면 값을 넣고 칩이 모두 보이게 카드 늘리기를 요청한다 · 못 읽은 끌기는 요청하지 않는다", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const noop = () => {};
    const setFolder = vi.fn();
    const requestFit = vi.fn();
    const folder = { projectId: "p1", projectName: "뻘뻘뻘", path: "e060/c0030" };
    const card = { id: "set", kind: "set", x: 0, y: 0 } as SceneCard;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(SetCard, { card, setFolder, setTagsText: noop, flushPending: noop, requestFit, onOutPortDown: noop, onResizeDown: noop })));
    const drop = (raw: string) => {
      const e = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { types: [DRAG_TYPES.folder], getData: () => raw } });
      act(() => { host.querySelector(".scene-setnode-folder")!.dispatchEvent(e); });
    };
    drop("not json");
    expect(setFolder).not.toHaveBeenCalled();
    expect(requestFit).not.toHaveBeenCalled();
    drop(encodeSceneFolderDrag(folder));
    expect(setFolder).toHaveBeenCalledWith("set", folder);
    expect(requestFit).toHaveBeenCalledWith("set");
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("폴더 드래그 정보를 정규화하고 안전하지 않은 경로는 거부한다", () => {
    const encoded = encodeSceneFolderDrag({
      projectId: "p1",
      projectName: "프로젝트",
      path: "ep001\\c0010",
    });
    expect(parseSceneFolderDrag(encoded)).toEqual({
      projectId: "p1",
      projectName: "프로젝트",
      path: "ep001/c0010",
    });
    expect(parseSceneFolderDrag(JSON.stringify({ projectId: "p1", path: "../outside" }))).toBeNull();
    expect(parseSceneFolderDrag("not-json")).toBeNull();
  });
});

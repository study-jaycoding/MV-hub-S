// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SetCard } from "../src/components/scene/cards/SetCard";
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

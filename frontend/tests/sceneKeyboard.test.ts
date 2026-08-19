import { describe, expect, it } from "vitest";
import {
  isSceneTextEntryTarget,
  sceneCopyShortcut,
  scenePasteShortcut,
  sceneEscapeTarget,
  sceneKeyIntent,
  sceneNodeKindForKey,
  type SceneKeyLike,
} from "../src/lib/sceneKeyboard";

const key = (value: string, patch: Partial<SceneKeyLike> = {}): SceneKeyLike => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("isSceneTextEntryTarget", () => {
  it("텍스트 입력 요소와 프롬프트 dock에서는 캔버스 단축키를 막는다", () => {
    expect(isSceneTextEntryTarget({ tagName: "input", type: "text" })).toBe(true);
    expect(isSceneTextEntryTarget({ tagName: "textarea" })).toBe(true);
    expect(isSceneTextEntryTarget({ tagName: "select" })).toBe(true);
    expect(isSceneTextEntryTarget({ tagName: "div", isContentEditable: true })).toBe(true);
    expect(
      isSceneTextEntryTarget({ tagName: "button", closest: (selector) => selector === ".sl-dockbar" }),
    ).toBe(true);
  });

  it("체크박스·버튼 같은 비텍스트 컨트롤에서는 캔버스 단축키를 허용한다", () => {
    expect(isSceneTextEntryTarget({ tagName: "input", type: "checkbox" })).toBe(false);
    expect(isSceneTextEntryTarget({ tagName: "button" })).toBe(false);
  });
});

describe("scene keyboard intent", () => {
  it("Escape는 열린 UI를 우선 닫고, 없을 때만 카드·행 선택을 해제한다", () => {
    const base = {
      colorOpen: false,
      pickerOpen: false,
      popupOpen: false,
      selectionCount: 0,
      rowSelectionCount: 0,
    };
    expect(sceneEscapeTarget({ ...base, colorOpen: true, selectionCount: 2 })).toBe("color");
    expect(sceneEscapeTarget({ ...base, pickerOpen: true, selectionCount: 2 })).toBe("picker");
    expect(sceneEscapeTarget({ ...base, popupOpen: true, selectionCount: 2 })).toBe("popup");
    expect(sceneEscapeTarget({ ...base, selectionCount: 1 })).toBe("selection");
    expect(sceneEscapeTarget({ ...base, rowSelectionCount: 1 })).toBe("selection");
    expect(sceneEscapeTarget(base)).toBeNull();
  });

  it("Tab 피커가 열려 있을 때 노드 키를 카드 종류로 변환한다", () => {
    expect(sceneNodeKindForKey("N")).toBe("generation");
    expect(sceneNodeKindForKey("c")).toBe("comfy");
    expect(sceneNodeKindForKey("s")).toBe("set");
    expect(sceneKeyIntent(key("t"), { pickerOpen: true, selectionCount: 0 })).toEqual({
      type: "create-node",
      kind: "text",
    });
  });

  it("undo·redo를 구분한다", () => {
    expect(sceneKeyIntent(key("z", { ctrlKey: true }), { pickerOpen: false, selectionCount: 0 })).toEqual({ type: "undo" });
    expect(
      sceneKeyIntent(key("Z", { metaKey: true, shiftKey: true }), {
        pickerOpen: false,
        selectionCount: 0,
      }),
    ).toEqual({ type: "redo" });
  });

  it("복사는 선택이 있을 때만 캔버스 명령이 된다", () => {
    const event = key("c", { ctrlKey: true });
    expect(sceneCopyShortcut(event, 2)).toBe(true);
    expect(sceneCopyShortcut(event, 0)).toBe(false);
    expect(sceneKeyIntent(event, { pickerOpen: false, selectionCount: 0 })).toBeNull();
    expect(sceneKeyIntent(event, { pickerOpen: false, selectionCount: 2 })).toEqual({ type: "copy" });
  });

  it("붙여넣기 안전 폴백은 내부 복사 노드가 있을 때만 켜진다", () => {
    const event = key("v", { ctrlKey: true });
    expect(scenePasteShortcut(event, 1)).toBe(true);
    expect(scenePasteShortcut(event, 0)).toBe(false);
    expect(scenePasteShortcut(key("v", { ctrlKey: true, altKey: true }), 1)).toBe(false);
  });

  it("두 카드 이상의 C는 자동 연결이고 Delete는 선택 삭제다", () => {
    expect(sceneKeyIntent(key("c"), { pickerOpen: false, selectionCount: 2 })).toEqual({ type: "auto-connect" });
    expect(sceneKeyIntent(key("Delete"), { pickerOpen: false, selectionCount: 1 })).toEqual({ type: "delete" });
    expect(sceneKeyIntent(key("Delete"), { pickerOpen: false, selectionCount: 0 })).toBeNull();
  });

  it("사용자가 바꾼 연결 키는 주입된 매칭 규칙으로 판정한다", () => {
    const matches = (_event: SceneKeyLike, shortcut: string) => shortcut === "boardConnect";
    expect(sceneKeyIntent(key("x"), { pickerOpen: false, selectionCount: 2 }, matches)).toEqual({
      type: "connect",
    });
  });
});

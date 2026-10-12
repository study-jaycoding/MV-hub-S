// @vitest-environment jsdom
// 프롬프트 줄의 태그 필터 ×(조작 규칙 51 — 24회차, Codex 전수 검토): mousedown 에만 걸려 있어 Tab 으로 닿은 뒤 Enter·Space 를 눌러도 아무 일이
//  없었다. 마우스는 전처럼 누르는 순간(mousedown, preventDefault 로 편집칸의 초점을 지킨다) 푼다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightPromptRow } from "../src/components/spotlight/SpotlightPromptRow";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("× 는 Enter·Space 로도 풀리고, 마우스는 mousedown 에서 푼다(초점은 빼앗지 않는다)", () => {
  const onClear = vi.fn();
  const noop = () => {};
  act(() => root.render(
    <SpotlightPromptRow expanded={false} tagFilter="hero" editorRef={{ current: null }} onToggleExpand={noop} onClearTagFilter={onClear}
      onInput={noop} onCaretMove={noop} onKeyDown={noop} onPaste={noop} onCompositionStart={noop} onCompositionEnd={noop}
      onDragOver={noop} onDrop={noop} onDragLeave={noop} onCopyPrompt={noop} />,
  ));
  const x = host.querySelector<HTMLButtonElement>(".sl-tag-badge button")!;
  expect(x.title).toBe("태그 필터 해제");
  const fire = (event: Event) => { act(() => { x.dispatchEvent(event); }); return event; };
  expect(fire(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })).defaultPrevented).toBe(true);
  expect(onClear).toHaveBeenCalledTimes(1); // 전엔 0
  fire(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  expect(onClear).toHaveBeenCalledTimes(2);
  fire(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  expect(onClear).toHaveBeenCalledTimes(2);
  expect(fire(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })).defaultPrevented).toBe(true);
  expect(onClear).toHaveBeenCalledTimes(3);
});

// @vitest-environment jsdom
// 프롬프트 줄 글자 수(Jay 2026-10-28): 오디오에만 있던 글자 수를 이미지·영상에도 보이고, 그 자리(행 아래 여백)를 늘 둬
//  오디오로 바꿀 때 칸 높이가 튀지 않게 한다. 글을 받지 않는 일(보이스 체인지·번역)은 숫자만 숨기고 자리는 그대로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightPromptRow } from "../src/components/spotlight/SpotlightPromptRow";
import { serialize } from "../src/lib/promptEditor";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const noop = () => {};
const render = (extra: Partial<Parameters<typeof SpotlightPromptRow>[0]>) => act(() => root.render(
  <SpotlightPromptRow expanded={false} tagFilter={null} editorRef={{ current: null }} onToggleExpand={noop} onClearTagFilter={noop}
    onInput={noop} onCaretMove={noop} onKeyDown={noop} onPaste={noop} onCompositionStart={noop} onCompositionEnd={noop}
    onDragOver={noop} onDrop={noop} onDragLeave={noop} onCopyPrompt={noop} onClearPrompt={noop} {...extra} />,
));

it("이미지·영상도 글자 수를 보이고, 행은 모델과 상관없이 같은 자리를 둔다", () => {
  render({ charCount: 1234 });
  expect(host.querySelector(".sl-char-count")?.textContent).toBe((1234).toLocaleString()); // 숫자만('자' 없이, Jay 2026-10-28)
  expect(host.querySelector(".sl-prompt-row")?.classList.contains("counted")).toBe(true);
  expect(host.querySelector(".sl-prompt")?.getAttribute("data-placeholder")).toBe("Describe the scene you imagine --- @Source, #Tag");

  render({ charCount: 3, script: { count: 3, max: 5000 } });
  expect(host.querySelector(".sl-char-count")?.textContent).toBe(`3 / ${(5000).toLocaleString()}`);
  expect(host.querySelector(".sl-prompt")?.getAttribute("data-placeholder")).toBe("Write the exact words to be spoken");

  render({ charCount: 3, notice: "글은 넣지 않습니다" });
  expect(host.querySelector(".sl-char-count")).toBeNull();
  expect(host.querySelector(".sl-prompt-row")?.classList.contains("counted")).toBe(true);
});

it("글자 수는 끝 공백도 치는 즉시 센다 — 보내는 글은 전처럼 앞뒤 공백을 자른다", () => {
  const editor = document.createElement("div");
  editor.textContent = "안녕 \u00a0";
  expect(serialize(editor, false).text.length).toBe(4); // 글자 수용 — 끝 공백 2개(칸 끝은 브라우저가 nbsp 로 넣는다)도 센다
  expect(serialize(editor).text).toBe("안녕"); // 보내는 글·견적용
});

// @vitest-environment jsdom
// SET 태그 칸은 한 줄 입력이라 붙여 넣은 줄바꿈이 사라져 태그가 합쳐졌다(재검토 B-05) — 쉼표로 바꿔 넣는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SetCard } from "../src/components/scene/cards/SetCard";
import { parseSceneSetTags } from "../src/lib/sceneSet";
import type { SceneCard } from "../src/lib/scenes";

let host: HTMLDivElement;
let root: Root;
const execCommand = vi.fn();
const noop = () => {};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  execCommand.mockReset();
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(document, "execCommand"); });

async function editing(tagsText: string) {
  const setTagsText = vi.fn();
  const card = { id: "s1", kind: "set", x: 0, y: 0, setCfg: { tagsText } } as SceneCard;
  await act(async () => {
    root.render(<SetCard card={card} setFolder={noop} setTagsText={setTagsText} flushPending={noop} requestFit={noop} onOutPortDown={noop} onResizeDown={noop} />);
  });
  await act(async () => { host.querySelector<HTMLElement>(".scene-setnode-tagview")!.click(); });
  return { input: host.querySelector<HTMLInputElement>("input.scene-setnode-pill")!, setTagsText };
}

function paste(input: HTMLInputElement, text: string) {
  const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), { clipboardData: { getData: () => text } });
  act(() => { input.dispatchEvent(event); });
  return event;
}

it("여러 줄을 붙여 넣으면 쉼표로 바꿔 insertText 로 넣는다 — 입력 이벤트가 저장하고 Ctrl+Z 기록에 남는다", async () => {
  execCommand.mockReturnValue(true);
  const { input, setTagsText } = await editing("");
  const event = paste(input, "태그A\r\n태그B\n태그C");
  expect(event.defaultPrevented).toBe(true);
  expect(execCommand).toHaveBeenCalledExactlyOnceWith("insertText", false, "태그A, 태그B, 태그C");
  expect(setTagsText).not.toHaveBeenCalled();
});

it("insertText 가 안 되면 고른 자리를 바꿔 저장한다 — 태그가 나뉜다", async () => {
  execCommand.mockReturnValue(false);
  const { input, setTagsText } = await editing("앞, 뒤");
  input.setSelectionRange(1, 1);
  paste(input, "A\nB");
  expect(setTagsText).toHaveBeenCalledExactlyOnceWith("s1", "앞A, B, 뒤");
  expect(parseSceneSetTags(setTagsText.mock.calls[0][1])).toEqual(["앞A", "B", "뒤"]);
  input.setSelectionRange(0, 2); // 고른 글을 바꾼다
  paste(input, "X\nY");
  expect(setTagsText).toHaveBeenLastCalledWith("s1", "X, Y, B, 뒤");
});

it("한 줄 붙여넣기는 브라우저 기본 동작이다", async () => {
  const { input, setTagsText } = await editing("");
  const event = paste(input, "태그A, 태그B");
  expect(event.defaultPrevented).toBe(false);
  expect(execCommand).not.toHaveBeenCalled();
  expect(setTagsText).not.toHaveBeenCalled();
});

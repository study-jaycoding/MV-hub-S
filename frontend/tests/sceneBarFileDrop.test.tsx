// @vitest-environment jsdom
// 탭 줄에 파일 놓기 = 히스토리(Jay 2026-11-23) — 그림·영상·오디오 가운데 첫 장만 넘긴다. 글·PDF·씬 파일이 앞에 있어도 건너뛴다(Codex 리뷰 01a20662).
//  끄는 동안 탭 줄이 받는 자리로 빛나고 맨 뒤에 새 탭 자리가 보인다. 파일이 아닌 끌기는 받지 않는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import type { WorkspaceContext } from "../src/types";

const scene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 0 });
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const onDropFile = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onDropFile.mockClear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <SceneBar scenes={[scene("s1")]} activeId="s1" workspaceContext={personal} onSelect={vi.fn()} onAdd={vi.fn()}
      onRename={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} onAssignWorkspace={vi.fn()} onDropFile={onDropFile} />,
  ));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const bar = () => host.querySelector<HTMLElement>(".scene-bar")!;
const send = (type: "dragover" | "drop", files: File[], types = ["Files"]) => {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    dataTransfer: { types, files, items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), dropEffect: "none" },
  });
  act(() => { bar().dispatchEvent(event); });
  return event;
};
const file = (name: string, type: string) => new File(["x"], name, { type });

it("글·PDF·씬 파일을 건너뛰고 첫 미디어 한 장만 넘긴다", () => {
  const png = file("stamped.png", "image/png");
  const event = send("drop", [file("notes.txt", "text/plain"), file("a.pdf", "application/pdf"), file("s.json", "application/json"), png, file("b.mp4", "video/mp4")]);
  expect(event.defaultPrevented).toBe(true);
  expect(onDropFile).toHaveBeenCalledExactlyOnceWith(png);
});

it("미디어가 없으면 아무것도 넘기지 않는다", () => {
  send("drop", [file("notes.txt", "text/plain")]);
  expect(onDropFile).not.toHaveBeenCalled();
});

it("파일을 끄는 동안 탭 줄이 빛나고 새 탭 자리가 보이며, 놓으면 꺼진다", () => {
  const over = send("dragover", [file("a.png", "image/png")]);
  expect(over.defaultPrevented).toBe(true);
  expect(bar().classList.contains("file-over")).toBe(true);
  expect(host.querySelector(".scene-tab-dropghost")).not.toBeNull();
  send("drop", [file("a.png", "image/png")]);
  expect(bar().classList.contains("file-over")).toBe(false);
  expect(host.querySelector(".scene-tab-dropghost")).toBeNull();
});

it("파일이 아닌 끌기는 받지 않는다(전역 지킴이가 '놓을 수 없음'으로 둔다)", () => {
  const over = send("dragover", [], ["text/plain"]);
  expect(over.defaultPrevented).toBe(false);
  expect(bar().classList.contains("file-over")).toBe(false);
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CutThumbs } from "../src/components/manage/CutThumbs";
import type { Task } from "../src/components/manage/types";
import { setLang } from "../src/lib/i18n";

vi.mock("../src/components/MediaThumbnail", () => ({
  MediaThumbnail: ({ thumb, src }: { thumb?: string; src?: string }) => <img src={thumb || src} />,
}));
let host: HTMLDivElement;
let root: Root;
const unlink = vi.fn();
const thumbnail = vi.fn((thumb?: string | null) => thumb || undefined);
function render(task: Task, readOnly = false) {
  act(() => root.render(<CutThumbs task={task} thumb={thumbnail} myUid="me" onUnlinkGen={unlink} readOnly={readOnly} />));
}
const base: Task = { id: "task", project_id: "project", name: "ep", status: "in_progress", created_at: "2026-09-17" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); setLang("ko");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("does not render or resolve media for another creator's private cuts", () => {
  render({ ...base, cuts: [1, 2].map((id) => ({ id: `fact:${id}`, status: "done", creator_uid: "other",
    metadata_only: true, thumb: "must-not-load", file_path: "must-not-load", media_type: "video" })) });
  expect(host.textContent).toBe("미공유 2개");
  expect(host.querySelector("img,video")).toBeNull();
  expect(thumbnail).not.toHaveBeenCalled();
});

it("shows local absence without changing counts or invoking media fallback", () => {
  render({ ...base, cuts: [{ id: "fact:1", status: "done", creator_uid: "me", metadata_only: true,
    preview_state: "missing" }] });
  expect(host.textContent).toBe("이 PC에 원본 없음 1개");
  expect(host.querySelector("img,video")).toBeNull();
});

it("renders verified local media and shared media alongside private counts", () => {
  render({ ...base, cuts: [
    { id: "fact:1", status: "done", creator_uid: "me", metadata_only: true, preview_state: "ready", thumb: "/own" },
    { id: "shared", status: "done", shared: true, thumb: "/shared" },
    { id: "fact:2", status: "done", creator_uid: "other", metadata_only: true },
  ] });
  expect([...host.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["/own", "/shared"]);
  expect(host.textContent).toContain("미공유 1개");
});

it("keeps existing content unlink controls but never enables them for fact ids", () => {
  const task: Task = { ...base, cuts: [
    { id: "content", status: "done", metadata_only: true, linked: true },
    { id: "fact:1", status: "done", metadata_only: true, linked: true },
  ] };
  render(task);
  expect(host.querySelectorAll("button")).toHaveLength(1);
  act(() => host.querySelector("button")?.click());
  expect(unlink).toHaveBeenCalledWith("task", "content");
  render(task, true);
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

it("translates private preview labels to English", () => {
  setLang("en");
  render({ ...base, cuts: [{ id: "fact:1", status: "done", creator_uid: "other", metadata_only: true }] });
  expect(host.textContent).toBe("Unshared: 1");
});

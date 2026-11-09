// @vitest-environment jsdom
// 코멘트 창 왼쪽 썸네일 칸(Jay 11-09 시안 C-2) — 어떤 생성물·파일의 코멘트인지 썸네일로 보이고, 누르면 크게 보기.
//  썸네일이 있으면 머리줄의 프롬프트·파일 이름 글자는 빼고(마우스를 올리면 그 글자), 없으면 지금처럼 글자. 그림 창 안에 끼운 목록엔 붙이지 않는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommentPanel, type CommentMedia, type CommentPanelItem } from "../src/components/common/CommentPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const item: CommentPanelItem = { id: "c1", author: "me", author_name: "나", text: "모자 색", created_at: "2026-11-09 08:00:00", parent_id: null };
function show(media: CommentMedia | null, embedded = false) {
  act(() => root.render(<CommentPanel comments={[item]} label="매튜집 프롬프트" myId="me" panelRef={() => {}} pos={{ x: 0, y: 0 }}
    onHeadMouseDown={() => {}} onClose={() => {}} onSend={async () => true} onEdit={async () => true} onDelete={() => {}}
    embedded={embedded} media={media} />));
}

it("shows the target's thumbnail on the left; clicking it opens the big view and the header drops the prompt text", () => {
  const onOpen = vi.fn();
  show({ thumb: "/thumbs/g1.jpg", type: "video", title: "매튜집 프롬프트 전체", onOpen });
  const panel = host.querySelector(".cmt-panel")!;
  expect(panel.classList.contains("cmt-with-media")).toBe(true);
  const media = panel.querySelector<HTMLButtonElement>(".cmt-media")!;
  expect(media.getAttribute("title")).toBe("매튜집 프롬프트 전체"); // 마우스를 올리면 프롬프트
  expect(media.querySelector("img")?.getAttribute("src")).toBe("/thumbs/g1.jpg");
  expect(media.querySelector(".cmt-media-play")).not.toBeNull(); // 영상 표시
  expect(panel.querySelector(".cmt-file")).toBeNull(); // 머리줄 프롬프트 글자는 뺐다
  // 썸네일 칸 옆 세로 칸에 머리줄·목록·입력이 그대로 있다
  const col = panel.querySelector(".cmt-col")!;
  expect(col.querySelector(".cmt-head")).not.toBeNull();
  expect(col.querySelector(".cmt-thread")?.textContent).toContain("모자 색");
  expect(col.querySelector(".cmt-input input")).not.toBeNull();
  act(() => media.click());
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("a video plays silently in place while the pointer is over the thumbnail and stops when it leaves (Jay 11-09)", () => {
  show({ thumb: "/thumbs/v.jpg", type: "video", title: "v", onOpen: () => {}, videoUrl: "/files/v.mp4" });
  const media = host.querySelector<HTMLButtonElement>(".cmt-media")!;
  expect(media.querySelector("video")).toBeNull(); // 올리기 전엔 영상을 받지 않는다
  act(() => { media.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  const video = media.querySelector("video")!;
  expect(video.getAttribute("src")).toBe("/files/v.mp4");
  expect(video.muted && video.loop && video.autoplay).toBe(true);
  act(() => { media.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
  expect(media.querySelector("video")).toBeNull(); // 떼면 내려 멈춘다
  show({ thumb: "/thumbs/i.jpg", type: "image", title: "i", onOpen: () => {} });
  act(() => { host.querySelector(".cmt-media")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  expect(host.querySelector(".cmt-media video")).toBeNull(); // 이미지는 그대로
});

it("keeps the old header text without a thumbnail, and never adds the column inside the draw window", () => {
  show(null);
  expect(host.querySelector(".cmt-media")).toBeNull();
  expect(host.querySelector(".cmt-panel")!.classList.contains("cmt-with-media")).toBe(false);
  expect(host.querySelector(".cmt-file")?.textContent).toBe("매튜집 프롬프트");
  show({ thumb: "/thumbs/g1.jpg", type: "image", title: "t", onOpen: () => {} }, true);
  expect(host.querySelector(".cmt-media")).toBeNull();
  expect(host.querySelector(".cmt-panel")!.classList.contains("cmt-with-media")).toBe(false);
});

it("an audio target shows a placeholder, and a target that cannot open stays a plain picture", () => {
  show({ thumb: null, type: "audio", title: "voice.wav" });
  const media = host.querySelector<HTMLButtonElement>(".cmt-media")!;
  expect(media.querySelector("img")).toBeNull();
  expect(media.querySelector(".cmt-media-ph")?.textContent).toBe("♪");
  expect(media.disabled).toBe(true);
  expect(media.querySelector(".cmt-media-zoom")).toBeNull();
});

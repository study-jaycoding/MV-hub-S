// @vitest-environment jsdom
// 카드 생성물 붙이기 창(카드 생성물 복구·담기) 목록의 썸네일 — Jay 11-18 시안 "이대로 만들어".
//  이미지 그대로 · 영상 = 첫 장면 + 재생 표시 + 길이 · 그림 없는 영상 = 재생 표시 + '영상' + 길이 · 음성 = 음표 + 파형 + 길이.
//  전엔 음성·그림 없는 영상이 빈 검은 칸이었다(media.ts mediaThumbUrl 이 null).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecoveryThumb } from "../src/components/scene/SceneRecoveryPanel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const draw = (props: Parameters<typeof RecoveryThumb>[0]) => {
  act(() => root.render(<RecoveryThumb {...props} />));
  return host.firstElementChild as HTMLElement;
};

it("이미지는 지금처럼 그림 하나 — 재생 표시·길이 없음", () => {
  const el = draw({ thumb: "/t.jpg", media: "image", duration: "4.0s" });
  expect(el.tagName).toBe("IMG");
  expect(el.className).toBe("scene-recovery-thumb");
  expect(el.getAttribute("src")).toBe("/t.jpg");
  expect(host.querySelector(".play-badge, .scene-recovery-dur")).toBeNull();
});

it("영상은 첫 장면 위에 재생 표시와 길이", () => {
  const el = draw({ thumb: "/v.jpg", media: "video", duration: "4.0s" });
  expect(el.classList.contains("scene-recovery-thumb-video")).toBe(true);
  expect(el.querySelector("img")!.getAttribute("src")).toBe("/v.jpg");
  expect(el.querySelector(".play-badge")).toBeTruthy();
  expect(el.querySelector(".scene-recovery-dur")!.textContent).toBe("4.0s");
});

it("그림이 없는 영상은 검은 칸 대신 재생 표시 + '영상' + 길이", () => {
  const el = draw({ thumb: null, media: "video", duration: "5.0s" });
  expect(el.classList.contains("scene-recovery-thumb-novideo")).toBe(true);
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector(".play-badge")).toBeTruthy();
  expect(el.querySelector(".scene-recovery-kind")!.textContent).toBe("영상");
  expect(el.querySelector(".scene-recovery-dur")!.textContent).toBe("5.0s");
});

it("음성은 음표 + 파형 + 길이 — 그림 주소가 있어도 그리지 않는다", () => {
  const el = draw({ thumb: "/should-not-show.jpg", media: "audio", duration: "12s" });
  expect(el.classList.contains("scene-recovery-thumb-audio")).toBe(true);
  expect(el.getAttribute("aria-label")).toBe("음성");
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector(".audio-glyph")).toBeTruthy();
  expect(el.querySelectorAll(".scene-recovery-wave span").length).toBeGreaterThanOrEqual(5);
  expect(el.querySelector(".scene-recovery-dur")!.textContent).toBe("12s");
});

it("길이를 모르면 길이 표시를 그리지 않는다 · 그림 없는 이미지는 지금처럼 빈 칸", () => {
  expect(draw({ thumb: null, media: "audio" }).querySelector(".scene-recovery-dur")).toBeNull();
  const empty = draw({ thumb: null, media: "image" });
  expect(empty.className).toBe("scene-recovery-thumb scene-recovery-thumb-empty");
});

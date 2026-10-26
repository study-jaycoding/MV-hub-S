// @vitest-environment jsdom
// 영상 요소 둘을 하나처럼(editVideoPair) — 미리 받아 둔 것을 앞으로 내놓는 길과, 앞의 것이 낸 이벤트만 전하는 것을 본다.
// 실제로 받는 시간·프레임이 나오는 때는 여기서 못 본다 — 그것은 격리 브라우저 실측 몫이다(docs/EDIT_TAB.md).
import { expect, it, vi } from "vitest";
import { pairVideo } from "../src/lib/editVideoPair";

function element() {
  const el = document.createElement("video");
  const state = { time: 0, error: null as object | null, paused: true };
  Object.defineProperty(el, "currentTime", { get: () => state.time, set: (value: number) => { state.time = value; } });
  Object.defineProperty(el, "error", { get: () => state.error });
  const load = vi.spyOn(el, "load").mockImplementation(() => { state.time = 0; });
  Object.defineProperty(el, "paused", { get: () => state.paused });
  const play = vi.spyOn(el, "play").mockImplementation(() => { state.paused = false; return Promise.resolve(); });
  const pause = vi.spyOn(el, "pause").mockImplementation(() => { state.paused = true; });
  return { el, state, load, play, pause };
}

it("뒤의 것은 가려 두고 다음 영상을 받는다 — 그 주소를 대면 받지 않고 앞뒤를 바꾼다", () => {
  const a = element();
  const b = element();
  const video = pairVideo(a.el, b.el);
  expect([a.el.dataset.spare, b.el.dataset.spare]).toEqual([undefined, ""]); // 뒤의 것에 표를 한다(CSS 가 가린다)
  video.src = "/v/a";
  video.load();
  expect(a.el.getAttribute("src")).toBe("/v/a");
  expect(a.load).toHaveBeenCalledTimes(1);

  video.prepare!("/v/b", 0);
  video.prepare!("/v/b", 0); // 프레임마다 불려도 한 번만 받는다
  expect(b.el.getAttribute("src")).toBe("/v/b");
  expect(b.load).toHaveBeenCalledTimes(1);
  expect(a.load).toHaveBeenCalledTimes(1); // 앞의 것은 건드리지 않는다

  expect(video.swap!("/v/x")).toBe(false); // 받아 둔 것이 아니다 — 평소 길로 받는다
  expect(video.swap!("/v/b")).toBe(true);
  expect([a.el.dataset.spare, b.el.dataset.spare]).toEqual(["", undefined]);
  expect(video.src).toBe("/v/b");
  expect(b.load).toHaveBeenCalledTimes(1); // 다시 받지 않았다
  void video.play();
  expect(b.play).toHaveBeenCalledTimes(1);
  expect(a.play).not.toHaveBeenCalled();
});

it("앞의 것이 낸 이벤트만 전한다 — 뒤의 것이 받는 중에 내는 것은 엔진 몫이 아니다", () => {
  const a = element();
  const b = element();
  const video = pairVideo(a.el, b.el);
  const seen = vi.fn();
  video.addEventListener("seeked", seen);
  a.el.dispatchEvent(new Event("seeked"));
  b.el.dispatchEvent(new Event("seeked"));
  expect(seen).toHaveBeenCalledTimes(1);
  video.prepare!("/v/b", 0);
  video.swap!("/v/b");
  a.el.dispatchEvent(new Event("seeked")); // 이제 뒤의 것
  expect(seen).toHaveBeenCalledTimes(1);
  b.el.dispatchEvent(new Event("seeked"));
  expect(seen).toHaveBeenCalledTimes(2);
  video.removeEventListener("seeked", seen);
  b.el.dispatchEvent(new Event("seeked"));
  expect(seen).toHaveBeenCalledTimes(2);
});

it("미리 세워 둘 시각을 적는다 — 방금까지 앞에서 틀던 영상을 다시 준비하면 받지 않고 그 시각으로만 보낸다", () => {
  const a = element();
  const b = element();
  const video = pairVideo(a.el, b.el);
  video.src = "/v/a";
  video.load();
  video.prepare!("/v/b", 3); // 같은 컷의 아래 클립 — 위 클립이 끝나는 시각부터 보인다
  expect(b.state.time).toBe(3);
  video.swap!("/v/b");
  a.state.time = 5; // 앞에서 끝까지 틀고 뒤로 간 요소
  video.prepare!("/v/a", 1); // 되돌아갈 자리(구간 반복·편집점 앞뒤 재생)
  expect(a.load).toHaveBeenCalledTimes(1); // 같은 영상 — 다시 받지 않는다
  expect(a.state.time).toBe(1);
  expect(video.swap!("/v/a")).toBe(true);
  // 앞에 나가 재생하던 요소의 준비 기록은 버린다 — 같은 (주소, 시각)을 다시 청해도 그 시각으로 보낸다
  b.state.time = 4.5;
  video.prepare!("/v/b", 3);
  expect(b.state.time).toBe(3);
});

it("받지 못한 것은 내놓지 않고, 비우라고 하면 뒤의 것만 비운다", () => {
  const a = element();
  const b = element();
  const video = pairVideo(a.el, b.el);
  video.src = "/v/a";
  video.prepare!("/v/b", 0);
  b.state.error = {};
  expect(video.swap!("/v/b")).toBe(false);
  expect(video.src).toBe("/v/a");
  video.prepare!(null, 0);
  expect(b.el.hasAttribute("src")).toBe(false);
  expect(b.load).toHaveBeenCalledTimes(2);
  expect(a.el.getAttribute("src")).toBe("/v/a");
  video.removeAttribute("src"); // 엔진이 영상을 내린다(빈 컷·이미지) — 앞의 것만
  expect(a.el.hasAttribute("src")).toBe(false);
  expect(video.src).toBe("");
});

it("넘어가기 직전에는 뒤의 것을 소리 없이 미리 굴린다 — 내놓을 때 소리를 돌려주고, 끄면 세워 둔 자리로 돌린다", () => {
  const a = element();
  const b = element();
  const video = pairVideo(a.el, b.el);
  video.src = "/v/a";
  video.playbackRate = 2;
  video.roll!(true);
  expect(b.play).not.toHaveBeenCalled(); // 받아 둔 것이 없으면 굴릴 것이 없다
  video.prepare!("/v/b", 3, 2);
  video.roll!(true);
  video.roll!(true); // 프레임마다 불려도 한 번만
  expect(b.play).toHaveBeenCalledTimes(1);
  expect(b.el.volume).toBe(0);
  b.el.muted = false; // 굴리는 중에 사용자가 소리를 켠다(화면이 두 요소의 muted 를 함께 푼다) — 가려진 영상은 여전히 조용하다
  video.roll!(true);
  expect(b.el.volume).toBe(0);
  expect(b.el.playbackRate).toBe(2); // prepare 가 준 그 클립의 배속으로(속도 클립이면 앞의 것과 다를 수 있다)
  expect(a.play).not.toHaveBeenCalled();

  b.state.time = 3.4;
  video.roll!(false); // 넘어가지 않았다(멈춤·자리 옮김) — 세우고 제자리로
  expect(b.pause).toHaveBeenCalledTimes(1);
  expect(b.el.volume).toBe(1);
  expect(b.state.time).toBe(3);

  video.roll!(true);
  b.state.time = 3.2;
  video.roll!(true); // 아직 한도(0.25초 × 2배속) 안 — 그대로 돈다
  expect(b.pause).toHaveBeenCalledTimes(1);
  b.state.time = 3.6;
  video.roll!(true); // 앞의 것이 서 있어 넘어가는 순간이 오지 않는다 — 너무 멀리 갔다: 제자리로 돌려 세운다
  expect(b.pause).toHaveBeenCalledTimes(2);
  expect(b.state.time).toBe(3);
  expect(b.el.volume).toBe(0);

  expect(video.swap!("/v/b")).toBe(true);
  expect(b.el.volume).toBe(1); // 굴리느라 꺼 둔 소리를 돌려준다
  expect(b.pause).toHaveBeenCalledTimes(2); // 내놓을 때는 세우지 않는다 — 돌던 것은 돌던 채로 이어진다
  video.roll!(false); // 이미 내놓았다 — 뒤의 것(방금까지 앞이던 요소)을 건드리지 않는다
  expect(a.pause).not.toHaveBeenCalled();

  video.prepare!("/v/c", 0);
  video.roll!(true);
  expect(a.el.volume).toBe(0);
  video.prepare!("/v/d", 0); // 굴리던 것을 다른 영상으로 바꾼다 — 소리를 돌려놓는다
  expect(a.el.volume).toBe(1);
});

// @vitest-environment jsdom
// Resolve 보내기 결과 가운데 확인이 필요한 것은 닫을 때까지 남는다(Jay 2026-10-14 · Codex 배포 전 검토 E4).
//  알림(토스트)은 한 칸이고 2.5초라, 줄 서 있던 다음 작업의 '처리 중' 글이 앞의 결과를 덮었다 — 못 보고 다시 보내면 타임라인이 한 벌 더 생긴다.
//  · 무엇을 남기나(lib/resolveTransfer 의 …NeedsCheck · lib/useResolveTransferActions): 부분 성공·실패·결과 불명. 정상 결과·진행 글은 알림에만.
//  · 세 줄까지 — 넘으면 오래된 것부터 빠진다. 닫는 길은 ✕ 뿐이다.
//  · 그리는 쪽(components/app/ResolveNotices): 겹이 아니다(Esc·뒤 화면의 키를 건드리지 않는다) · ✕ 는 마우스로 눌러도 초점을 안 가져간다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

const api = vi.hoisted(() => ({ timeline: vi.fn(), transfer: vi.fn(), status: vi.fn() }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  createResolveTimeline: api.timeline,
  createResolveTransfer: api.transfer,
  getResolveConnectionStatus: api.status,
}));

import { ResolveNotices } from "../src/components/app/ResolveNotices";
import { HttpError } from "../src/lib/http";
import { backgroundKeysBlocked } from "../src/lib/keyGate";
import {
  resolveTimelineNeedsCheck, resolveTimelineSummary, resolveTransferNeedsCheck, resolveTransferSummary,
  type ResolveTimelineBuild, type ResolveTransferResult,
} from "../src/lib/resolveTransfer";
import { RESOLVE_NOTICE_LIMIT, useResolveTransferActions } from "../src/lib/useResolveTransferActions";

const gen = (id: string) => ({
  id, status: "done", project_id: "p1", folder_path: "e070/c1", deleted: false,
  assets: [{ id: `a-${id}`, generation_id: id, type: "video", file_path: `/media/${id}.mp4` }],
} as unknown as Generation);
const target = { project_id: "rp", project_name: "편집" };
const transfer = (over: Partial<ResolveTransferResult> = {}, imported: Partial<ResolveTransferResult["resolve_import"]> = {}) => ({
  transfer_id: "t1", project_id: "p1", project_name: "P1", status: "complete", total: 1, downloaded: 1, skipped: 0, error_count: 0,
  items: [], resolve_target: target,
  resolve_import: {
    status: "complete", project_name: "편집", target_root: "MV Hub/P1", total: 1, imported: 1, skipped: 0, error_count: 0, error: null,
    items: [], ...imported,
  },
  ...over,
} as unknown as ResolveTransferResult);
const built = (over: Partial<ResolveTimelineBuild> = {}): ResolveTimelineBuild => ({
  status: "complete", timeline_name: "P1_e070", timeline_id: "tl-1", step: "done", video: 2, audio: 0,
  markers_added: 0, markers_skipped: 0, mark: false, saved: true, mismatches: [], short_sources: [], warnings: [],
  error: null, error_code: null, ...over,
});
const crashed = built({ status: "unavailable", timeline_name: "", timeline_id: "", error: "결과를 받지 못했습니다", error_code: "child_crashed" });

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useResolveTransferActions>;
const flashed: string[] = [];
function Probe() {
  hook = useResolveTransferActions({ flash: (message: string) => { flashed.push(message); } });
  return null;
}
// 줄의 일(연결 확인 → 요청 → 결과)이 다 끝날 때까지
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
const sendTimeline = async (answer: unknown, fail = false) => {
  if (fail) api.timeline.mockRejectedValueOnce(answer);
  else api.timeline.mockResolvedValueOnce(answer);
  await act(async () => { void hook.sendTimelineToResolve({ name: "P1_e070" }, [gen("a")], target); });
  await settle();
};
const sendClips = async (answer: unknown, fail = false) => {
  if (fail) api.transfer.mockRejectedValueOnce(answer);
  else api.transfer.mockResolvedValueOnce(answer);
  await act(async () => { hook.sendToResolve([gen("a")]); });
  await settle();
};
const kept = () => hook.notices.map((item) => item.text);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of [api.timeline, api.transfer, api.status]) mock.mockReset();
  api.status.mockResolvedValue({ status: "ready", ...target, message: "" });
  flashed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("남길 결과인가 — 요약이 '완료'라고 말하는 것만 아니다(두 판정이 어긋나지 않는다)", () => {
  const failedItem = { generation_id: "g2", folder_path: "e070/c2", filename: "c2.mp4", media_type: "video", local_path: "", status: "error", error: "원본 다운로드 실패" };
  const transfers: [ResolveTransferResult, boolean][] = [
    [transfer(), false],
    [transfer({}, { imported: 0, skipped: 1 }), false], // 이미 있던 것뿐 — 완료다
    [transfer({ status: "partial", error_count: 1, items: [failedItem] as ResolveTransferResult["items"] }), true], // 준비에서 하나 떨어졌다
    [transfer({}, { status: "partial", error_count: 1 }), true], // 가져오기에서 하나 떨어졌다
    [transfer({}, { status: "failed", imported: 0 }), true],
    [transfer({}, { status: "partial", error: "Resolve 프로젝트 저장을 확인하지 못했습니다" }), true],
    [transfer({}, { status: "unavailable", imported: 0, error: "DaVinci Resolve가 실행 중이지 않습니다" }), true],
    [transfer({}, { status: "unavailable", imported: 0 }), true], // 까닭이 안 실려 와도(요약은 'Resolve 연결 실패') 못 가져온 것이다
  ];
  for (const [value, keep] of transfers) {
    expect(resolveTransferNeedsCheck(value)).toBe(keep);
    expect(resolveTransferSummary(value).includes("가져오기 완료")).toBe(!keep);
  }
  const timelines: [ResolveTimelineBuild, boolean][] = [
    [built(), false],
    [built({ markers_added: 2 }), false],
    [built({ warnings: ["전송 기록을 저장하지 못했습니다: 디스크"] }), true], // 계획대로 지었지만 경고가 붙었다
    [built({ status: "partial", error: "소리 클립을 넣지 못했습니다" }), true], // 지었지만 계획과 다르다
    [built({ status: "failed", timeline_name: "", error: "빈 타임라인을 만들지 못했습니다" }), true],
    [built({ status: "unavailable", timeline_name: "", error: "DaVinci Resolve가 실행 중이지 않습니다" }), true],
    [crashed, true], // 만들었는지 모른다
  ];
  for (const [value, keep] of timelines) {
    const result = { transfer: transfer(), timeline: value };
    expect(resolveTimelineNeedsCheck(result)).toBe(keep);
    if (!keep) expect(resolveTimelineSummary(result)).toContain("을 만들었습니다");
  }
});

it("확인이 필요한 결과는 알림에 더해 남는다 — 정상 결과와 진행 글은 알림에만 뜨고, 다음 작업의 글이 남긴 것을 지우지 않는다", async () => {
  await sendTimeline({ transfer: transfer(), timeline: built() });
  expect(flashed.at(-1)).toBe("Resolve 에 타임라인 'P1_e070' 을 만들었습니다 · 클립 2");
  expect(kept()).toEqual([]);
  await sendClips(transfer());
  expect(flashed.at(-1)).toContain("가져오기 완료");
  expect(kept()).toEqual([]);

  const unknown = "타임라인을 만들었는지 확인하지 못했습니다 — 다시 보내기 전에 Resolve 를 확인하세요 · 결과를 받지 못했습니다";
  await sendTimeline({ transfer: transfer(), timeline: crashed });
  expect(flashed.at(-1)).toBe(unknown); // 알림은 지금 그대로다
  expect(kept()).toEqual([unknown]);

  await sendClips(transfer()); // 줄 서 있던 다음 작업 — 알림은 '처리 중'·'완료'로 바뀐다
  expect(flashed.slice(-2)).toEqual(["Resolve 원본 1개 처리 중 · 편집", "Resolve 1개 가져오기 완료 · MV Hub/P1"]);
  expect(kept()).toEqual([unknown]); // 남긴 것은 그대로다

  await sendClips(transfer({}, { status: "partial", imported: 0, error_count: 1, items: [] }));
  expect(kept()).toEqual([unknown, "Resolve 가져오기 0개 완료 · 1개 실패"]); // 아래로 쌓인다
});

it("요청이 실패로 끝난 것도 남는다 — 서버가 거절했다 · 만들어졌는지 모른다 · 전송 실패", async () => {
  await sendTimeline(new HttpError(409, "409: 다른 Resolve 프로젝트가 열려 있습니다", "다른 Resolve 프로젝트가 열려 있습니다"), true);
  await sendTimeline(new TypeError("Failed to fetch"), true);
  await sendClips(new HttpError(500, "500: 디스크가 가득 찼습니다", "디스크가 가득 찼습니다"), true);
  expect(kept()).toEqual([
    "타임라인 보내기 실패: 다른 Resolve 프로젝트가 열려 있습니다",
    "타임라인 보내기 실패: Failed to fetch — 만들어졌을 수 있습니다. 다시 보내기 전에 Resolve 를 확인하세요",
    "Resolve 전송 실패: 디스크가 가득 찼습니다",
  ]);
  // 연결을 확인하다 멈춘 것은 보내기의 결과가 아니다 — 누른 자리에서 바로 본 글이라 알림에만 뜬다
  api.status.mockResolvedValueOnce({ status: "not_running", message: "DaVinci Resolve가 실행 중이지 않습니다." });
  await act(async () => { hook.sendToResolve([gen("a")]); });
  await settle();
  expect(flashed.at(-1)).toBe("DaVinci Resolve가 실행 중이지 않습니다.");
  expect(kept()).toHaveLength(3);
});

it("세 줄까지 쌓인다 — 넘으면 오래된 것부터 빠지고, ✕ 로 닫은 줄만 사라진다", async () => {
  expect(RESOLVE_NOTICE_LIMIT).toBe(3);
  for (const reason of ["하나", "둘", "셋", "넷"]) await sendClips(new HttpError(500, `500: ${reason}`, reason), true);
  expect(kept()).toEqual(["Resolve 전송 실패: 둘", "Resolve 전송 실패: 셋", "Resolve 전송 실패: 넷"]);
  expect(new Set(hook.notices.map((item) => item.id)).size).toBe(3);

  act(() => hook.dismissNotice(hook.notices[1].id));
  expect(kept()).toEqual(["Resolve 전송 실패: 둘", "Resolve 전송 실패: 넷"]);
  await sendClips(new HttpError(500, "500: 다섯", "다섯"), true); // 같은 글이 또 와도 따로 한 줄이다(따로 일어난 일)
  await sendClips(new HttpError(500, "500: 다섯", "다섯"), true);
  expect(kept()).toEqual(["Resolve 전송 실패: 넷", "Resolve 전송 실패: 다섯", "Resolve 전송 실패: 다섯"]);
});

it("안내 줄 — 첫 마디가 굵고, ✕ 로만 닫힌다. 겹이 아니라 뒤 화면의 키·Esc 를 건드리지 않고, ✕ 는 마우스로 눌러도 초점을 안 가져간다", () => {
  const dismissed: number[] = [];
  const items = [
    { id: 1, text: "타임라인을 만들었는지 확인하지 못했습니다 — 다시 보내기 전에 Resolve 를 확인하세요 · 결과를 받지 못했습니다" },
    { id: 2, text: "Resolve 가져오기 2개 완료 · 1개 실패 (원본 다운로드 실패)" },
    { id: 3, text: "Resolve 전송 실패: 디스크가 가득 찼습니다" },
  ];
  const show = (list: typeof items) => act(() => root.render(<ResolveNotices items={list} onDismiss={(id) => { dismissed.push(id); }} />));
  show([]);
  expect(host.innerHTML).toBe(""); // 남긴 것이 없으면 아무것도 그리지 않는다

  show(items);
  const lines = () => [...host.querySelectorAll<HTMLElement>(".resolve-notice")];
  const closers = () => [...host.querySelectorAll<HTMLButtonElement>(".resolve-notice-x")];
  expect(lines().map((line) => line.querySelector("b")!.textContent)).toEqual([
    "타임라인을 만들었는지 확인하지 못했습니다", "Resolve 가져오기 2개 완료", "Resolve 전송 실패: 디스크가 가득 찼습니다",
  ]);
  expect(lines()[0].querySelector(":scope > span")!.textContent).toBe(items[0].text); // 글은 한 글자도 빼지 않는다
  expect(host.querySelector(".resolve-notices")!.getAttribute("role")).toBe("status");
  expect(closers().map((button) => button.getAttribute("aria-label"))).toEqual(["안내 닫기", "안내 닫기", "안내 닫기"]);

  // 겹이 아니다 — 떠 있어도 뒤 화면의 단축키는 그대로고, Esc 로 닫히지 않는다
  expect(backgroundKeysBlocked()).toBe(false);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(escape); });
  expect([escape.defaultPrevented, dismissed]).toEqual([false, []]);

  // 마우스: 누름이 초점을 가져가지 않는다(가져가면 줄이 사라지며 초점이 BODY 로 떨어진다)
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  act(() => { closers()[1].dispatchEvent(press); });
  expect(press.defaultPrevented).toBe(true);
  act(() => closers()[1].click());
  expect(dismissed).toEqual([2]);
});

// ── 훅과 그리는 쪽을 같이 둔다(Codex 코드 리뷰 — 줄이 실제로 사라질 때의 초점 · 안내 안에서 난 키) ──
function Live() {
  hook = useResolveTransferActions({ flash: (message: string) => { flashed.push(message); } });
  return <ResolveNotices items={hook.notices} onDismiss={hook.dismissNotice} />;
}
const closers = () => [...host.querySelectorAll<HTMLButtonElement>(".resolve-notice-x")];
const shown = () => [...host.querySelectorAll(".resolve-notice b")].map((item) => item.textContent!.replace("Resolve 전송 실패: ", ""));
const fail = (reason: string) => sendClips(new HttpError(500, `500: ${reason}`, reason), true);

it("초점이 있던 줄이 사라지면 남은 줄의 ✕ 로 옮긴다 — 네 번째 결과가 와서 맨 위 줄이 빠질 때도, 키보드로 닫을 때도. 안내 밖의 초점은 건드리지 않는다", async () => {
  act(() => root.render(<Live />));
  for (const reason of ["하나", "둘", "셋"]) await fail(reason);
  expect(shown()).toEqual(["하나", "둘", "셋"]);

  // 첫 줄의 ✕ 에 초점을 둔 채(Tab 으로 왔다) 줄 서 있던 네 번째 결과가 온다 — 맨 위 줄이 빠진다. 사용자가 닫은 것이 아니다
  closers()[0].focus();
  await fail("넷");
  expect(shown()).toEqual(["둘", "셋", "넷"]);
  expect(document.activeElement).toBe(closers()[0]); // BODY 가 아니다 — 그 자리에 올라온 줄의 ✕. 떨어지면 다음 Delete 가 뒤의 고른 클립을 지운다

  // 초점이 있던 줄이 남아 있으면 그 줄을 따라간다(자리 번호를 따라가지 않는다)
  closers()[1].focus(); // '셋'
  await fail("다섯"); // '둘'이 빠진다 — '셋'은 첫 줄이 됐다
  expect(shown()).toEqual(["셋", "넷", "다섯"]);
  expect(document.activeElement).toBe(closers()[0]);

  // 키보드로 닫기 — 같은 자리에 올라온 줄로, 마지막 줄이었으면 앞 줄로
  closers()[1].focus();
  act(() => closers()[1].click()); // 가운데('넷')
  expect(shown()).toEqual(["셋", "다섯"]);
  expect(document.activeElement).toBe(closers()[1]); // '다섯'
  act(() => closers()[1].click()); // 마지막 줄
  expect(shown()).toEqual(["셋"]);
  expect(document.activeElement).toBe(closers()[0]);

  // 초점이 안내 밖에 있으면 줄이 빠져도 건드리지 않는다
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  outside.focus();
  for (const reason of ["여섯", "일곱", "여덟"]) await fail(reason);
  expect(shown()).toEqual(["여섯", "일곱", "여덟"]);
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

it("안내 안에서 난 키는 뒤 화면의 키 처리(window)에 닿지 않는다 — 전파만 막아 Tab·Enter·Space 는 그대로고, 안내 밖에서 난 키는 그대로 간다", async () => {
  act(() => root.render(<Live />));
  await fail("하나");
  const heard: string[] = [];
  const listen = (event: KeyboardEvent) => { heard.push(event.key); };
  window.addEventListener("keydown", listen); // 라이브러리·편집 탭의 단축키가 듣는 자리 — 버블 단계이고, 키가 어디서 났는지 보지 않는다
  const press = (target: Element, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  closers()[0].focus();
  // R·D(뒤의 고른 카드에 색·비활성) · Delete·화살표(편집 탭의 클립·재생헤드) · Esc(뒤의 선택 해제)
  const stopped = ["r", "d", "Delete", "ArrowLeft", "Escape", "Tab", "Enter", " "].map((key) => press(closers()[0], key));
  expect(heard).toEqual([]);
  expect(stopped).toEqual(Array(8).fill(false)); // 기본 동작은 하나도 막지 않는다(Tab 이동·단추 누르기)
  expect(shown()).toEqual(["하나"]); // Esc 로 닫히지도 않는다(겹이 아니다)

  press(document.body, "r"); // 뒤 화면에 초점이 있을 때의 키는 그대로다
  expect(heard).toEqual(["r"]);
  window.removeEventListener("keydown", listen);
});

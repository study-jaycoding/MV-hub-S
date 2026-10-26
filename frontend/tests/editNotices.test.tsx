// @vitest-environment jsdom
// 편집 탭 경고 → 화면 위 알림 줄(Jay 2026-10-24 — "팝업 알림으로 나와서 x 누르면 사라지게 … 지금 알림 나오는 것들처럼 일관성 있게").
//  lib/useStateNotices 가 상황 목록을 줄로 올리고, 앱은 Resolve 결과와 같은 components/app/ResolveNotices 에 그린다.
//  · ✕ = 그 줄만 닫힘 — 같은 상황이 이어지는 동안 다시 안 뜬다 · 상황이 풀리면 줄도 사라지고 닫은 표시도 잊는다(다시 생기면 다시 뜬다)
//  · 다른 상황(열쇠가 다르다)은 새 줄 · 글자 단추는 그때의 동작 · 떠나면(언마운트) 빈 목록 · Resolve 결과 줄의 닫기는 그대로 받는 쪽이
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResolveNotices } from "../src/components/app/ResolveNotices";
import { useStateNotices, type NoticeLine, type StateNotice } from "../src/lib/useStateNotices";

let host: HTMLDivElement;
let root: Root;
let lifted: readonly NoticeLine[] = [];

function Tab({ warnings }: { warnings: StateNotice[] }) {
  useStateNotices(warnings, (lines) => { lifted = lines; });
  return null;
}
// 앱처럼 — 편집 탭이 올린 줄을 위에, Resolve 결과를 아래에
function App({ warnings, results = [], onDismiss = () => {} }: {
  warnings: StateNotice[] | null; results?: { id: number; text: string }[]; onDismiss?: (id: number) => void;
}) {
  const [lines, setLines] = useState<readonly NoticeLine[]>([]);
  return (
    <>
      {warnings && <Lift warnings={warnings} onNotices={setLines} />}
      <ResolveNotices items={[...lines, ...results]} onDismiss={onDismiss} />
    </>
  );
}
function Lift({ warnings, onNotices }: { warnings: StateNotice[]; onNotices: (lines: readonly NoticeLine[]) => void }) {
  useStateNotices(warnings, onNotices);
  return null;
}

const rows = () => [...host.querySelectorAll<HTMLElement>(".resolve-notice")];
const heads = () => rows().map((row) => row.querySelector("b")!.textContent);
const closeRow = (head: string) => act(() => rows().find((row) => row.querySelector("b")!.textContent === head)!
  .querySelector<HTMLButtonElement>(".resolve-notice-x")!.click());

const ACCOUNT = { key: "share:account", text: "화면과 허브의 계정이 달라 멈췄습니다 — 새로 고쳐 주세요" };
const backup = (state: string, run: () => void): StateNotice => ({
  key: `backup:${state}`, text: state === "conflict" ? "자동 백업 멈춤 · 다른 편집은 사본으로 보존" : "DB 백업 실패 · 연결 후 다시 시도",
  action: { label: "백업 보기", run },
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  lifted = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("경고는 Resolve 결과와 같은 알림 줄에 같은 모양 — 굵은 첫 마디·글자 단추·✕, 막대 알약이 아니다", () => {
  const open = vi.fn();
  act(() => root.render(<App warnings={[ACCOUNT, { ...backup("conflict", open), title: "자세히" }]} results={[{ id: 7, text: "Resolve 전송 실패: 연결 없음" }]} />));
  expect(host.querySelector(".resolve-notices")!.getAttribute("role")).toBe("status");
  expect(heads()).toEqual(["화면과 허브의 계정이 달라 멈췄습니다", "자동 백업 멈춤", "Resolve 전송 실패: 연결 없음"]); // 편집 경고가 위
  const act1 = rows()[1].querySelector<HTMLButtonElement>(".resolve-notice-act")!;
  expect([act1.textContent, rows()[1].querySelector("span")!.getAttribute("title"), rows()[0].querySelector(".resolve-notice-act")]).toEqual(["백업 보기", "자세히", null]);
  act(() => act1.click());
  expect(open).toHaveBeenCalledTimes(1);
});

it("✕ 로 닫으면 그 상황이 이어지는 동안 안 뜨고, 풀렸다가 다시 생기면 다시 뜬다 · 다른 상황은 새 줄", () => {
  const run = () => {};
  const show = (warnings: StateNotice[]) => act(() => root.render(<App warnings={warnings} />));
  show([ACCOUNT, backup("conflict", run)]);
  closeRow("화면과 허브의 계정이 달라 멈췄습니다");
  expect(heads()).toEqual(["자동 백업 멈춤"]); // 그 줄만
  show([ACCOUNT, backup("conflict", run)]); // 같은 상황이 이어진다 — 다시 안 뜬다
  expect(heads()).toEqual(["자동 백업 멈춤"]);
  closeRow("자동 백업 멈춤");
  expect(rows()).toEqual([]);
  show([ACCOUNT, backup("error", run)]); // 백업은 다른 상황(충돌 → 실패) — 새 줄
  expect(heads()).toEqual(["DB 백업 실패"]);
  show([backup("error", run)]); // 계정 문제가 풀렸다 — 닫은 표시도 잊는다
  show([ACCOUNT, backup("error", run)]); // 다시 생겼다 — 다시 뜬다
  expect(heads()).toEqual(["화면과 허브의 계정이 달라 멈췄습니다", "DB 백업 실패"]);
  show([]); // 상황이 다 풀리면 줄도 저절로 사라진다
  expect(rows()).toEqual([]);
});

it("글자 단추는 그때의 동작을 부른다(글이 같아 다시 올리지 않아도) · 떠나면 빈 목록 · Resolve 결과 줄의 ✕ 는 받는 쪽이", () => {
  const first = vi.fn();
  const second = vi.fn();
  act(() => root.render(<Tab warnings={[backup("conflict", first)]} />));
  const before = lifted;
  act(() => root.render(<Tab warnings={[backup("conflict", second)]} />));
  expect(lifted).toBe(before); // 글이 같다 — 다시 올리지 않는다
  const line = lifted[0] as Extract<NoticeLine, { id: string }>;
  act(() => line.action!.run());
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
  act(() => root.render(<></>));
  expect(lifted).toEqual([]); // 편집 탭을 떠났다

  const dismissed: number[] = [];
  act(() => root.render(<App warnings={[ACCOUNT]} results={[{ id: 3, text: "Resolve 전송 실패: 연결 없음" }]} onDismiss={(id) => { dismissed.push(id); }} />));
  closeRow("Resolve 전송 실패: 연결 없음");
  expect(dismissed).toEqual([3]);
  expect(heads()).toEqual(["화면과 허브의 계정이 달라 멈췄습니다", "Resolve 전송 실패: 연결 없음"]); // 결과 줄은 받는 쪽이 지운다(여기서는 안 지움)
});

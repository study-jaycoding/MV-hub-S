// @vitest-environment jsdom
// 크레딧 달력의 일정 칩(조작 규칙 51 — 24회차, Codex 전수 검토): role=button 인데 Enter 만 열고 Space 는 아무 일도 없었다(div 라 기본 동작도 없다).
//  둘 다 열고, Space 의 기본 동작(달력 스크롤)은 막는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreditCalendar } from "../src/components/manage/console/CreditCalendar";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const data = {
  today: "2026-10-11", main: { id: "mv", name: "MV", balance: 0, balance_seen_at: null, reported: 1 },
  subs: [{ id: "s1", name: "서브", projects: [], recurring_period: "month" }], pending: [],
  totals: {}, schedule: [], allocation: { allocated: 0, spent: 0, unused: 0, source: "estimate", base: null, base_day: null },
  calendar: { from: "2026-07-01", to: "2026-12-31", events: [{ kind: "topup", sub_id: "s1", topup_id: "t1", name: "서브", day: "2026-10-02", credits: 100 }] },
};

it.each(["Enter", " "])("일정 칩에서 %j 를 누르면 정보 창이 열린다 — 기본 동작은 막는다", async (name) => {
  await act(async () => root.render(
    <CreditCalendar data={data as never} canEdit busy={false} onMove={() => {}} onEdit={async () => {}} loadNote={() => new Promise(() => {})} />,
  ));
  const chip = host.querySelector<HTMLElement>(".wc-cal-chip")!;
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => { chip.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(host.querySelector(".wc-event-info")).not.toBeNull(); // 전엔 Space 로는 열리지 않았다
});

// @vitest-environment jsdom
// 달력의 추가 크레딧 정보 창(2026-10-03 점검 CXF-2) — 메모를 못 읽었으면 '메모 없음'으로 보지 않는다.
// 그렇게 보면 금액만 고쳐 저장해도 note:null 이 실려 기존 메모가 지워졌다. 이제 금액만 보내 서버의 메모를 그대로 둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreditCalendar } from "../src/components/manage/console/CreditCalendar";

const DATA = {
  today: "2026-10-03",
  calendar: { from: "2026-07-01", to: "2026-12-31",
    events: [{ kind: "topup", sub_id: "s1", topup_id: "t1", name: "서브", day: "2026-10-02", credits: 100 }] },
  schedule: [],
  subs: [{ id: "s1", name: "서브", projects: [], recurring_period: "month" }],
} as never;

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

it("메모를 못 읽은 채 금액만 고쳐 저장하면 메모는 보내지 않는다(서버의 기존 메모 유지)", async () => {
  const onEdit = vi.fn(async () => {});
  await act(async () => {
    root.render(<CreditCalendar data={DATA} canEdit busy={false} onMove={() => {}} onEdit={onEdit}
      loadNote={() => Promise.reject(new Error("일시 실패"))} />);
  });
  await act(async () => { host.querySelector<HTMLElement>(".wc-cal-chip")!.click(); });
  await settle();

  const note = host.querySelector<HTMLInputElement>("#wc-event-note")!;
  expect(note.disabled).toBe(true);
  expect(note.placeholder).toContain("메모를 읽지 못했습니다");
  const credits = host.querySelector<HTMLInputElement>("#wc-event-credits")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(credits, "200"); credits.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".wc-event-info button.pri")!.click(); });
  await settle();

  expect(onEdit).toHaveBeenCalledTimes(1);
  const patch = onEdit.mock.calls[0][1] as Record<string, unknown>;
  expect(patch).toEqual({ credits: 200 });
  expect("note" in patch).toBe(false);
});

// 19회차(조작 규칙 46): 메모는 창을 연 뒤에 도착한다. 도착한 렌더에는 '받았다'만 참이고 칸에는 아직 빈 글이 있어(칸 채우기가 그린 뒤로 밀렸다)
//  그 한 박자 동안 [저장]이 켜졌다 — 금액 칸의 Enter 는 note:null 을 보내 기존 메모를 지웠다.
it("메모가 늦게 도착해도 [저장]은 켜지지 않는다 — 손대지 않은 메모를 '지웠다'로 보지 않는다", async () => {
  const onEdit = vi.fn(async () => {});
  let arrive!: (note: string) => void;
  await act(async () => {
    root.render(<CreditCalendar data={DATA} canEdit busy={false} onMove={() => {}} onEdit={onEdit}
      loadNote={() => new Promise<string | null>((resolve) => { arrive = resolve; })} />);
  });
  await act(async () => { host.querySelector<HTMLElement>(".wc-cal-chip")!.click(); });
  const save = host.querySelector<HTMLButtonElement>(".wc-event-info button.pri")!;
  expect(save.disabled).toBe(true);
  let flips = 0; // [저장]의 disabled 가 바뀐 횟수 — 켜졌다 꺼졌으면 0 이 아니다(끝난 뒤의 모습만 봐서는 그 한 박자를 못 본다)
  const watch = new MutationObserver((records) => { flips += records.length; });
  watch.observe(save, { attributes: true, attributeFilter: ["disabled"] });
  await act(async () => { arrive("기존 메모"); });
  await settle();
  flips += watch.takeRecords().length;
  watch.disconnect();
  expect(host.querySelector<HTMLInputElement>("#wc-event-note")!.value).toBe("기존 메모");
  expect([save.disabled, flips]).toEqual([true, 0]);

  // 메모를 고치면 켜지고, 고친 글이 나간다
  const note = host.querySelector<HTMLInputElement>("#wc-event-note")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(note, "고친 메모"); note.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { save.click(); });
  await settle();
  expect(onEdit.mock.calls.map((call) => call[1])).toEqual([{ note: "고친 메모" }]);
});

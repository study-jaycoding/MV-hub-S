// @vitest-environment jsdom
// 순서 손잡이(⠿)의 '누르고 있다' 표식은 뗀 것을 놓쳐도 내린다(조작 규칙 39 — lib/useDragEndReset.useHandleRelease).
// 2026-10-12(조작 점검 12회차, Codex 전수 검토): 손잡이는 누르는 동안만 줄을 draggable 로 만든다(mousedown 에 켜고 손잡이의 mouseup·끌기의
//  drop·dragend 에 끈다). 끌기가 시작되기 전에 손잡이 밖에서 떼거나 누른 채 다른 창으로 가면 셋 다 오지 않아 표식이 남고, 그 뒤로는 줄의
//  이름·본문을 끌어도 순서가 바뀌어 저장됐다. 세 곳이 같은 훅을 쓴다 — 사이드바 프로젝트 줄(tests/projectFolderMenu) ·
//  관리자 창의 프로젝트 표(tests/adminWindowTabs) · 서브스페이스 표(여기).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubTable } from "../src/components/manage/console/ConsoleMainParts";
import { useHandleRelease } from "../src/lib/useDragEndReset";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("순서 손잡이의 '누르고 있다' 표식 — 손잡이 밖에서 떼거나, 누른 채 창을 떠나거나 탭이 숨으면 내린다. 내린 뒤에는 듣지 않는다", () => {
  let armed = false;
  let releases = 0;
  function Host() {
    const [on, setOn] = useState(false);
    armed = on;
    useHandleRelease(on, () => { releases += 1; setOn(false); });
    return <button onMouseDown={() => setOn(true)}>⠿</button>;
  }
  act(() => root.render(<Host />));
  const press = () => act(() => { host.querySelector("button")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  press();
  expect(armed).toBe(true);
  act(() => { document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }); // 손잡이 밖에서 뗌
  expect(armed).toBe(false);
  press();
  act(() => { window.dispatchEvent(new Event("blur")); }); // 누른 채 다른 창으로
  expect(armed).toBe(false);
  press();
  act(() => { document.dispatchEvent(new Event("visibilitychange")); }); // 보이는 채의 통지는 아니다
  expect(armed).toBe(true);
  hidden.mockReturnValue(true);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); }); // 탭이 숨었다
  expect(armed).toBe(false);
  expect(releases).toBe(3);
  act(() => { window.dispatchEvent(new Event("blur")); document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(releases).toBe(3); // 내려가 있는 동안은 리스너가 없다
});

it("서브스페이스 표의 순서 손잡이도 같은 훅을 쓴다 — 손잡이 밖에서 떼면 줄이 끌리는 채로 남지 않는다", () => {
  const noop = () => {};
  const sub = { id: "s1", name: "Sub", balance: 0, first_seen_at: null, monthly_topup: null, recurring_auto: false, next_topup_day: null, status: "active", projects: [] };
  act(() => root.render(<SubTable data={{ subs: [sub] } as never} canEdit busy={false} onSelect={noop} onMove={noop} onCredit={noop} onFolder={noop}
    onPeriod={noop} onStatus={noop} onArchive={noop} onAdd={noop} />));
  const row = host.querySelector<HTMLElement>("table.wc-subs tbody tr")!;
  act(() => { row.querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(row.draggable).toBe(true);
  act(() => { document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  expect(row.draggable).toBe(false);
});

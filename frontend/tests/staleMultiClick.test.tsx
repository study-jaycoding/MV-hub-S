// @vitest-environment jsdom
// 조작 규칙 61(33회차) — 두 번 누름의 둘째가 '첫 누름으로 바뀐 화면'에 닿는 것을 버린다(lib/useStaleMultiClick).
//  브라우저는 연속 누름 수(detail)를 시간·거리로만 센다: 첫 누름이 화면을 바꿔 같은 자리에 다른 것이 서 있어도 둘째 누름은 그 새 요소에
//  mousedown·click(detail 2)·dblclick 으로 간다(2026-10-13 헤드리스 크롬 실측). 시험은 그 순서를 detail 값으로 흉내 낸다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useStaleMultiClick } from "../src/lib/useStaleMultiClick";

let host: HTMLDivElement;
let root: Root;
let log: string[];

// 격자 뿌리와 그 안의 카드·단추 — 카드는 실제 카드처럼 누름의 잡는 단계에서도 일을 한다('새 항목 확인')
function Box({ place }: { place: string }) {
  const multi = useStaleMultiClick(place);
  return (
    <div className="box" {...multi} onMouseDown={() => log.push("격자 누름")} onDoubleClick={() => log.push("두 번 클릭")}>
      <div className="card" draggable onMouseDownCapture={() => log.push("카드 확인")} onDragStart={() => log.push("끌기 시작")}>
        <button type="button" onClick={() => log.push("단추")}>단추</button>
      </div>
    </div>
  );
}
const draw = (place: string, key = "a") => act(() => root.render(<Box key={key} place={place} />));
const button = () => host.querySelector("button")!;
const fire = (type: string, detail: number, init: MouseEventInit = {}, at?: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail, ...init });
  if (at !== undefined) Object.defineProperty(event, "timeStamp", { value: at });
  act(() => { button().dispatchEvent(event); });
  return event;
};
// 한 번의 누름 — 브라우저의 순서(mousedown → click, 두 번째면 dblclick 까지)
const press = (detail: number, at?: number) => {
  fire("mousedown", detail, {}, at);
  fire("click", detail, {}, at);
  if (detail === 2) fire("dblclick", detail, {}, at);
};
const ONE = ["카드 확인", "격자 누름", "단추"]; // 보통의 누름 하나가 남기는 것

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  log = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("같은 자리의 두 번 클릭은 그대로다 — 둘째 누름도 단추를 누르고 두 번 클릭으로 오른다", () => {
  draw("e035");
  press(1);
  press(2);
  expect(log).toEqual([...ONE, ...ONE, "두 번 클릭"]);
  fire("dragstart", 0); // 끌기도 그대로
  expect(log.at(-1)).toBe("끌기 시작");
});

it("첫 누름 뒤로 자리가 바뀌면 둘째 누름은 통째로 버린다 — 카드의 누름·단추·두 번 클릭·끌기 시작 모두. 다음의 새 누름은 듣는다", () => {
  draw("프로젝트 맨 위");
  press(1);
  draw("e035"); // 첫 누름([열기])이 자리를 옮겼다 — 같은 자리에 새 화면의 단추가 서 있다
  log = [];
  const down = fire("mousedown", 2);
  const drag = fire("dragstart", 0); // 그 누름을 쥔 채 끌기 — 카드의 dragstart 가 그 카드를 싣기 전에 막는다
  const click = fire("click", 2);
  const dbl = fire("dblclick", 2);
  expect(log).toEqual([]); // 카드가 누름의 잡는 단계에서 하는 일('새 항목 확인')까지 닿지 않는다(Codex 코드 리뷰)
  expect([down.defaultPrevented, drag.defaultPrevented, click.defaultPrevented, dbl.defaultPrevented]).toEqual([true, true, true, true]);
  press(1); // 새 누름 — 연속 누름이 끝났다
  expect(log).toEqual(ONE);
});

it("이 격자가 첫 누름을 보지 못했으면(그 사이에 새로 선 격자) 둘째 누름을 버린다", () => {
  draw("e035", "옛 격자");
  press(1);
  draw("e035", "새 격자"); // 자리의 열쇠는 같아도 격자가 새로 섰다(자리를 비웠다 다시 그린 경우) — 첫 누름을 본 적이 없다
  log = [];
  press(2);
  expect(log).toEqual([]);
});

it("오래된 첫 누름은 이 연속 누름의 것이 아니다 — 그 사이의 첫 누름을 못 봤다(잠긴 화면이 삼켰다)", () => {
  draw("e035");
  press(1, 1000);
  log = [];
  press(2, 1000 + 1501);
  expect(log).toEqual([]);
  press(1, 5000);
  press(2, 5300);
  expect(log).toEqual([...ONE, ...ONE, "두 번 클릭"]);
});

it("버리는 것은 연속 누름뿐이다 — 키보드가 만든 click(detail 0)과 오른쪽 단추는 건드리지 않는다", () => {
  draw("프로젝트 맨 위");
  press(1);
  draw("e035");
  fire("mousedown", 2); // 버려진 둘째 누름
  log = [];
  fire("click", 0); // Enter·Space 가 만든 click
  expect(log).toEqual(["단추"]);
  const right = fire("mousedown", 2, { button: 2 }); // 오른쪽 단추의 연속 누름 — 이 규칙의 대상이 아니다
  expect([right.defaultPrevented, log]).toEqual([false, ["단추", "카드 확인", "격자 누름"]]);
});

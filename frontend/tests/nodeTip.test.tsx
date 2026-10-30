// @vitest-environment jsdom
// 캔버스 노드 설명 창(Jay 2026-10-30 B안) — 설명 글(title)을 줄 규칙으로 나눠 읽고, 노드 안에 올리면 머문 뒤 앱 모양 창으로 그린다.
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NodeTip, parseNodeTip } from "../src/components/scene/NodeTip";

it("줄 규칙 — 제목 · 상태(색 있을 때) · 해결 · 덧말 · 조작 키", () => {
  expect(parseNodeTip(
    "매튜_바디.png\n사본 · 서버에 같은 이름 — 같은 그림인지 확인 못 함\n해결: 에셋에서 끌어와 바꾸기\n원래 PC 에서 레퍼런스 찾기\n휠클릭 = 정보",
    "warn",
  )).toEqual({
    head: "매튜_바디.png", status: "사본 · 서버에 같은 이름", detail: ["같은 그림인지 확인 못 함"], fix: "에셋에서 끌어와 바꾸기",
    notes: ["원래 PC 에서 레퍼런스 찾기"], rows: [], keys: [["휠클릭", "정보"]],
  });
  // 생성 실패(generationStatusTitle) — 첫 줄 '문제: 설명' 이 상태, '해결 방법:' 은 해결, 나머지 '라벨: 값' 은 표 줄
  expect(parseNodeTip("생성 실패: 서버가 거절함\n해결 방법: 다시 생성\n단계: 완료\nHiggsfield 상태: failed", "bad")).toEqual({
    status: "생성 실패", detail: ["서버가 거절함"], fix: "다시 생성", notes: [], rows: [["단계", "완료"], ["Higgsfield 상태", "failed"]], keys: [],
  });
  // 원인을 분류 못 한 실패 — 첫 줄(보이는 상태 글) 뒤가 바로 '라벨: 값' 이면 첫 줄이 상태
  expect(parseNodeTip("실패\n단계: 실패\nContent rejected", "bad")).toMatchObject({ status: "실패", rows: [["단계", "실패"]], notes: ["Content rejected"] });
  // 색이 없으면 첫 줄은 제목(' — ' 뒤는 설명), 짧은 글은 제목만, 키만 있는 글은 키만
  expect(parseNodeTip("중첩 소스 — 내부 생성물을 펼쳐 사용")).toMatchObject({ head: "중첩 소스", detail: ["내부 생성물을 펼쳐 사용"] });
  expect(parseNodeTip("배치 줄이기")).toEqual({ head: "배치 줄이기", detail: [], notes: [], rows: [], keys: [] });
  expect(parseNodeTip("드래그 = 크기 조절")).toEqual({ detail: [], notes: [], rows: [], keys: [["드래그", "크기 조절"]] });
  // “ 로 묶은 프롬프트는 ' — '·':' 가 있어도 나누지 않는다
  expect(parseNodeTip("“RULE ZERO — THREE: x”\n클릭 = 선택 · D = 비활성")).toMatchObject({
    head: "“RULE ZERO — THREE: x”", detail: [], keys: [["클릭", "선택"], ["D", "비활성"]],
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Board() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="scene-board">
      <div className="scene-card">
        <span id="port" className="scene-port out" title={"레퍼런스 출력\n드래그 = 생성 카드에 연결"} />
        <span id="bad" title={"r.png\n서버에 없음"} data-tip-tone="bad" />
      </div>
      <button id="outside" title="노드 밖" />
      <NodeTip rootRef={ref} />
    </div>
  );
}
const tip = () => document.querySelector(".node-tip");
const over = (el: Element) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 10, clientY: 10 }));
const out = (el: Element) => el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));

it("노드 안에 올리면 머문 뒤 창이 뜨고, 그동안 title 은 떼어 두었다가 벗어나면 되돌린다", async () => {
  await act(async () => { root.render(<Board />); });
  const port = document.getElementById("port")!;
  await act(async () => { over(port); });
  expect(port.hasAttribute("title")).toBe(false); // 기본 말풍선이 같이 뜨지 않게
  expect(tip()).toBeNull(); // 아직 머물지 않았다
  await act(async () => { vi.advanceTimersByTime(450); });
  expect(tip()?.querySelector(".node-tip-head")?.textContent).toBe("레퍼런스 출력");
  expect([...tip()!.querySelectorAll(".node-tip-keys kbd")].map((k) => k.textContent)).toEqual(["드래그"]);
  await act(async () => { out(port); });
  expect(tip()).toBeNull();
  expect(port.getAttribute("title")).toBe("레퍼런스 출력\n드래그 = 생성 카드에 연결");
});

it("상태 색 · 누르면 닫힘 · 노드 밖 요소는 손대지 않는다", async () => {
  await act(async () => { root.render(<Board />); });
  const bad = document.getElementById("bad")!;
  await act(async () => { over(bad); vi.advanceTimersByTime(450); });
  expect(tip()?.classList.contains("tone-bad")).toBe(true);
  expect(tip()?.querySelector(".node-tip-status")?.textContent).toBe("서버에 없음");
  await act(async () => { window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(tip()).toBeNull();
  expect(bad.getAttribute("title")).toBe("r.png\n서버에 없음");
  const outside = document.getElementById("outside")!;
  await act(async () => { over(outside); vi.advanceTimersByTime(450); });
  expect(tip()).toBeNull();
  expect(outside.getAttribute("title")).toBe("노드 밖");
});

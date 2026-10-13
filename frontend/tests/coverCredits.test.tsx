// @vitest-environment jsdom
// 폴더 카드의 크레딧(lib/coverCredits) — 건마다 묻는 값이라 한 번 받은 것은 기억하고 한꺼번에 넷만 묻는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const generationMetrics = vi.fn();
vi.mock("../src/api", () => ({ api: { generationMetrics: (...args: unknown[]) => generationMetrics(...args) } }));
const { forgetCoverCredits, useCoverCredits } = await import("../src/lib/coverCredits");

let root: Root;
let host: HTMLDivElement;
function Cell({ id }: { id: string }) {
  const credits = useCoverCredits(id);
  return <span data-id={id}>{credits === undefined ? "…" : credits === null ? "미상" : String(credits)}</span>;
}
const shown = () => [...host.querySelectorAll("span")].map((cell) => cell.textContent);
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  forgetCoverCredits();
  generationMetrics.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("한꺼번에 넷만 묻고, 끝나는 대로 다음을 묻는다 — 같은 그림은 한 번만", async () => {
  const waiting = new Map<string, (value: { real_credits: number | null }) => void>();
  generationMetrics.mockImplementation((id: string) => new Promise((resolve) => { waiting.set(id, resolve); }));
  const ids = ["a", "b", "c", "d", "e", "f", "a"]; // 'a' 가 두 번 — 요청은 한 번
  act(() => root.render(<>{ids.map((id, index) => <Cell key={index} id={id} />)}</>));
  await settle();
  expect([generationMetrics.mock.calls.map((call) => call[0]), shown()]).toEqual([["a", "b", "c", "d"], ["…", "…", "…", "…", "…", "…", "…"]]);
  await act(async () => { waiting.get("a")!({ real_credits: 54 }); });
  await settle();
  expect([generationMetrics.mock.calls.map((call) => call[0]), shown()]).toEqual([["a", "b", "c", "d", "e"], ["54", "…", "…", "…", "…", "…", "54"]]);
  await act(async () => { for (const id of ["b", "c", "d", "e"]) waiting.get(id)!({ real_credits: id === "c" ? null : 1.5 }); });
  await settle();
  await act(async () => { waiting.get("f")!({ real_credits: 2 }); });
  await settle();
  expect(shown()).toEqual(["54", "1.5", "미상", "1.5", "1.5", "2", "54"]);
});

// Codex 코드 리뷰: 실제 크레딧은 생성 뒤 나중에 확정된다 — '모름'을 영영 기억하면 '미상'이 굳는다. 잠깐(1분)만 기억하고 그 뒤엔 다시 묻는다.
it("'모름'(값 없음·실패)은 잠깐만 기억한다 — 1분 안에는 다시 묻지 않고, 지나서 다시 그리면 다시 물어 확정된 값으로 바뀐다", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    generationMetrics.mockResolvedValue({ real_credits: null });
    act(() => root.render(<Cell id="late" />));
    await settle();
    expect([shown(), generationMetrics.mock.calls.length]).toEqual([["미상"], 1]);
    vi.setSystemTime(new Date("2026-10-13T00:00:59Z"));
    act(() => root.render(<><Cell id="late" /><Cell id="late" /></>));
    await settle();
    expect(generationMetrics).toHaveBeenCalledTimes(1);
    generationMetrics.mockResolvedValue({ real_credits: 90 });
    vi.setSystemTime(new Date("2026-10-13T00:01:01Z"));
    act(() => root.render(<Cell id="late" />));
    await settle();
    expect([shown(), generationMetrics.mock.calls.length]).toEqual([["90"], 2]);
  } finally {
    vi.useRealTimers();
  }
});

it("기억을 비운 뒤 늦게 끝난 옛 요청은 새 상태를 건드리지 않는다(시험 사이의 섞임)", async () => {
  let release!: (value: { real_credits: number }) => void;
  generationMetrics.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  act(() => root.render(<Cell id="old" />));
  await settle();
  act(() => root.render(<></>)); // 그 시험의 화면은 내려갔다
  forgetCoverCredits();
  await act(async () => { release({ real_credits: 5 }); });
  await settle();
  generationMetrics.mockResolvedValue({ real_credits: 9 });
  act(() => root.render(<><Cell id="old" /><Cell id="a" /><Cell id="b" /><Cell id="c" /><Cell id="d" /></>));
  await settle();
  expect(shown()).toEqual(["9", "9", "9", "9", "9"]); // 옛 요청의 값(5)이 기억에 들지 않았고, 줄도 막히지 않았다
});

it("한 번 받은 것은 기억한다 — 다시 그려도 묻지 않는다. 못 받은 것(실패·호출이 바로 던짐)은 '미상'이고 줄이 멎지 않는다", async () => {
  generationMetrics.mockImplementation((id: string) => {
    if (id === "throws") throw new TypeError("not a function");
    return id === "fails" ? Promise.reject(new Error("502")) : Promise.resolve({ real_credits: 7 });
  });
  act(() => root.render(<><Cell id="throws" /><Cell id="fails" /><Cell id="ok" /></>));
  await settle();
  expect(shown()).toEqual(["미상", "미상", "7"]);
  act(() => root.render(<></>));
  act(() => root.render(<><Cell id="ok" /><Cell id="fails" /></>));
  expect(shown()).toEqual(["7", "미상"]); // 받는 중('…')을 거치지 않는다
  await settle();
  expect(generationMetrics).toHaveBeenCalledTimes(3);
});

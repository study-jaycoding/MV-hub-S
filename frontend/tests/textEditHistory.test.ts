// 글자 노드 편집칸의 되돌리기 기록 — 브라우저 기록 대신 쓴다(실제 크롬 재현·실측은 docs/status/dev메인전환_검토수정_2026-11-01.md).
import { describe, expect, it } from "vitest";
import { breakTextTyping, recordTextEdit, redoTextEdit, startTextHistory, undoTextEdit } from "../src/lib/textEditHistory";

const at = (text: string, caret = text.length) => ({ text, caret });
const typed = (history: ReturnType<typeof startTextHistory>, text: string, time: number, alone = false) =>
  recordTextEdit(history, at(text), time, alone);

describe("글자 칸 되돌리기 기록", () => {
  it("이어 친 글은 한 걸음이고, 0.7초 넘게 쉬면 새 걸음이다", () => {
    const history = startTextHistory(at(""));
    typed(history, "a", 1000);
    typed(history, "ab", 1300);
    typed(history, "abc", 1900);
    typed(history, "abcd", 2700);
    expect(undoTextEdit(history)).toEqual(at("abc"));
    expect(undoTextEdit(history)).toEqual(at(""));
    expect(undoTextEdit(history)).toBeNull();
  });

  it("줄바꿈·붙여넣기는 앞뒤 입력과 묶이지 않는다", () => {
    const history = startTextHistory(at("base"));
    typed(history, "base1", 1000);
    typed(history, "base1\n", 1100, true);
    typed(history, "base1\nx", 1200);
    expect(undoTextEdit(history)).toEqual(at("base1\n"));
    expect(undoTextEdit(history)).toEqual(at("base1"));
    expect(undoTextEdit(history)).toEqual(at("base"));
  });

  it("끊으면 다음 입력은 시간과 상관없이 따로 한 걸음이다 — @ 고르기", () => {
    const history = startTextHistory(at(""));
    typed(history, "@im", 1000);
    breakTextTyping(history);
    typed(history, "@image1 ", 1100, true);
    expect(undoTextEdit(history)).toEqual(at("@im"));
  });

  it("캐럿을 옮긴 뒤의 입력은 새 걸음이고, 되돌리면 옮긴 자리로 돌아간다", () => {
    const history = startTextHistory(at(""));
    typed(history, "abc", 1000);
    recordTextEdit(history, at("abc", 1), 1100, false);
    recordTextEdit(history, at("aXbc", 2), 1200, false);
    expect(undoTextEdit(history)).toEqual(at("abc", 1));
  });

  it("다시 실행 — 되돌린 만큼 앞으로 가고, 새 입력이 있으면 앞 기록을 버린다", () => {
    const history = startTextHistory(at("a"));
    typed(history, "ab", 1000);
    typed(history, "abc", 3000);
    undoTextEdit(history);
    undoTextEdit(history);
    expect(redoTextEdit(history)).toEqual(at("ab"));
    expect(redoTextEdit(history)).toEqual(at("abc"));
    expect(redoTextEdit(history)).toBeNull();
    undoTextEdit(history);
    typed(history, "abX", 9000);
    expect(redoTextEdit(history)).toBeNull();
  });

  it("글이 그대로면 쌓지 않는다 · 200걸음까지만 둔다", () => {
    const history = startTextHistory(at(""));
    typed(history, "", 1000);
    expect(undoTextEdit(history)).toBeNull();
    for (let n = 1; n <= 260; n += 1) typed(history, `t${n}`, n * 1000);
    let steps = 0;
    while (undoTextEdit(history)) steps += 1;
    expect(steps).toBe(200);
  });
});

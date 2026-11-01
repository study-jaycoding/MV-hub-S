// 글자 노드 편집칸의 되돌리기 기록 — 브라우저 기록은 알약으로 글 조각을 바꾸면 어긋나 Ctrl+Z 가 듣지 않거나 앞 글을 지운다(2026-11-01 실제 크롬).
//  칸의 글과 캐럿을 직접 남기고, 되돌릴 때 칸을 다시 채운다. 편집칸을 열 때 새로 시작하고 닫으면 버린다 — 닫은 뒤에는 캔버스 되돌리기가 맡는다.

export interface TextSnapshot {
  text: string;
  caret: number;
}

export interface TextEditHistory {
  past: TextSnapshot[];
  future: TextSnapshot[];
  now: TextSnapshot;
  typingAt: number | null; // 이어 칠 수 있는 입력의 시각 — 묶지 않을 때는 null
}

const MERGE_MS = 700;
const LIMIT = 200;

export function startTextHistory(now: TextSnapshot): TextEditHistory {
  return { past: [], future: [], now, typingAt: null };
}

/** 이어 치던 입력을 끊는다 — 다음 변경은 따로 한 걸음이다. */
export function breakTextTyping(history: TextEditHistory): void {
  history.typingAt = null;
}

/** 칸의 지금 상태를 남긴다. alone = 줄바꿈·붙여넣기처럼 앞뒤 입력과 묶지 않는 변경. 글이 그대로면 캐럿만 옮겨 적는다. */
export function recordTextEdit(history: TextEditHistory, next: TextSnapshot, at: number, alone: boolean): void {
  if (next.text === history.now.text) {
    if (next.caret !== history.now.caret) history.typingAt = null; // 캐럿을 옮긴 뒤의 입력은 다른 자리다
    history.now = next;
    return;
  }
  const merged = !alone && history.typingAt !== null && at - history.typingAt < MERGE_MS;
  if (!merged) {
    history.past.push(history.now);
    if (history.past.length > LIMIT) history.past.shift();
  }
  history.now = next;
  history.future = [];
  history.typingAt = alone ? null : at;
}

export function undoTextEdit(history: TextEditHistory): TextSnapshot | null {
  const back = history.past.pop();
  if (!back) return null;
  history.future.push(history.now);
  history.now = back;
  history.typingAt = null;
  return back;
}

export function redoTextEdit(history: TextEditHistory): TextSnapshot | null {
  const forward = history.future.pop();
  if (!forward) return null;
  history.past.push(history.now);
  history.now = forward;
  history.typingAt = null;
  return forward;
}

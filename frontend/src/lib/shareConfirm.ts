// 늦은 공유·최종·보류 요청의 끝을 허브의 원장으로 확인한다(Jay 결정 10A). 공유 서버가 60초 넘게 답하지 않으면 허브는 그 요청을
//  '실패'가 아니라 결과 불명(502 + {code: "upstream_timeout", refs})으로 돌려주고, 조정기가 서버 상태를 관측해 원장을 닫는다.
//  화면은 그동안 '확인 중'으로 세고, 끝나면 반영·실패·확인 불가로 알린다. 설계 docs/status/결정일곱_설계_2026-10-15.md 10A.
import { HttpError, jsonFetch } from "./http";
import { t } from "./i18n";

export type IntentRef = { gen_id: string; intent_id: string; seq: number; scope?: string };
type Outcome = { state: "pending" | "confirmed" | "failed" | "unknown"; reason?: string };
export type SettledCounts = { confirmed: number; failed: number; unknown: number; reasons: string[] };

export const SLOW_NOTICE = "서버가 늦습니다 — 들어갔는지 확인하는 중입니다";

/** 허브가 '늦은 서버 — 결과 불명'으로 돌려준 오류면 그 원장 참조, 아니면 null. */
export function slowRefs(error: unknown): IntentRef[] | null {
  if (!(error instanceof HttpError) || error.info?.code !== "upstream_timeout") return null;
  return Array.isArray(error.info.refs) ? (error.info.refs as IntentRef[]) : [];
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const ASK_BATCH = 500; // 허브 상한(models.IntentOutcomesIn)과 같다
type Answer = Outcome & { intent_id: string; seq: number };

// 한 번 묻기(참조 여러 개를 한 요청으로 — 2,000장이면 하나씩은 한 바퀴 2,000 요청이었다, Codex 63회차) — 응답·본문이 멈춰도 기한(ms)에
//  끊고 null(다음 차례에 다시). 허브가 멎으면 기다림이 기한을 넘지 않게(Codex 10A 리뷰).
async function ask(refs: IntentRef[], ms: number): Promise<Answer[] | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([
      jsonFetch<Answer[]>("/api/share/intents/outcomes", {
        method: "POST",
        body: JSON.stringify({ refs: refs.map(({ intent_id, seq, scope }) => ({ intent_id, seq, scope })) }),
        signal: controller.signal,
      }),
      new Promise<null>((done) => {
        timer = setTimeout(() => {
          controller.abort();
          done(null);
        }, ms);
      }),
    ]);
    return Array.isArray(answers) ? answers : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 원장이 끝날 때까지 묻는다 — pollMs 간격, limitMs 가 지나도 끝나지 않은 것은 '확인 불가'로 센다. 묻기 실패는 다음 차례에 다시. */
export async function settleIntents(refs: IntentRef[], pollMs = 5000, limitMs = 10 * 60_000): Promise<SettledCounts> {
  const left = new Map(refs.map((ref) => [`${ref.intent_id}:${ref.seq}`, ref]));
  const counts: SettledCounts = { confirmed: 0, failed: 0, unknown: 0, reasons: [] };
  const until = Date.now() + limitMs;
  for (;;) {
    const waiting = [...left.values()];
    for (let i = 0; i < waiting.length; i += ASK_BATCH) {
      const remaining = until - Date.now();
      if (remaining <= 0) break;
      for (const outcome of (await ask(waiting.slice(i, i + ASK_BATCH), Math.min(15_000, remaining))) ?? []) {
        const key = `${outcome.intent_id}:${outcome.seq}`;
        if (outcome.state === "pending" || !left.has(key)) continue;
        left.delete(key);
        counts[outcome.state] += 1;
        if (outcome.reason) counts.reasons.push(outcome.reason);
      }
    }
    if (!left.size || Date.now() >= until) break;
    await sleep(Math.min(pollMs, until - Date.now())); // 기다림도 기한을 넘지 않게(Codex 10A 재검토)
  }
  counts.unknown += left.size;
  return counts;
}

const REASONS: Record<string, string> = {
  composite_reverted: "최종 지정이 들어가지 않아 공유도 되돌렸습니다",
  composite_final_refused: "최종 지정이 들어가지 않았습니다(공유는 그대로)",
  account_changed: "그사이 계정이 바뀌어 확인하지 못했습니다",
};

/** 확인이 끝난 뒤의 한 줄. */
export function settledSummary(counts: SettledCounts): string {
  const line = t("늦었던 요청 확인: 반영 {confirmed} · 실패 {failed} · 확인 불가 {unknown}")
    .replace("{confirmed}", String(counts.confirmed)).replace("{failed}", String(counts.failed)).replace("{unknown}", String(counts.unknown));
  const reasons = [...new Set(counts.reasons)].map((reason) => t(REASONS[reason] ?? reason));
  const hint = counts.unknown ? [t("확인하지 못한 것은 카드 상태를 보세요.")] : [];
  return [line, ...reasons, ...hint].join(" · ");
}

/** 늦은 요청을 뒤에서 확인하고, 끝나면 알린 뒤 화면을 다시 읽는다(부르는 쪽은 기다리지 않는다). */
export function watchSlowRequests(refs: IntentRef[], flash: (message: string) => void, refresh: () => void | Promise<void>): void {
  if (!refs.length) return;
  void settleIntents(refs).then(async (counts) => {
    flash(settledSummary(counts));
    await refresh();
  });
}

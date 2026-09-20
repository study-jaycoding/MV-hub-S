import { isHttpStatus } from "./http";

export async function runGenerationBulk(
  ids: string[],
  fn: (id: string) => Promise<unknown>,
): Promise<number> {
  const results = await Promise.allSettled(ids.map(fn));
  return results.filter((x) => x.status === "rejected").length;
}

export function bulkResultText(
  total: number,
  failed: number,
  doneText: string,
  partialText: string,
): string {
  if (failed) return `${total - failed}개 ${partialText} · ${failed}개 실패`;
  return `${total}개를 ${doneText}`;
}

// 휴지통 보내기 전용 — 서버는 공유 중인 항목의 삭제를 409 로 거절한다(routers/generation.py). 그냥 "N개 실패"로만 알리면
// 무엇을 해야 하는지 알 수 없다(2026-09-21 실측: 12장 중 공유 5장 → "7개 휴지통 이동 · 5개 실패"). 공유 중은 따로 센다.
export async function runGenerationTrash(
  ids: string[],
  fn: (id: string) => Promise<unknown>,
): Promise<{ done: string[]; shared: number; failed: number }> {
  const results = await Promise.allSettled(ids.map(fn));
  const rejected = results.flatMap((x) => (x.status === "rejected" ? [x.reason] : []));
  const shared = rejected.filter((reason) => isHttpStatus(reason, 409)).length;
  return {
    done: ids.filter((_, i) => results[i].status === "fulfilled"),
    shared,
    failed: rejected.length - shared,
  };
}

export function trashResultText(total: number, shared: number, failed: number): string {
  if (!shared && !failed) return `${total}개를 휴지통으로 보냈습니다.`;
  const moved = total - shared - failed;
  return [
    moved ? `${moved}개 휴지통 이동` : "",
    shared ? `${shared}개는 공유 중이라 건너뜀(먼저 공유 해제)` : "",
    failed ? `${failed}개 실패` : "",
  ].filter(Boolean).join(" · ");
}

export function trashConfirmText(count: number, includeRestoreHint: boolean): string {
  return (
    `선택한 ${count}개를 휴지통으로 보낼까요?\n` +
    `메인 라이브러리에서 빠지고 별도 휴지통 DB로 이동합니다(힉스필드 원본엔 영향 없음).` +
    (includeRestoreHint ? `\n사이드바 '휴지통 보기'에서 검색·복원할 수 있습니다.` : "")
  );
}

export function purgeConfirmText(count: number): string {
  return (
    `선택한 ${count}개를 영구 삭제할까요?\n` +
    `휴지통에서 완전히 사라지며 복원할 수 없습니다.\n` +
    `(힉스필드 원본·이미 보관된 미디어 파일엔 영향 없음)`
  );
}

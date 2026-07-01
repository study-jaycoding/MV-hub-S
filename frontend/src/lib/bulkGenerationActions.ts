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

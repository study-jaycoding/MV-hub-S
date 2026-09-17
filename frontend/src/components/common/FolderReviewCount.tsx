import type { FolderReviewCounts } from "../../types";
import { useT } from "../../lib/i18n";

export function FolderReviewCount({ counts, total }: { counts: FolderReviewCounts | null; total: number }) {
  const t = useT();
  if (!counts) return <span className="folder-tree-count" title={t("상태별 개수 정보가 없어 전체 개수를 표시합니다. 서버 업데이트 후 확인하세요.")}>
    {total === 0 ? "-" : t("전체 {count}").replace("{count}", String(total))}
  </span>;
  const label = t("최종 {final}개 · 보류 {held}개 · 전체 {total}개 (하위 폴더 포함)")
    .replace("{final}", String(counts.final)).replace("{held}", String(counts.held)).replace("{total}", String(total));
  return <span className={`folder-tree-count folder-review-count${total ? "" : " zero"}`} title={label} aria-label={label}>
    {total === 0 ? "-" : <>
      {counts.final > 0 && <><span className="folder-review-final">★{counts.final}</span><span aria-hidden> · </span></>}
      {counts.held > 0 && <><span className="folder-review-held">R{counts.held}</span><span aria-hidden> · </span></>}
      <strong className="folder-review-total">{total}</strong>
    </>}
  </span>;
}

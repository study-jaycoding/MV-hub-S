// 폴더 카드의 정보 줄 — 모아보기 [개별] 카드·컷 카드(그리드)·컷 줄(리스트)이 같이 쓴다(Jay 2026-10-13: 컷 카드와 줄에도 모아보기 카드 같은 정보).
//  모델·작업자·크레딧·생성일 = 그 카드에 보이는 그림 **한 장**(팀이 정한 대표, 없으면 가장 최근 것)의 것. 검토 = 그 **폴더 안**의 개수
//  (공유 · ★ 최종 · R 보류 · 전체 — 사이드바 폴더 숫자와 같은 규칙·같은 색, 0 은 감춤). 개수를 모르면(옛 공유 서버·목록에서도 못 셈) 그 그림의 상태.
import type { HTMLAttributes } from "react";
import { useCoverCredits } from "../lib/coverCredits";
import { workerLabel } from "../lib/cutSummary";
import { reviewCounts } from "../lib/episodeBoard";
import { formatCredits } from "../lib/formatCredits";
import { formatGenerationDateTime, generationListMeta } from "../lib/generationDisplay";
import { useT } from "../lib/i18n";
import { useModelDisplayName } from "../lib/modelCatalog";
import type { FolderCard } from "../types";

interface Props extends HTMLAttributes<HTMLDivElement> {
  folder: FolderCard;
}

export function CoverInfo({ folder, className, ...rest }: Props) {
  const t = useT();
  const modelName = useModelDisplayName();
  const g = folder.cover;
  const credits = useCoverCredits(g.id);
  const duration = generationListMeta((g.params || {}) as Record<string, unknown>).duration;
  const review = reviewCounts(folder);
  return (
    <div className={"reel-info" + (className ? " " + className : "")} {...rest}>
      <span className="k">{t("모델")}</span><span className="v">{modelName(g.model)}{duration ? <> · <i>{duration}</i></> : null}</span>
      <span className="k">{t("작업자")}</span><span className="v">{workerLabel(g)}</span>
      <span className="k">{t("크레딧")}</span>
      <span className="v">{credits === undefined ? "…" : credits != null ? `${formatCredits(credits)} credits` : t("미상")}</span>
      <span className="k">{t("생성일")}</span><span className="v">{formatGenerationDateTime(g.created_at)}</span>
      <span className="k">{t("검토")}</span>
      {review === null ? (
        <span className="v">{g.is_final ? t("최종") : g.is_held ? t("보류") : t("공유")}</span>
      ) : (
        // 0 인 것은 감춘다(사이드바와 같다). 조각 사이의 '·' 은 CSS 가 그린다
        <span className="v reel-rv">
          {review.shared > 0 && <span>{t("공유")} <b>{review.shared}</b></span>}
          {review.final > 0 && <span className="fin">★ {t("최종")} {review.final}</span>}
          {review.held > 0 && <span className="held" title={t("보류")}>R {review.held}</span>}
          <span className="all">{t("전체")} {folder.count}</span>
        </span>
      )}
    </div>
  );
}

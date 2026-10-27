// 폴더 카드의 정보 줄 — 모아보기 [개별] 카드·컷 카드(그리드)·컷 줄(리스트)이 같이 쓴다(Jay 2026-10-13: 컷 카드와 줄에도 모아보기 카드 같은 정보).
//  모델·작업자·크레딧·생성일 = 그 카드에 보이는 그림 **한 장**(팀이 정한 대표, 없으면 가장 최근 것)의 것. 검토 = 그 **폴더 안**의 개수
//  (공유 · ★ 최종 · R 보류 · 전체 — 사이드바 폴더 숫자와 같은 규칙·같은 색, 0 은 감춤). 개수를 모르면(옛 공유 서버·목록에서도 못 셈) 그 그림의 상태.
//  크레딧은 카드마다 요청 한 건이다 — **화면에 들어온 카드만** 묻는다(컷 화면은 카드를 다 그린다. 화면을 벗어나면 줄에서 빠진다 — lib/coverCredits).
import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import { useCoverCredits } from "../lib/coverCredits";
import { workerLabel } from "../lib/cutSummary";
import { reviewCounts } from "../lib/episodeBoard";
import { formatCredits } from "../lib/formatCredits";
import { formatGenerationDateAndTime, formatGenerationDateTime, generationListMeta } from "../lib/generationDisplay";
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
  const ref = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined"); // 못 재는 환경은 바로 묻는다
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setOnScreen(entries[entries.length - 1].isIntersecting), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const credits = useCoverCredits(g.id, onScreen);
  const duration = generationListMeta((g.params || {}) as Record<string, unknown>).duration;
  const review = reviewCounts(folder);
  const model = modelName(g.model, g.params);
  // 날짜와 시각을 조각으로 나눈다 — 컷 카드(그리드)의 정보판은 늘 두 줄(날짜 / 시각)로 그려 줄 높이가 카드마다 같다(CSS .ep-grid .ep-meta .when).
  //  한 줄에 두면 월·일·시의 자릿수에 따라 어떤 카드는 줄이 바뀌고 어떤 카드는 안 바뀌어 아래 줄이 어긋났다(Jay 2026-10-13 밤).
  const [day, clock] = formatGenerationDateAndTime(g.created_at);
  return (
    <div ref={ref} className={"reel-info" + (className ? " " + className : "")} {...rest}>
      {/* 좁은 카드에서는 값이 한 줄로 잘린다(말줄임) — 잘린 값은 title 로 다 보인다 */}
      <span className="k">{t("모델")}</span>
      {/* 좁으면 모델 이름이 줄고(말줄임) 길이는 남는다 — CSS .model */}
      <span className="v model" title={duration ? `${model} · ${duration}` : model}><span>{model}</span>{duration ? <> · <i>{duration}</i></> : null}</span>
      <span className="k">{t("작업자")}</span><span className="v">{workerLabel(g)}</span>
      <span className="k">{t("크레딧")}</span>
      <span className="v">{credits === undefined ? "…" : credits != null ? `${formatCredits(credits)} credits` : t("미상")}</span>
      <span className="k">{t("생성일")}</span>
      <span className="v when" title={formatGenerationDateTime(g.created_at)}><span>{day}</span>{clock ? <> <span>{clock}</span></> : null}</span>
      <span className="k">{t("검토")}</span>
      {review === null ? (
        <span className="v">{g.is_final ? t("최종") : g.is_held ? t("보류") : t("공유")}</span>
      ) : (
        // 0 인 것은 감춘다(사이드바와 같다). 조각 사이의 '·' 은 CSS 가 그린다
        <span
          className="v reel-rv"
          title={`${t("공유")} ${review.shared} · ${t("최종")} ${review.final} · ${t("보류")} ${review.held} · ${t("전체")} ${folder.count}`}
        >
          {review.shared > 0 && <span>{t("공유")} <b>{review.shared}</b></span>}
          {/* '최종' 글자는 좁은 카드에서 CSS 가 뺀다(★ 숫자만 — 색이 같다) */}
          {review.final > 0 && <span className="fin">★ <em>{t("최종")}</em> {review.final}</span>}
          {review.held > 0 && <span className="held" title={t("보류")}>R {review.held}</span>}
          <span className="all">{t("전체")} {folder.count}</span>
        </span>
      )}
    </div>
  );
}

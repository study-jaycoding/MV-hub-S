// 편집 탭 미디어 풀의 썸네일 카드 — 라이브러리 카드(GenerationCard)와 같은 모양으로 '보이기만' 한다(Jay 2026-10-08).
//  모양은 라이브러리 CSS 클래스(card·card-thumb·card-sf·creator-badge·play-badge·card-bottom·card-here)를 그대로 쓴다 —
//  값을 베껴 두면 그쪽이 바뀔 때 어긋난다. 카드 안 조작(공유·태그·코멘트)은 없다. 누르기·더블클릭·우클릭은 풀이 건다.
import type { HTMLAttributes } from "react";
import { reviewState } from "../../lib/generationReview";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import type { Generation } from "../../types";

export interface PoolItem {
  gen: Generation;
  track: number | null; // 타임라인에 넣은 트랙(안 넣었으면 null)
  showing: boolean; // 지금 타임라인 뷰어에 보이는 것
  source?: "S" | "L" | "R" | "LR"; // 소스 클립 판에 떠 있다(Jay 2026-10-14) — S = 싱글 뷰어, 듀얼이면 왼쪽·오른쪽·둘 다
  resolve?: boolean; // 다빈치(미디어 풀)에서 고른 것(Jay 2026-10-14) — 빨간 테두리와 '다빈치' 표
}

// 타임라인에 넣은 카드의 표 글 — 미디어 풀과 폴더 창이 같은 글을 쓴다.
export const editMarkLabel = (track: number, t: (key: string) => string) =>
  t("V{track} - 선택 카드").replace("{track}", String(track));

// 소스 클립 판의 표 글 — "소스 L"·"소스 R"·"소스 L·R"(싱글 뷰어면 "소스"). 풀의 세 보기와 폴더 창이 같은 글을 쓴다.
export const sourceMarkLabel = (source: PoolItem["source"], t: (key: string) => string) =>
  !source ? "" : `${t("소스")}${source === "S" ? "" : ` ${source === "LR" ? "L·R" : source}`}`;

// 풀 카드의 표 — 넣은 트랙과 소스 클립 판(둘 다면 이어서). 없으면 null. short = 작은 카드에 보이는 짧은 글
export function poolMark(item: PoolItem, t: (key: string) => string): { label: string; short: string; lead: boolean } | null {
  const side = item.source === "LR" ? "L·R" : item.source === "S" ? "" : item.source ?? "";
  const source = sourceMarkLabel(item.source, t);
  const label = [item.track !== null ? editMarkLabel(item.track, t) : "", source].filter(Boolean).join(" · ");
  if (!label) return null;
  const short = [item.track !== null ? `V${item.track}` : "", item.source ? side || t("소스") : ""].filter(Boolean).join("·");
  return { label, short, lead: item.showing || !!item.source }; // 지금 뷰어에 보이는 것만 라임
}

export function EditCard({
  item,
  picked,
  handlers,
}: {
  item: PoolItem;
  picked: boolean; // 풀에서 고른 카드(듀얼 뷰어의 소스)
  handlers: HTMLAttributes<HTMLButtonElement>; // 누르기·더블클릭·우클릭·휠 클릭·설명 — 세 보기가 같은 것을 쓴다
}) {
  const t = useT();
  const { gen, track } = item;
  const base = poolMark(item, t);
  // 다빈치에서 고른 것 — 표 글 끝에 '다빈치'를 잇고 빨갛게(표가 없던 카드면 '다빈치'만)
  const dv = t("다빈치");
  const mark = !item.resolve ? base
    : { label: base ? `${base.label} · ${dv}` : dv, short: base ? `${base.short}·${dv}` : dv, lead: true };
  const thumb = thumbOf(gen, 512);
  const state = reviewState(gen); // 공유 목록이라 shared·held·final 중 하나다
  return (
    <button type="button" className={"ed-card" + (picked ? " ed-picked" : "") + (item.resolve ? " ed-dv" : "")} {...handlers}>
      {/* 넣은 카드 = 라이브러리의 '선택'과 같은 굵은 상태색 테두리 */}
      <span className={"card card-grid" + (state === "unshared" ? "" : ` st-${state}`) + (track !== null ? " selected" : "")}>
        <span className="card-clip">
          <span className="card-thumb">
            {thumb && <img src={thumb} alt="" loading="lazy" draggable={false} />}
            {!gen.is_mine && <span className="creator-badge">👤 {gen.creator_name || t("팀원")}</span>}
            <span className="card-tl">
              <span className={"card-sf on" + (gen.is_final ? " final" : gen.is_held ? " held" : "")}>
                {gen.is_final ? (
                  <svg className="card-final-star" viewBox="2 0 96 91" aria-hidden="true" focusable="false">
                    <polygon points="50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35" />
                  </svg>
                ) : "S"}
              </span>
            </span>
            {gen.assets[0].type === "video" && <span className="play-badge">▶</span>}
            {/* 아래 변 가운데의 표 — 라이브러리 폴더 창의 '방금 누른 카드'와 같은 자리·같은 모양. 타임라인에 넣은 카드에
                트랙과 함께 붙는다(Jay: "V1 - 선택 카드"), 소스 클립 판에 떠 있으면 '소스 L' 처럼(2026-10-14). 지금 뷰어에
                보이는 것만 라임, 아래에 깔린 것은 옅게. */}
            {mark && (
              <span className="card-bottom">
                <span className={(mark.lead ? "card-here" : "card-folder static") + (item.resolve ? " ed-dv-mark" : "")}>
                  {/* 카드가 작으면 CSS 가 data-short("V1"·"V1·L")만 보인다 */}
                  <span data-short={mark.short}>{mark.label}</span>
                </span>
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}

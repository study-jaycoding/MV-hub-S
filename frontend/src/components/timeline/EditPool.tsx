// 편집 탭 오른쪽 — 재생헤드가 있는 컷 폴더에 공유된 생성물. 누르면 그 컷 자리에 넣고, 다시 누르면 뺀다.
//  카드는 라이브러리 카드와 같은 모양이다(EditCard). 같은 목록을 크게 펼친 것이 컷 창(EditCutWindow).
import type { Generation } from "../../types";
import { useT } from "../../lib/i18n";
import type { EditListState } from "../../lib/useEditSequence";
import { EditCard, type PoolItem } from "./EditCard";

export type { PoolItem };

export function EditPool({
  title,
  items,
  listState,
  listError,
  notice,
  noticeAction,
  onToggle,
  onReload,
}: {
  title: string; // 'e070 / c0050'
  items: PoolItem[];
  listState: EditListState;
  listError: string | null;
  notice: string | null; // 목록 대신 보여 줄 안내(폴더를 안 골랐다·워크스페이스 미확인 등)
  noticeAction?: { label: string; run: () => void } | null; // 안내 옆의 출구(워크스페이스 미확인 → 전체 보기)
  onToggle: (gen: Generation) => void;
  onReload: () => void;
}) {
  const t = useT();
  const placed = items.filter((item) => item.track !== null).length;
  return (
    <section className="ed-pool" onMouseDown={(event) => event.preventDefault()}>
      <div className="ed-pool-head">
        <h3>{t("이 컷의 생성물")}</h3>
        <button type="button" className="ed-link" onClick={onReload} title={t("공유 목록을 다시 받습니다")}>
          {t("새로 고침")}
        </button>
      </div>
      <div className="ed-pool-sub">
        {notice ? (
          <>
            {notice}{" "}
            {noticeAction && <button type="button" className="ed-link" onClick={noticeAction.run}>{noticeAction.label}</button>}
          </>
        ) : (
          <>
            {title} · {t("공유된 것 {count}개").replace("{count}", String(items.length))}
            {placed > 0 && <> · {t("넣은 것 {count}개").replace("{count}", String(placed))}</>}
          </>
        )}
      </div>
      {!notice && listState === "error" && (
        <div className="ed-pool-note ed-bad" role="status">
          {t("공유 목록을 받지 못했습니다.")} {listError}
        </div>
      )}
      {!notice && listState === "capped" && (
        <div className="ed-pool-note" role="status">{t("최대 2,000건까지만 표시합니다.")}</div>
      )}
      {!notice && listState === "loading" && !items.length && (
        <div className="ed-pool-note" role="status">{t("공유 목록을 받는 중...")}</div>
      )}
      {!notice && (
        <div className="ed-pgrid">
          {items.map((item) => (
            <EditCard key={item.gen.id} item={item} onClick={() => onToggle(item.gen)}
              title={item.track !== null ? t("누르면 타임라인에서 뺍니다") : t("누르면 이 컷 자리에 넣습니다")} />
          ))}
        </div>
      )}
      {!notice && listState === "ok" && !items.length && (
        <div className="ed-pool-note">{t("이 컷 폴더에 공유된 생성물이 없습니다.")}</div>
      )}
      <div className="ed-hint">
        {t("고르면 이 컷 자리에 들어갑니다.")}<br />
        {t("여러 개를 고르면 위로 쌓이고, 맨 위에 있는 것이 보입니다.")}<br />
        {t("타임라인의 컷을 더블클릭하면 크게 펼쳐 봅니다.")}
      </div>
    </section>
  );
}

// 편집 탭 오른쪽 — 재생헤드가 있는 컷 폴더에 공유된 생성물. 누르면 그 컷 자리에 넣고, 다시 누르면 뺀다.
import type { Generation } from "../../types";
import { generationListMeta } from "../../lib/generationDisplay";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import type { EditListState } from "../../lib/useEditSequence";

export interface PoolItem {
  gen: Generation;
  track: number | null; // 타임라인에 넣은 트랙(안 넣었으면 null)
  showing: boolean; // 지금 뷰어에 보이는 것
}

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
          {items.map(({ gen, track, showing }) => {
            const asset = gen.assets[0];
            const thumb = thumbOf(gen, 512);
            const seconds = asset.type === "video" ? generationListMeta(gen.params ?? {}).duration ?? "" : "";
            return (
              <button
                type="button"
                key={gen.id}
                className={"ed-pcard" + (track !== null ? " ed-picked" : "")}
                onClick={() => onToggle(gen)}
                title={track !== null ? t("누르면 타임라인에서 뺍니다") : t("누르면 이 컷 자리에 넣습니다")}
              >
                <span className="ed-pimg" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
                  {gen.is_final && <span className="ed-badge ed-final" title={t("최종")}>★</span>}
                  {gen.is_held && !gen.is_final && <span className="ed-badge ed-held" title={t("보류")}>H</span>}
                  {asset.type === "image" && <span className="ed-badge ed-kind">{t("이미지")}</span>}
                  {track !== null && (
                    <span className="ed-in">{showing ? t("V{track} · 지금 보이는 것").replace("{track}", String(track)) : `V${track}`}</span>
                  )}
                </span>
                <span className="ed-pmeta">
                  <span>{gen.creator_name || gen.worker_name || ""}</span>
                  <span>{seconds}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {!notice && listState === "ok" && !items.length && (
        <div className="ed-pool-note">{t("이 컷 폴더에 공유된 생성물이 없습니다.")}</div>
      )}
      <div className="ed-hint">
        {t("고르면 이 컷 자리에 들어갑니다.")}<br />
        {t("여러 개를 고르면 위로 쌓이고, 맨 위에 있는 것이 보입니다.")}
      </div>
    </section>
  );
}

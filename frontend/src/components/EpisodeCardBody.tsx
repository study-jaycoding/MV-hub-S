// 폴더 카드의 안쪽 그림(줄·카드·표) — FolderCardGrid 가 에피소드 화면이거나 리스트 보기일 때 카드(.cut-card.ep-card) 안에 그린다.
//  고르기·마퀴·키·두 번 클릭(들어가기/모아보기)·우클릭(폴더 창)은 격자의 것 그대로다 — 여기는 모양과, 카드 안의 누름만 맡는다.
//  리스트 = 가로 한 줄(번호 · 표지 · 이름과 숫자 · 띠) / 그리드 = 큰 표지 + 컷 띠 + 대표 진행 막대(Jay 2026-10-13, 시안 mock_project_top_*.png)
//  / 표 = 리스트 단추를 한 번 더 누른 것(번호 · 작은 그림 · 숫자 열 — 시안 mock_cut_list_view_v2.png).
//  띠: 묶음(하위 폴더 있음)은 그 아래 **컷**을, 컷(하위 폴더 없음)은 그 컷의 **생성물**(★ 대표 · ★ 최종 · R 보류 · 만든 사람)을 싣는다.
//  서버가 새 집계를 안 주면(옛 공유 서버) 그 표시만 빠진다 — 번호·표지·이름·건수·단추는 그대로 보인다.
//  카드 안의 단추에는 data-ep-action 을 붙인다 — 격자가 그 누름을 카드 고르기·두 번 클릭으로 읽지 않게 하는 표식이다.
import { useT } from "../lib/i18n";
import {
  episodeNumber, repProgress, reviewCounts, sharedAgo, stripOf, takesOf, type Ago, type EpisodeLayout,
} from "../lib/episodeBoard";
import { mediaThumbUrl, thumbOf } from "../lib/media";
import type { FolderCard, FolderCardChild, FolderCardTake } from "../types";
import { CoverInfo } from "./CoverInfo";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folder: FolderCard;
  layout: EpisodeLayout;
  thumbSize: number; // 표지 썸네일 크기(격자가 카드 폭으로 정한다)
  fill: boolean; // 썸네일 꽉 채움 ↔ 비율 유지
  now: number; // '2시간 전' 의 기준 시각 — 격자가 한 번 재어 모든 카드에 같은 값을 준다
  cutsColumn?: boolean; // 표 — '컷' 열을 그리는가(이 화면에 하위 폴더를 가진 카드가 있다. 머리줄과 같은 값)
  // 카드 안 단추의 누름 — 누른 이벤트를 같이 넘긴다(격자가 '위에 뜬 메뉴를 닫는 누름'이었는지 본다).
  onEnter: (e: React.MouseEvent) => void; // 이 폴더로 들어가기([열기] · [폴더로] · '+N')
  onEnterCut: (cut: FolderCardChild, e: React.MouseEvent) => void; // 컷 띠의 컷 — 그 컷으로 바로
  onPreviewTake: (take: FolderCardTake, e: React.MouseEvent) => void; // 생성물 띠의 그림 — 크게 보기
}

export function EpisodeCardBody({ folder, layout, thumbSize, fill, now, cutsColumn = false, onEnter, onEnterCut, onPreviewTake }: Props) {
  const t = useT();
  const asset = folder.cover.assets?.[0];
  const isVideo = asset?.type === "video";
  const number = episodeNumber(folder.name);
  const subfolders = folder.subfolders ?? 0;
  const leaf = subfolders === 0; // 컷 — 더 들어갈 폴더가 없다
  const strip = stripOf(folder, layout);
  const takes = takesOf(folder);
  const progress = repProgress(folder);
  const review = reviewCounts(folder);
  const line =
    (subfolders ? `${t("컷")} ${subfolders} · ` : "") + `${folder.count}${t("건")}` +
    (folder.video_count != null ? ` · ${t("영상")} ${folder.video_count}` : "");
  const agoText = (ago: Ago): string =>
    ago.unit === "now" ? t("방금") : ago.unit === "yesterday" ? t("어제")
      : `${ago.n}${t(ago.unit === "min" ? "분 전" : ago.unit === "hour" ? "시간 전" : "일 전")}`;
  const ago = sharedAgo(folder.last_shared_at, now);
  const shared = ago ? agoText(ago) + (folder.last_shared_by ? ` · ${folder.last_shared_by}` : "") : "";
  const enter = (
    <button type="button" data-ep-action tabIndex={-1} className="ep-enter" title={leaf ? `${folder.path} — ${t("이 폴더로 이동합니다")}` : undefined} onClick={onEnter}>
      {t(leaf ? "폴더로" : "열기")} ▸
    </button>
  );

  if (layout === "table") {
    const dash = <span className="ep-t-none">-</span>;
    return (
      <>
        <span className="ep-num" aria-hidden="true">{number}</span>
        <span className={"ep-thumb" + (fill ? "" : " contain")}>
          <MediaThumbnail thumb={thumbOf(folder.cover, 256)} isVideo={isVideo} src={asset?.file_path} alt="" fallback={null} />
        </span>
        <span className="ep-t-name">{folder.name}</span>
        {cutsColumn && <span className="ep-t-n">{subfolders || dash}</span>}
        {leaf ? (
          <span className={"ep-t-rep" + (folder.rep ? " rep" : "")}>{folder.rep ? `★ ${t("대표")}` : t("미정")}</span>
        ) : (
          <span className={"ep-t-rep" + (progress?.done ? " rep" : "")}>{progress ? `★ ${progress.done}/${progress.total}` : dash}</span>
        )}
        <span className="ep-t-n">{folder.count}</span>
        <span className="ep-t-n">{folder.video_count ?? dash}</span>
        <span className="ep-t-n">{review?.shared || dash}</span>
        <span className="ep-t-n fin">{review?.final || dash}</span>
        <span className="ep-t-n held">{review?.held || dash}</span>
        <span className="ep-t-ago">{ago ? agoText(ago) : dash}</span>
        <span className="ep-t-workers">
          {folder.workers?.length ? folder.workers.map((one) => `${one.name ?? t("팀원")} ${one.count}`).join(" · ") : dash}
        </span>
        {enter}
      </>
    );
  }

  const cover = (
    <>
      <MediaThumbnail thumb={thumbOf(folder.cover, thumbSize)} isVideo={isVideo} src={asset?.file_path} alt="" fallback={null} />
      {isVideo && <span className="play-badge">▶</span>}
    </>
  );
  const tiles = strip && (strip.cuts.length > 0 || strip.more > 0) && (
    <span className="ep-strip">
      {strip.cuts.map((cut) => {
        const media = cut.cover.assets?.[0];
        return (
          <button
            key={cut.path}
            type="button"
            data-ep-action
            tabIndex={-1}
            className={"ep-cut" + (cut.rep ? " rep" : "")}
            title={`${cut.path} · ${cut.count}${t("건")}`}
            onClick={(e) => onEnterCut(cut, e)}
          >
            {/* 컷 카드와 같은 그림 분기 — 포스터가 있으면 그것, 포스터 없는 영상은 첫 프레임(원격 영상은 썸네일 주소를 못 만든다) */}
            <MediaThumbnail
              thumb={mediaThumbUrl(media?.file_path, media?.thumbnail_path, media?.type, 256)}
              isVideo={media?.type === "video"}
              src={media?.file_path}
              alt=""
              fallback={null}
            />
            <span className="ep-cut-name">{cut.name}</span>
            <span className="ep-cut-n">{cut.count}</span>
          </button>
        );
      })}
      {strip.more > 0 && (
        <button type="button" data-ep-action tabIndex={-1} className="ep-cut more" title={t("이 에피소드의 컷을 모두 봅니다")} onClick={onEnter}>
          +{strip.more}
        </button>
      )}
    </span>
  );
  // 컷의 생성물 띠 — 그림을 누르면 크게 보기(띠에 실린 것끼리 ←/→), '+N' 은 그 컷 폴더로
  const takeTiles = takes && takes.takes.length > 0 && (
    <span className="ep-strip takes">
      {takes.takes.map((take) => {
        const media = take.cover.assets?.[0];
        const rep = folder.rep && take.cover.id === folder.cover.id;
        return (
          <button
            key={take.cover.id}
            type="button"
            data-ep-action
            tabIndex={-1}
            className={"ep-cut ep-take" + (rep ? " rep" : "")}
            title={t("크게 보기")}
            onClick={(e) => onPreviewTake(take, e)}
          >
            <MediaThumbnail
              thumb={mediaThumbUrl(media?.file_path, media?.thumbnail_path, media?.type, 256)}
              isVideo={media?.type === "video"}
              src={media?.file_path}
              alt=""
              fallback={null}
            />
            {take.final ? <span className="ep-take-m fin" title={t("최종")}>★</span> : take.held ? <span className="ep-take-m held" title={t("보류")}>R</span> : null}
            {take.by && <span className="ep-take-by">{take.by}</span>}
          </button>
        );
      })}
      {takes.more > 0 && (
        <button type="button" data-ep-action tabIndex={-1} className="ep-cut more" title={t("이 폴더로 이동합니다")} onClick={onEnter}>
          +{takes.more}
        </button>
      )}
    </span>
  );
  const bar = progress && (
    <span className="ep-bar" aria-hidden="true">
      <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
    </span>
  );

  if (layout === "list")
    return (
      <>
        <span className="ep-num" aria-hidden="true">{number}</span>
        <span className={"ep-poster" + (fill ? "" : " contain")}>
          {cover}
          {/* 컷 줄 — 표지가 팀이 정한 대표인가(그리드의 컷 카드 위 '대표 미정'과 같은 뜻) */}
          {leaf && <span className={"ep-pchip" + (folder.rep ? " rep" : "")}>{folder.rep ? `★ ${t("대표")}` : t("대표 미정")}</span>}
        </span>
        <span className="ep-info">
          <span className="ep-name">{folder.name}</span>
          {shared && <span className="ep-sub">{t("마지막 공유")} {shared}</span>}
          <span className="ep-line">{line}</span>
          {!leaf && (
            <>
              {bar}
              {progress && <span className="ep-rep">{t("대표 정한 컷")} {progress.done} / {progress.total}</span>}
            </>
          )}
          {enter}
        </span>
        {/* 컷 줄 — 가운데에 그 그림의 정보와 폴더 안의 검토 개수(모아보기 카드와 같은 줄, Jay 2026-10-13) */}
        {leaf && <CoverInfo folder={folder} className="ep-meta" />}
        {leaf ? takeTiles : tiles}
      </>
    );
  return (
    <>
      <span className={"ep-cover" + (fill ? "" : " contain")}>
        {cover}
        {number && <span className="ep-num" aria-hidden="true">{number}</span>}
        {progress && (
          <span className={"ep-chip" + (progress.done ? "" : " none")}>
            {progress.done ? `★ ${t("대표")} ${progress.done}/${progress.total}` : t("대표 미정")}
          </span>
        )}
        <span className="ep-cap">
          <b>{folder.name}</b>
          <span>{line}</span>
        </span>
      </span>
      {tiles}
      {(progress || shared) && (
        <span className="ep-foot">
          {progress && <span>{t("대표")} {progress.done} / {progress.total}</span>}
          {bar ?? <span className="ep-bar none" />}
          {shared && <span>{shared}</span>}
        </span>
      )}
    </>
  );
}

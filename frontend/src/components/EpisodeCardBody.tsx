// 에피소드 카드의 안쪽 그림 — FolderCardGrid 가 에피소드 화면(lib/episodeBoard 의 isEpisodeLevel)일 때 카드(.cut-card.ep-card) 안에 그린다.
//  고르기·마퀴·키·두 번 클릭(들어가기)·우클릭(폴더 창)은 격자의 것 그대로다 — 여기는 모양과, 카드 안의 두 가지 누름(컷 띠의 컷 · [열기])만 맡는다.
//  리스트 = 가로 한 줄(번호 · 표지 · 이름과 숫자 · 컷 띠) / 그리드 = 큰 표지 + 컷 띠 + 대표 진행 막대(Jay 2026-10-13, 시안 mock_project_top_*.png).
//  서버가 새 집계를 안 주면(옛 공유 서버) 그 표시만 빠진다 — 표지·이름·컷 수·건수는 그대로 보인다.
//  카드 안의 단추에는 data-ep-action 을 붙인다 — 격자가 그 누름을 카드 고르기·두 번 클릭으로 읽지 않게 하는 표식이다.
import { useT } from "../lib/i18n";
import { episodeNumber, repProgress, sharedAgo, stripOf, type Ago, type EpisodeLayout } from "../lib/episodeBoard";
import { mediaThumbUrl, thumbOf } from "../lib/media";
import type { FolderCard, FolderCardChild } from "../types";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folder: FolderCard;
  layout: EpisodeLayout;
  thumbSize: number; // 표지 썸네일 크기(격자가 카드 폭으로 정한다)
  fill: boolean; // 썸네일 꽉 채움 ↔ 비율 유지
  now: number; // '2시간 전' 의 기준 시각 — 격자가 한 번 재어 모든 카드에 같은 값을 준다
  // 카드 안 단추의 누름 — 누른 이벤트를 같이 넘긴다(격자가 '위에 뜬 메뉴를 닫는 누름'이었는지 본다).
  onEnter: (e: React.MouseEvent) => void; // 이 에피소드로 들어가기([열기] · '+N')
  onEnterCut: (cut: FolderCardChild, e: React.MouseEvent) => void; // 컷 띠의 컷 — 그 컷으로 바로
}

export function EpisodeCardBody({ folder, layout, thumbSize, fill, now, onEnter, onEnterCut }: Props) {
  const t = useT();
  const asset = folder.cover.assets?.[0];
  const isVideo = asset?.type === "video";
  const number = episodeNumber(folder.name);
  const strip = stripOf(folder, layout);
  const progress = repProgress(folder);
  const subfolders = folder.subfolders ?? 0;
  const line =
    (subfolders ? `${t("컷")} ${subfolders} · ` : "") + `${folder.count}${t("건")}` +
    (folder.video_count != null ? ` · ${t("영상")} ${folder.video_count}` : "");
  const agoText = (ago: Ago): string =>
    ago.unit === "now" ? t("방금") : ago.unit === "yesterday" ? t("어제")
      : `${ago.n}${t(ago.unit === "min" ? "분 전" : ago.unit === "hour" ? "시간 전" : "일 전")}`;
  const ago = sharedAgo(folder.last_shared_at, now);
  const shared = ago ? agoText(ago) + (folder.last_shared_by ? ` · ${folder.last_shared_by}` : "") : "";

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
  const bar = progress && (
    <span className="ep-bar" aria-hidden="true">
      <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
    </span>
  );

  if (layout === "list")
    return (
      <>
        <span className="ep-num" aria-hidden="true">{number}</span>
        <span className={"ep-poster" + (fill ? "" : " contain")}>{cover}</span>
        <span className="ep-info">
          <span className="ep-name">{folder.name}</span>
          {shared && <span className="ep-sub">{t("마지막 공유")} {shared}</span>}
          <span className="ep-line">{line}</span>
          {bar}
          {progress && <span className="ep-rep">{t("대표 정한 컷")} {progress.done} / {progress.total}</span>}
          <button type="button" data-ep-action tabIndex={-1} className="ep-enter" onClick={onEnter}>{t("열기")} ▸</button>
        </span>
        {tiles}
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

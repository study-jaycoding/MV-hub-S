// 공유 & 리뷰 탭의 폴더 묶음 보기 — 고른 폴더 바로 아래 폴더마다 카드 한 장(표지·이름·건수). 누르면 그 폴더의 창을 연다.
//  표지는 팀이 정한 대표, 없으면 가장 최근 것(그때는 카드 위에 '대표 미정'). 한 장짜리 카드와 구분되게 종이를 겹친 모양이다.
//  S 단추·작성자 표시는 넣지 않는다 — 이 카드는 생성물 한 장이 아니라 묶음이라, 누를 수 있는 것처럼 보이면 안 된다.
import { useT } from "../lib/i18n";
import { thumbOf } from "../lib/media";
import type { FolderCard } from "../types";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folders: FolderCard[];
  scale: number; // 라이브러리 격자와 같은 카드 크기 배율
  fill: boolean; // 썸네일 꽉 채움 ↔ 비율 유지
  onOpen: (folder: FolderCard) => void;
  outside: number; // 고른 폴더에 직접 든 수 — 어느 카드에도 들지 않아 맨 끝 칸으로 알린다
  onShowAll: () => void; // 그 칸을 누르면 한 장씩 보기로
}

export function FolderCardGrid({ folders, scale, fill, onOpen, outside, onShowAll }: Props) {
  const t = useT();
  const width = Math.round(180 * scale); // ThumbnailGrid 의 카드 최소 폭과 같은 식
  const thumbSize = width * (window.devicePixelRatio || 1) <= 256 ? 256 : 512;
  return (
    <div className="grid-wrap">
      {/* tabIndex — 폴더 창을 닫은 뒤 초점을 돌려받는 자리(App 의 초점 복원) */}
      <div
        className="cut-grid"
        tabIndex={-1}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` }}
      >
        {folders.map((folder) => {
          const asset = folder.cover.assets?.[0];
          const isVideo = asset?.type === "video";
          return (
            <button
              key={folder.path}
              type="button"
              className="cut-card"
              title={`${folder.path} · ${folder.count}${t("건")}`}
              onClick={() => onOpen(folder)}
            >
              <span className={"cut-face" + (fill ? "" : " contain")}>
                {/* 생성물 카드와 같은 그림 분기(깨진 뒤 새 대표로 바뀌면 다시 보이고, 포스터 없는 영상은 첫 프레임) */}
                <MediaThumbnail
                  thumb={thumbOf(folder.cover, thumbSize)}
                  isVideo={isVideo}
                  src={asset?.file_path}
                  alt=""
                  fallback={null}
                />
                {isVideo && <span className="play-badge">▶</span>}
                <span className="cut-tab">
                  <span>{folder.name}</span>
                  <b>{folder.count}</b>
                </span>
              </span>
              {!folder.rep && <span className="cut-pill">{t("대표 미정")}</span>}
            </button>
          );
        })}
        {outside > 0 && (
          <button
            type="button"
            className="cut-card cut-out"
            title={t("이 폴더에 직접 든 생성물은 컷 카드에 들지 않습니다 — 누르면 한 장씩 모두 봅니다")}
            onClick={onShowAll}
          >
            <span className="cut-out-count">{t("컷 밖")} {outside}{t("건")}</span>
            <span className="cut-out-hint">{t("한 장씩 보기")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

import type { RefObject } from "react";
import type { Generation } from "../../types";

type Mention = { kind: "@" | "#"; query: string };

// @ 피커에 얹는 '트레이 항목' — 고르면 token(@image1 등) 텍스트가 프롬프트에 들어간다.
export interface TrayMentionItem {
  index: number; // 원본 트레이 인덱스(선택 시 사용)
  token: string; // @image1 / @video1 / @audio1
  type: string; // image | video | audio
  name: string; // 소스명(부가 표시)
  media: string; // 썸네일 URL(이미지) 또는 비디오 파일 URL. 없으면 아이콘 폴백.
}

interface Props {
  mention: Mention;
  tagList: string[];
  tagCounts: Map<string, number>;
  sourceList: Generation[];
  activeIndex: number;
  listRef: RefObject<HTMLDivElement>;
  assetProject: string | null;
  tagFilter: string | null;
  onHoverIndex: (index: number) => void;
  onSelectTag: (tag: string) => void;
  onSelectSource: (source: Generation) => void;
  trayList: TrayMentionItem[]; // 트레이 항목(seedance) — 소스보다 앞에 표시
  onSelectTrayRef: (index: number) => void;
}

export function SpotlightMentionPicker({
  mention,
  tagList,
  tagCounts,
  sourceList,
  activeIndex,
  listRef,
  assetProject,
  tagFilter,
  onHoverIndex,
  onSelectTag,
  onSelectSource,
  trayList,
  onSelectTrayRef,
}: Props) {
  return (
    <div className="sl-mention">
      <div className="sl-mention-head">
        {mention.kind === "@"
          ? trayList.length
            ? "레퍼런스 (@image1 · @이름)"
            : "소스 (@이름)"
          : "태그 (#)"}
        <span className="sl-mention-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</span>
      </div>
      <div className="sl-mention-list" ref={listRef}>
        {mention.kind === "#" ? (
          tagList.length === 0 ? (
            <div className="sl-mention-empty">
              {assetProject ? "태그가 없습니다" : "에셋 창을 열어 프로젝트를 선택하세요"}
            </div>
          ) : (
            tagList.map((tag, index) => (
              <button
                key={tag}
                className={"sl-mention-item sl-tag-item" + (index === activeIndex ? " on" : "")}
                onMouseEnter={() => onHoverIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectTag(tag);
                }}
              >
                <span className="sl-tag-hash">#</span>
                <span className="sl-mention-name">{tag}</span>
                <span className="sl-tag-count">{tagCounts.get(tag)}</span>
              </button>
            ))
          )
        ) : trayList.length + sourceList.length === 0 ? (
          <div className="sl-mention-empty">
            {assetProject
              ? tagFilter
                ? `'#${tagFilter}' 소스가 없습니다`
                : "소스가 없습니다 (에셋/그리드에서 S 등록 · 또는 트레이에 드래그)"
              : "에셋 창을 열어 프로젝트를 선택하세요"}
          </div>
        ) : (
          <>
            {/* 트레이 항목(앞) — 고르면 @image1 텍스트 토큰 삽입. 통합 인덱스 = 목록 내 위치 i. */}
            {trayList.length > 0 && (
              <div className="sl-mention-sub">트레이 항목 (@image1 …)</div>
            )}
            {trayList.map((item, i) => (
              <button
                key={"tray-" + item.index}
                className={"sl-mention-item" + (i === activeIndex ? " on" : "")}
                onMouseEnter={() => onHoverIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectTrayRef(item.index);
                }}
              >
                {item.media && item.type === "video" ? (
                  <video src={item.media} muted autoPlay loop playsInline preload="auto" />
                ) : item.media ? (
                  <img src={item.media} alt="" />
                ) : (
                  <span className="sl-mention-ph">{item.type === "audio" ? "🎵" : "🖼"}</span>
                )}
                <span className="sl-mention-name">{item.token}</span>
                <span className="sl-mention-tags">{item.name}</span>
              </button>
            ))}
            {/* 소스(뒤) — 시각적 칩으로 삽입. 통합 인덱스 = trayList.length + index. */}
            {sourceList.length > 0 && trayList.length > 0 && (
              <div className="sl-mention-sub">소스 (@이름)</div>
            )}
            {sourceList.map((source, index) => {
              const combined = trayList.length + index;
              const asset = source.assets[0];
              const thumb = asset?.thumbnail_path || asset?.file_path;
              return (
                <button
                  key={source.id}
                  className={"sl-mention-item" + (combined === activeIndex ? " on" : "")}
                  onMouseEnter={() => onHoverIndex(combined)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectSource(source);
                  }}
                >
                  {thumb ? <img src={thumb} alt="" /> : <span className="sl-mention-ph" />}
                  <span className="sl-mention-name">@{source.source_name || "source"}</span>
                  <span className="sl-mention-tags">
                    {source.tags.map((tag) => (
                      <span key={tag} className="sl-mention-tag">
                        #{tag}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

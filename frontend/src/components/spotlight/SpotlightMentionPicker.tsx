import type { RefObject } from "react";
import type { Generation } from "../../types";

type Mention = { kind: "@" | "#"; query: string };

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
}: Props) {
  return (
    <div className="sl-mention">
      <div className="sl-mention-head">
        {mention.kind === "@" ? "소스 (@이름)" : "태그 (#)"}
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
        ) : sourceList.length === 0 ? (
          <div className="sl-mention-empty">
            {assetProject
              ? tagFilter
                ? `'#${tagFilter}' 소스가 없습니다`
                : "소스가 없습니다 (에셋/그리드에서 S 등록)"
              : "에셋 창을 열어 프로젝트를 선택하세요"}
          </div>
        ) : (
          sourceList.map((source, index) => {
            const asset = source.assets[0];
            const thumb = asset?.thumbnail_path || asset?.file_path;
            return (
              <button
                key={source.id}
                className={"sl-mention-item" + (index === activeIndex ? " on" : "")}
                onMouseEnter={() => onHoverIndex(index)}
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
          })
        )}
      </div>
    </div>
  );
}

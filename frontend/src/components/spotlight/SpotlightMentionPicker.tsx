import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { displayThumb, hideBrokenImg, showLoadedImg } from "../../lib/media";
import type { Generation } from "../../types";

type Mention = { kind: "@" | "#"; query: string };
const MENTION_TOP_GAP = 8; // 화면 위 끝과 피커 사이
const MENTION_MAX_LIST = 760; // 자리가 넉넉하면 15개쯤(항목 ≈ 50px) — prompt-dock.css 의 상한과 같다

// @ 피커에 얹는 '트레이 항목' — 고르면 token(@image1 등) 텍스트가 프롬프트에 들어간다.
export interface TrayMentionItem {
  index: number; // 원본 트레이 인덱스(선택 시 사용)
  token: string; // @image1 / @video1 / @audio1
  type: string; // image | video | audio
  name: string; // 소스명(부가 표시)
  media: string; // 이미지/비디오 모두 표시용 정지 썸네일 URL. 없으면 아이콘 폴백.
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
  // 목록의 높이는 **패널 위에 실제로 남은 자리**까지만이다 — 피커는 패널 위로 뜨는데(CSS bottom: 100%), CSS 의 상한(화면 높이 − 150px)은 패널이
  //  낮을 때만 맞는다. 레퍼런스 트레이를 펼치면 패널이 230px 넘게 커져, 낮은 창(높이 600 안팎)에서는 피커의 윗부분이 화면 밖으로 나가 첫
  //  항목들을 볼 수도 누를 수도 없었다(조작 규칙 50). 그릴 때마다(패널 높이는 글을 치면 달라진다)와 창 크기가 바뀔 때 잰다.
  const boxRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(() => {});
  fitRef.current = () => {
    const box = boxRef.current;
    const list = listRef.current;
    if (!box || !list) return;
    const around = box.offsetHeight - list.offsetHeight; // 머리글·테두리
    const room = box.getBoundingClientRect().bottom - MENTION_TOP_GAP - around; // 피커의 아래 끝은 패널에 묶여 있다 — 그 위로 쓸 수 있는 높이
    // 남은 자리보다 크게 잡지 않는다 — 최소 높이를 두면 아주 낮은 창에서는 그만큼 다시 화면 밖으로 나간다(Codex 코드 리뷰). 자리가 한 줄뿐이면
    //  한 줄만 보이고 안에서 스크롤한다.
    list.style.maxHeight = `${Math.max(0, Math.min(MENTION_MAX_LIST, Math.floor(room)))}px`;
  };
  useLayoutEffect(() => { fitRef.current(); });
  useEffect(() => {
    const onResize = () => fitRef.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return (
    <div className="sl-mention" ref={boxRef}>
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
                {item.media ? (
                  <img src={displayThumb(item.media) || undefined} alt="" onError={hideBrokenImg} onLoad={showLoadedImg} />
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
                  {thumb ? (
                    <img src={displayThumb(thumb) || undefined} alt="" onError={hideBrokenImg} onLoad={showLoadedImg} />
                  ) : (
                    <span className="sl-mention-ph" />
                  )}
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

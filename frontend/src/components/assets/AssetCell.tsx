// Assets 그리드/리스트의 단일 셀(메모이제이션) — 미디어 썸네일 + 호버 오버레이 + S·T·C 상태줄.
// 핸들러는 path 인자를 받는 안정 참조로만 받아 React.memo 가 변화 없는 셀을 건너뛴다.
import { memo, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { downloadOne } from "../../lib/download";
import { TagEditor } from "../TagEditor";
import type { AssetMeta, AssetNode, InfoTarget } from "../../types";

export const AssetCell = memo(function AssetCell({
  project,
  node,
  idx,
  layout,
  scale,
  fit,
  selected,
  focused,
  deactivated,
  selectedCount,
  meta,
  editingTag,
  tagEditing,
  onS,
  onT,
  onC,
  onTagsReplace,
  onBulkTagAdd,
  onBulkTagRemove,
  onTagCancel,
  onInfo,
  onExportDrag,
}: {
  project: string;
  node: AssetNode;
  idx: number;
  layout: "grid" | "list";
  scale: number;
  fit: "cover" | "contain";
  selected: boolean;
  focused: boolean;
  deactivated?: boolean; // 비활성(회색) 표시 — d 키. 색만 회색, 크기 유지(히스토리와 달리 축소 안 함)
  selectedCount?: number; // 이 카드가 다중선택에 포함될 때 N(에디터에 '선택 N개에 적용' 표시)
  meta: AssetMeta;
  editingTag: boolean;
  tagEditing?: boolean; // 다중선택 태그 편집 활성 — 선택된 비포커스 카드에 읽기전용 스트립 표시
  onS: (path: string) => void;
  onT: (path: string) => void; // 태그 인라인 편집 시작(생성카드 T 버튼과 동일 · 키보드 #와 같은 경로)
  onC: (path: string) => void;
  onTagsReplace: (path: string, tags: string[]) => void; // 이 카드의 태그를 정확히 이 집합으로 교체
  onBulkTagAdd: (path: string, names: string[]) => void; // 다중선택 시 추가를 선택 전체에 적용
  onBulkTagRemove: (path: string, names: string[]) => void; // 다중선택 시 ×해제를 선택 전체에(공통 삭제)
  onTagCancel: () => void;
  onInfo: (t: InfoTarget) => void;
  // 네이티브 파일 드래그 시작 → 부모가 선택 상태를 보고 단일/다중(zip) DownloadURL 설정 + 마퀴 취소
  onExportDrag: (path: string, dt: DataTransfer) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const url = api.assetFileUrl(project, node.path);
  const isVideo = node.type === "video";
  const isAudio = node.type === "audio";
  const isList = layout === "list";
  // 이미지는 리사이즈 썸네일로(풀해상도 디코딩 렉 방지). 영상/오디오는 원본 사용.
  const imgSrc = node.type === "image" ? api.assetThumbUrl(project, node.path, 512) : url;
  // 영상 포스터 — ffmpeg 첫 프레임(서버 캐시). 내 작업 라이브러리처럼 poster 로 깔면 preload=none 이라
  // 원본 로딩 없이 선명한 썸네일이 뜬다(포스터 실패 시 poster 만 비고 재생은 정상).
  const posterSrc = isVideo ? api.assetThumbUrl(project, node.path, 512) : undefined;
  // 영상 poster 는 <img loading="lazy"> 혜택이 없어 폴더 전환 즉시 전부 요청된다(썸네일 폭주).
  // → 뷰포트에 들어올 때만 poster 를 붙여 초기 요청을 줄인다(이미지는 이미 lazy 라 대상 아님).
  const [nearView, setNearView] = useState(false);
  useEffect(() => {
    if (!isVideo || nearView) return; // 영상만·한 번 보이면 관찰 종료
    const el = cellRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNearView(true); // 미지원 환경은 그냥 즉시 로드(기능 저하 방지)
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNearView(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" }, // 화면 300px 전부터 미리 로드(스크롤 시 pop-in 완화)
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isVideo, nearView]);

  // list: 행 높이를 슬라이더로 고정(메인 라이브러리식) → 썸네일이 행 높이를 꽉 채우는 정사각.
  // grid: padding-bottom 트릭으로 정사각.
  const rowH = Math.round(200 * scale); // 리스트 행 높이(=썸네일 한 변)
  const cellStyle: React.CSSProperties | undefined = isList ? { height: rowH } : undefined;
  const mediaStyle: React.CSSProperties = isList
    ? { width: rowH, height: "100%" } // 셀 높이(rowH)를 꽉 채우는 정사각
    : { position: "relative", width: "100%", height: 0, paddingBottom: "100%", boxSizing: "content-box" };
  const fillStyle: React.CSSProperties = isList
    ? { width: "100%", height: "100%", objectFit: fit }
    : { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: fit };

  const onEnter = () => {
    if (videoRef.current) videoRef.current.muted = true; // 영상 호버는 무음(React muted 반영 버그 방어). 오디오는 그대로
    (videoRef.current || audioRef.current)?.play().catch(() => {});
  };
  const onLeave = () => {
    const m = videoRef.current || audioRef.current;
    if (m) {
      m.pause();
      m.currentTime = 0;
    }
  };
  const info = (x: number, y: number) =>
    onInfo({ kind: "file", project, node, meta, x, y });

  // OS·외부 앱으로 카드를 끌어다 놓으면 파일이 그 위치에 그대로 저장됨(브라우저 네이티브 다운로드 드래그).
  // 단일/다중(zip) 판단은 현재 선택을 아는 부모가 처리. 이미지 표시는 썸네일이지만 내보내는 건 항상 원본.
  const onMediaDragStart = (e: React.DragEvent) => {
    // OS·외부 앱 내보내기(DownloadURL) + 본창 트레이용 커스텀 타입(application/x-ch-asset)을
    // 부모 exportDrag 가 함께 심는다 — 다중선택이면 선택 전체를 한 번에 싣기 위해(선택 상태를 가진
    // 부모가 처리). 셀은 시작만 위임.
    onExportDrag(node.path, e.dataTransfer);
  };

  // 좌상단 액션 — S(소스)·T(태그)·C(코멘트). 생성파트와 동일 위치/스타일(card-tl/card-sf/card-cm).
  //  · 기능은 어셋 고유: S=소스 등록/해제(meta.is_source), T=태그 인라인 편집(#), C=어셋 코멘트(meta.has_unread). 골드/최종 개념 없음.
  //  · 평소 숨김(호버 시 표시), S 는 소스이면·T 는 태그 있으면·C 는 미확인 코멘트면 항상 표시.
  const topLeft = (
    <div className="card-tl">
      <button
        className={"card-sf" + (meta.is_source ? " on" : "")}
        title={meta.is_source ? `소스: @${meta.source_name || ""} · 클릭=해제` : "소스로 등록 (s)"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onS(node.path);
        }}
      >
        S
      </button>
      <button
        className={"card-cm" + (meta.tags.length ? " on" : "")}
        title={
          meta.tags.length
            ? `태그: ${meta.tags.join(", ")} · 클릭=태그 편집 (#)`
            : "태그 입력 (#)"
        }
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onT(node.path);
        }}
      >
        T
      </button>
      <button
        className={"card-cm" + (meta.has_unread ? " alert" : "")}
        title={
          meta.comment_count
            ? `코멘트 ${meta.comment_count}개${meta.has_unread ? " · 미확인" : ""}`
            : "코멘트 (c)"
        }
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onC(node.path);
        }}
      >
        C
      </button>
    </div>
  );

  // 하단 영역: 태그 인라인 편집(키보드 #) 중에는 입력, 그 외엔 컬러바(생성파트와 동일 크기). 색 없으면 없음.
  const statusBar = editingTag ? (
    <div
      className="card-status"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <TagEditor
        tags={meta.tags}
        onChange={(next) => onTagsReplace(node.path, next)}
        onBulkAdd={(names) => onBulkTagAdd(node.path, names)}
        onBulkRemove={(names) => onBulkTagRemove(node.path, names)}
        selectedCount={selectedCount}
        onClose={onTagCancel}
      />
    </div>
  ) : tagEditing && selected ? (
    <div
      className="card-status"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <TagEditor
        tags={meta.tags}
        onChange={(next) => onTagsReplace(node.path, next)}
        selectedCount={selectedCount}
        showInput={false}
      />
    </div>
  ) : !isList && meta.color ? (
    <div className="card-colorbar" style={{ background: meta.color }} title="컬러 마커" />
  ) : null;

  // 선택/마퀴/키보드는 그리드 컨테이너에서 위임 처리(data-idx 로 식별).
  return (
    <div
      ref={cellRef}
      className={
        "asset-cell" +
        (isList ? " list" : "") +
        (selected ? " selected" : "") +
        (focused ? " focused" : "") +
        (deactivated ? " deactivated" : "")
      }
      style={cellStyle}
      data-idx={idx}
    >
      <div
        className="asset-media"
        style={mediaStyle}
        title={node.name}
        draggable
        onDragStart={onMediaDragStart}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {isVideo ? (
          <video ref={videoRef} src={url} poster={nearView ? posterSrc : undefined} muted loop playsInline preload="none" draggable={false} style={fillStyle} />
        ) : isAudio ? (
          <div className="audio-tile" style={fillStyle}>
            <span className="audio-glyph">🎵</span>
            <audio ref={audioRef} src={url} loop preload="none" />
          </div>
        ) : (
          <img
            src={imgSrc}
            loading="lazy"
            decoding="async"
            draggable={false}
            alt={node.name}
            style={fillStyle}
          />
        )}
        {isVideo && <span className="play-badge">▶</span>}
        {isAudio && <span className="play-badge">♪</span>}
        {topLeft}

        <div
          className="thumb-overlay"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="ov-top">
            <button className="ov-icon" title="정보" onClick={(e) => info(e.clientX, e.clientY)}>
              ⓘ
            </button>
          </div>
          <div className="ov-bottom">
            {!isList && <span className="ov-name">{node.name}</span>}
            <button
              className="ov-icon"
              title="원본 위치 열기 (탐색기)"
              onClick={(e) => {
                e.stopPropagation();
                api
                  .revealAsset(project, node.path)
                  .catch((err) => alert(`원본 위치 열기 실패: ${err}`));
              }}
            >
              📂
            </button>
            <button className="ov-icon" title="다운로드" onClick={() => downloadOne(url, node.name)}>
              ⤓
            </button>
          </div>
        </div>
      </div>

      {isList && meta.color && (
        <div className="list-color-bar" style={{ background: meta.color }} />
      )}
      {isList ? (
        <div className="card-detail">
          <div className="cd-model">
            <span className="cd-type-ic">{isVideo ? "🎬" : isAudio ? "🎵" : "🖼"}</span>
            {node.name}
          </div>
          <button
            className="info-path-btn cd-path"
            title="원본 위치 열기 (탐색기)"
            onClick={(e) => {
              e.stopPropagation();
              api.revealAsset(project, node.path).catch((err) => alert(`원본 위치 열기 실패: ${err}`));
            }}
          >
            <span className="info-path">{node.path}</span>
            <span className="info-path-icon">↗</span>
          </button>
          <div className="cd-meta">
            <span className="cd-chip">{isVideo ? "영상" : isAudio ? "오디오" : "이미지"}</span>
            {meta.tags.length > 0 && <span className="cd-chip"># {meta.tags.join(", ")}</span>}
            {meta.is_source && <span className="cd-chip">@{meta.source_name || "소스"}</span>}
          </div>
          {statusBar}
        </div>
      ) : (
        statusBar
      )}
    </div>
  );
});

// 다운로드: 로컬 서빙 URL 은 download 속성, 외부 URL 은 새 탭.

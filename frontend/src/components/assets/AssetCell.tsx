// Assets 그리드/리스트의 단일 셀(메모이제이션) — 미디어 썸네일 + 호버 오버레이 + S·T·C 상태줄.
// 핸들러는 path 인자를 받는 안정 참조로만 받아 React.memo 가 변화 없는 셀을 건너뛴다.
import { memo, useRef } from "react";
import { api } from "../../api";
import { download } from "../../lib/download";
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
  meta,
  editingTag,
  onS,
  onC,
  onTagCommit,
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
  meta: AssetMeta;
  editingTag: boolean;
  onS: (path: string) => void;
  onC: (path: string) => void;
  onTagCommit: (path: string, tags: string[]) => void;
  onTagCancel: () => void;
  onInfo: (t: InfoTarget) => void;
  // 네이티브 파일 드래그 시작 → 부모가 선택 상태를 보고 단일/다중(zip) DownloadURL 설정 + 마퀴 취소
  onExportDrag: (path: string, dt: DataTransfer) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const url = api.assetFileUrl(project, node.path);
  const isVideo = node.type === "video";
  const isAudio = node.type === "audio";
  const isList = layout === "list";
  // 이미지는 리사이즈 썸네일로(풀해상도 디코딩 렉 방지). 영상/오디오는 원본 사용.
  const imgSrc = node.type === "image" ? api.assetThumbUrl(project, node.path, 512) : url;

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
    onExportDrag(node.path, e.dataTransfer); // OS·외부 앱 내보내기(DownloadURL) 유지
    // 본창 프롬프트의 레퍼런스 트레이로 드래그(같은 오리진 팝업↔본창)에서 읽을 커스텀 타입.
    // 트레이는 이 타입만 받아 asset:proj|path 레퍼런스로 추가한다(생성 --image 입력).
    e.dataTransfer.setData(
      "application/x-ch-asset",
      JSON.stringify({ project, path: node.path, name: node.name, type: node.type }),
    );
  };

  // 좌상단 액션 — S(소스)·C(코멘트). 생성파트와 동일 위치/스타일(card-tl/card-sf/card-cm).
  //  · 기능은 어셋 고유: S=소스 등록/해제(meta.is_source), C=어셋 코멘트(meta.has_unread). 골드/최종 개념 없음.
  //  · 평소 숨김(호버 시 표시), S 는 소스이면·C 는 미확인 코멘트면 항상 표시.
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
      <input
        className="cs-tag-input"
        autoFocus
        placeholder="태그 입력(쉼표) ⏎"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            const add = (e.target as HTMLInputElement).value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onTagCommit(node.path, add);
          } else if (e.key === "Escape") {
            onTagCancel();
          }
        }}
        onBlur={onTagCancel}
      />
    </div>
  ) : !isList && meta.color ? (
    <div className="card-colorbar" style={{ background: meta.color }} title="컬러 마커" />
  ) : null;

  // 선택/마퀴/키보드는 그리드 컨테이너에서 위임 처리(data-idx 로 식별).
  return (
    <div
      className={
        "asset-cell" +
        (isList ? " list" : "") +
        (selected ? " selected" : "") +
        (focused ? " focused" : "")
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
          <video ref={videoRef} src={url} muted loop playsInline preload="metadata" draggable={false} style={fillStyle} />
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
            <button className="ov-icon" title="다운로드" onClick={() => download(url, node.name)}>
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

import { memo } from "react";
import { APP_EVENTS, dispatchAppEvent } from "../../lib/appEvents";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { downloadName, downloadOne } from "../../lib/download";
import { thumbOf } from "../../lib/media";
import type { Generation, InfoTarget, PreviewTarget } from "../../types";
import { MediaThumbnail } from "../MediaThumbnail";

type SConfirm = { id: string; kind: "share" | "final" } | null;

interface Props {
  generation: Generation;
  x: number;
  y: number;
  width: number;
  height: number;
  isRoot: boolean;
  isSelected: boolean;
  onLine: boolean;
  offLine: boolean;
  fill: boolean;
  disabled: boolean;
  typeFilter: "all" | "image" | "video" | "audio";
  colorFilter?: Set<string>;
  tagFilter?: Set<string>;
  sharedOnly: boolean;
  commentOnly: boolean;
  finalOnly: boolean;
  sConfirm: SConfirm;
  onSClick: (generation: Generation) => void;
  onSDouble: (generation: Generation) => void;
  onSConfirmYes: (generation: Generation) => void;
  onSConfirmNo: () => void;
  onPreview: (target: PreviewTarget) => void;
  onInfo: (target: InfoTarget) => void;
  onRegenerate: (generation: Generation) => void;
  onTag?: (generation: Generation) => void; // T → 태그 편집(있을 때만 버튼 표시)
  onOpenComments?: (generation: Generation) => void; // C → 코멘트 스레드(있을 때만 버튼 표시)
}

export const HistoryBoardNode = memo(function HistoryBoardNode({
  generation,
  x,
  y,
  width,
  height,
  isRoot,
  isSelected,
  onLine,
  offLine,
  fill,
  disabled,
  typeFilter,
  colorFilter,
  tagFilter,
  sharedOnly,
  commentOnly,
  finalOnly,
  sConfirm,
  onSClick,
  onSDouble,
  onSConfirmYes,
  onSConfirmNo,
  onPreview,
  onInfo,
  onRegenerate,
  onTag,
  onOpenComments,
}: Props) {
  const asset = generation.assets[0];
  const thumb = thumbOf(generation);
  const dimmed =
    (typeFilter !== "all" && asset?.type !== typeFilter) ||
    (!!colorFilter && colorFilter.size > 0 && !(generation.color && colorFilter.has(generation.color))) ||
    (!!tagFilter && tagFilter.size > 0 && !generation.tags.some((tag) => tagFilter.has(tag))) ||
    (sharedOnly && !generation.shared) ||
    (commentOnly && generation.comment_count === 0) ||
    (finalOnly && !generation.is_final);

  return (
    <div
      data-id={generation.id}
      className={
        "linb-node" +
        (isRoot ? " root" : "") +
        (onLine && !isSelected && !isRoot ? " mainline" : "") +
        (isSelected ? " sel" : "") +
        (generation.is_final ? " final" : "") +
        (generation.color || generation.is_final ? " has-cbar" : "") +
        (disabled ? " disabled" : "") +
        (!generation.shared && !generation.is_mine ? " unshared" : "") +
        (offLine ? " offline" : "") +
        (fill ? "" : " fit-contain") +
        (dimmed ? " dimmed" : "")
      }
      style={{ left: x, top: y, width, height }}
      title={`${generation.prompt.slice(0, 80)}\n클릭=선택 · 드래그=위치 이동(다중선택 시 함께) · 배경 드래그=복수 선택 · 더블클릭=미리보기 · 휠클릭=정보 · d=비활성 · l=자동 정렬`}
      onMouseEnter={(e) => {
        const video = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
        if (video) {
          video.muted = true; // React <video muted> 반영 버그 → 재생 직전 무음 강제(썸네일 호버 무음)
          video.play().catch(() => {});
        }
      }}
      onMouseLeave={(e) => {
        const video = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
        if (video) {
          video.pause();
          video.currentTime = 0;
        }
      }}
      onDoubleClick={() =>
        asset &&
        onPreview({
          url: asset.file_path,
          type: asset.type,
          name: generation.prompt.slice(0, 50),
          genId: generation.id,
        })
      }
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onInfo({ kind: "generation", gen: generation, x: e.clientX, y: e.clientY });
        }
      }}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      <MediaThumbnail
        thumb={thumb}
        isVideo={asset?.type === "video"}
        src={asset?.file_path}
        fallback={<span className={"linb-ph status-" + generation.status}>{generation.status}</span>}
      />
      {asset?.type === "video" && <span className="linb-vid">▶</span>}
      {isRoot && <span className="linb-tag root-tag">원본</span>}
      {(generation.shared || generation.is_final) && (
        <span
          className={"linb-sf" + (generation.is_final ? " final" : " shared")}
          title={generation.is_final ? "최종(골드)" : "팀 공유됨"}
        >
          {generation.is_final ? "★" : "S"}
        </span>
      )}
      {(generation.color || generation.is_final) && (
        <span
          className={"linb-colorbar" + (generation.is_final ? " final" : "")}
          style={generation.is_final ? undefined : { background: generation.color || undefined }}
        />
      )}

      <div className="linb-ov" onMouseDown={(e) => e.stopPropagation()}>
        <div className="linb-ov-top">
          {generation.status === "done" && (
            <button
              className={
                "linb-ov-btn" +
                (generation.shared ? " on" : "") +
                (generation.is_final ? " final" : "")
              }
              title={
                generation.is_final
                  ? "최종(골드) · 더블클릭=최종 해제"
                  : generation.shared
                    ? "팀 공유됨 · 클릭=공유 해제 · 더블클릭=최종 지정"
                    : "팀에 공유 (클릭) · 공유 후 더블클릭=최종 지정"
              }
              onClick={(e) => {
                e.stopPropagation();
                onSClick(generation);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onSDouble(generation);
              }}
            >
              {generation.is_final ? "★" : "S"}
            </button>
          )}
          {onTag && (
            <button
              className={"linb-ov-btn" + (generation.tags.length ? " on" : "")}
              title={
                generation.tags.length
                  ? `태그: ${generation.tags.join(", ")} · 클릭=편집`
                  : "태그 편집"
              }
              onClick={(e) => {
                e.stopPropagation();
                onTag(generation);
              }}
            >
              T
            </button>
          )}
          {onOpenComments && (
            <button
              className={"linb-ov-btn" + (generation.has_unread ? " alert" : "")}
              title={
                generation.has_unread
                  ? `새 코멘트 · 총 ${generation.comment_count}개`
                  : generation.comment_count
                    ? `코멘트 ${generation.comment_count}개`
                    : "코멘트 스레드 열기"
              }
              onClick={(e) => {
                e.stopPropagation();
                onOpenComments(generation);
              }}
            >
              C
            </button>
          )}
          <button
            className="linb-ov-btn"
            style={{ marginLeft: "auto" }}
            title="정보"
            onClick={(e) => onInfo({ kind: "generation", gen: generation, x: e.clientX, y: e.clientY })}
          >
            ⓘ
          </button>
        </div>
        <span
          className="linb-ov-btn linb-ov-drag linb-ov-grip"
          draggable
          title="클릭 또는 끌어내려 프롬프트 재사용(프롬프트·옵션 불러오기)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            dispatchAppEvent(APP_EVENTS.reusePrompt, generation.id); // 클릭만으로도 재사용
          }}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPES.generation, generation.id);
            e.dataTransfer.effectAllowed = "copy";
          }}
        >
          ⠿
        </span>
        <div className="linb-ov-bot">
          {asset && (
            <button
              className="linb-ov-btn"
              title="다운로드"
              onClick={() => downloadOne(asset.file_path, downloadName(generation, asset.type))}
            >
              ⤓
            </button>
          )}
          <button
            className="linb-ov-btn"
            title="레퍼런스로 사용 — 이 생성물을 @레퍼런스로 추가 (끌어내리면 프롬프트 재사용)"
            onClick={(e) => {
              e.stopPropagation();
              dispatchAppEvent(APP_EVENTS.addReference, generation.id);
            }}
          >
            @
          </button>
          <button
            className="linb-ov-btn"
            title="재생성 — 이 결과물에서 파생본 만들기"
            onClick={() => onRegenerate(generation)}
          >
            ↻
          </button>
        </div>
      </div>
      {sConfirm?.id === generation.id && (
        <div
          className="sconfirm"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="cs-final-q">
            {sConfirm.kind === "final"
              ? generation.is_final
                ? "최종 지정을 해제할까요?"
                : "최종(골드)으로 지정할까요?"
              : generation.shared
                ? "공유 해제 할까요?"
                : "공유 하시겠습니까?"}
          </span>
          <div className="cs-final-actions">
            <button className="cs-final-yes" onClick={() => onSConfirmYes(generation)}>
              Yes
            </button>
            <button className="cs-final-no" onClick={onSConfirmNo}>
              No
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

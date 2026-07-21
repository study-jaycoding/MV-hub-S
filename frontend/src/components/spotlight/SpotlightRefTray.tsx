import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { displayThumb, hideBrokenImg } from "../../lib/media";
import { refSrc } from "../../lib/promptParts";
import type { ChipRef } from "../../lib/promptEditor";
import type { PreviewTarget } from "../../types";
import {
  seedanceHasTokenRoles,
  seedanceTrayBadge,
  seedanceTrayBadgeTitle,
  seedanceTrayRole,
  seedanceTrayTypeIndex,
  usesMediaRefTokens,
  usesSeedanceMediaRefs,
  type SeedanceTokenRoles,
} from "../../lib/seedancePrompt";

export type SpotlightTrayRef = ChipRef & { uid: string };

interface Props {
  trayRefs: SpotlightTrayRef[];
  model: string;
  liveSeedanceRoles: SeedanceTokenRoles;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onItemDragStart: (index: number) => (event: DragEvent<HTMLElement>) => void;
  onItemDrop: (index: number) => (event: DragEvent<HTMLElement>) => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  onPreview?: (target: PreviewTarget) => void; // 항목 더블클릭 → 원본 크게 보기
}

export function SpotlightRefTray({
  trayRefs,
  model,
  liveSeedanceRoles,
  onDragOver,
  onDrop,
  onKeyDown,
  onItemDragStart,
  onItemDrop,
  onRemove,
  onClearAll,
  onPreview,
}: Props) {
  return (
    <div
      className="sl-reftray"
      tabIndex={0}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={onKeyDown}
      onMouseDown={(e: MouseEvent<HTMLDivElement>) => {
        if (!(e.target as HTMLElement).closest("button")) e.currentTarget.focus();
      }}
    >
      {trayRefs.length === 0 ? (
        <div className="sl-reftray-empty">
          에셋 창 또는 탐색기에서 파일을 여기로 드래그하세요 - 번호 순서대로 레퍼런스가 됩니다
        </div>
      ) : (
        <>
        {trayRefs.map((ref, index) => {
          // 타입 순번(@image1, @video1 …)은 레퍼런스 토큰 쓰는 모든 모델에서 보인다(이미지 모델 포함).
          const tokenVisible = usesMediaRefTokens(model) || seedanceHasTokenRoles(liveSeedanceRoles);
          const badgeRole = seedanceTrayRole(trayRefs, index, liveSeedanceRoles);
          const badgeTitle = seedanceTrayBadgeTitle(badgeRole);
          // 역할 배지(시작/끝/옴니 = S/E/O)는 seedance 전용 개념 → seedance 모델에서만(이미지 모델엔 안 뜸).
          const showRoleBadge = usesSeedanceMediaRefs(model);
          // 보이는 번호 = 프롬프트에 쓰는 번호(@image2, @video1 …).
          const displayIndex = tokenVisible ? seedanceTrayTypeIndex(trayRefs, index) : index + 1;
          return (
            <div
              key={ref.uid}
              className="sl-reftray-item"
              draggable
              onDragStart={onItemDragStart(index)}
              onDragOver={onDragOver}
              onDrop={onItemDrop(index)}
              onDoubleClick={() =>
                onPreview?.({
                  url: refSrc(ref.file_path) || ref.thumb,
                  type: ref.type,
                  name: ref.name,
                })
              }
              title={`${displayIndex}. ${ref.name} · ${badgeTitle} · 더블클릭=크게 보기`}
            >
              <span className="sl-reftray-num">{displayIndex}</span>
              {ref.type === "video" ? (
                <video
                  // React <video muted> 는 DOM 프로퍼티로 안 붙는 알려진 버그 → 소리가 새어나온다.
                  // 재생 직전 명령형으로 muted 를 강제하고 play() 한다(autoPlay 속성 대신).
                  ref={(el) => {
                    if (!el) return;
                    el.muted = true;
                    el.play().catch(() => {});
                  }}
                  src={refSrc(ref.file_path)}
                  muted
                  loop
                  preload="auto"
                  playsInline
                  draggable={false}
                />
              ) : (ref.type as string) === "audio" ? (
                <span className="sl-reftray-ph">A</span>
              ) : ref.thumb ? (
                // draggable=false: 썸네일 자체가 네이티브 이미지 드래그가 되면 크롬이 합성 파일을
                // 만들어 순서변경이 '외부 파일 추가'로 처리된다. 드래그 주체는 항상 바깥 항목 div.
                <img
                  src={displayThumb(ref.thumb) || undefined}
                  alt=""
                  draggable={false}
                  onError={hideBrokenImg}
                />
              ) : (
                <span className="sl-reftray-ph" />
              )}
              {showRoleBadge && (
                <span className={`sl-reftray-role ${badgeRole}`} title={badgeTitle}>
                  {seedanceTrayBadge(badgeRole)}
                </span>
              )}
              <span className="sl-reftray-name">{ref.name}</span>
              <button
                className="sl-reftray-x"
                title="제거"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRemove(index)}
              >
                ×
              </button>
            </div>
          );
        })}
        {/* 레퍼런스 전체 비우기 — 생성 후에도 트레이는 남으므로(연속 변형용) 한 번에 초기화 */}
        <button
          className="sl-reftray-clear"
          title="레퍼런스 전체 비우기"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClearAll}
        >
          <span className="sl-reftray-clear-ic" aria-hidden>⌫</span>
        </button>
        </>
      )}
    </div>
  );
}

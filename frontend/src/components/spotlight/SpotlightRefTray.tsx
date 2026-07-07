import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { refSrc } from "../../lib/promptParts";
import type { ChipRef } from "../../lib/promptEditor";
import {
  seedanceTrayBadge,
  seedanceTrayBadgeTitle,
  seedanceTrayRole,
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
          const badgeRole = seedanceTrayRole(ref, index, liveSeedanceRoles);
          const badgeTitle = seedanceTrayBadgeTitle(badgeRole);
          const showRoleBadge = usesSeedanceMediaRefs(model) || liveSeedanceRoles.size > 0;
          return (
            <div
              key={ref.uid}
              className="sl-reftray-item"
              draggable
              onDragStart={onItemDragStart(index)}
              onDragOver={onDragOver}
              onDrop={onItemDrop(index)}
              title={`${index + 1}. ${ref.name} · ${badgeTitle}`}
            >
              <span className="sl-reftray-num">{index + 1}</span>
              {ref.type === "video" ? (
                <video
                  src={refSrc(ref.file_path)}
                  muted
                  preload="metadata"
                  playsInline
                  draggable={false}
                />
              ) : ref.thumb ? (
                // draggable=false: 썸네일 자체가 네이티브 이미지 드래그가 되면 크롬이 합성 파일을
                // 만들어 순서변경이 '외부 파일 추가'로 처리된다. 드래그 주체는 항상 바깥 항목 div.
                <img src={ref.thumb} alt="" draggable={false} />
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

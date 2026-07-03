import { ProjectAssignMenu } from "../ProjectAssignMenu";
import { useT } from "../../lib/i18n";
import type { Generation, Project } from "../../types";

type AssignHandlers = {
  projects: Project[];
  onAssign: (projectId: string | null, folderPath?: string | null) => void;
  onCreateAndAssign: (name: string) => void;
};

export function BoardSelectionActionBar({
  selected,
  projects,
  onShare,
  onDownload,
  onCompare,
  onAssign,
  onCreateAndAssign,
  onDelete,
}: {
  selected: Generation[];
  onShare: (selected: Generation[]) => void;
  onDownload: (selected: Generation[]) => void;
  onCompare: (selected: Generation[]) => void;
  onDelete: (selected: Generation[]) => void;
} & AssignHandlers) {
  const t = useT();
  if (!selected.length) return null;

  return (
    <div className="select-bar">
      <span className="sb-count">
        {selected.length}
        {t("개 선택")}
      </span>
      <button onClick={() => onShare(selected)}>{t("↗ 팀에 공유")}</button>
      <button
        onClick={() => onDownload(selected)}
        title="선택한 결과물 일괄 다운로드(레퍼런스 이름으로 저장)"
      >
        ⤓ 다운로드
      </button>
      {selected.length >= 2 && (
        <button
          onClick={() => onCompare(selected)}
          title="선택한 결과물들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
        >
          ⊞ 비교
        </button>
      )}
      <ProjectAssignMenu
        count={selected.length}
        projects={projects}
        onAssign={onAssign}
        onCreateAndAssign={onCreateAndAssign}
      />
      <button className="sb-del" onClick={() => onDelete(selected)} title="휴지통으로 보내기">
        🗑 삭제
      </button>
    </div>
  );
}

export function LibrarySelectionActionBar({
  selectedCount,
  selectedGenerations,
  tab,
  projects,
  onPublish,
  onFinalize,
  onDownload,
  onCompare,
  onAssign,
  onCreateAndAssign,
  onDelete,
  onRestore,
  onPurge,
}: {
  selectedCount: number;
  selectedGenerations: Generation[];
  tab: string;
  onPublish: () => void;
  onFinalize: () => void;
  onDownload: (selected: Generation[]) => void;
  onCompare: (selected: Generation[]) => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
} & AssignHandlers) {
  const t = useT();
  const hasActive = selectedGenerations.some((generation) => !generation.deleted);
  const hasDeleted = selectedGenerations.some((generation) => generation.deleted);

  if (selectedCount <= 0) return null;

  return (
    <div className="select-bar">
      <span className="sb-count">
        {selectedCount}
        {t("개 선택")}
      </span>
      {tab === "my" && <button onClick={onPublish}>{t("↗ 팀에 공유")}</button>}
      {hasActive && (
        <button onClick={onFinalize} title="선택한 결과물을 최종(골드) 확정 — 팀 공유 겸함">
          ★ {t("최종 확정")}
        </button>
      )}
      <button
        onClick={() => onDownload(selectedGenerations)}
        title="선택한 결과물 일괄 다운로드(레퍼런스 이름으로 저장)"
      >
        ⤓ 다운로드
      </button>
      {selectedCount >= 2 && (
        <button
          onClick={() => onCompare(selectedGenerations)}
          title="선택한 버전들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
        >
          ⊞ 비교
        </button>
      )}
      <ProjectAssignMenu
        count={selectedCount}
        projects={projects}
        onAssign={onAssign}
        onCreateAndAssign={onCreateAndAssign}
      />
      {hasActive && (
        <button className="sb-del" onClick={onDelete} title="휴지통으로 보내기">
          🗑 삭제
        </button>
      )}
      {hasDeleted && (
        <button onClick={onRestore} title="휴지통에서 복구">
          ↺ {t("복구")}
        </button>
      )}
      {hasDeleted && (
        <button className="sb-del" onClick={onPurge} title="휴지통에서 영구 삭제(복원 불가)">
          ⨯ {t("영구삭제")}
        </button>
      )}
    </div>
  );
}

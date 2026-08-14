import { ProjectAssignMenu } from "../ProjectAssignMenu";
import { useT } from "../../lib/i18n";
import type { GradeMode } from "../../lib/gradeStep";
import type { Generation, Project } from "../../types";

type AssignHandlers = {
  projects: Project[];
  onAssign: (projectId: string | null, folderPath?: string | null) => void;
};

export function BoardSelectionActionBar({
  selected,
  projects,
  onShare,
  onDownload,
  onCompare,
  onAssign,
  onDelete,
  onResolveTransfer,
  onResolveRetry,
  resolveRetryProjectName,
  resolveTransferBusy,
  resolveTransferPendingCount,
}: {
  selected: Generation[];
  onShare: (selected: Generation[]) => void;
  onDownload: (selected: Generation[]) => void;
  onCompare: (selected: Generation[]) => void;
  onDelete: (selected: Generation[]) => void;
  // Resolve 전송 — 넘긴 곳(캔버스 선택바)에서만 버튼 노출. 라이브러리 바와 동일 동작.
  onResolveTransfer?: (selected: Generation[]) => void;
  onResolveRetry?: (() => void) | null;
  resolveRetryProjectName?: string;
  resolveTransferBusy?: boolean;
  resolveTransferPendingCount?: number;
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
      {onResolveTransfer && (
        <button
          className="sb-resolve"
          aria-busy={resolveTransferBusy}
          onClick={() => onResolveTransfer(selected)}
          title={
            resolveTransferBusy
              ? `Resolve 작업 ${resolveTransferPendingCount ?? 0}건 처리 중 · 선택 항목을 대기열에 추가`
              : "선택한 완료본을 프로젝트의 Render 폴더 구조로 저장하고 Resolve로 가져오기"
          }
        >
          {resolveTransferBusy
            ? `${t("◆ Resolve에 추가")} (${resolveTransferPendingCount ?? 0})`
            : t("◆ Resolve로 보내기")}
        </button>
      )}
      {onResolveRetry && (
        <button
          className="sb-resolve"
          onClick={onResolveRetry}
          title={`이미 준비된 원본을 다시 복사하지 않고 ${resolveRetryProjectName || "예정된 Resolve 프로젝트"}에 가져오기`}
        >
          ↻ 준비 원본 다시 가져오기
        </button>
      )}
      {selected.length >= 2 && (
        <button
          onClick={() => onCompare(selected)}
          title="선택한 결과물들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
        >
          ⊞ 비교
        </button>
      )}
      <ProjectAssignMenu projects={projects} onAssign={onAssign} />
      <button className="sb-del" onClick={() => onDelete(selected)} title="휴지통으로 보내기">
        🗑 삭제
      </button>
    </div>
  );
}

export function LibrarySelectionActionBar({
  selectedCount,
  selectedGenerations,
  projects,
  onShare,
  onGradeStep,
  onDownload,
  onResolveTransfer,
  onResolveRetry,
  resolveRetryProjectName,
  resolveTransferBusy,
  resolveTransferPendingCount,
  onCompare,
  onAssign,
  onDelete,
  onRestore,
  onPurge,
}: {
  selectedCount: number;
  selectedGenerations: Generation[];
  onShare: (selected: Generation[]) => void;
  // 공유&리뷰 탭 — '팀에 공유' 자리를 ↑/↓ 등급 한 칸 이동 버튼 2개로 교체(넘긴 곳에서만).
  onGradeStep?: (mode: GradeMode) => void;
  onDownload: (selected: Generation[]) => void;
  onResolveTransfer: (selected: Generation[]) => void;
  onResolveRetry: (() => void) | null;
  resolveRetryProjectName: string;
  resolveTransferBusy: boolean;
  resolveTransferPendingCount: number;
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
      {/* 캔버스 선택바와 동일 — 휴지통 항목만 선택했을 땐 숨김(공유 대상 없음).
          공유&리뷰 탭(onGradeStep)에서는 '팀에 공유' 대신 ↑/↓ 등급 한 칸 이동 버튼 2개. */}
      {hasActive &&
        (onGradeStep ? (
          <span className="sb-grade">
            <button
              title="한 단계 내리기 (최종→공유, 공유→일반)"
              onClick={() => onGradeStep("down")}
            >
              ↓
            </button>
            <button
              title="한 단계 올리기 (일반→공유, 공유→최종)"
              onClick={() => onGradeStep("up")}
            >
              ↑
            </button>
          </span>
        ) : (
          <button onClick={() => onShare(selectedGenerations)}>{t("↗ 팀에 공유")}</button>
        ))}
      <button
        onClick={() => onDownload(selectedGenerations)}
        title="선택한 결과물 일괄 다운로드(레퍼런스 이름으로 저장)"
      >
        ⤓ 다운로드
      </button>
      <button
        className="sb-resolve"
        aria-busy={resolveTransferBusy}
        onClick={() => onResolveTransfer(selectedGenerations)}
        title={
          resolveTransferBusy
            ? `Resolve 작업 ${resolveTransferPendingCount}건 처리 중 · 선택 항목을 대기열에 추가`
            : "선택한 완료본을 프로젝트의 Render 폴더 구조로 저장하고 Resolve로 가져오기"
        }
      >
        {resolveTransferBusy
          ? `${t("◆ Resolve에 추가")} (${resolveTransferPendingCount})`
          : t("◆ Resolve로 보내기")}
      </button>
      {onResolveRetry && (
        <button
          className="sb-resolve"
          onClick={onResolveRetry}
          title={`이미 준비된 원본을 다시 복사하지 않고 ${resolveRetryProjectName || "예정된 Resolve 프로젝트"}에 가져오기`}
        >
          ↻ 준비 원본 다시 가져오기
        </button>
      )}
      {selectedCount >= 2 && (
        <button
          onClick={() => onCompare(selectedGenerations)}
          title="선택한 버전들을 나란히 비교(프롬프트·파라미터 차이 색칠)"
        >
          ⊞ 비교
        </button>
      )}
      <ProjectAssignMenu projects={projects} onAssign={onAssign} />
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

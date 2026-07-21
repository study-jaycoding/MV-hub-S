// 구성(캔버스)탭 좌측 폴더 사이드바 — 라이브러리 필터 사이드바(FilterSidebar)에서 '프로젝트/폴더
// 트리'(ProjectSection)만 떼어낸 슬림 버전. 캔버스에서도 폴더를 선택해 ①새 생성물을 그 폴더로 배정
// (armedFolder 무장) ②계보 보드를 그 폴더로 필터, 그리고 카드를 폴더로 드래그해 담을 수 있게 한다.
// onFilter/onViewDeleted 배선은 FilterSidebar 와 동일(폴더/프로젝트 선택 시 필터 반영).
import type { Filters, Project } from "../../types";
import { ProjectSection } from "./ProjectSection";

export function CanvasFolderSidebar({
  filters,
  onChange,
  projects,
  unassignedCount,
  archivedCount,
  onArmFolder,
  onDropToFolder,
  onDropToUnassigned,
}: {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  projects: Project[];
  unassignedCount: number;
  archivedCount: number;
  onArmFolder?: (projectId: string, path: string) => void;
  onDropToFolder?: (projectId: string, path: string, genId: string) => void;
  onDropToUnassigned?: (genId: string) => void;
}) {
  // 닫기는 라이브러리(내작업) 탭과 동일하게 툴바의 필터 토글(▢/▷)에 위임한다 — 사이드바 내부에 별도
  // ✕ 를 두지 않는다(두 탭 UX 일치).
  return (
    <aside className="sidebar">
      <ProjectSection
        projects={projects}
        unassignedCount={unassignedCount}
        archivedCount={archivedCount}
        activeId={filters.project_id}
        tab={filters.tab === "team" ? "team" : "my"}
        deletedOnly={!!filters.deleted_only}
        onFilter={(pid) =>
          onChange({
            project_id: pid,
            folder_path: undefined, // 프로젝트(또는 상위) 선택 시 폴더 필터 해제
            deleted_only: undefined,
            include_deleted: undefined,
          })
        }
        onViewDeleted={() =>
          onChange({ deleted_only: true, project_id: undefined, include_deleted: undefined })
        }
        onArmFolder={onArmFolder}
        onDropToFolder={onDropToFolder}
        onDropToUnassigned={onDropToUnassigned}
      />
    </aside>
  );
}

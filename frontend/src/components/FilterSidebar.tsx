// 좌측 필터 사이드바 (~150px, DESIGN.md §4): 프로젝트 / 컬러 / 자동태그 / 생성자 / 공유.
import { useState } from "react";
import { useT } from "../lib/i18n";
import { loadJSON, saveJSON } from "../lib/storage";
import { ColorFilterDots } from "./common/ColorFilterDots";
import type { Facets, Filters, Project } from "../types";
import { ProjectSection } from "./sidebar/ProjectSection";
import { CreatorSection } from "./sidebar/CreatorSection";

// 하단 블록(컬러·전역태그·생성자) 접기 상태 — 접으면 그만큼 프로젝트 폴더가 넓어진다. 영속.
const FOOT_OPEN_KEY = "ch.sidebarFootOpen";

interface Props {
  facets: Facets;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  // 프로젝트(작업 묶음) — App 이 단일 소스로 보유, 사이드바와 선택바가 공유
  projects: Project[];
  unassignedCount: number;
  archivedCount: number; // 보관 프로젝트 수(보관함 지연 로딩)
  // 컬러 인스턴트 필터 — 툴바(LibraryToolbar)와 동일 상태 공유(연동: 같이 켜짐/꺼짐)
  colorDots: { k: string; hex: string }[];
  colorFilter: Set<string>;
  onToggleColor: (hex: string) => void;
  finalOnly?: boolean; // 골드 필터: 최종(골드)만 (툴바와 상태 공유)
  onToggleFinal?: () => void;
  grayOn?: boolean; // 회색 필터: 비활성(회색) 카드 숨기기(툴바와 상태 공유)
  onToggleGray?: () => void;
  armedAutoTags: Set<string>; // 무장된 전역 태그(다음 생성에 자동 적용)
  onToggleAutoTag: (t: string) => void;
  onAddAutoTag: () => void;
  onDeleteAutoTag: (t: string) => void;
  onCreatorChanged: () => void; // 생성자 '나 지정'/이름변경 후 라이브러리 새로고침
  armedFolder?: { projectId: string; path: string } | null; // 무장 폴더 = 폴더 트리 빨간 하이라이트
  onArmFolder?: (projectId: string, path: string) => void; // 폴더 선택 시 무장(생성 시 folder_path)
  onDropToFolder?: (projectId: string, path: string, genId: string) => void; // 카드 드래그 → 폴더 담기
  onDropToUnassigned?: (genId: string) => void; // 카드 드래그 → 미분류(귀속 해제)
  workspaceName?: string; // 머리말 = 현재 워크스페이스 이름
}

export function FilterSidebar({
  facets,
  filters,
  onChange,
  colorDots,
  colorFilter,
  onToggleColor,
  finalOnly = false,
  onToggleFinal,
  grayOn = false,
  onToggleGray,
  armedAutoTags,
  onToggleAutoTag,
  onAddAutoTag,
  onDeleteAutoTag,
  onCreatorChanged,
  armedFolder,
  onArmFolder,
  onDropToFolder,
  onDropToUnassigned,
  projects,
  unassignedCount,
  archivedCount,
  workspaceName,
}: Props) {
  const tr = useT();
  const [footOpen, setFootOpen] = useState<boolean>(
    () => loadJSON<boolean>(FOOT_OPEN_KEY) ?? true,
  );
  const toggleFoot = () =>
    setFootOpen((open) => {
      saveJSON(FOOT_OPEN_KEY, !open);
      return !open;
    });
  return (
    <aside className="sidebar">
      {/* 위 = 프로젝트/폴더(남는 높이를 다 쓰고 스스로 스크롤), 아래 = 컬러·전역태그·생성자 고정 */}
      <div className="sidebar-main">
        <ProjectSection
          workspaceName={workspaceName}
          projects={projects}
          unassignedCount={unassignedCount}
          archivedCount={archivedCount}
          activeId={filters.project_id}
          tab={filters.tab === "team" ? "team" : "my"}
          deletedOnly={!!filters.deleted_only}
          armedFolder={armedFolder}
          // 프로젝트/라이브러리/미분류 선택 시 휴지통 보기는 해제(메인으로 복귀)
          onFilter={(pid) =>
            onChange({
              project_id: pid,
              folder_path: undefined, // 프로젝트(또는 상위) 선택 시 폴더 필터 해제 → 전체 보기
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
      </div>

      <button
        className={"sidebar-foot-toggle" + (footOpen ? " on" : "")}
        onClick={toggleFoot}
        title={footOpen ? "접기 — 폴더를 더 넓게 본다" : "펼치기"}
      >
        <span className="sidebar-foot-caret">{footOpen ? "▾" : "▴"}</span>
        {tr("컬러")} · {tr("전역 태그")} · {tr("생성자")}
      </button>

      <div className="sidebar-foot" hidden={!footOpen}>
        <section>
          <h4>{tr("컬러")}</h4>
          <div className="color-dots">
            <ColorFilterDots
              colorDots={colorDots}
              activeColors={colorFilter}
              onToggleColor={onToggleColor}
              grayOn={grayOn}
              onToggleGray={onToggleGray}
              finalOnly={finalOnly}
              onToggleFinal={onToggleFinal}
            />
          </div>
        </section>

        <section>
          <h4 className="auto-tag-head">
            {tr("전역 태그")}
            <button className="auto-tag-add" title={tr("전역 태그")} onClick={onAddAutoTag}>
              +
            </button>
          </h4>
          <div className="chips">
            {facets.auto_tags.length === 0 && <span className="muted">{tr("없음")}</span>}
            {facets.auto_tags.map((t) => (
              <span key={t} className={"auto-tag-chip" + (armedAutoTags.has(t) ? " on" : "")}>
                <button
                  className="auto-tag-name"
                  title={armedAutoTags.has(t) ? "해제 (생성 시 자동 적용 중)" : "선택 — 다음 생성에 자동 적용"}
                  onClick={() => onToggleAutoTag(t)}
                >
                  {t}
                </button>
                <button
                  className="auto-tag-x"
                  title="전역 태그 삭제"
                  onClick={() => onDeleteAutoTag(t)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </section>

        <CreatorSection
          activeUid={filters.creator_uid}
          onFilter={(uid) => onChange({ creator_uid: uid })}
          onChanged={onCreatorChanged}
          tab={filters.tab === "team" ? "team" : "my"}
          projectId={
            filters.project_id && filters.project_id !== "none"
              ? filters.project_id
              : undefined
          }
        />
      </div>

      {/* 공유(SHARED) 섹션 제거 — 불필요. 휴지통(TRASH)도 프로젝트 섹션으로 통합됨. */}
    </aside>
  );
}

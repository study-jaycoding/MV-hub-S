// 좌측 필터 사이드바 (~150px, DESIGN.md §4): 프로젝트 / 컬러 / 자동태그 / 생성자 / 공유.
import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../lib/i18n";
import type { Creator, Facets, Filters, Project } from "../types";

// 프로젝트(작업 묶음) **필터 전용** — 선택하면 그 안 결과물만 보인다.
// 생성·이름변경·보관·삭제(관리)는 권한 게이트가 걸린 관리자 창의 '프로젝트' 탭에서만 한다.
function ProjectSection({
  projects,
  unassignedCount,
  archivedCount,
  activeId,
  deletedOnly,
  onFilter,
  onViewDeleted,
}: {
  projects: Project[];
  unassignedCount: number;
  archivedCount: number; // 보관 프로젝트 수(헤더 표시·지연 로딩 판단)
  activeId?: string;
  deletedOnly: boolean; // 휴지통(지운 것만) 보기 활성 여부
  onFilter: (projectId?: string) => void;
  onViewDeleted: () => void; // '지운 것 보기' 선택
}) {
  const tr = useT();
  // 순서 드래그 — 그립(⠿)을 잡고 끌어 옮긴다. 낙관적 로컬 순서 + 서버 저장(App reload 가 재동기).
  const [order, setOrder] = useState<Project[]>(projects);
  useEffect(() => setOrder(projects), [projects]);
  const [dragArmed, setDragArmed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dropAt = async (toIdx: number) => {
    const from = dragIdx;
    setDragArmed(false);
    setDragIdx(null);
    setOverIdx(null);
    if (from === null || from === toIdx) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    setOrder(next);
    api.reorderProjects(next.map((x) => x.id)).catch(() => {}); // 실패해도 App reload 가 서버 순서로 보정
  };
  // 보관(archived) 프로젝트는 **펼칠 때만** 불러온다(지연 로딩) — 보관할수록 평소 로드가 가벼워짐.
  const [archived, setArchived] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const loadArchived = () =>
    api
      .projects(true)
      .then((r) => {
        setArchived(r.projects.filter((p) => p.archived));
        setArchivedLoaded(true);
      })
      .catch(() => {});
  const toggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    if (next && !archivedLoaded) loadArchived(); // 첫 펼침에만 실제 목록 요청
  };
  // 활성 프로젝트가 바뀌면(보관/해제 등) 이미 펼쳐 본 보관함은 갱신, 안 봤으면 그대로 둔다.
  useEffect(() => {
    if (showArchived) loadArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);
  return (
    <>
      {/* 상단 기본 보기 — MV 바로 아래(프로젝트 묶음과 별개): 라이브러리 / 미분류 / 휴지통 */}
      <section>
        <h4 className="auto-tag-head">Millionvolt</h4>
        <div className="proj-list">
          {/* '전체' = 메인 라이브러리(지운 것 제외). 휴지통 꺼짐 + 프로젝트 미선택일 때 활성 */}
          <button
            className={"proj-row" + (!activeId && !deletedOnly ? " on" : "")}
            onClick={() => onFilter(undefined)}
          >
            <span className="proj-name">{tr("라이브러리")}</span>
          </button>
          <button
            className={
              "proj-row proj-unassigned" + (activeId === "none" && !deletedOnly ? " on" : "")
            }
            onClick={() => onFilter(activeId === "none" ? undefined : "none")}
            title="아직 프로젝트에 담기지 않은 결과물"
          >
            <span className="proj-name">{tr("미분류")}</span>
            <span className="proj-count">{unassignedCount}</span>
          </button>
          {/* 지운 것 보기 — 별도 휴지통 DB. 선택하면 지운 항목만 표시(검색·복원·영구삭제 가능) */}
          <button
            className={"proj-row proj-trash" + (deletedOnly ? " on" : "")}
            onClick={onViewDeleted}
            title="지운 것만 보기 — 힉스필드 원본엔 영향 없음(우리 카탈로그 휴지통)"
          >
            <span className="proj-name">{tr("휴지통 보기")}</span>
          </button>
        </div>
      </section>

      {/* PROJECTS — 실제 프로젝트(작업 묶음)만. 생성·관리는 관리자 창의 '프로젝트' 탭에서. */}
      <section>
        <h4 className="auto-tag-head">{tr("프로젝트")}</h4>
        <div className="proj-list">
          {order.length === 0 && <span className="muted">{tr("없음")}</span>}
          {order.map((p, idx) => (
            <button
              key={p.id}
              className={
                "proj-row" +
                (activeId === p.id && !deletedOnly ? " on" : "") +
                (dragIdx === idx ? " row-dragging" : "") +
                (overIdx === idx && dragIdx !== idx ? " row-dragover" : "")
              }
              onClick={() => onFilter(activeId === p.id ? undefined : p.id)}
              title={p.name}
              draggable={dragArmed}
              onDragStart={(e) => {
                setDragIdx(idx);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (dragIdx === null) return;
                e.preventDefault();
                if (overIdx !== idx) setOverIdx(idx);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropAt(idx);
              }}
              onDragEnd={() => {
                setDragArmed(false);
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              <span
                className="proj-drag-handle"
                title="드래그해서 순서 변경"
                onMouseDown={() => setDragArmed(true)}
                onMouseUp={() => setDragArmed(false)}
                onClick={(e) => e.stopPropagation()}
              >
                ⠿
              </span>
              <span className="proj-name">{p.name}</span>
              <span className="proj-count">{p.count}</span>
            </button>
          ))}
          {archivedCount > 0 && (
            <div className="proj-archived">
              <button
                className="proj-archived-head"
                onClick={toggleArchived}
                title="보관한 프로젝트 — 펼칠 때만 불러옴(평소 로드 가벼움)"
              >
                {showArchived ? "▾" : "▸"} {tr("보관함")} ({archivedCount})
              </button>
              {showArchived &&
                archived.map((p) => (
                  <button
                    key={p.id}
                    className={"proj-row archived" + (activeId === p.id ? " on" : "")}
                    onClick={() => onFilter(activeId === p.id ? undefined : p.id)}
                    title={p.name}
                  >
                    <span className="proj-name">{p.name}</span>
                    <span className="proj-count">{p.count}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

// 생성자(팀 워크스페이스 작성자) 필터. 이름은 각자의 로그인 표시이름에서 자동으로 온다
// (제공자는 set_provider_name 이 생성자 행에 미러). 수동 이름변경·'나로 지정'은 제거.
function CreatorSection({
  activeUid,
  onFilter,
  tab,
  projectId,
}: {
  activeUid?: string;
  onFilter: (uid?: string) => void;
  onChanged?: () => void; // (호환용 — 더는 안 씀)
  tab: "my" | "team"; // My Work 탭이면 본인만(보통 1명 → 자동 숨김), Team 탭이면 공유물 작성자
  projectId?: string; // 프로젝트 선택 시 그 프로젝트 참여 인원(멤버)을 표시 → 팀공유 탭에서 그 사람으로 필터
}) {
  const tr = useT();
  const [creators, setCreators] = useState<Creator[]>([]);
  // '나'(is_mine)를 맨 위로 — 나머지는 서버가 준 순서 유지(안정 정렬).
  const load = () =>
    api
      .creators(tab, projectId)
      .then((cs) =>
        setCreators([...cs].sort((a, b) => (a.is_mine === b.is_mine ? 0 : a.is_mine ? -1 : 1))),
      )
      .catch(() => {});
  useEffect(() => {
    load();
  }, [tab, projectId]);
  if (!creators.length) return null; // 로드 전(빈 목록)만 숨김 — '나'만 있어도 항상 표시
  return (
    <section>
      <h4>{tr("생성자")}</h4>
      {creators.map((c) => (
        <div key={c.uid} className={"creator-row" + (activeUid === c.uid ? " on" : "")}>
          <button
            className="creator-pick"
            onClick={() => onFilter(activeUid === c.uid ? undefined : c.uid)}
            title={c.uid}
          >
            <span
              className="creator-dot"
              style={{ background: c.is_mine ? "var(--accent)" : "#4ade80" }}
            />
            <span className="creator-name">{c.is_mine ? "나" : c.name || "팀원"}</span>
            <span className="creator-count">{c.count}</span>
          </button>
        </div>
      ))}
    </section>
  );
}

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
  armedAutoTags: Set<string>; // 무장된 전역 태그(다음 생성에 자동 적용)
  onToggleAutoTag: (t: string) => void;
  onAddAutoTag: () => void;
  onDeleteAutoTag: (t: string) => void;
  onCreatorChanged: () => void; // 생성자 '나 지정'/이름변경 후 라이브러리 새로고침
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
  armedAutoTags,
  onToggleAutoTag,
  onAddAutoTag,
  onDeleteAutoTag,
  onCreatorChanged,
  projects,
  unassignedCount,
  archivedCount,
}: Props) {
  const tr = useT();
  return (
    <aside className="sidebar">
      <ProjectSection
        projects={projects}
        unassignedCount={unassignedCount}
        archivedCount={archivedCount}
        activeId={filters.project_id}
        deletedOnly={!!filters.deleted_only}
        // 프로젝트/라이브러리/미분류 선택 시 휴지통 보기는 해제(메인으로 복귀)
        onFilter={(pid) =>
          onChange({ project_id: pid, deleted_only: undefined, include_deleted: undefined })
        }
        onViewDeleted={() =>
          onChange({ deleted_only: true, project_id: undefined, include_deleted: undefined })
        }
      />

      <section>
        <h4>{tr("컬러")}</h4>
        <div className="color-dots">
          {/* 골드 dot — 레드 앞. 누르면 최종(골드) 지정된 것만 필터(툴바 골드 dot 과 동일 상태). */}
          {onToggleFinal && (
            <button
              className={"af-dot af-dot-gold" + (finalOnly ? " on" : "")}
              title="최종(골드)으로 지정된 것만 보기"
              onClick={onToggleFinal}
            />
          )}
          {colorDots.map(({ k, hex }) => {
            const on = colorFilter.has(hex);
            return (
              <button
                key={k}
                className={"af-dot" + (on ? " on" : "")}
                style={{
                  background: hex,
                  filter: on ? "brightness(1.2) saturate(1.25)" : "brightness(0.45) saturate(0.7)",
                  opacity: on ? 1 : 0.85,
                  borderColor: on ? "#fff" : "rgba(0,0,0,0.4)",
                  boxShadow: on ? `0 0 0 2px ${hex}, 0 0 11px ${hex}` : "none",
                }}
                title={`${k.toUpperCase()} 컬러만 보기`}
                onClick={() => onToggleColor(hex)}
              />
            );
          })}
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

      {/* 공유(SHARED) 섹션 제거 — 불필요. 휴지통(TRASH)도 프로젝트 섹션으로 통합됨. */}
    </aside>
  );
}

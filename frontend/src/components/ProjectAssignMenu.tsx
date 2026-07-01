// 선택한 결과물들을 프로젝트(작업 묶음)에 담는 드롭다운. 선택바(select-bar)에 표시.
// 로드맵 §0-4: 프로젝트로 귀속 = 공유·이동의 단위로 묶기.
// 폴더가 연결된 프로젝트는 ▸ 를 눌러 아래에 폴더 트리를 펼쳐 특정 폴더에도 담을 수 있다.
// 마지막으로 연 프로젝트·펼침 상태는 localStorage 에 기억한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAskPrompt } from "../lib/prompt";
import { visibleProjectFolderRoots } from "../lib/projectFolderTree";
import { loadJSON, saveJSON } from "../lib/storage";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import type { Project, ProjectFolderState } from "../types";
import { FolderTreeView } from "./common/FolderTreeView";

const LS_PID = "ch.pam.expandedPid"; // 마지막으로 폴더를 펼친 프로젝트
const LS_EXP = "ch.pam.folderExpanded"; // 프로젝트별 펼친 폴더 경로들

export function ProjectAssignMenu({
  count,
  projects,
  onAssign,
  onCreateAndAssign,
}: {
  count: number; // 선택 개수(라벨용)
  projects: Project[];
  onAssign: (projectId: string | null, folderPath?: string | null) => void; // null = 미분류로 빼기
  onCreateAndAssign: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const askPrompt = useAskPrompt();
  const closeMenu = useCallback(() => setOpen(false), []);

  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  // 마지막으로 펼친 폴더·펼침 상태를 기억(재오픈 시 복원).
  const [expandedPid, setExpandedPid] = useState<string | null>(() => loadJSON<string>(LS_PID));
  const [folderState, setFolderState] = useState<Record<string, ProjectFolderState>>({});
  const [folderExpanded, setFolderExpanded] = useState<Record<string, string[]>>(
    () => loadJSON<Record<string, string[]>>(LS_EXP) || {},
  );

  useOutsideMouseDown(ref, closeMenu, open);

  // 폴더 연결 여부 로드(메뉴 열 때).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .projectFolderLinks()
      .then((res) => {
        if (!alive) return;
        const links = res.links || {};
        setLinkedIds(new Set(Object.keys(links).filter((pid) => !!links[pid]?.root_path)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // 기억된(또는 새로 펼친) 프로젝트의 폴더 트리 지연 로드.
  useEffect(() => {
    if (!open || !expandedPid || folderState[expandedPid]) return;
    let alive = true;
    api
      .projectFolder(expandedPid)
      .then((st) => alive && setFolderState((prev) => ({ ...prev, [expandedPid]: st })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, expandedPid, folderState]);

  const pick = (projectId: string | null, folderPath?: string | null) => {
    onAssign(projectId, folderPath);
    setOpen(false);
  };

  const toggleFolders = (pid: string) => {
    const next = expandedPid === pid ? null : pid;
    setExpandedPid(next);
    saveJSON(LS_PID, next);
  };

  const toggleNode = (pid: string, path: string) => {
    setFolderExpanded((prev) => {
      const cur = new Set(prev[pid] || []);
      if (cur.has(path)) cur.delete(path);
      else cur.add(path);
      const next = { ...prev, [pid]: [...cur] };
      saveJSON(LS_EXP, next);
      return next;
    });
  };

  const createNew = async () => {
    setOpen(false);
    const name = (
      await askPrompt(`새 프로젝트 이름 (${count}개 담기)`, "", "프로젝트 이름 ⏎")
    )?.trim();
    if (!name) return;
    onCreateAndAssign(name);
  };

  return (
    <div className="proj-assign" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} title="선택한 결과물을 프로젝트에 담기">
        📁 프로젝트에 담기 ▾
      </button>
      {open && (
        <div className="proj-assign-menu">
          <button className="pam-new" onClick={createNew}>
            + 새 프로젝트…
          </button>
          {projects.length > 0 && <div className="pam-sep" />}
          {projects.map((p) => {
            const linked = linkedIds.has(p.id);
            const isOpen = expandedPid === p.id;
            const st = isOpen ? folderState[p.id] : undefined;
            const roots = st?.tree ? visibleProjectFolderRoots(st.tree) : [];
            return (
              <div key={p.id} className="pam-proj">
                <div className="pam-proj-row">
                  <button className="pam-proj-main" onClick={() => pick(p.id)} title={p.name}>
                    <span className="pam-name">{p.name}</span>
                    <span className="pam-count">{p.count}</span>
                  </button>
                  {linked && (
                    <button
                      className={"pam-fold-toggle" + (isOpen ? " on" : "")}
                      title="폴더 선택해 담기"
                      onClick={() => toggleFolders(p.id)}
                    >
                      ▸
                    </button>
                  )}
                </div>
                {linked && isOpen && (
                  <div className="pam-folders">
                    {!st && <div className="side-folder-note">폴더 로딩...</div>}
                    {st?.error && <div className="side-folder-note error">{st.error}</div>}
                    {st && !st.error && !roots.length && (
                      <div className="side-folder-note">폴더 없음</div>
                    )}
                    {roots.length > 0 && (
                      <FolderTreeView
                        nodes={roots}
                        selectedPath=""
                        expanded={new Set(folderExpanded[p.id] || [])}
                        onToggle={(path) => toggleNode(p.id, path)}
                        onSelect={(path) => pick(p.id, path)}
                        scroll
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="pam-sep" />
          <button className="pam-clear" onClick={() => pick(null)}>
            미분류로 빼기
          </button>
        </div>
      )}
    </div>
  );
}

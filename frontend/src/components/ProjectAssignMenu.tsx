// 선택한 결과물들을 프로젝트(작업 묶음)에 담는 드롭다운. 선택바(select-bar)에 표시.
// 로드맵 §0-4: 프로젝트로 귀속 = 공유·이동의 단위로 묶기.
// 폴더가 연결된 프로젝트는 ▸ 를 눌러 아래에 폴더 트리를 펼쳐 특정 폴더에도 담을 수 있다.
// 폴더 숫자는 사이드바와 동일한 '담긴 생성물 수'(folder-counts)로 덮어쓴다 — 관리용 트리가
// 들고 오는 디스크 파일 수는 이 문맥(어디에 담을까)에선 오해만 부른다.
// 마지막으로 연 프로젝트·펼침 상태는 localStorage 에 기억한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { buildFolderCountTree, type FolderCountTreeNode } from "../lib/folderTreeModel";
import { visibleProjectFolderRoots } from "../lib/projectFolderTree";
import { loadJSON, saveJSON } from "../lib/storage";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import type { Project, ProjectFolderState } from "../types";
import { FolderTreeView } from "./common/FolderTreeView";

const LS_PID = "ch.pam.expandedPid"; // 마지막으로 폴더를 펼친 프로젝트
const LS_EXP = "ch.pam.folderExpanded"; // 프로젝트별 펼친 폴더 경로들

// 디스크 스캔이 붙여온 파일 수 제거 — folder-counts 도착 전(또는 0건)에 잘못된 숫자가
// 잠깐이라도 보이지 않게 전부 0(표시는 '-')으로 눕힌다.
const stripDiskCounts = (nodes: FolderCountTreeNode[]): FolderCountTreeNode[] =>
  nodes.map((node) => ({
    ...node,
    count: 0,
    children: node.children ? stripDiskCounts(node.children) : node.children,
  }));

export function ProjectAssignMenu({
  projects,
  onAssign,
}: {
  projects: Project[];
  onAssign: (projectId: string | null, folderPath?: string | null) => void; // null = 미분류로 빼기
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const closeMenuOnEscape = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  // 마지막으로 펼친 폴더·펼침 상태를 기억(재오픈 시 복원).
  const [expandedPid, setExpandedPid] = useState<string | null>(() => loadJSON<string>(LS_PID));
  const [folderState, setFolderState] = useState<Record<string, ProjectFolderState>>({});
  // 사이드바와 같은 폴더별 '담긴 생성물 수' — 트리에 덮어쓸 값(pid → {folder_path: n}).
  const [folderCounts, setFolderCounts] = useState<Record<string, Record<string, number>>>({});
  const [folderExpanded, setFolderExpanded] = useState<Record<string, string[]>>(
    () => loadJSON<Record<string, string[]>>(LS_EXP) || {},
  );

  useOutsideMouseDown(ref, closeMenu, open);
  // 메뉴만 닫고 현재 카드 선택은 유지 — 전역 라이브러리 Esc 보다 캡처 단계에서 먼저 처리한다.
  useEscapeClose(closeMenuOnEscape, open, true, true);

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

  // 기억된(또는 새로 펼친) 프로젝트의 폴더 트리 + 담긴 개수 지연 로드.
  useEffect(() => {
    if (!open || !expandedPid) return;
    let alive = true;
    if (!folderState[expandedPid]) {
      api
        .projectFolder(expandedPid)
        .then((st) => alive && setFolderState((prev) => ({ ...prev, [expandedPid]: st })))
        .catch(() => {
          // 조용히 삼키지 않고 사유 표시(아래 렌더가 st.error 를 보여줌).
          if (alive)
            setFolderState((prev) => ({
              ...prev,
              [expandedPid]: { error: "폴더 정보를 불러오지 못했습니다" } as ProjectFolderState,
            }));
        });
    }
    if (!folderCounts[expandedPid]) {
      api
        .projectFolderCounts(expandedPid)
        .then(
          (r) =>
            alive &&
            setFolderCounts((prev) => ({ ...prev, [expandedPid]: r.counts || {} })),
        )
        .catch(() => {}); // 실패 시 '-' 유지 — 디스크 파일 수로 폴백하지 않는다
    }
    return () => {
      alive = false;
    };
  }, [open, expandedPid, folderState, folderCounts]);

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

  return (
    <div className="proj-assign" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="선택한 결과물을 프로젝트에 담기"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        📁 프로젝트에 담기 ▾
      </button>
      {open && (
        <div className="proj-assign-menu">
          {projects.map((p) => {
            const linked = linkedIds.has(p.id);
            const isOpen = expandedPid === p.id;
            const st = isOpen ? folderState[p.id] : undefined;
            const rawRoots = st?.tree ? stripDiskCounts(visibleProjectFolderRoots(st.tree)) : [];
            const counts = isOpen ? folderCounts[p.id] : undefined;
            const roots = counts ? buildFolderCountTree(rawRoots, counts) : rawRoots;
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
                      // scroll(scroll-15) 금지 — overscroll-behavior:contain 이 있어 트리가 안 넘칠 때
                      // 휠을 부모로 안 넘겨 '휠 먹통'이 된다. 이 메뉴는 바깥 팝업 하나만 스크롤한다.
                      <FolderTreeView
                        nodes={roots}
                        selectedPath=""
                        expanded={new Set(folderExpanded[p.id] || [])}
                        onToggle={(path) => toggleNode(p.id, path)}
                        onSelect={(path) => pick(p.id, path)}
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

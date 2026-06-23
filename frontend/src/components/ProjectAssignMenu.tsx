// 선택한 결과물들을 프로젝트(작업 묶음)에 담는 드롭다운. 선택바(select-bar)에 표시.
// 로드맵 §0-4: 프로젝트로 귀속 = 공유·이동의 단위로 묶기.
import { useEffect, useRef, useState } from "react";
import { useAskPrompt } from "../lib/prompt";
import type { Project } from "../types";

export function ProjectAssignMenu({
  count,
  projects,
  onAssign,
  onCreateAndAssign,
}: {
  count: number; // 선택 개수(라벨용)
  projects: Project[];
  onAssign: (projectId: string | null) => void; // null = 미분류로 빼기
  onCreateAndAssign: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const askPrompt = useAskPrompt();

  // 바깥 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (projectId: string | null) => {
    onAssign(projectId);
    setOpen(false);
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
          {projects.map((p) => (
            <button key={p.id} onClick={() => pick(p.id)} title={p.name}>
              <span className="pam-name">{p.name}</span>
              <span className="pam-count">{p.count}</span>
            </button>
          ))}
          <div className="pam-sep" />
          <button className="pam-clear" onClick={() => pick(null)}>
            미분류로 빼기
          </button>
        </div>
      )}
    </div>
  );
}

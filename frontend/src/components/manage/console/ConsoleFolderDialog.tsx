// 렌더 폴더 창 — 서브 표의 폴더 단추. 렌더 폴더는 **프로젝트마다**, 그리고 **이 PC 에** 저장되는 설정이다
// (`/api/manage/project-folders` 는 로컬 전용 경로). 프로젝트 관리 창과 같은 API(setProjectFolder)를 쓴다.
import { useEffect, useState } from "react";
import { api } from "../../../api";
import { manageApi } from "../../../lib/manageApi";

type Row = { id: string; name: string; root: string; initial: string; selected: string; state: "loading" | "ready" | "saving" | "saved" | "error"; error?: string };

const errorText = (reason: unknown) => String(reason).replace(/^Error:\s*/, "");

export function ConsoleFolderDialog({ workspaceId, name, onClose }: { workspaceId: string; name: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const patch = (id: string, next: Partial<Row>) => setRows((cur) => cur?.map((r) => (r.id === id ? { ...r, ...next } : r)) ?? cur);

  useEffect(() => {
    let alive = true;
    manageApi.taskProjects(workspaceId).then(async (res) => {
      const projects = res.projects.filter((p) => !p.archived);
      if (!alive) return;
      setRows(projects.map((p) => ({ id: p.id, name: p.name, root: "", initial: "", selected: "", state: "loading" })));
      for (const p of projects) {
        api.projectFolder(p.id)
          .then((f) => alive && patch(p.id, { root: f.root_path || "", initial: f.root_path || "", selected: f.selected_path || "", state: "ready" }))
          .catch(() => alive && patch(p.id, { state: "ready" }));
      }
    }).catch((reason) => alive && setError(`프로젝트를 불러오지 못했습니다. ${errorText(reason)}`));
    return () => { alive = false; };
  }, [workspaceId]);

  const save = async (row: Row) => {
    const root = row.root.trim();
    patch(row.id, { state: "saving", error: "" });
    try {
      // 루트가 그대로면 고른 하위 폴더도 유지, 바뀌면 비운다(프로젝트 관리 창과 같은 규칙).
      const state = await api.setProjectFolder(row.id, { root_path: root, selected_path: root && root === row.initial ? row.selected : "" });
      patch(row.id, { root: state.root_path || "", initial: state.root_path || "", selected: state.selected_path || "", state: "saved" });
    } catch (reason) {
      patch(row.id, { state: "error", error: errorText(reason) });
    }
  };

  return (
    <div className="credit-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wc-dialog wc-folder-dialog" role="dialog" aria-label="렌더 폴더">
        <h3>렌더 폴더 · {name}</h3>
        <p>프로젝트마다 렌더 원본 폴더 경로를 적습니다. 이 PC 에 저장되는 설정입니다(다른 PC 는 각자 지정). 비우고 저장하면 연결을 해제합니다.</p>
        {error ? <div className="wc-error">{error}</div> : null}
        {rows === null && !error ? <div className="wc-hint">불러오는 중...</div> : null}
        {rows && !rows.length ? <div className="wc-hint">이 서브에 연결된 프로젝트가 없습니다.</div> : null}
        {rows?.map((row) => (
          <div key={row.id} className="wc-folder-row">
            <div className="wc-folder-name">{row.name}</div>
            <input id={`wc-folder-${row.id}`} className="wc-left" value={row.root} disabled={row.state === "loading" || row.state === "saving"}
              placeholder={row.state === "loading" ? "불러오는 중..." : "예: Z:\\Project\\render"}
              onChange={(e) => patch(row.id, { root: e.target.value, state: "ready" })}
              onKeyDown={(e) => { if (e.key === "Enter" && row.root.trim() !== row.initial) void save(row); }} />
            <button type="button" className="wc-btn" disabled={row.state === "loading" || row.state === "saving" || row.root.trim() === row.initial}
              onClick={() => void save(row)}>{row.state === "saving" ? "저장 중" : "저장"}</button>
            {row.state === "saved" ? <span className="wc-chip ok">저장됨</span> : null}
            {row.state === "error" ? <span className="wc-error">{row.error}</span> : null}
          </div>
        ))}
        <footer><button type="button" onClick={onClose}>닫기</button></footer>
      </div>
    </div>
  );
}

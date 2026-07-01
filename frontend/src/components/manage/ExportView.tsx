// 완료 탭 — 완료 작업의 최종본(★)만 렌더 폴더 경로 구조 그대로 물리 저장.
// 프로젝트를 고르면 그 프로젝트의 렌더 폴더 연결 상태를 확인하고, 버튼으로 저장을 실행한다.
// 저장은 로컬 전용(이 PC 디스크). 이미 저장된 건 건너뛴다(멱등).
import { useEffect, useState } from "react";
import { api } from "../../api";
import { manageApi, type SaveFinalsResult } from "../../lib/manageApi";
import { projectApi } from "../../lib/projectApi";
import type { ProjectFolderState } from "../../types";

export function ExportView() {
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [folder, setFolder] = useState<ProjectFolderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveFinalsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .projects("team")
      .then((r) => {
        const ps = r.projects.map((p) => ({ pid: p.id, name: p.name }));
        setProjects(ps);
        setPid((cur) => cur || (ps[0]?.pid ?? ""));
      })
      .catch((e) => setErr(String(e?.message || e)));
  }, []);

  useEffect(() => {
    setResult(null);
    setErr(null);
    if (!pid) {
      setFolder(null);
      return;
    }
    projectApi
      .projectFolder(pid)
      .then(setFolder)
      .catch((e) => setErr(String(e?.message || e)));
  }, [pid]);

  const renderPath = folder?.render_path || "";
  const canSave = !!pid && !!renderPath && !folder?.error && !busy;

  const onSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setResult(null);
    setErr(null);
    try {
      const r = await manageApi.saveFinals(pid);
      setResult(r);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="manage-dash export-root">
      <header className="manage-head">
        <h1>완료본 저장</h1>
        <div className="work-head-ctl">
          <select
            className="manage-proj-select"
            value={pid}
            onChange={(e) => setPid(e.target.value)}
          >
            {!projects.length && <option value="">(프로젝트 없음)</option>}
            {projects.map((p) => (
              <option key={p.pid} value={p.pid}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="export-body">
        <p className="export-desc">
          완료(★최종) 상태의 생성물만 아래 렌더 폴더의 경로 구조(예: <code>ep001/c0010</code>) 그대로
          저장합니다. 이미 저장된 파일은 건너뜁니다.
        </p>

        <div className="export-target">
          <span className="export-target-label">저장 위치</span>
          {folder?.error ? (
            <span className="export-target-err">⚠ {folder.error}</span>
          ) : renderPath ? (
            <code className="export-target-path">{renderPath}</code>
          ) : (
            <span className="export-target-err">
              렌더 폴더가 연결되지 않았습니다. 관리자 창에서 프로젝트 폴더를 먼저 연결하세요.
            </span>
          )}
        </div>

        <button className="export-btn" disabled={!canSave} onClick={onSave}>
          {busy ? "저장 중…" : "완료만 저장하기"}
        </button>

        {err && <div className="export-err">저장 실패: {err}</div>}

        {result && (
          <div className="export-result">
            <div className="export-result-line">
              저장 <b>{result.saved}</b> · 건너뜀 <b>{result.skipped}</b>
              {result.errors.length > 0 && (
                <>
                  {" "}
                  · 오류 <b>{result.errors.length}</b>
                </>
              )}
            </div>
            {result.errors.length > 0 && (
              <ul className="export-err-list">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    <code>{e.gen_id.slice(0, 8)}</code> — {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 완료 탭 — 완료 작업의 최종본(★)만 렌더 폴더 경로 구조 그대로 물리 저장.
// 프로젝트를 고르면 그 프로젝트의 렌더 폴더 연결 상태를 확인하고, 버튼으로 저장을 실행한다.
// 저장은 로컬 전용(이 PC 디스크). 이미 저장된 건 건너뛴다(멱등).
import { useEffect, useState } from "react";
import { api } from "../../api";
import {
  manageApi,
  type SaveFinalsResult,
  type SaveFinalsStatus,
} from "../../lib/manageApi";

export function ExportView() {
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [status, setStatus] = useState<SaveFinalsStatus | null>(null);
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

  const loadStatus = (p: string) => {
    if (!p) {
      setStatus(null);
      return;
    }
    manageApi
      .saveFinalsStatus(p)
      .then(setStatus)
      .catch((e) => setErr(String(e?.message || e)));
  };

  useEffect(() => {
    setResult(null);
    setErr(null);
    loadStatus(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const renderPath = status?.render_path || "";
  const targets = status?.targets ?? [];
  const pending = targets.filter((t) => !t.saved).length;
  const canSave = !!pid && !!renderPath && !status?.error && !busy;

  const onSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setResult(null);
    setErr(null);
    try {
      const r = await manageApi.saveFinals(pid);
      setResult(r);
      loadStatus(pid); // 저장 후 대상·이력 갱신
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
          {status?.error ? (
            <span className="export-target-err">⚠ {status.error}</span>
          ) : renderPath ? (
            <code className="export-target-path">{renderPath}</code>
          ) : (
            <span className="export-target-err">
              렌더 폴더가 연결되지 않았습니다. 관리자 창에서 프로젝트 폴더를 먼저 연결하세요.
            </span>
          )}
        </div>

        <div className="export-preview">
          저장 대상 최종본 <b>{targets.length}</b>건
          {targets.length > 0 && (
            <>
              {" "}
              — 새로 저장 <b>{pending}</b> · 이미 저장 <b>{targets.length - pending}</b>
            </>
          )}
        </div>

        <button className="export-btn" disabled={!canSave || pending === 0} onClick={onSave}>
          {busy ? "저장 중…" : pending === 0 ? "새로 저장할 최종본 없음" : `완료만 저장하기 (${pending})`}
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

        {status && status.history.length > 0 && (
          <div className="export-history">
            <div className="export-history-head">저장 이력 ({status.history.length})</div>
            <ul className="export-history-list">
              {status.history.map((h) => (
                <li key={h.gen_id} className={h.exists ? "" : "missing"}>
                  <span className="export-history-when">{h.exported_at}</span>
                  <code className="export-history-path">{h.dest_path}</code>
                  {!h.exists && <span className="export-history-gone">파일 없음</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

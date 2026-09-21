// 완료 탭 — 완료 작업의 최종본(★)만 렌더 폴더 경로 구조 그대로 물리 저장.
// 프로젝트를 고르면 그 프로젝트의 렌더 폴더 연결 상태를 확인하고, 버튼으로 저장을 실행한다.
// 저장은 로컬 전용(이 PC 디스크). 이미 저장된 건 건너뛴다(멱등).
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { reconcileArrayState, reconcileValueState } from "../../lib/stateReconciliation";
import {
  manageApi,
  type SaveFinalsKind,
  type SaveFinalsResult,
  type SaveFinalsStatus,
} from "../../lib/manageApi";

export function ExportView({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [status, setStatus] = useState<SaveFinalsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveFinalsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pidRef = useRef(pid);
  const seenReloadSignalRef = useRef(reloadSignal);
  const statusRequestRef = useRef(0);
  pidRef.current = pid;

  const loadProjects = () => {
    api
      .projects("team")
      .then((r) => {
        const ps = r.projects.map((p) => ({ pid: p.id, name: p.name }));
        setProjects((previous) => reconcileArrayState(previous, ps));
        setPid((cur) => cur || (ps[0]?.pid ?? ""));
      })
      .catch((e) => setErr(String(e?.message || e)));
  };

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStatus = (p: string) => {
    const requestId = ++statusRequestRef.current;
    if (!p) {
      setStatus(null);
      return;
    }
    manageApi
      .saveFinalsStatus(p)
      .then((next) => {
        if (statusRequestRef.current === requestId && pidRef.current === p) {
          setStatus((previous) => reconcileValueState(previous, next));
        }
      })
      .catch((e) => {
        if (statusRequestRef.current === requestId && pidRef.current === p)
          setErr(String(e?.message || e));
      });
  };

  useEffect(() => {
    setResult(null);
    setErr(null);
    loadStatus(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  useEffect(() => {
    if (seenReloadSignalRef.current === reloadSignal) return;
    seenReloadSignalRef.current = reloadSignal;
    loadProjects();
    loadStatus(pidRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const renderPath = status?.render_path || "";
  const targets = status?.targets ?? [];
  const serverOutdated = !!status?.server_outdated; // 구서버 — 대상 판정 불가(0건과 구별)
  // 종류별 건수 — final=최종(★) · shared=공유 중이지만 최종은 아닌 것(컷 폴더의 shared/ 에 저장된다). 구백엔드는 kind 가 없다(= final).
  const kindOf = (t: { kind?: SaveFinalsKind }) => t.kind ?? "final";
  const count = (kind: SaveFinalsKind, saved: boolean) =>
    targets.filter((t) => kindOf(t) === kind && !t.reason && t.saved === saved).length;
  const pending = { final: count("final", false), shared: count("shared", false) }; // 새로 저장 가능
  const alreadySaved = { final: count("final", true), shared: count("shared", true) };
  const sharedSupported = status?.shared_supported === true; // 서버가 된다고 한 때만 켠다 — 구버전·조회 실패면 공유 저장만 꺼진다
  const blocked = targets.filter((t) => t.reason); // 저장 불가(사유 있음)
  // 저장 이력은 렌더 폴더 아래 부분만 보여 준다 — 반 폭 칸에서 파일 이름이 잘리지 않게(전체 경로는 툴팁).
  const underRender = (path: string) => {
    const root = renderPath.replace(/[\\/]+$/, "");
    return root && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length).replace(/^[\\/]+/, "") || path : path;
  };
  const canSave = !!pid && !!renderPath && !status?.error && !serverOutdated && !busy;

  const onSave = async (kind: SaveFinalsKind) => {
    if (!canSave) return;
    setBusy(true);
    setResult(null);
    setErr(null);
    try {
      const r = await manageApi.saveFinals(pid, undefined, kind);
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
        <div>
          <h1>완료본 저장</h1>
          <p className="export-desc">
            공유·최종 상태의 생성물을 렌더 폴더의 경로 구조(예: <code>ep001/c0010</code>) 그대로 저장합니다.
            공유본은 그 컷 폴더 안의 <code>shared</code> 폴더에 들어갑니다.
          </p>
        </div>
      </header>

      {/* 위 = 한 장의 판(프로젝트 → 저장 위치 → 건수 → 저장) · 아래 = 왼쪽 저장 대상 / 오른쪽 저장 이력 */}
      <div className="export-cols">
        <div className="export-card">
          <div className="export-fields">
            <label className="export-target">
              <span className="export-target-label">프로젝트</span>
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
            </label>

            <div className="export-target">
              <span className="export-target-label">저장 위치 (렌더 폴더)</span>
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
          </div>

          {serverOutdated && (
            <div className="export-err">
              ⚠ 공유 서버 업데이트가 필요합니다 — 서버가 완료본 저장 대상 조회를 지원하지 않는
              구버전입니다. 서버를 먼저 업데이트한 뒤 다시 시도하세요.
            </div>
          )}

          <div className="export-counts">
            <div className="kind-final">
              <span className="export-kind-label">★ 최종</span>
              <b className={pending.final ? "new" : "zero"}>{pending.final}</b>
              <span>새로 저장</span>
              <b className={alreadySaved.final ? "" : "zero"}>{alreadySaved.final}</b>
              <span>이미 저장</span>
            </div>
            <div className="kind-shared">
              <span className="export-kind-label">공유</span>
              <b className={pending.shared ? "new" : "zero"}>{pending.shared}</b>
              <span>새로 저장</span>
              <b className={alreadySaved.shared ? "" : "zero"}>{alreadySaved.shared}</b>
              <span>이미 저장</span>
            </div>
            <div>
              <span className="export-kind-label">저장 불가</span>
              <b className={blocked.length ? "bad" : "zero"}>{blocked.length}</b>
              <span>원본 없음 등</span>
            </div>
          </div>

          <div className="export-act">
            <button
              className="export-btn"
              disabled={!canSave || !sharedSupported || pending.shared === 0}
              onClick={() => onSave("shared")}
              title={
                sharedSupported
                  ? "공유 중인 것(최종 제외) 중 폴더에 없는 것만 저장 — 컷 폴더의 shared 폴더로"
                  : status?.shared_error
                    ? `공유 목록을 읽지 못했습니다 — ${status.shared_error}`
                    : "공유 서버 업데이트 뒤 쓸 수 있습니다"
              }
            >
              공유 저장 ({pending.shared})
            </button>
            <button
              className="export-btn export-btn-final"
              disabled={!canSave || pending.final === 0}
              onClick={() => onSave("final")}
              title="최종(★)인 것 중 폴더에 없는 것만 저장"
            >
              최종 저장 ({pending.final})
            </button>
            <span className="export-hint">{busy ? "저장 중…" : "이미 저장된 파일은 건너뜁니다."}</span>
          </div>

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

        <div className="export-side">
          <div className="export-history">
            <div className="export-history-head">저장 대상 ({targets.length})</div>
            {targets.length ? (
              <ul className="export-history-list export-target-list">
                {targets.map((t) => (
                  <li key={t.gen_id}>
                    <code className="export-history-path">
                      {[t.folder_path && kindOf(t) === "shared" ? t.folder_path + "/shared" : t.folder_path, t.filename].filter(Boolean).join(" · ") ||
                        t.gen_id.slice(0, 8)}
                    </code>
                    {t.reason && <span className="export-target-reason">{t.reason}</span>}
                    <span className={"export-badge kind-" + kindOf(t)}>{kindOf(t) === "final" ? "최종" : "공유"}</span>
                    <span className={"export-badge " + (t.reason ? "bad" : t.saved ? "done" : "new")}>
                      {t.reason ? "저장 불가" : t.saved ? "이미 저장" : "새로 저장"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : status && !serverOutdated ? (
              <div className="export-hint">저장할 최종본이 없습니다.</div>
            ) : null}
          </div>

          {status && status.history.length > 0 && (
            <div className="export-history">
              <div className="export-history-head">저장 이력 ({status.history.length})</div>
              <ul className="export-history-list">
                {status.history.map((h) => (
                  <li key={h.gen_id} className={h.exists ? "" : "missing"}>
                    <span className="export-history-when">{h.exported_at}</span>
                    <code className="export-history-path" title={h.dest_path}>{underRender(h.dest_path)}</code>
                    {!h.exists && <span className="export-history-gone">파일 없음</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 완료 탭 — 완료 작업의 최종본(★)만 렌더 폴더 경로 구조 그대로 물리 저장.
// 프로젝트를 고르면 그 프로젝트의 렌더 폴더 연결 상태를 확인하고, 버튼으로 저장을 실행한다.
// 저장은 로컬 전용(이 PC 디스크). 이미 저장된 건 건너뛴다(멱등).
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { reconcileArrayState, reconcileValueState } from "../../lib/stateReconciliation";
import {
  manageApi,
  type SaveFinalsCompare,
  type SaveFinalsKind,
  type SaveFinalsResult,
  type SaveFinalsStatus,
} from "../../lib/manageApi";

// 비교 = 마주 도는 두 화살표 · 미러 = 굵은 오른쪽 화살표 · 업데이트 = 꺾쇠(Jay 지정 2026-09-21).
const ICON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const CompareIcon = () => (
  <svg {...ICON} strokeWidth={2.5}>
    <path d="M4 11V9a2 2 0 0 1 2-2h12" />
    <path d="M15 3.5 18.5 7 15 10.5" />
    <path d="M20 13v2a2 2 0 0 1-2 2H6" />
    <path d="M9 13.5 5.5 17 9 20.5" />
  </svg>
);
const MirrorIcon = () => (
  <svg {...ICON}>
    <path d="M3.5 9.5h9v-4l8 6.5-8 6.5v-4h-9z" fill="currentColor" stroke="none" />
  </svg>
);
const UpdateIcon = () => (
  <svg {...ICON} strokeWidth={2.8}>
    <path d="M8.5 4.5 16 12l-7.5 7.5" />
  </svg>
);

export function ExportView({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const [projects, setProjects] = useState<{ pid: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [status, setStatus] = useState<SaveFinalsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveFinalsResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 비교 결과 — 미러·업데이트는 이것이 있을 때만 켜진다. 프로젝트를 바꾸거나 저장·새로고침으로 상태가 달라지면 버린다(낡은 비교로 실행 금지).
  const [compare, setCompare] = useState<SaveFinalsCompare | null>(null);
  const [comparing, setComparing] = useState(false);
  const compareRequestRef = useRef(0);
  const dropCompare = () => {
    compareRequestRef.current += 1;
    setCompare(null);
    setComparing(false);
  };
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
    dropCompare();
    loadStatus(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  useEffect(() => {
    if (seenReloadSignalRef.current === reloadSignal) return;
    seenReloadSignalRef.current = reloadSignal;
    dropCompare();
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

  const onCompare = async () => {
    if (!canSave || comparing) return;
    const requestId = ++compareRequestRef.current;
    setComparing(true);
    setErr(null);
    try {
      const next = await manageApi.saveFinalsCompare(pid);
      if (compareRequestRef.current === requestId) setCompare(next);
    } catch (e: any) {
      if (compareRequestRef.current === requestId) setErr(String(e?.message || e));
    } finally {
      if (compareRequestRef.current === requestId) setComparing(false);
    }
  };

  const onSave = async (kind: SaveFinalsKind | "all") => {
    if (!canSave) return;
    dropCompare(); // 저장하면 폴더가 달라진다 — 다시 비교해야 미러·업데이트가 켜진다
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
            <span className="export-act-sep" />
            <button
              type="button"
              className={"export-icon-btn" + (compare ? " on" : "")}
              disabled={!canSave || comparing}
              onClick={onCompare}
              title="비교 — 프로그램에 있는 것(공유+최종)과 렌더 폴더를 견준다. 읽기만 한다"
              aria-label="비교"
              aria-pressed={!!compare}
            >
              <CompareIcon />
            </button>
            {/* 미러는 파일을 옮기는 첫 기능이라, 여러 PC 가 같은 폴더를 쓸 때의 안전장치(협력 잠금·공유 저장 목록)를 넣은 뒤에 연다. */}
            <button type="button" className="export-ghost-btn danger" disabled title="준비 중 — 여러 PC 가 같은 폴더를 쓸 때의 안전장치를 먼저 넣습니다. 지금은 비교에서 '폴더에만 남은 것'을 확인만 할 수 있습니다">
              <MirrorIcon />
              미러{compare ? ` (+${compare.to_add.length} · −${compare.extra.length})` : ""}
            </button>
            <button
              type="button"
              className="export-ghost-btn"
              disabled={!canSave || !compare || compare.to_add.length === 0}
              onClick={() => onSave("all")}
              title={compare ? "새로 저장할 것만 올린다(공유+최종)" : "비교를 먼저 실행하세요"}
            >
              <UpdateIcon />
              업데이트{compare ? ` (+${compare.to_add.length})` : ""}
            </button>
            <span className="export-hint export-hint-two">
              <b>미러</b>는 똑같이 맞춘다.
              <br />
              <b>업데이트</b>는 추가된 것만 올린다.
            </span>
          </div>
          <span className="export-hint">{busy ? "저장 중…" : comparing ? "비교하는 중…" : "이미 저장된 파일은 건너뜁니다."}</span>

          {err && <div className="export-err">실패: {err}</div>}

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

        {compare && (
          <div className="export-compare">
            <div className="export-compare-head">
              <b>비교 결과</b>
              <span className="export-pill add">새로 저장할 것 {compare.to_add.length}</span>
              <span className="export-pill rm">폴더에만 남은 것 {compare.extra.length}</span>
              <span className="export-pill">같음 {compare.same}</span>
              {compare.blocked.length > 0 && <span className="export-pill unk">저장 불가 {compare.blocked.length}</span>}
              {compare.unknown > 0 && <span className="export-pill unk">모르는 파일 {compare.unknown} · 건드리지 않음</span>}
            </div>
            {[
              { key: "add", sign: "+", title: "새로 저장할 것 — 프로그램에는 있는데 폴더에 없다(업데이트가 저장)", items: compare.to_add },
              { key: "rm", sign: "−", title: "폴더에만 남은 것 — 우리 파일인데 프로그램에서는 더 이상 저장 대상이 아니다(미러가 정리할 것)", items: compare.extra },
            ].map((group) =>
              group.items.length ? (
                <div key={group.key} className="export-compare-group">
                  <div className="export-history-head">{group.title}</div>
                  <ul className="export-history-list export-target-list">
                    {group.items.map((item) => (
                      <li key={group.key + item.folder_path + item.filename}>
                        <span className={"export-sign " + group.key}>{group.sign}</span>
                        <code className="export-history-path">{item.folder_path} · {item.filename}</code>
                        <span className={"export-badge kind-" + item.kind}>{item.kind === "final" ? "최종" : "공유"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            {!compare.to_add.length && !compare.extra.length && <div className="export-hint export-compare-group">폴더가 프로그램과 같습니다.</div>}
          </div>
        )}

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

// 관리자 창 · 에셋 대장(2026-09-30, docs/ASSET_REGISTRY.md) — 프로젝트별 마지막 훑기 상태와 수동 훑기.
// 합의안 12절 R7: 루트별 상태·시각·파일 수·처리량·오류 수만 보인다(경로 목록은 보이지 않는다).
import { useCallback, useEffect, useState } from "react";
import { assetRegistryApi, type AssetRegistryScanRow, type AssetRegistryStatus } from "../../lib/assetRegistryApi";

const STATE_LABEL: Record<string, string> = { ok: "완료", partial: "일부 대기", failed: "실패" };

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function AssetRegistryTab() {
  const [status, setStatus] = useState<AssetRegistryStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await assetRegistryApi.status());
    } catch (error) {
      setMsg(`상태를 읽지 못했습니다(${error instanceof Error ? error.message : "오류"}) — 공유 서버가 옛 버전일 수 있습니다.`);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // 도는 동안만 5초마다 다시 읽는다.
  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [status?.running, load]);

  const scanNow = async () => {
    setConfirming(false);
    try {
      await assetRegistryApi.scan();
      setMsg("훑기를 시작했습니다. 끝나면 아래 표가 바뀝니다.");
    } catch (error) {
      setMsg(`시작하지 못했습니다(${error instanceof Error ? error.message : "오류"}).`);
    }
    void load();
  };

  const row = (p: AssetRegistryScanRow) => {
    const count = status?.counts[p.project_id] || {};
    const waiting = status?.waiting_large[p.project_id] || 0;
    return (
      <tr key={p.project_id}>
        <td>{p.name || p.project_id}</td>
        <td title={p.note || undefined}>{STATE_LABEL[p.state] || p.state}</td>
        <td>{p.files.toLocaleString()}</td>
        <td>
          {(count.present || 0).toLocaleString()}
          {count.missing ? ` · 없어짐 ${count.missing.toLocaleString()}` : ""}
        </td>
        <td>
          {p.hashed.toLocaleString()} · {size(p.hashed_bytes)}
        </td>
        <td>
          {p.undetermined + p.pending ? `${p.undetermined} · ${p.pending}` : "—"}
          {waiting ? ` (큰 파일 ${waiting} 수동 대기)` : ""}
        </td>
        <td>{duration(p.elapsed_ms)}</td>
        <td>{when(p.finished_at)}</td>
      </tr>
    );
  };

  return (
    <section className="admin-section">
      <div className="admin-note-sub">
        공유 서버가 PM 프로젝트 폴더의 그림마다 번호를 붙여, 이름을 바꾸거나 옮겨도 캔버스 레퍼런스가 따라가게 합니다.
        첫 전체 훑기는 NAS 를 천천히(초당 8MB) 읽어 약 30분 걸리니 사람이 적은 시간에 누릅니다.
      </div>
      <h4>상태</h4>
      {!status ? (
        <div className="admin-empty">읽는 중…</div>
      ) : !status.enabled ? (
        <div className="admin-empty">꺼져 있습니다 — 공유 서버에서 CONTENT_HUB_ASSET_REGISTRY=1 로 켭니다.</div>
      ) : (
        <div className="admin-note-sub">
          {status.running
            ? `훑는 중: ${status.current.name || status.current.project_id || ""} (${status.current.phase === "large" ? "큰 파일" : "목록·지문"})`
            : `쉬는 중 · 자동 ${status.interval_min > 0 ? `${status.interval_min}분마다` : "없음(수동만)"}`}
        </div>
      )}
      {msg && <div className="admin-act-msg">{msg}</div>}
      {status?.enabled && !status.running && (
        <div className="admin-acct-actions">
          {confirming ? (
            <>
              <span>NAS 를 오래 읽습니다. 시작할까요?</span>
              <button className="admin-mini-btn" onClick={() => void scanNow()}>
                시작
              </button>
              <button className="admin-mini-btn" onClick={() => setConfirming(false)}>
                취소
              </button>
            </>
          ) : (
            <button className="admin-mini-btn" onClick={() => setConfirming(true)}>
              지금 훑기
            </button>
          )}
        </div>
      )}
      {status && status.projects.length > 0 && (
        <table className="admin-table">
          <thead>
            <tr>
              <th>프로젝트</th>
              <th>상태</th>
              <th>파일</th>
              <th>대장</th>
              <th>이번에 읽음</th>
              <th>미판정 · 대기</th>
              <th>걸린 시간</th>
              <th>마지막</th>
            </tr>
          </thead>
          <tbody>{status.projects.map(row)}</tbody>
        </table>
      )}
      {status?.enabled && status.projects.length === 0 && <div className="admin-empty">아직 훑은 적이 없습니다.</div>}
    </section>
  );
}

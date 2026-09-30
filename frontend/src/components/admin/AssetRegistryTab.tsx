// 관리자 창 · 에셋 대장(2026-09-30, docs/ASSET_REGISTRY.md) — 프로젝트별 마지막 훑기 상태와 수동 훑기.
// 합의안 12절 R7: 루트별 상태·시각·파일 수·처리량·오류 수만 보인다(경로 목록은 보이지 않는다).
// 서버가 NAS 를 못 읽으면 [이 PC 에서 훑기] — 이 PC(관리자)가 대신 훑어 서버에 올린다(§10, 서버가 helper_enabled 일 때만).
import { useCallback, useEffect, useState } from "react";
import {
  assetRegistryApi,
  type AssetRegistryScanRow,
  type AssetRegistryStatus,
  type RegistryHelperStatus,
} from "../../lib/assetRegistryApi";

const STATE_LABEL: Record<string, string> = { ok: "완료", partial: "일부 대기", failed: "실패", aborted: "멈춤" };

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
  // 좁은 관리자 창의 표 한 칸에 들어가게 짧게(9/30 14:08)
  const short = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } as const;
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", short);
}

const errText = (error: unknown) => (error instanceof Error ? error.message : "오류");

export function AssetRegistryTab() {
  const [status, setStatus] = useState<AssetRegistryStatus | null>(null);
  const [helper, setHelper] = useState<RegistryHelperStatus | null>(null);
  const [msg, setMsg] = useState("");
  const [confirming, setConfirming] = useState<"" | "server" | "helper">("");

  const load = useCallback(async () => {
    let next: AssetRegistryStatus | null = null;
    try {
      next = await assetRegistryApi.status();
      setStatus(next);
    } catch (error) {
      setMsg(`상태를 읽지 못했습니다(${errText(error)}) — 공유 서버가 옛 버전일 수 있습니다.`);
    }
    // 이 PC 의 도우미 상태 — 로컬 허브가 아닌 곳(서버 화면을 원격으로 연 경우)에선 없다
    if (next?.helper_enabled) setHelper(await assetRegistryApi.helperStatus().catch(() => null));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // 서버·이 PC·다른 도우미 PC 어느 쪽이든 도는 동안만 5초마다 다시 읽는다.
  const busy = Boolean(status?.running || status?.lease || helper?.running);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const start = async (which: "server" | "helper") => {
    setConfirming("");
    try {
      await (which === "server" ? assetRegistryApi.scan() : assetRegistryApi.helperScan());
      setMsg(
        which === "server"
          ? "훑기를 시작했습니다. 끝나면 아래 표가 바뀝니다."
          : "이 PC 에서 훑기를 시작했습니다. 앱을 켜 둔 채로 두면 끝나고 아래 표가 바뀝니다.",
      );
    } catch (error) {
      setMsg(`시작하지 못했습니다(${errText(error)}).`);
    }
    void load();
  };

  const confirmOrButton = (which: "server" | "helper", label: string, ask: string) =>
    confirming === which ? (
      <>
        <span>{ask}</span>
        <button className="admin-mini-btn" onClick={() => void start(which)}>
          시작
        </button>
        <button className="admin-mini-btn" onClick={() => setConfirming("")}>
          취소
        </button>
      </>
    ) : (
      <button className="admin-mini-btn" onClick={() => setConfirming(which)}>
        {label}
      </button>
    );

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

  const on = Boolean(status?.enabled || status?.helper_enabled);
  const idle = !status?.running && !status?.lease && !helper?.running;
  return (
    <section className="admin-section">
      <div className="admin-note-sub">
        공유 서버가 PM 프로젝트 폴더의 그림마다 번호를 붙여, 이름을 바꾸거나 옮겨도 캔버스 레퍼런스가 따라가게 합니다.
        첫 전체 훑기는 NAS 를 천천히(초당 8MB) 읽어 약 30분 걸리니 사람이 적은 시간에 누릅니다.
      </div>
      <h4>상태</h4>
      {!status ? (
        <div className="admin-empty">읽는 중…</div>
      ) : !on ? (
        <div className="admin-empty">
          꺼져 있습니다 — 공유 서버에서 CONTENT_HUB_ASSET_REGISTRY=1(서버가 훑기) 또는
          CONTENT_HUB_ASSET_REGISTRY_HELPER=1(관리자 PC 가 훑기)로 켭니다.
        </div>
      ) : (
        <div className="admin-note-sub">
          {status.running
            ? `훑는 중: ${status.current.name || status.current.project_id || ""} (${status.current.phase === "large" ? "큰 파일" : "목록·지문"})`
            : status.lease
              ? `도우미 PC 가 훑는 중: ${status.lease.name || status.lease.project_id}`
              : `쉬는 중 · 자동 ${status.enabled && status.interval_min > 0 ? `${status.interval_min}분마다` : "없음(수동만)"}`}
        </div>
      )}
      {msg && <div className="admin-act-msg">{msg}</div>}
      {status?.enabled && idle && (
        <div className="admin-acct-actions">{confirmOrButton("server", "지금 훑기", "NAS 를 오래 읽습니다. 시작할까요?")}</div>
      )}
      {status?.helper_enabled && (
        <>
          <div className="admin-note-sub">
            서버가 NAS 를 못 읽을 때는 이 PC 가 대신 훑어 올립니다(이 PC 의 NAS 연결을 씁니다). 끝날 때까지 앱을 켜 둡니다.
          </div>
          {helper?.running && (
            <div className="admin-note-sub">이 PC 에서 훑는 중: {helper.current.name || helper.current.project_id || "준비 중"}</div>
          )}
          {helper?.abort && <div className="admin-act-msg">이 PC 훑기를 멈췄습니다 — {helper.abort}</div>}
          {!helper?.running && (helper?.results.length || 0) > 0 && (
            <div className="admin-note-sub">
              이 PC 의 마지막 훑기:{" "}
              {helper!.results
                .map((r) => `${r.name || r.project_id} ${STATE_LABEL[r.state] || r.state}${r.note ? `(${r.note})` : ""}`)
                .join(" · ")}
            </div>
          )}
          {idle && helper && (
            <div className="admin-acct-actions">
              {confirmOrButton("helper", "이 PC 에서 훑기", "이 PC 로 NAS 를 오래 읽습니다. 시작할까요?")}
            </div>
          )}
        </>
      )}
      {status && status.projects.length > 0 && (
        <div className="admin-registry-wrap">
          <table className="admin-table admin-registry">
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
        </div>
      )}
      {on && status?.projects.length === 0 && <div className="admin-empty">아직 훑은 적이 없습니다.</div>}
    </section>
  );
}

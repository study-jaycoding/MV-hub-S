// 관리자 창 · 공유 서버 탭 — 서버 백업 복사 위치(2026-10-02 설계 r5 · Codex 승인, Jay 모의 화면 승인).
// 공유 서버가 매일 만드는 DB 백업을 NAS 로 한 번 더 복사하는 예약 작업의 위치·결과를 보여 주고 바꾼다.
// [저장]은 매번 내 비밀번호를 다시 확인한다(백업에 계정 정보가 들어 있어 위치 = 반출 경로). [지금 복사]는 관리자면 바로.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  backupReplicaApi,
  looksLikeUnc,
  runFinished,
  type BackupReplicaRunStart,
  type BackupReplicaStatus,
} from "../../lib/backupReplicaApi";
import { HttpError, isRouteMissing } from "../../lib/http";
import { useEscapeClose } from "../../lib/useEscapeClose";

const POLL_MS = 5000;
const POLL_LIMIT_MS = 30 * 60 * 1000;

const ERROR_TEXT: Record<string, string> = {
  target_unavailable: "복사 위치에 접근할 수 없습니다 — NAS 주소와 서버 PC 의 쓰기 권한을 확인하세요",
  target_unsafe: "복사 위치가 원본 백업 폴더와 겹칩니다 — 다른 위치를 지정하세요",
  copy_failed: "일부 파일을 복사하지 못했습니다",
  source_unavailable: "원본 백업 폴더를 읽지 못했습니다",
  target_not_configured: "복사 위치가 없습니다",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}. ${d.getDate()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const errText = (error: unknown) =>
  error instanceof HttpError ? error.detail : error instanceof Error ? error.message : "오류";

type Tone = "ok" | "bad" | "warn" | "off";
interface View { tone: Tone; head: string; lines: string[] }

/** 결과 상자 한 개의 모양 — 위치·결과·예약 작업 상태를 따로 읽고, '0건 성공'을 백업 확보로 보이지 않게 한다. */
export function replicaView(status: BackupReplicaStatus, copying: boolean): View {
  if (!status.target) {
    return { tone: "off", head: "복사 위치가 없습니다", lines: ["백업이 서버 PC 디스크에만 있습니다 — 서버가 고장 나면 같이 잃을 수 있습니다"] };
  }
  if (copying) {
    return { tone: "off", head: "복사 중…", lines: ["몇 분 걸릴 수 있습니다 — 창을 닫아도 서버에서 계속됩니다"] };
  }
  const result = status.result;
  if (!result || result.state === "never_run") {
    return { tone: "warn", head: "아직 복사한 적 없음", lines: ["[지금 복사]로 바로 확인할 수 있습니다"] };
  }
  if (result.state === "state_unavailable") {
    return { tone: "warn", head: "복사 결과를 읽지 못했습니다", lines: [] };
  }
  const lines: string[] = [];
  const otherPlace = Boolean(result.target_id && status.target_id && result.target_id !== status.target_id);
  if (!result.target_id) lines.push("이전 버전 기록 — 어느 위치로 복사했는지는 확인되지 않습니다");
  let view: View;
  if (result.state === "failed") {
    lines.unshift(ERROR_TEXT[result.error_code || ""] || `복사 실패(${result.error_code || "원인 미상"})`);
    if (result.last_success_at) lines.push(`마지막 성공 ${when(result.last_success_at)}`);
    view = { tone: "bad", head: `마지막 복사 실패 · ${when(result.last_attempt_at)}`, lines };
  } else if (result.state === "success" && result.copied === 0 && result.skipped === 0) {
    view = { tone: "off", head: `복사할 백업 파일 없음 · ${when(result.last_attempt_at)}`, lines: ["원본 백업 폴더가 비어 있습니다", ...lines] };
  } else if (result.state === "success") {
    lines.unshift(`새로 복사 ${result.copied} · 이미 있음 ${result.skipped} · 실패 ${result.failed}`);
    view = { tone: "ok", head: `마지막 복사 성공 · ${when(result.last_attempt_at)}`, lines };
  } else if (result.state === "no_source") {
    view = { tone: "off", head: "원본 백업 폴더가 아직 없습니다", lines };
  } else {
    view = { tone: "warn", head: `복사 상태: ${result.state}`, lines };
  }
  if (otherPlace) {
    return { tone: "warn", head: "새 위치로는 아직 복사 안 함", lines: ["아래는 이전 위치의 결과입니다 — [지금 복사]로 바로 확인할 수 있습니다", `${view.head}`] };
  }
  return view;
}

/** 예약 작업·서버 실행 계정·옛 설정 경고 — [지금 복사]를 막는 것과 안내만 하는 것. */
function warnings(status: BackupReplicaStatus): { blockRun: boolean; notes: string[] } {
  const notes: string[] = [];
  const task = status.task;
  let blockRun = false;
  if (!task) {
    notes.push("서버의 예약 작업 상태를 읽지 못했습니다 — 잠시 뒤 다시 열어 보세요");
    blockRun = true;
  } else if (!task.exists) {
    notes.push("예약 작업(MVHub BackupCopy)이 없습니다 — 서버 PC 에서 register_autostart.bat 을 실행하세요");
    blockRun = true;
  } else {
    if (!task.enabled) { notes.push("예약 작업이 꺼져 있습니다 — 매일 복사가 일어나지 않습니다"); blockRun = true; }
    if (!task.matches_install) { notes.push("예약 작업이 이 서버 설치를 가리키지 않습니다 — 서버 PC 에서 다시 등록하세요"); blockRun = true; }
    else if (!task.ignore_new) { notes.push("예약 작업의 동시 실행 설정이 달라 [지금 복사]를 막았습니다"); blockRun = true; }
  }
  if (status.target && status.target_garbled) notes.push("설정 글자가 깨져 있습니다 — 위치를 다시 입력해 저장하세요");
  // NAS 형식(unc_format_error)이 아닌 모든 값 — 대개 드라이브 글자 경로. 서버 PC 의 실제 디스크면 그대로 써도 된다(예약 작업이 본다).
  // 막아야 하는 건 Z: 같은 연결 드라이브. 형식이 깨진 NAS 주소일 수도 있어 '드라이브 경로'로 단정하지 않는다(2026-10-02 Jay·Claude 검토)
  else if (status.target && !status.target_is_unc) notes.push("NAS 주소 형식이 아닙니다 — 서버 PC 안의 디스크 경로라면 그대로 써도 됩니다. Z: 같은 네트워크 연결 드라이브라면 예약 작업이 못 보니 NAS 주소로 바꾸세요");
  if (!status.server_account_system) notes.push("서버가 예약 작업(SYSTEM)으로 돌고 있지 않아 [저장] 때 확인이 실제 복사와 다를 수 있습니다");
  return { blockRun, notes };
}

/** onDialogOpenChange — 비밀번호 확인창이 열렸는지 관리자 창에 알린다. 같은 Esc 를 관리자 창도 받으므로 그쪽은 건너뛰고
 *  이 확인창만 닫는다(프로젝트 탭과 같은 방식, Codex main 검토 P2-2). 저장 중에는 Esc 로 아무것도 닫지 않는다. */
export function BackupReplicaSection({ onDialogOpenChange }: { onDialogOpenChange?: (open: boolean) => void } = {}) {
  const [status, setStatus] = useState<BackupReplicaStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmMsg, setConfirmMsg] = useState("");
  const [copying, setCopying] = useState(false);
  const pollRef = useRef<number | null>(null);
  const deadlineRef = useRef<number | null>(null); // 30분 종료 — 조회가 응답 없이 멈춰도 따로 돈다(Codex 설계 r1)
  const watchRef = useRef<object | null>(null); // 지금 감시의 표 — 끊은 감시의 늦은 응답이 다음 조회를 예약하지 않게
  const aliveRef = useRef(true);
  const seqRef = useRef(0); // 늦게 온 옛 응답이 새 상태를 덮지 않게

  const stopPoll = useCallback(() => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    if (deadlineRef.current !== null) window.clearTimeout(deadlineRef.current);
    pollRef.current = deadlineRef.current = null;
    watchRef.current = null;
  }, []);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopPoll();
    };
  }, [stopPoll]);

  const apply = useCallback((next: BackupReplicaStatus) => {
    setStatus(next);
    setDraft(next.target || "");
  }, []);

  /** 복사가 끝날 때까지 다시 읽는다 — 앞 조회가 끝난 뒤 5초 뒤에 다음 조회(한 번에 하나). 조회가 5초보다 느려도 응답을
   *  버리지 않는다(예전 setInterval 은 매번 새 요청이 앞 응답을 무효로 만들었다, Codex main 검토 P2-3).
   *  start 가 있으면 '이번 실행' 끝, 없으면(이미 돌던 복사) 작업이 멈출 때까지. 30분 제한은 따로 도는 타이머다 — 조회가
   *  응답 없이 멈춰도(요청 제한시간 없음) 끝난다. 끝낸 뒤 늦게 온 응답은 화면도 다음 조회도 바꾸지 못한다(감시 표). */
  const watch = useCallback((start: BackupReplicaRunStart | null) => {
    stopPoll();
    setCopying(true);
    const me = {};
    watchRef.current = me;
    deadlineRef.current = window.setTimeout(() => {
      if (!aliveRef.current || watchRef.current !== me) return;
      stopPoll();
      setCopying(false);
      setMsg("확인 시간 초과 — 복사는 서버에서 계속될 수 있습니다. 나중에 다시 열어 확인하세요.");
    }, POLL_LIMIT_MS);
    const tick = () => {
      pollRef.current = null;
      if (!aliveRef.current || watchRef.current !== me) return;
      const seq = ++seqRef.current;
      backupReplicaApi
        .status()
        .then((next) => {
          if (!aliveRef.current || seq !== seqRef.current || watchRef.current !== me) return;
          setStatus(next);
          if (start ? runFinished(next, start) : !next.task?.running) {
            stopPoll();
            setCopying(false);
          }
        })
        .catch(() => undefined) // 한 번 못 읽어도 다음 주기에 다시 본다
        .finally(() => {
          if (aliveRef.current && watchRef.current === me) pollRef.current = window.setTimeout(tick, POLL_MS);
        });
    };
    pollRef.current = window.setTimeout(tick, POLL_MS);
  }, [stopPoll]);

  useEffect(() => {
    const seq = ++seqRef.current;
    backupReplicaApi
      .status()
      .then((next) => {
        if (!aliveRef.current || seq !== seqRef.current) return;
        apply(next);
        if (next.task?.running) watch(null); // 예약 복사가 도는 중에 열었으면 끝날 때까지 갱신
      })
      .catch((error) => {
        if (!aliveRef.current) return;
        if (isRouteMissing(error)) setUnsupported(true);
        else setMsg(`상태를 읽지 못했습니다(${errText(error)})`);
      });
  }, [apply, watch]);

  useEscapeClose(() => setConfirming(false), confirming && !busy);
  useEffect(() => {
    if (!confirming) return;
    onDialogOpenChange?.(true);
    return () => onDialogOpenChange?.(false);
  }, [confirming, onDialogOpenChange]);

  const save = async () => {
    if (!status) return;
    setBusy(true);
    setConfirmMsg("");
    try {
      const next = await backupReplicaApi.save(draft.trim(), status.target_id, password);
      apply(next);
      setConfirming(false);
      setMsg(next.audit_warning ? "바꿨습니다(감사 결과 기록 실패 — 바꾸려 한 기록은 남았습니다)" : "바꿨습니다. 다음 복사부터 이 위치를 씁니다.");
    } catch (error) {
      setConfirmMsg(errText(error));
    } finally {
      setPassword("");
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setMsg("");
    let start: BackupReplicaRunStart;
    try {
      start = await backupReplicaApi.run();
    } catch (error) {
      if (aliveRef.current) {
        setMsg(`지금 복사를 시작하지 못했습니다(${errText(error)})`);
        setBusy(false);
      }
      return;
    }
    if (!aliveRef.current) return; // 응답 전에 창을 닫았으면 타이머를 새로 만들지 않는다
    setBusy(false);
    watch(start);
  };

  if (unsupported) {
    return (
      <section className="admin-section">
        <h4>서버 백업 복사 위치</h4>
        <div className="admin-note-sub">공유 서버를 업데이트한 뒤 사용할 수 있습니다.</div>
      </section>
    );
  }
  if (status && !status.applicable) return null;

  const view = status ? replicaView(status, copying || Boolean(status.task?.running)) : null;
  const warn = status ? warnings(status) : { blockRun: true, notes: [] };
  const editable = Boolean(status?.editable);
  const changed = draft.trim() !== (status?.target || "");
  const draftOk = looksLikeUnc(draft);

  return (
    <section className="admin-section backup-replica">
      <h4>서버 백업 복사 위치</h4>
      <div className="admin-note-sub">
        공유 서버가 매일 자동으로 만드는 <b>DB 백업</b>(서버 PC 디스크, 최근 7개)과 팀원 백업을 <b>매일 03:30</b> 아래
        위치로 한 번 더 복사합니다(최근 30개). 서버 PC가 고장 나도 남도록 <b>서버 밖 NAS</b>를 지정하세요. 서버 설정이라
        모든 관리자에게 같게 보입니다.
      </div>
      {view ? (
        <div className={`replica-status ${view.tone}`} role="status">
          <div className="head"><span className="dot" />{view.head}</div>
          {view.lines.map((line) => <div className="meta" key={line}>{line}</div>)}
          {status?.target ? <div className="meta">지금 위치 <span className="path">{status.target}</span></div> : null}
        </div>
      ) : (
        <div className="admin-loading">불러오는 중…</div>
      )}
      {warn.notes.map((note) => <div className="replica-warn" key={note}>⚠ {note}</div>)}
      <input
        className="settings-input"
        placeholder="\\NAS\공유폴더\mvhub_backup"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={!editable || busy}
        aria-label="백업 복사 위치"
        style={{ maxWidth: 420 }}
      />
      {status && !editable && status.lock_reason ? <div className="replica-warn">{status.lock_reason}</div> : null}
      {changed && draft.trim() && !draftOk ? <div className="replica-warn">\\서버\공유폴더 처럼 NAS 주소를 적어 주세요</div> : null}
      <div className="replica-actions">
        <button
          className="settings-action"
          disabled={!editable || busy || !changed || !draftOk}
          onClick={() => { setConfirmMsg(""); setPassword(""); setConfirming(true); }}
        >
          저장
        </button>
        <button
          className="settings-action"
          disabled={busy || copying || !status?.target || warn.blockRun || Boolean(status?.task?.running)}
          onClick={() => void runNow()}
        >
          지금 복사
        </button>
      </div>
      {msg ? <p className="replica-msg">{msg}</p> : null}
      <div className="admin-note-sub" style={{ marginTop: 10 }}>
        ⓘ <b>\\NAS\공유폴더\…</b> 처럼 NAS 주소를 적습니다(Z:·D: 같은 드라이브 글자는 받지 않습니다). <b>[저장]</b>은 내
        비밀번호를 한 번 더 확인하고, 서버가 그 위치에 실제로 쓸 수 있는지 시험한 뒤 바꿉니다. <b>[지금 복사]</b>는 새벽까지
        기다리지 않고 지금 한 번 복사합니다.
      </div>

      {confirming ? (
        <div className="admin-confirm-backdrop" onMouseDown={() => !busy && setConfirming(false)}>
          <div className="admin-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <p className="admin-confirm-q">
              백업 위치를 <b>{draft.trim()}</b> 로 바꿉니다.
              <br />
              <span className="replica-warn-inline">
                ⚠ 이 위치에 들어갈 수 있는 사람은 계정 정보가 든 백업을 가져갈 수 있습니다. 믿을 수 있는 곳입니까?
              </span>
            </p>
            <input
              className="settings-input"
              type="password"
              placeholder="현재 내 비밀번호"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && password && !busy && void save()}
              autoFocus
              style={{ marginBottom: 12 }}
            />
            {confirmMsg ? <div className="login-error">{confirmMsg}</div> : null}
            <div className="admin-confirm-actions">
              <button className="admin-confirm-yes" disabled={busy || !password} onClick={() => void save()}>
                {busy ? "확인 중…" : "바꾸기"}
              </button>
              <button className="admin-confirm-no" disabled={busy} onClick={() => setConfirming(false)}>취소</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// 업데이트 진행 덮개 — 업데이트를 누르면 화면 가운데에 떠서 진행을 알린다(Jay 2026-09-28).
//
// 왜 따로 도는가: 업데이트를 시작하는 자리가 둘(설정 패널·알림센터)이고, 설정 패널은 닫히면
// 언마운트돼 진행을 놓친다. 그래서 이 덮개는 앱에 상주하며 **시작 신호**(startReleaseUpdate)와
// 새로고침 뒤 남는 **대기 표시**(sessionStorage)만 보고 스스로 상태를 묻는다.
// 평소에는 아무 요청도 하지 않는다.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  UPDATE_STAGES,
  UPDATE_WAIT_VERSION_KEY,
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  onReleaseUpdateStarted,
  pollFailureMessage,
  releaseUpdateMessage,
  startReleaseUpdate,
  updateBlockersText,
  updateStageIndex,
  type ReleaseUpdateStatus,
} from "../lib/releaseUpdate";

const POLL_MS = 1500;
const DEADLINE_MS = 5 * 60 * 1000;

function waitVersion(): string {
  try {
    return window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY) || "";
  } catch {
    return ""; // 사생활 보호 창 등 — 없으면 시작 신호만으로 동작한다
  }
}

function clearWait(): void {
  try {
    window.sessionStorage.removeItem(UPDATE_WAIT_VERSION_KEY);
  } catch {
    // ignore
  }
}

export function UpdateProgressOverlay() {
  const [open, setOpen] = useState(() => !!waitVersion());
  const [status, setStatus] = useState<ReleaseUpdateStatus | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false); // 실패·시간초과 — 폴링을 멈추고 단추를 내준다
  const [forcing, setForcing] = useState(false);
  const [forceError, setForceError] = useState("");
  const [confirmForce, setConfirmForce] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 어느 경로로 시작하든(설정·알림센터) 같은 신호를 받는다.
  useEffect(
    () =>
      onReleaseUpdateStarted(() => {
        setStatus(null);
        setNote("");
        setDone(false);
        setForcing(false);
        setForceError("");
        setConfirmForce(false);
        setOpen(true);
      }),
    [],
  );

  // 덮개는 마우스뿐 아니라 **키보드도** 막아야 한다. 막지 않으면 뒤 화면에 남은 포커스로
  // Tab·Enter 가 그대로 들어간다(Codex 지적, 2026-09-28). 포커스가 밖으로 나가면 되돌린다.
  useEffect(() => {
    if (!open) return;
    boxRef.current?.focus();
    const keepInside = (event: FocusEvent) => {
      const box = boxRef.current;
      if (box && event.target instanceof Node && !box.contains(event.target)) {
        event.stopPropagation();
        box.focus();
      }
    };
    document.addEventListener("focusin", keepInside, true);
    return () => document.removeEventListener("focusin", keepInside, true);
  }, [open]);

  useEffect(() => {
    if (!open || done) return;
    let cancelled = false;
    let timer = 0;
    let firstFailedAt: number | null = null;
    let idleHits = 0; // 진행 중이 아닌 응답을 연달아 받은 횟수
    // 제한 시간은 요청과 따로 잰다 — 상태 요청이 끝나지 않으면 await 뒤의 시간 검사에 닿지 못해 5분이 지나도 덮개가
    // 화면을 막았다(2026-10-03 점검 CXF-6). 만료되면 늦게 오는 응답은 버린다(cancelled).
    const limit = window.setTimeout(() => {
      cancelled = true;
      window.clearTimeout(timer);
      // 대기 표시를 지운다 — 남겨 두면 다음 새로고침에 덮개가 다시 떠서 앱을 5분 더 가린다
      // (Codex 지적, 2026-09-28).
      clearWait();
      setNote(
        "자동 확인 시간이 초과됐습니다. 프로그램 창과 업데이트 로그(%LOCALAPPDATA%\\MVHub\\updates\\update.log)를 확인해주세요.",
      );
      setDone(true);
    }, DEADLINE_MS);

    const poll = async () => {
      const expected = waitVersion();
      try {
        const next = await getReleaseUpdateStatus(false);
        if (cancelled) return;
        firstFailedAt = null;
        setStatus(next);
        setNote("");
        if (next.state === "failed") {
          clearWait();
          setDone(true);
          return;
        }
        // 완료 판정은 설정 패널과 같은 계약 — 새 버전으로 바뀌었을 때만 새 화면을 연다.
        const target = expected || next.latest_version;
        if (
          target
          && (next.state === "complete" || next.state === "up_to_date")
          && next.current_version === target
        ) {
          clearWait();
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        // 업데이트가 아니면 덮개를 걷는다. 앱이 강제 종료되면 대기 표시가 남고, 그대로 두면
        // 이미 끝난 업데이트 때문에 5분 동안 화면을 막는다. 시작 직후 서버가 아직 'available'
        // 을 줄 수 있으므로 연달아 두 번 확인한 뒤에 닫는다.
        if (!isReleaseUpdateRunning(next.state)) {
          idleHits += 1;
          if (idleHits >= 2) {
            clearWait();
            setOpen(false);
            return;
          }
        } else {
          idleHits = 0;
        }
      } catch {
        // 옛 허브가 내려가고 새 허브가 뜨는 동안의 무응답은 정상이다. 다만 90초를 넘으면
        // 멈춘 퍼센트 대신 정직한 대기 안내로 바꾼다(유령 진행률 방지).
        if (cancelled) return;
        if (firstFailedAt == null) firstFailedAt = Date.now();
        setNote(pollFailureMessage(firstFailedAt, Date.now()) ?? "");
      }
      if (cancelled) return;
      timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(limit);
    };
  }, [open, done]);

  const force = async () => {
    setForcing(true);
    setForceError("");
    try {
      // 성공하면 시작 신호가 위 구독으로 돌아와 덮개를 진행 상태로 되돌린다.
      await startReleaseUpdate(true);
    } catch (e) {
      setForceError(
        e instanceof Error && e.message
          ? e.message
          : "강제 업데이트를 시작하지 못했습니다. 잠시 뒤 다시 시도하세요.",
      );
      setForcing(false);
    }
  };

  if (!open) return null;

  const state = status?.state ?? "starting";
  const failed = state === "failed";
  const at = updateStageIndex(state);
  const percent = typeof status?.percent === "number" ? Math.min(100, Math.max(0, status.percent)) : null;
  const stepText = note || releaseUpdateMessage(status) || "업데이트 실행기를 준비하는 중…";
  const blockers = updateBlockersText(status); // 강제로 끊기게 될 작업을 확인 화면에 그대로 보여준다

  return createPortal(
    <div className="upd-veil" role="alertdialog" aria-modal="true" aria-label="업데이트 진행">
      <div className="upd-box" ref={boxRef} tabIndex={-1}>
        {failed ? (
          <div className="upd-bang" aria-hidden="true">!</div>
        ) : (
          <div className="upd-ring" aria-hidden="true" />
        )}
        <h3 className="upd-title">{failed ? "업데이트하지 못했습니다" : "업데이트 중입니다"}</h3>
        <p className="upd-step">{stepText}</p>

        {!failed && (
          <>
            <div className="upd-bar">
              <i style={percent == null ? undefined : { width: `${percent}%` }} />
            </div>
            <div className="upd-pct">
              <span>{UPDATE_STAGES[Math.min(at, UPDATE_STAGES.length - 1)].label}</span>
              <b>{percent == null ? "준비 중" : `${percent}%`}</b>
            </div>

            <ul className="upd-stages">
              {UPDATE_STAGES.map((stage, i) => (
                <li key={stage.key} className={i < at ? "done" : i === at ? "now" : ""}>
                  <span className="upd-dot">{i < at ? "✓" : ""}</span>
                  {stage.label}
                </li>
              ))}
            </ul>

            <p className="upd-warn">프로그램을 끄거나 컴퓨터를 종료하지 마세요</p>
          </>
        )}

        {status?.current_version && status.latest_version && (
          <p className="upd-ver">
            v<b>{status.current_version}</b> → v<b>{status.latest_version}</b>
          </p>
        )}

        {forceError && <p className="upd-forcefail">{forceError}</p>}

        {done && !confirmForce && (
          <div className="upd-actions">
            {/* 강제 업데이트 — 실패로 멈춘 상태를 풀고 처음부터 다시 설치한다. */}
            <button type="button" className="upd-force" onClick={() => setConfirmForce(true)}>
              강제 업데이트
            </button>
            <button type="button" className="upd-close" onClick={() => setOpen(false)}>
              닫기
            </button>
          </div>
        )}

        {/* 강제는 진행 중인 작업을 확인하지 않고 앱을 종료한다 — 누르기 전에 한 번 묻는다
            (설정 패널의 강제 경로와 같은 계약, Codex 지적 2026-09-28). */}
        {done && confirmForce && (
          <div className="upd-confirm">
            <p className="upd-confirmtext">
              진행 중인 작업을 확인하지 않고 프로그램을 종료한 뒤 처음부터 다시 설치합니다.
              {blockers && <> 지금 {blockers}이 진행 중입니다.</>}
            </p>
            <div className="upd-actions">
              <button type="button" className="upd-force" onClick={() => void force()} disabled={forcing}>
                {forcing ? "시작하는 중…" : "예, 강제로 진행"}
              </button>
              <button
                type="button"
                className="upd-close"
                onClick={() => setConfirmForce(false)}
                disabled={forcing}
              >
                취소
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

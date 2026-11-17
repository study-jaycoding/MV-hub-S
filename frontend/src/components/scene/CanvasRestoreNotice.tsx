// 허브 공책 첫 전환 복구 동선(docs/status/공책첫전환복구동선_2026-11-15.md) — 합류 때 보관함(["nr", 계정])으로 옮긴 이 브라우저의 씬을
//  캔버스에서 알리고(알림 줄), 골라 기존 전체 가져오기 규칙으로 지금 캔버스에 되살린다(고르기 창). 공책 켬에서만.
//  알림은 씬 저장 알림을 구독하지 않는다 — 보관 묶음은 줄지 않아 저장마다 읽으면 캔버스가 느려진다(비참여 Claude B1).
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getAccountNamespace } from "../../lib/accountScope";
import { flashMsg } from "../../lib/flash";
import { hubHasFeature, subscribeHubFeatures } from "../../lib/hubFeatures";
import { useModalFocus } from "../../lib/keyGate";
import { isCanvasFloating, isCanvasWindow } from "../../lib/popupWindows";
import { downloadNotebookArchive, importSceneArchiveText, restoreArchiveRows, restoreArchiveText, type RestoreRow } from "../../lib/sceneArchive";
import { dismissNotebookStarted, getNotebookStartNotice, readRestoreArchives, SCENE_WRITER_FEATURE, subscribeNotebookStartNotice, subscribeRestoreArchived, type RestoreArchive } from "../../lib/sceneNotebook";
import { subscribeSceneStoreExternal, subscribeSceneStoreStale } from "../../lib/sceneStore";
import { getSceneWriterView, startSceneNotebook } from "../../lib/sceneWriter";
import { useT } from "../../lib/i18n";
import { listPersistedScenes } from "../../lib/scenes";
import { useEscapeClose } from "../../lib/useEscapeClose";

const seenKey = (account: string) => `mvhub.restoreNoticeSeen:${account}`;
const BLOCKED_WRITER = ["away", "taking", "giving", "checking", "syncing"];

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
/** 본 묶음 — 지금 남아 있는 묶음 id 만 남긴다(개수로 자르면 옛 묶음이 다시 뜬다). */
const seenSubs = new Set<() => void>();
export function markSeen(account: string, ids: string[], existing: string[]): void {
  const keep = new Set(existing);
  const next = [...new Set([...readList(seenKey(account)), ...ids])].filter((id) => keep.has(id));
  try { localStorage.setItem(seenKey(account), JSON.stringify(next)); } catch { /* 못 적으면 다음에 다시 알린다 — 잃는 것이 없다 */ }
  for (const fn of [...seenSubs]) fn(); // 같은 창의 알림도 바로 갱신(storage 이벤트는 같은 창에 오지 않는다)
}
export const selectable = (row: RestoreRow) => row.state === "differs" || row.state === "absent";
const rowKey = (row: RestoreRow) => `${row.archiveId}|${row.bucket}|${row.scene.id}`;

const writable = () => !isCanvasFloating() && !BLOCKED_WRITER.includes(getSceneWriterView().mode);

/** 고른 행을 되살린다. 확인은 가져오기 호출 바로 앞에서, 사이에 기다림 없이. 반환 = 결과 문구(로컬·허브를 나눈다).
 *  저장 뒤 계정이 바뀌어 던지면 가져오기 함수가 같은 ID 로 들어간 씬의 카드 소속을 시작 계정 대기열에 넣어 둔다(sceneArchive). */
export async function restoreRows(account: string, rows: RestoreRow[]): Promise<string> {
  if (account !== getAccountNamespace()) throw new Error("계정이 바뀌었습니다. 보관한 씬을 다시 열어 주세요.");
  if (!hubHasFeature(SCENE_WRITER_FEATURE)) throw new Error("캔버스가 이 브라우저에만 저장되는 상태라 되살리지 않았습니다 — 설정의 보관본 내려받기를 쓰세요.");
  if (!writable()) throw new Error("캔버스를 다른 창이나 다른 브라우저가 쓰는 중이라 되살리지 않았습니다.");
  const { added, recovered } = await importSceneArchiveText(restoreArchiveText(account, rows));
  return `캔버스에 ${added + recovered}개를 되살렸습니다${recovered ? `(사본 ${recovered}개)` : ""}.`;
}

/** 보관한 씬 고르기 창 — 알림(그 묶음)·설정(모든 묶음)이 같이 쓴다. */
export function RestorePicker({ account, archives, onClose, onRestored }: {
  account: string; archives: RestoreArchive[]; onClose: () => void; onRestored: (archiveIds: string[]) => void;
}) {
  useEscapeClose(onClose);
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocus(boxRef);
  const rows = useMemo(() => restoreArchiveRows(account, archives, listPersistedScenes(null)), [account, archives]);
  const [picked, setPicked] = useState(() => new Set(rows.filter(selectable).map(rowKey)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = rows.filter((row) => selectable(row) && picked.has(rowKey(row)));
  const ordered = [...archives].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const label: Record<RestoreRow["state"], string> = { same: "이미 캔버스에 있음", restored: "이미 되살림", differs: "다름 — 사본으로", absent: "캔버스에 없음", unreadable: "읽을 수 없음" };
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const message = await restoreRows(account, chosen);
      flashMsg(message);
      onRestored([...new Set(chosen.map((row) => row.archiveId))]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "되살리지 못했습니다.");
    } finally { setBusy(false); }
  };
  return createPortal(
    <>
      <div className="scene-del-catcher" onMouseDown={(event) => { event.preventDefault(); onClose(); }} />
      <div ref={boxRef} className="manage-float host-exit-confirm canvas-restore-picker" role="dialog" aria-modal="true" aria-label="보관한 씬">
        <header className="admin-head"><span className="admin-title">보관한 씬</span></header>
        <div className="admin-body">
          <p className="host-exit-text">고른 씬을 새 탭으로 되살립니다. 지금 캔버스의 씬은 바꾸지 않고, 보관함은 그대로 남습니다.</p>
          {ordered.map((archive) => {
            const own = rows.filter((row) => row.archiveId === archive.id);
            if (!own.length) return null;
            return (
              <section key={archive.id} className="canvas-restore-group">
                <div className="canvas-restore-when">
                  <span>{new Date(archive.createdAt).toLocaleString("ko-KR")} 보관</span>
                  <button type="button" className="settings-action ghost" onClick={() => downloadNotebookArchive(archive)}>파일로 내려받기</button>
                </div>
                {own.map((row, index) => {
                  const key = rowKey(row), can = selectable(row);
                  return (
                    <label key={`${key}#${index}`} className={"canvas-restore-row" + (can ? "" : " off")}>
                      <input type="checkbox" disabled={!can || busy} checked={can && picked.has(key)}
                        onChange={(event) => setPicked((prior) => { const next = new Set(prior); if (event.target.checked) next.add(key); else next.delete(key); return next; })} />
                      <span className="canvas-restore-name">{row.scene.name || "(이름 없음)"}<small>카드 {row.cards}장</small></span>
                      <span className="canvas-restore-tag">{label[row.state]}</span>
                    </label>
                  );
                })}
              </section>
            );
          })}
          {error && <p role="alert" className="error">{error}</p>}
          <div className="host-exit-actions">
            <button type="button" className="settings-action" data-restore-action="restore" disabled={busy || !chosen.length} onClick={() => void run()}>
              {`${chosen.length}개 되살리기`}
            </button>
            <button type="button" className="settings-action ghost" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** 캔버스 탭 알림 줄 — 공책 켬·본 창일 때만 읽는다. */
export function CanvasRestoreNotice() {
  const notebook = useSyncExternalStore(subscribeHubFeatures, () => hubHasFeature(SCENE_WRITER_FEATURE), () => false);
  if (!notebook || isCanvasWindow()) return null;
  return <><CanvasNotebookStartNotice /><CanvasRestoreNoticeBody /></>;
}

function CanvasNotebookStartNotice() {
  const t = useT();
  const notice = useSyncExternalStore(subscribeNotebookStartNotice, getNotebookStartNotice, () => null);
  const [later, setLater] = useState<{ question: string; folded: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!notice || notice.account !== getAccountNamespace()) return null;
  if (notice.kind === "started") return (
    <div className="canvas-restore-notice canvas-notebook-start" role="status">
      <span>{t("이제 이 PC 의 어느 브라우저에서 열어도 같은 캔버스가 보입니다.")}</span>
      <button type="button" className="settings-action ghost" onClick={() => dismissNotebookStarted(notice.id)}>{t("닫기")}</button>
    </div>
  );
  const start = async () => {
    setBusy(true);
    try { await startSceneNotebook(notice.id); }
    finally { setBusy(false); }
  };
  const laterKey = `mvhub.canvasStartLater:${notice.account}`;
  const questionKey = `${notice.account}:${notice.provenanceFingerprint}:${notice.bookFingerprint}:${notice.count}`;
  let folded = false;
  try { folded = sessionStorage.getItem(laterKey) === questionKey; } catch { /* 저장할 수 없으면 현재 화면에서만 접는다. */ }
  if (later?.question === questionKey) folded = later.folded;
  const fold = (value: string | null) => {
    setLater({ question: questionKey, folded: value !== null });
    try { if (value) sessionStorage.setItem(laterKey, value); else sessionStorage.removeItem(laterKey); } catch { /* 현재 화면의 상태는 유지한다. */ }
  };
  return (
    <div className="canvas-restore-notice canvas-notebook-start" role="status">
      {folded ? <>
        <span>{t("이 브라우저에만 저장 중")}</span>
        <button type="button" className="settings-action ghost" onClick={() => fold(null)}>{t("다른 브라우저와 같이 쓰기")}</button>
      </> : <>
        <span><strong>{t("이 캔버스를 다른 브라우저에서도 쓸까요?")}</strong><br />
          {notice.changed && <>{t("캔버스가 바뀌어 다시 확인해 주세요")}<br /></>}
          {t(notice.afterRestore ? "이 PC 에 저장된 캔버스(씬 {count}개)를 다른 브라우저와 같이 쓸까요? 이 브라우저에 있던 캔버스는 따로 보관했습니다." :
            notice.count === 0 ? "이 브라우저의 캔버스가 비어 있습니다. 이 PC 에 저장된 캔버스(씬 {count}개)를 불러와 다른 브라우저와 같이 쓸까요?" :
            "지금 보이는 캔버스(씬 {count}개)가 이 PC 의 어느 브라우저에서 열어도 그대로 보이게 됩니다. 전에 저장돼 있던 캔버스는 따로 보관됩니다.")
            .replace("{count}", String(notice.afterRestore || notice.count === 0 ? notice.hubCount : notice.count))}</span>
        <button type="button" className="settings-action ghost" disabled={busy} onClick={() => fold(questionKey)}>{t("나중에")}</button>
        <button type="button" className="settings-action canvas-notebook-confirm" data-notebook-action="start" disabled={busy} onClick={() => void start()}>{t(notice.count === 0 ? "불러오기" : "이 캔버스로 쓰기")}</button>
      </>}
    </div>
  );
}

function CanvasRestoreNoticeBody() {
  const account = getAccountNamespace();
  const [state, setState] = useState<{ account: string; archives: RestoreArchive[] } | null>(null);
  const [tick, redraw] = useReducer((value: number) => value + 1, 0);
  const [open, setOpen] = useState<string | null>(null); // 연 묶음 id
  const read = useCallback(() => {
    const at = getAccountNamespace();
    void readRestoreArchives(at).then((result) => {
      if (at !== getAccountNamespace()) return;
      // 읽기 실패·낡은 기준이면 알림을 그리지 않는다('되살릴 것 없음' 으로 단정하지 않는다)
      setState(result.ok && result.fresh ? { account: at, archives: result.value } : null);
    }, () => { if (at === getAccountNamespace()) setState(null); });
  }, []);
  useEffect(() => {
    setOpen(null); // 계정이 바뀌면 고르기 창을 닫는다
    read();
    // 씬 저장 알림은 구독하지 않는다(위 머리말). 새 묶음·다른 탭·기능·낡은 읽기 회복·focus 때만 다시 읽는다.
    const offs = [subscribeRestoreArchived(read), subscribeSceneStoreExternal(read), subscribeHubFeatures(read), subscribeSceneStoreStale(read)];
    seenSubs.add(redraw);
    window.addEventListener("focus", read);
    return () => { offs.forEach((off) => off()); seenSubs.delete(redraw); window.removeEventListener("focus", read); };
  }, [account, read]);
  const archives = state?.account === account ? state.archives : null;
  const target = useMemo(() => {
    if (!archives) return null;
    void tick;
    const seen = new Set(readList(seenKey(account)));
    const rows = restoreArchiveRows(account, archives, listPersistedScenes(null));
    const candidates = archives
      .filter((archive) => !seen.has(archive.id))
      .map((archive) => ({ archive, count: rows.filter((row) => row.archiveId === archive.id && selectable(row)).length }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.archive.createdAt.localeCompare(a.archive.createdAt));
    return candidates[0] ?? null;
  }, [account, archives, tick]);
  if (!archives || !target) return null;
  const dismiss = (ids: string[]) => { markSeen(account, ids, archives.map((archive) => archive.id)); setOpen(null); };
  const lead = target.archive.fromGeneration ? "저장된 캔버스가 백업에서 되돌려져" : "캔버스를 이 PC 에 저장된 것으로 바꿨습니다.";
  return (
    <>
      <div className="canvas-restore-notice" role="status">
        <span>{`${lead} 이 브라우저에만 있던 씬 ${target.count}개는 지우지 않고 보관했습니다`}</span>
        <button type="button" className="settings-action" data-restore-action="open" onClick={() => setOpen(target.archive.id)}>보관한 씬 보기</button>
        <button type="button" className="canvas-restore-x" aria-label="보관 알림 닫기" onClick={() => dismiss([target.archive.id])}>✕</button>
      </div>
      {open === target.archive.id && (
        <RestorePicker account={account} archives={[target.archive]} onClose={() => setOpen(null)} onRestored={(ids) => dismiss(ids)} />
      )}
    </>
  );
}

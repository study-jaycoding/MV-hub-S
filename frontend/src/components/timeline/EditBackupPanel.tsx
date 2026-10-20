import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  captureEditBackupGuard, getEditBackupStatus, loadEditBackup, retryEditBackups, subscribeEditBackup,
  type BackupListing, type BackupState,
} from "../../lib/editDocBackup";
import type { ArchiveTarget } from "../../lib/editArchive";
import { useT } from "../../lib/i18n";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { useEditDoc } from "../../lib/useEditDoc";

const labels: Record<BackupState, string> = {
  off: "DB 백업 연결 대기", idle: "이 문서의 저장된 원문 없음", pending: "DB 백업 대기", saving: "DB 백업 중", saved: "DB 백업 완료",
  conflict: "자동 백업 멈춤 · 다른 편집은 사본으로 보존", error: "DB 백업 실패 · 연결 후 다시 시도",
  invalid: "읽을 수 없는 원문 · DB 백업 안 됨", too_big: "1 MiB 초과 · DB 백업 안 됨",
};
export function EditBackupNotice({ docKey, onOpen }: { docKey: string | null; onOpen: () => void }) {
  const t = useT();
  const state = useSyncExternalStore(subscribeEditBackup, () => getEditBackupStatus(docKey));
  return <>
    <p role="status">{t(labels[state.state])}{state.updatedAt && <> · {t("백업 시각")} {state.updatedAt}</>}
      {state.preservedAt && <> · {t("마지막 사본 시각")} {state.preservedAt}</>}
      {!!state.skipped && <> · {t("백업하지 못한 문서 {count}개").replace("{count}", String(state.skipped))}</>}
    </p>
    <p>{t(state.state === "off" ? "DB 백업 연결을 확인할 수 없습니다. 편집 메뉴에서 파일로 보관하세요."
      : "저장된 타임라인은 현재 계정의 DB에 별도로 백업됩니다. 전송 전에 창을 강제로 닫거나 브라우저 자료를 지우면 최근 편집을 잃을 수 있습니다.")}</p>
    <button type="button" className="ed-link" disabled={!docKey || state.state === "off"} onClick={onOpen}>{t("DB 백업 보기·복원")}</button>{" "}
    <button type="button" className="ed-link" disabled={state.state === "off"} onClick={retryEditBackups}>{t("백업 다시 시도")}</button>
  </>;
}

export function EditBackupPanel({ docKey, target, edit, onClose }: {
  docKey: string; target: ArchiveTarget; edit: Omit<ReturnType<typeof useEditDoc>, "applyEdit">; onClose: () => void;
}) {
  const t = useT();
  const modal = useRef<HTMLDivElement>(null);
  useModalFocus(modal);
  useEscapeClose(onClose);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<BackupListing | null>(null);
  const [selected, setSelected] = useState<{ raw: string; copyHash?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const live = useRef(edit); live.current = edit;
  useEffect(() => {
    const version = ++epoch.current;
    const authorized = captureEditBackupGuard();
    setBusy(true); setListing(null); setSelected(null); setMessage("");
    loadEditBackup(docKey, offset).then((value) => {
      if (epoch.current !== version || !authorized()) return;
      setListing(value);
      if (value.head?.data !== undefined) setSelected({ raw: value.head.data });
    }).catch(() => { if (epoch.current === version) setMessage(t("백업 목록을 읽지 못했습니다. 연결을 확인하고 다시 읽어 주세요.")); })
      .finally(() => { if (epoch.current === version) setBusy(false); });
    return () => { epoch.current += 1; };
  }, [docKey, offset, refresh, t]);
  const pickBackup = async (hash?: string) => {
    const version = epoch.current;
    const authorized = captureEditBackupGuard();
    setBusy(true); setSelected(null); setMessage("");
    try {
      const value = await loadEditBackup(docKey, offset, hash);
      if (epoch.current !== version || !authorized()) return;
      const source = hash ? value.copy : value.head;
      if (!source || (hash && source.data_hash !== hash) || typeof source.data !== "string") throw new Error();
      setListing(value); setSelected({ raw: source.data, copyHash: hash });
    } catch { if (epoch.current === version) setMessage(t("선택한 백업을 읽지 못했습니다.")); }
    finally { if (epoch.current === version) setBusy(false); }
  };
  const apply = async (adopt: boolean) => {
    if (!listing || busy) return;
    const snapshot = live.current.captureArchiveSnapshot(true);
    if (!snapshot) { setMessage(t("편집이 바뀌었습니다. 목록을 다시 읽어 주세요.")); return; }
    const raw = adopt ? snapshot.dirty ? snapshot.docRaw : snapshot.raw : selected?.raw;
    if (raw == null) return;
    const version = epoch.current;
    setBusy(true); setMessage("");
    const result = await live.current.replaceFromBackup(raw, snapshot, listing.head?.revision ?? null, target, adopt, adopt ? undefined : selected?.copyHash);
    if (epoch.current !== version) return;
    setBusy(false);
    setMessage(t(result === "saved" ? "직전 편집을 사본으로 보존하고 복원했습니다."
      : result === "stopped" ? "편집 또는 백업이 바뀌어 멈췄습니다. 목록을 다시 읽어 주세요."
        : result === "uncertain" ? "복원 응답을 확인하지 못했습니다. 현재 편집을 유지했습니다. 목록을 다시 읽어 확인하세요."
          : "복원하지 못했습니다. 현재 편집을 유지했습니다."));
    // 성공 후에도 새 판 번호는 다시 읽어야 한다.
    setListing(null); setSelected(null);
  };
  return createPortal(<>
    <div className="gradestep-catcher" onMouseDown={onClose} />
    <div ref={modal} className="gradestep-modal ed-export ed-import" role="dialog" aria-modal="true" aria-label={t("DB 백업 보기·복원")}>
      <div className="gradestep-title">{t("DB 백업 보기·복원")}</div>
      <div className="gradestep-body">
        <p>{target.projectId} / {target.seq}</p>
        <p>{t("다른 편집 창을 닫고 복원하세요. 복원 직전의 현재 편집과 DB 백업은 사본으로 보존됩니다. 원본 미디어는 포함되지 않습니다.")}</p>
        <div role="group" aria-label={t("복원할 백업")}>
          {listing?.head && <button type="button" className="gradestep-btn" disabled={busy}
            aria-pressed={!!selected && !selected.copyHash} onClick={() => { void pickBackup(); }}>
            {t("현재 DB 백업")} · {listing.head.updated_at}
          </button>}
          {listing?.copies.map((copy) => <button type="button" className="gradestep-btn" key={copy.data_hash} disabled={busy}
            aria-pressed={selected?.copyHash === copy.data_hash} onClick={() => { void pickBackup(copy.data_hash); }}>
            {t("보존 사본")} · {copy.created_at} · {copy.bytes} B
          </button>)}
          {listing && !listing.head && !listing.total_copies && <p>{t("저장된 DB 백업이 없습니다.")}</p>}
        </div>
        <button type="button" className="ed-link" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{t("이전")}</button>{" "}
        <button type="button" className="ed-link" disabled={busy || !listing || offset + 20 >= listing.total_copies} onClick={() => setOffset(offset + 20)}>{t("다음")}</button>
        <p role="status">{busy ? t("불러오는 중…") : message}</p>
      </div>
      <div className="gradestep-actions">
        <button type="button" className="gradestep-btn cancel" onClick={onClose}>{t("닫기")}</button>
        <button type="button" className="gradestep-btn" disabled={busy} onClick={() => setRefresh(refresh + 1)}>{t("목록 다시 읽기")}</button>
        <button type="button" className="gradestep-btn" disabled={busy || !listing || edit.readError || !edit.hasValidDoc || edit.restorePending}
          onClick={() => { void apply(true); }}>{t("현재 편집을 DB 백업으로 채택")}</button>
        <button type="button" className="gradestep-btn confirm" disabled={busy || !selected || !listing || edit.readError || edit.restorePending}
          onClick={() => { void apply(false); }}>{t("선택한 백업 복원")}</button>
      </div>
    </div>
  </>, document.body);
}

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { getAccountScope } from "../../lib/accountScope";
import { downloadText } from "../../lib/download";
import {
  createEditArchive, createRecoveryArchive, knownDocEquals, MAX_ARCHIVE_BYTES, parseEditArchive, utf8Bytes,
  type ArchiveTarget, type EditArchive,
} from "../../lib/editArchive";
import type { EditDoc } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { useModalFocus } from "../../lib/keyGate";
import type { ArchiveSnapshot, VerifiedArchiveBackup, useEditDoc } from "../../lib/useEditDoc";
import { useEscapeClose } from "../../lib/useEscapeClose";

type Controller = Omit<ReturnType<typeof useEditDoc>, "applyEdit">;
type Candidate = { doc: EditDoc; archive: EditArchive; snapshot: ArchiveSnapshot; same: boolean };
type Backup = { text: string; allowed: boolean };

export function editArchiveFilename(target: ArchiveTarget, kind: "working" | "stored" | "damaged" | "recovery") {
  const name = `${target.projectId}-${target.seq}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 110);
  return `mvhub-edit-${kind}-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.${kind === "stored" || kind === "damaged" ? "txt" : "json"}`;
}

export function EditArchiveExportConfirm({ snapshot, target, projectName, onClose }: {
  snapshot: ArchiveSnapshot;
  target: ArchiveTarget;
  projectName?: string;
  onClose: () => void;
}) {
  const t = useT();
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);
  useEscapeClose(onClose);
  const [capturedAt] = useState(() => new Date().toISOString());
  const [message, setMessage] = useState("");
  const { working, restorable } = useMemo(() => {
    const working = snapshot.valid ? createEditArchive(snapshot.doc, target, snapshot.dirty) : null;
    if (working) working.exportedAt = capturedAt;
    return { working, restorable: working && parseEditArchive(JSON.stringify(working), target).ok };
  }, [snapshot, target, capturedAt]);
  const download = (raw: boolean) => {
    const text = raw ? snapshot.raw : working ? JSON.stringify(working) : null;
    if (text === null) return;
    try {
      downloadText(editArchiveFilename(target, raw ? snapshot.bad ? "damaged" : "stored" : "working"), text, raw ? "text/plain" : "application/json");
      setMessage(t("다운로드를 시작했습니다. 실제 저장된 파일을 확인하세요."));
    } catch { setMessage(t("다운로드를 시작하지 못했습니다.")); }
  };
  return createPortal(<>
    <div className="gradestep-catcher" onMouseDown={onClose} />
    <div ref={modalRef} className="gradestep-modal ed-export ed-import" role="dialog" aria-modal="true" aria-label={t("편집 파일 보관")}>
      <div className="gradestep-title">{t("편집 파일 보관")}</div>
      <div className="gradestep-body">
        <dl className="ed-export-rows">
          <dt>{t("대상")}</dt><dd>{projectName || target.projectId} / {target.seq}</dd>
          <dt>{t("캡처 시각")}</dt><dd>{capturedAt}</dd>
        </dl>
        <p>{t("이 창을 열 때 캡처한 작업본과 저장 원문을 보관합니다. 원본 미디어는 포함되지 않습니다.")}</p>
        <p>{t("작업본 파일에는 현재 버전에서 읽은 편집만 담습니다. 모르는 필드를 보존하려면 저장 원문도 따로 보관하세요.")}</p>
        {snapshot.dirty && <p>{t("저장되지 않은 편집도 작업본 파일에 포함됩니다.")}</p>}
        {!working && <p className="ed-export-bad">{t("내보낼 유효한 작업본이 없습니다.")}</p>}
        {working && !restorable && <p className="ed-export-bad">{t("작업본이 복원 한도를 넘습니다. 파일로 구출할 수 있지만 이 버전에서 자동 복원할 수 없습니다.")}</p>}
        {snapshot.raw !== null && <p>{t("저장 원문은 UTF-8 텍스트입니다. 원 저장 바이트의 동일성이나 자동 복원을 보장하지 않습니다.")}</p>}
        {message && <p role="status">{message}</p>}
      </div>
      <div className="gradestep-actions">
        <button type="button" className="gradestep-btn cancel" onClick={onClose}>{t("닫기")}</button>
        {snapshot.raw !== null && <button type="button" className="gradestep-btn" onClick={() => download(true)}>
          {t(snapshot.bad ? "손상 원문 구출" : "저장 원문 보관")}
        </button>}
        <button type="button" className="gradestep-btn confirm" disabled={!working} onClick={() => download(false)}>{t("작업본 파일 보관")}</button>
      </div>
    </div>
  </>, document.body);
}

export function EditImportConfirm({ edit, target, contextKey, projectName, onClose, flash }: {
  edit: Controller;
  target: ArchiveTarget;
  contextKey: string;
  projectName?: string;
  onClose: () => void;
  flash: (message: string) => void;
}) {
  const t = useT();
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);
  const epoch = useRef(0);
  const live = useRef(edit);
  live.current = edit;
  const initial = useRef({ doc: edit.doc, rev: edit.rev, contextKey, account: getAccountScope(), projectId: target.projectId, seq: target.seq });
  const liveContext = useRef(contextKey);
  liveContext.current = contextKey;
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [verified, setVerified] = useState<VerifiedArchiveBackup | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => { epoch.current += 1; onClose(); };
  useEscapeClose(close);
  useEffect(() => () => { epoch.current += 1; }, []);
  useEffect(() => {
    if (edit.doc !== initial.current.doc || edit.rev !== initial.current.rev || contextKey !== initial.current.contextKey ||
      target.projectId !== initial.current.projectId || target.seq !== initial.current.seq ||
      getAccountScope() !== initial.current.account || edit.readError || edit.conflict || edit.restorePending) {
      epoch.current += 1;
      if (!edit.conflict && !edit.readError) flash(t(edit.restorePending
        ? "저장 결과를 확인하지 못했습니다. 직전 파일을 보관하고 저장 결과를 다시 확인하세요."
        : "대상이나 편집이 바뀌어 복원을 중단했습니다. 다시 시작하세요."));
      onClose();
    }
  }, [edit.doc, edit.rev, edit.readError, edit.conflict, edit.restorePending, contextKey, target.projectId, target.seq, onClose, flash, t]);

  const current = (mine: number, snapshot: ArchiveSnapshot) => {
    if (mine !== epoch.current) return false;
    if (liveContext.current === initial.current.contextKey && getAccountScope() === initial.current.account &&
      live.current.isArchiveSnapshotCurrent(snapshot)) return true;
    epoch.current += 1;
    setCandidate(null);
    setBackup(null);
    setVerified(null);
    setBusy(false);
    setMessage(t("대상이나 편집이 바뀌었습니다. 파일을 다시 선택하세요."));
    return false;
  };
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const mine = ++epoch.current;
    const snapshot = live.current.captureArchiveSnapshot(true);
    setCandidate(null);
    setBackup(null);
    setVerified(null);
    setMessage("");
    if (!snapshot) { setMessage(t("현재 편집을 확인할 수 없습니다. 화면을 확인하고 다시 시작하세요.")); return; }
    if (!current(mine, snapshot)) return;
    if (file.size > MAX_ARCHIVE_BYTES) { setMessage(t("10 MiB 이하의 파일을 선택하세요.")); return; }
    setBusy(true);
    try {
      const text = await file.text();
      if (!current(mine, snapshot)) return;
      const parsed = parseEditArchive(text, target);
      if (!parsed.ok) { setMessage(t(parsed.message)); return; }
      const same = snapshot.valid && knownDocEquals(snapshot.doc, parsed.doc);
      setCandidate({ doc: parsed.doc, archive: parsed.archive, snapshot, same });
    } catch {
      if (current(mine, snapshot)) setMessage(t("파일을 읽지 못했습니다."));
    } finally {
      if (mine === epoch.current) setBusy(false);
    }
  };
  const makeBackup = () => {
    if (!candidate || !current(epoch.current, candidate.snapshot)) return;
    const { snapshot } = candidate;
    const working = snapshot.valid && !(snapshot.bad && !snapshot.dirty)
      ? createEditArchive(snapshot.doc, target, snapshot.dirty) : null;
    const text = createRecoveryArchive(target, working, snapshot.raw, snapshot.bad);
    const allowed = utf8Bytes(text) <= MAX_ARCHIVE_BYTES && (!working || parseEditArchive(JSON.stringify(working), target).ok);
    setBackup({ text, allowed });
    setVerified(null);
    try {
      downloadText(editArchiveFilename(target, "recovery"), text, "application/json");
      setMessage(t(allowed
        ? "다운로드를 시작했습니다. 실제 저장된 직전 파일을 다시 선택해 확인하세요."
        : "직전 파일 구출 다운로드를 시작했습니다. 현재 작업본이나 파일이 복원 한도를 넘어 이 복원은 중단합니다."));
    } catch {
      setBackup(null);
      setMessage(t("다운로드를 시작하지 못했습니다."));
    }
  };
  const verify = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !candidate || !backup?.allowed) return;
    const mine = ++epoch.current;
    setVerified(null);
    setBusy(true);
    setMessage("");
    try {
      if (file.size > MAX_ARCHIVE_BYTES || file.size !== utf8Bytes(backup.text)) {
        setMessage(t("직전 파일의 크기나 내용이 다릅니다. 방금 만든 파일을 선택하세요."));
        return;
      }
      const result = await live.current.verifyArchiveBackup(candidate.snapshot, backup.text, file);
      if (!current(mine, candidate.snapshot)) return;
      setVerified(result);
      setMessage(t(result ? "직전 파일을 확인했습니다." : "직전 파일의 크기나 내용이 다릅니다. 방금 만든 파일을 선택하세요."));
    } catch {
      if (current(mine, candidate.snapshot)) setMessage(t("파일을 읽지 못했습니다."));
    } finally {
      if (mine === epoch.current) setBusy(false);
    }
  };
  const restore = () => {
    if (!candidate || (!candidate.same && !verified) || !current(epoch.current, candidate.snapshot)) return;
    const result = live.current.replaceFromArchive(candidate.doc, candidate.snapshot, verified);
    if (result === "saved" || result === "unchanged") {
      flash(t(result === "saved" ? "파일에서 편집을 복원했습니다." : "현재 편집과 같아 바꾸지 않았습니다."));
      close();
    } else {
      setMessage(t(result === "uncertain" ? "저장 결과를 확인하지 못했습니다. 직전 파일을 보관하고 저장 결과를 다시 확인하세요."
        : result === "failed" ? "복원 저장에 실패했습니다. 기존 작업본과 직전 파일을 보관하세요."
          : "대상이나 편집이 바뀌어 복원을 중단했습니다. 다시 시작하세요."));
      setVerified(null);
    }
  };

  return createPortal(<>
    <div className="gradestep-catcher" onMouseDown={close} />
    <div ref={modalRef} className="gradestep-modal ed-export ed-import" role="dialog" aria-modal="true" aria-label={t("파일에서 편집 복원")}>
      <div className="gradestep-title">{t("파일에서 편집 복원")}</div>
      <div className="gradestep-body">
        <dl className="ed-export-rows">
          <dt>{t("대상")}</dt><dd>{projectName || target.projectId} / {target.seq}</dd>
          <dt>{t("현재 계정")}</dt><dd>{initial.current.account || t("로컬 계정")}</dd>
        </dl>
        <p>{t("다른 창을 닫고 진행하세요. 이 파일은 다른 계정에서 만든 것일 수 있으며, 현재 계정의 이 시퀀스만 바꿉니다.")}</p>
        <p>{t("원본 미디어는 포함되지 않습니다. 목록에 없는 미디어도 클립을 지우지 않고 남깁니다.")}</p>
        <label className="ed-import-file">{t("복원할 파일 선택")}
          <input type="file" accept=".json,application/json" disabled={busy} onChange={choose} />
        </label>
        {candidate && <>
          <dl className="ed-export-rows">
            <dt>{t("현재 편집")}</dt><dd>{t("클립 {count}개").replace("{count}", String(candidate.snapshot.doc.clips.length))} · {t("북마크 {count}").replace("{count}", String(candidate.snapshot.doc.markers?.length ?? 0))}</dd>
            <dt>{t("복원할 편집")}</dt><dd>{t("클립 {count}개").replace("{count}", String(candidate.doc.clips.length))} · {t("북마크 {count}").replace("{count}", String(candidate.doc.markers?.length ?? 0))} · {candidate.archive.exportedAt}</dd>
          </dl>
          {(candidate.snapshot.dirty || candidate.archive.unsaved) && <p>{t("저장되지 않은 편집이 포함됩니다. 복원하면 현재 작업본 전체가 바뀝니다.")}</p>}
          {candidate.snapshot.raw !== null && <p>{t("직전 파일에는 현재 화면에서 캡처한 저장 원문도 그대로 보관합니다. 모르는 필드나 손상 내용은 자동 적용하지 않습니다.")}</p>}
          {candidate.snapshot.bad && <p>{t("손상 원문만 있으면 직전 파일은 원문 구출용입니다. 복원할 때 기존 .bad는 현재 손상 원문으로 교체될 수 있습니다.")}</p>}
          {candidate.same ? <p>{t("현재 편집과 같습니다. 파일 보관이나 저장 없이 마칩니다.")}</p> : <>
            <button type="button" className="gradestep-btn" disabled={busy} onClick={makeBackup}>{t("복원 직전 파일 만들기")}</button>
            {backup?.allowed && <label className="ed-import-file">{t("방금 만든 직전 파일 확인")}
              <input type="file" accept=".json,application/json" disabled={busy} onChange={verify} />
            </label>}
          </>}
        </>}
        {message && <p role="status">{message}</p>}
        <p className="ed-export-note">{t("파일 확인은 다시 읽은 내용의 일치만 확인합니다. 영구 보존이나 원본 미디어 보존을 보장하지 않습니다.")}</p>
      </div>
      <div className="gradestep-actions">
        <button type="button" className="gradestep-btn cancel" onClick={close}>{t("취소")}</button>
        <button type="button" className="gradestep-btn confirm" disabled={busy || !candidate || (!candidate.same && !verified)} onClick={restore}>
          {t(candidate?.same ? "같은 편집 확인" : "직전 파일을 확인했습니다. 이 시퀀스에 복원")}
        </button>
      </div>
    </div>
  </>, document.body);
}

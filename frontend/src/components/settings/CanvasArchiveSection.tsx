import { useEffect, useRef, useState } from "react";
import { CANVAS_OTHER_TAB, useCanvasFloating, useCanvasFollower } from "../../lib/popupWindows";
import { downloadSceneArchive, downloadNotebookArchive, importSceneArchiveText, readStorageRecovery, downloadStorageRecovery, redundantMirrorHoldIds, type StorageRecovery } from "../../lib/sceneArchive";
import { subscribeEditBackup } from "../../lib/editDocBackup";
import { getAccountNamespace } from "../../lib/accountScope";
import { hubHasFeature, subscribeHubFeatures } from "../../lib/hubFeatures";
import { SCENE_WRITER_FEATURE, readSceneNotebook, readNotebookArchive, hasRestoreArchiveContent, type NotebookArchive } from "../../lib/sceneNotebook";
import { useSceneWriter } from "../../lib/sceneWriter";
import { useT } from "../../lib/i18n";
import { sceneStoreReady, subscribeSceneStoreExternal } from "../../lib/sceneStore";
import { isSceneSaveFailing, listScenes, subscribeSceneSaveState, subscribeScenesPersisted } from "../../lib/scenes";
import { SettingsDescription } from "./SettingsDescription";

/** '복원 전에 남겨 둔 것' 기록 — 펼친 칸과 접힌 '자료 관리' 제목 줄이 같이 읽는다. [기록, 바꾸기, 읽기 실패]. */
export function useStorageRecovery() {
  const writer = useSceneWriter();
  const account = getAccountNamespace();
  const [recovery, setRecovery] = useState<StorageRecovery | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let readVersion = 0;
    setRecovery(null);
    setFailed(false);
    const read = () => {
      if (!sceneStoreReady()) return;
      const version = ++readVersion;
      void readStorageRecovery().then((value) => {
        if (alive && version === readVersion && value.account === account && account === getAccountNamespace()) {
          setRecovery(value);
          setFailed(false);
        }
      }).catch(() => { if (alive && version === readVersion) setFailed(true); });
    };
    read();
    const offScene = subscribeSceneSaveState(read), offEdit = subscribeEditBackup(read), offFeatures = subscribeHubFeatures(read);
    const offPersisted = subscribeScenesPersisted(read), offExternal = subscribeSceneStoreExternal(read);
    window.addEventListener("storage", read);
    window.addEventListener("focus", read);
    return () => { alive = false; offScene(); offEdit(); offFeatures(); offPersisted(); offExternal(); window.removeEventListener("storage", read); window.removeEventListener("focus", read); };
  }, [account, writer.mode]);
  return [recovery?.account === account ? recovery : null, setRecovery, failed] as const;
}

/** 보류 개수 — 캔버스 보관본(미러는 아직 막힌 씬·장부가 있는 것만) · 편집 문서 · 카드 정리 대기. */
export function heldRecoveryCounts(recovery: StorageRecovery | null) {
  const blockedMirrorIds = new Set(recovery?.mirror?.blockedIds ?? []);
  for (const id of redundantMirrorHoldIds(recovery)) blockedMirrorIds.delete(id);
  const canvas = (recovery?.canvases.filter(hasRestoreArchiveContent).length ?? 0) + (recovery?.mirror?.originals.filter((item) => item.scenes.some(({ id }) => blockedMirrorIds.has(id)) || item.ledger.some(([id]) => blockedMirrorIds.has(id))).length ?? 0);
  const edit = recovery?.edits.length ?? 0;
  const card = recovery?.cards?.candidates.reduce((n, c) => n + c.removals.length + c.revives.length + c.backfill.length, 0) ?? 0;
  return { canvas, edit, card, total: canvas + edit + card };
}

// 캔버스 전체를 파일 하나로 내려받고, 그 파일에서 다시 가져온다(백업·PC 옮기기·저장소가 막혔을 때 건지기).
// 씬 하나를 주고받는 캔버스의 [저장]/[불러오기]와 다르다 — 이쪽은 계정·씬 id 를 그대로 싣고, 가져올 때 합친다.
export function CanvasArchiveSection() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failing, setFailing] = useState(isSceneSaveFailing);
  const floating = useCanvasFloating(); // 캔버스가 다른 창에 떠 있는 동안 씬은 그 창만 쓴다 — 가져오기는 저장 입구를 지나지 않아 여기서 막는다
  const otherTab = useCanvasFollower();
  const writer = useSceneWriter();
  const [archive, setArchive] = useState<NotebookArchive | null>(null);
  const [archiveAccount, setArchiveAccount] = useState("");
  const account = getAccountNamespace();
  const [ownRecovery, setRecovery, recoveryFailed] = useStorageRecovery();
  useEffect(() => {
    const readError = "보관본을 읽지 못했습니다. 이 브라우저의 자료는 유지했습니다.";
    setMsg((previous) => recoveryFailed ? readError : previous === readError ? "" : previous);
  }, [recoveryFailed]);
  useEffect(() => {
    let alive = true;
    setArchive(null);
    if (hubHasFeature(SCENE_WRITER_FEATURE) && sceneStoreReady()) void (async () => {
      const snapshot = await readSceneNotebook(account);
      if (!snapshot.ok || !snapshot.value.joined) return;
      const result = await readNotebookArchive(account, snapshot.value.joined.notebookId);
      if (alive && account === getAccountNamespace() && result.ok) { setArchive(result.value); setArchiveAccount(account); }
    })();
    return () => { alive = false; };
  }, [account, writer.mode]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => subscribeSceneSaveState(setFailing), []);

  // 분리 창(Assets·관리)은 캔버스 저장소를 열지 않는다 — 거기서는 내보낼 것이 없다.
  if (!sceneStoreReady()) return null;

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      setMsg(await work());
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () =>
    run(async () => `캔버스 ${await downloadSceneArchive()}개를 파일로 내려받았습니다.`);
  const importAll = (file: File) =>
    run(async () => {
      const { added, recovered } = await importSceneArchiveText(await file.text());
      const currentRecovery = await readStorageRecovery();
      if (currentRecovery.account === account && account === getAccountNamespace()) setRecovery(currentRecovery);
      if (!added && !recovered) return "파일의 캔버스가 이미 모두 있습니다 — 더한 것이 없습니다.";
      return (
        `캔버스 ${added}개를 가져왔습니다` +
        (recovered ? ` · 내용이 다른 ${recovered}개는 '[사본]' 탭으로 따로 두었습니다.` : ".")
      );
    });
  const { canvas: canvasCount, edit: editCount, card: cardCount } = heldRecoveryCounts(ownRecovery);

  return (
    <div className="settings-subblock">
      <h6>캔버스 자료</h6>
      {!!(canvasCount + editCount + cardCount) && ownRecovery && <div className="settings-subblock" style={{ borderColor: "var(--warning, #c86f20)" }}>
        <h6>{t("복원 전에 남겨 둔 것")}</h6>
        <p role="status" style={{ color: "var(--warning, #c86f20)" }}>{t("허브와 이 브라우저의 기록 시점이 다릅니다. 허브가 백업에서 되살려졌거나, 업데이트 전 자료일 수 있습니다. 이 브라우저에 있던 내용은 지우지 않고 아래에 보관했고, 자동으로 다시 보내지 않습니다.")}</p>
        <p>{t("캔버스 보관본 {canvasCount}개 · 편집 문서 {editCount}개 · 카드 정리 대기 {cardCount}개").replace("{canvasCount}", String(canvasCount)).replace("{editCount}", String(editCount)).replace("{cardCount}", String(cardCount))}</p>
        <div className="settings-row">
          <button className="settings-action" disabled={busy} onClick={() => void run(async () => { downloadStorageRecovery(ownRecovery); return "보관본을 내려받았습니다."; })}>{t("보관본 내려받기")}</button>
          <button className="settings-action" disabled={busy || floating} onClick={() => fileRef.current?.click()}>{t("전체 가져오기로 되살리기")}</button>
        </div>
      </div>}
      {!(canvasCount + editCount + cardCount) && !!ownRecovery?.mirror?.originals.length && redundantMirrorHoldIds(ownRecovery).size > 0 && <div className="settings-row">
        <button className="settings-action" disabled={busy} onClick={() => void run(async () => { downloadStorageRecovery(ownRecovery); return "보관본을 내려받았습니다."; })}>{t("보관본 내려받기")}</button>
      </div>}
      {archive && archiveAccount === account && <div className="settings-row">
        <span>{t("허브로 바꾸기 전 이 브라우저 캔버스 {count}개 — 합치지 않고 따로 남겨 둔 것").replace("{count}", String(Object.values(archive.scenes).reduce((n, scenes) => n + scenes.length, 0)))}</span>
        <button className="settings-action" disabled={busy} onClick={() => { if (archiveAccount === getAccountNamespace()) downloadNotebookArchive(archive); }}>{t("내려받기")}</button>
      </div>}
      <div className="settings-row">
        <button className="settings-action" onClick={exportAll} disabled={busy}>
          전체 내보내기
        </button>
        <button className="settings-action" onClick={() => fileRef.current?.click()} disabled={busy || floating}>
          전체 가져오기
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importAll(file);
          event.target.value = ""; // 같은 파일을 다시 고를 수 있게 초기화
        }}
      />
      {/* 실시간 정보(저장 실패·방금 한 일의 결과)는 접기 밖 한 줄에 둔다(Jay 규칙). */}
      <SettingsDescription
        summary={
          msg ||
          (failing
            ? "⚠ 지금 캔버스가 저장되지 않고 있습니다 — 내보내 두세요."
            : floating
              ? otherTab ? `${CANVAS_OTHER_TAB} — 그 뒤에 가져오세요.`
                : writer.mode === "away" ? t("캔버스가 다른 브라우저에 열려 있습니다 — 여기서 연 뒤 가져오세요")
                : writer.mode === "taking" || writer.mode === "giving" ? t("캔버스를 넘기는 중입니다 — 끝난 뒤 가져오세요")
                : writer.mode === "checking" || writer.mode === "syncing" ? t("허브 공책을 맞추는 중입니다 — 끝난 뒤 가져오세요")
                : "캔버스가 별도 창에 떠 있는 동안은 가져올 수 없습니다. 창을 닫은 뒤 가져오세요."
              : "이 PC 의 모든 캔버스를 파일 하나로 내려받거나, 그 파일에서 다시 가져옵니다.")
        }
      >
        <p>내보낸 파일에는 아직 저장되지 않은 편집까지 들어갑니다. 그림·영상 파일은 들어가지 않습니다(참조만).</p>
        <p>
          가져오기는 지금 캔버스를 덮지 않습니다 — 없는 캔버스만 더하고, 같은 캔버스인데 내용이 다르면
          &apos;[사본] 이름&apos; 탭으로 따로 둡니다.
        </p>
      </SettingsDescription>
      {/* '옮길 때(2026-10-08)' 옛 이관 기록 줄은 뺐다(자료 관리 시안 2판) — 기록은 lib/sceneStore 에 남아 있다. */}
      <p className="settings-hint" data-testid="canvas-storage-facts">
        지금 캔버스 {listScenes(null).length}개
      </p>
    </div>
  );
}

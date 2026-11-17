import { useState } from "react";
import { takeSceneWriter, useSceneWriter } from "../lib/sceneWriter";
import { downloadSceneArchive } from "../lib/sceneArchive";
import { useT } from "../lib/i18n";
import { CanvasFloatIcon } from "./TopBar";

export function CanvasWriterStatus() {
  const state = useSceneWriter();
  const t = useT();
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const taking = state.mode === "taking";
  const giving = state.mode === "giving";
  const matching = state.mode === "checking" || state.mode === "syncing";
  const busy = taking || giving || matching;
  const exportAll = async () => {
    setExporting(true);
    try {
      const count = await downloadSceneArchive();
      setExportMessage(t("캔버스 {count}개를 파일로 내려받았습니다.").replace("{count}", String(count)));
    } catch {
      setExportMessage(t("내려받지 못했습니다."));
    } finally { setExporting(false); }
  };
  return <div className="canvas-away" role="status" aria-live="polite">
    {busy ? <span className="canvas-writer-spinner" aria-hidden="true" /> : <CanvasFloatIcon />}
    <span>{t(state.floating ? "이 캔버스 창의 편집이 멈췄습니다" : taking ? "넘겨받는 중" : giving ? "마지막 편집을 저장하고 있습니다" : matching ? "캔버스를 맞추는 중" : state.error ? "캔버스를 맞추지 못했습니다" : state.handed ? "다른 브라우저로 넘겼습니다" : "다른 브라우저에서 이 캔버스를 쓰고 있습니다 · 여기서 고치려면 넘겨받으세요")}</span>
    <small>{state.error || t(state.floating ? "메인 창에서 캔버스를 다시 연 뒤 작업해 주세요" : taking ? "다른 브라우저의 마지막 편집을 저장하고 캔버스를 받아 오는 중입니다" : giving ? "저장을 확인한 뒤 넘깁니다" : matching ? "캔버스의 마지막 저장 내용을 확인하고 있습니다" : "정상적으로 넘기면 그 브라우저의 마지막 편집까지 저장한 뒤 넘어옵니다")}</small>
    {state.localCount > 0 && <small>{t("이 브라우저에만 남는 씬 {count}개").replace("{count}", String(state.localCount))}</small>}
    {exportMessage && <small>{exportMessage}</small>}
    {!busy && !state.floating && <div className="canvas-writer-actions">
      {state.error && <button className="settings-action" disabled={exporting} onClick={() => void exportAll()}>{t("전체 내보내기")}</button>}
      <button className="canvas-writer-open" onClick={takeSceneWriter}>{t(state.error ? "다시 시도" : state.handed ? "여기서 다시 열기" : "여기서 열기")}</button>
    </div>}
  </div>;
}

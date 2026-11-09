import { takeSceneWriter, useSceneWriter } from "../lib/sceneWriter";
import { CanvasFloatIcon } from "./TopBar";

export function CanvasWriterStatus() {
  const state = useSceneWriter();
  const taking = state.mode === "taking";
  const giving = state.mode === "giving";
  return <div className="canvas-away" role="status" aria-live="polite">
    {taking || giving ? <span className="canvas-writer-spinner" aria-hidden="true" /> : <CanvasFloatIcon />}
    <span>{taking ? "넘겨받는 중" : giving ? "마지막 편집을 저장하고 있습니다" : state.handed ? "다른 브라우저로 넘겼습니다" : "캔버스는 다른 브라우저에서 열려 있습니다"}</span>
    <small>{taking ? "다른 브라우저의 마지막 편집을 저장하고 허브 공책을 받고 있습니다" : giving ? "허브에서 저장을 확인한 뒤 넘깁니다" : "여기서 열면 그 브라우저의 마지막 편집까지 저장한 뒤 넘어옵니다"}</small>
    {state.localCount > 0 && <small>이 브라우저에만 남는 씬 {state.localCount}개</small>}
    {!taking && !giving && <button className="canvas-writer-open" onClick={takeSceneWriter}>{state.handed ? "여기서 다시 열기" : "여기서 열기"}</button>}
  </div>;
}

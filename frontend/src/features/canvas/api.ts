import { lazy } from "react";
export { canvasTarget, createCanvasDocumentPort, importCanvasSnapshot, restoreCanvasCardLinks, restoreCanvasDocuments, relinkCanvasDocuments, type CanvasTarget, type CanvasCommand, type CanvasDocumentPort, type CanvasWriteReceipt } from "./session";
export { useCanvasSession, type CanvasInputCommand } from "./useCanvasSession";
export type { CanvasComfyCommand, ComfyConfigEdit, ComfyRuntimeUpdate } from "./comfyCommands";
export { doneOutputsPatch } from "./comfyCommands";
export type { CanvasGestures, CanvasMoveHandle, CanvasCardResizeHandle, CanvasGroupResizeHandle, CanvasGestureRect, CanvasGroupFrame } from "./gestures";
export { gatherCanvasReferences } from "./references";
export { sceneRefWorkspaceId, relinkCards, applyRelink, relinkKey, type RelinkTarget } from "./assetRefs";
// GPU 보기 모드(docs/status/캔버스_GPU판설계_2026-11-11.md) — 개발 표식 mvhub.canvas.gpuBoard 뒤
export { useGpuBoardMode, type CameraSource } from "./gpu/gpuMode";
// GPU 판 본체(WebGL·아틀라스)는 켤 때만 불러온다 — 이 포트를 쓰는 lib 모듈(sceneBackup 등)이 같이 불러오면 공책 시험이 전체 시험에서 시간 초과(11-11 실측)
export const GpuBoard = lazy(() => import("./gpu/GpuBoard").then((m) => ({ default: m.GpuBoard })));
export type { GpuBoardProps } from "./gpu/GpuBoard";
export { GpuOverlayCard } from "./gpu/GpuOverlayCard";
export { GpuMeasure, GPU_MEASURE_BATCH, type GpuMeasureItem, type GpuMeasureResult } from "./gpu/GpuMeasure";
export { buildGpuScene, type GpuSceneInput, type GpuSceneModel } from "./gpu/gpuScene";

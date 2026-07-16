// Canvas 씬(빈 캔버스) 상태·CRUD 를 App.tsx 에서 추출.
//  · 씬 목록/활성/바인딩/선택 상태 + 씬 CRUD(선택·추가·이름변경·삭제)를 한곳에.
//  · patchActiveScene: 활성 씬을 갱신하고 목록을 다시 읽는 반복 패턴(updateScene + listScenes)을 DRY.
// 씬은 프로젝트 무관 전역(S1) — 모든 scenes 호출에 projectId=null. localStorage 데이터계층(scenes.ts).
import { useRef, useState } from "react";
import type { Scene, SceneRef } from "./scenes";
import {
  createScene,
  deleteScene,
  getActiveSceneId,
  listScenes,
  setActiveSceneId as persistActiveScene,
  updateScene,
} from "./scenes";
import type { Generation } from "../types";

export function useSceneCoordination() {
  const [scenes, setScenes] = useState<Scene[]>(() => listScenes(null));
  const [activeSceneId, setActiveSceneId] = useState<string | null>(() => getActiveSceneId(null));
  const activeScene = scenes.find((s) => s.id === activeSceneId) || null;
  // 씬 생성 카드 1개 선택 시 그 카드(id+레퍼런스)를 하단 프롬프트에 바인딩. SceneBoard 가 통지.
  const [sceneBinding, setSceneBinding] = useState<{ cardId: string; refs: SceneRef[] } | null>(null);
  // 씬 캔버스에서 선택된 결과 카드들 → 프롬프트 위 선택바. 삭제는 명령형 핸들로.
  const [sceneSelGens, setSceneSelGens] = useState<Generation[]>([]);
  const sceneActionRef = useRef<{ deleteSelected: () => void } | null>(null);

  const refreshScenes = () => setScenes(listScenes(null));
  const selectScene = (id: string | null) => {
    setActiveSceneId(id);
    persistActiveScene(null, id);
  };
  const addScene = () => {
    const s = createScene(null);
    refreshScenes();
    selectScene(s.id);
  };
  const renameScene = (id: string, name: string) => {
    updateScene(null, id, { name });
    refreshScenes();
  };
  const removeSceneById = (id: string) => {
    deleteScene(null, id);
    refreshScenes();
    if (activeSceneId === id) selectScene(null);
  };
  // 활성 씬 patch + 목록 재읽기 — updateScene(null, activeScene.id, …) + setScenes(listScenes(null)) 반복을 하나로.
  const patchActiveScene = (patch: Partial<Scene>) => {
    if (!activeScene) return;
    updateScene(null, activeScene.id, patch);
    refreshScenes();
  };

  // setScenes/refreshScenes 는 내부 전용(반환 안 함) — 외부는 CRUD·patchActiveScene 로만 씬을 바꾼다.
  return {
    scenes,
    activeSceneId,
    activeScene,
    sceneBinding,
    setSceneBinding,
    sceneSelGens,
    setSceneSelGens,
    sceneActionRef,
    selectScene,
    addScene,
    renameScene,
    removeSceneById,
    patchActiveScene,
  };
}

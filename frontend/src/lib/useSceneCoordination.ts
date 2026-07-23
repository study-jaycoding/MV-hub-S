// Canvas 씬(빈 캔버스) 상태·CRUD 를 App.tsx 에서 추출.
//  · 씬 목록/활성/바인딩/선택 상태 + 씬 CRUD(선택·추가·이름변경·삭제)를 한곳에.
//  · patchActiveScene: 활성 씬을 갱신하고 목록을 다시 읽는 반복 패턴(updateScene + listScenes)을 DRY.
// 씬은 프로젝트 무관 전역(S1) — 모든 scenes 호출에 projectId=null. localStorage 데이터계층(scenes.ts).
import { useEffect, useRef, useState } from "react";
import type { Scene, SceneRef, SceneSnapshot } from "./scenes";
import {
  createScene,
  deleteScene,
  getActiveSceneId,
  importScene,
  listScenes,
  setActiveSceneId as persistActiveScene,
  updateScene,
} from "./scenes";
import { STORAGE_KEYS } from "./storageKeys";
import type { Generation } from "../types";

export function useSceneCoordination(flash?: (msg: string) => void) {
  const [scenes, setScenes] = useState<Scene[]>(() => listScenes(null));
  const [activeSceneId, setActiveSceneId] = useState<string | null>(() => getActiveSceneId(null));
  const activeScene = scenes.find((s) => s.id === activeSceneId) || null;
  // 멀티탭 보호(C4) — 다른 탭이 씬을 저장하면(storage 이벤트) 마지막 저장이 조용히 덮어써서 이 탭이
  //  스테일해지는 걸 막는다. ★비파괴만: '내가 보고 있는 활성 씬'은 내 in-memory 를 유지(편집 보존)하고,
  //  나머지(비활성) 씬만 최신으로 반영한다. 활성 씬이 외부에서 바뀌거나 삭제되면 알림만 한다(자동 병합
  //  금지 — 자동 병합은 삭제한 카드가 되살아나는 위험이 있어 배제).
  const activeSceneIdRef = useRef(activeSceneId);
  activeSceneIdRef.current = activeSceneId;
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const lastNotifyRef = useRef(0);
  useEffect(() => {
    const notify = (msg: string) => {
      const now = Date.now();
      if (now - lastNotifyRef.current < 5000) return; // 다른 탭 연속 편집 시 알림 폭주 방지
      lastNotifyRef.current = now;
      flashRef.current?.(msg);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.scenes) return; // 내 탭 저장은 storage 이벤트 안 옴 — 교차탭만
      const latest = listScenes(null);
      setScenes((prev) => {
        const activeId = activeSceneIdRef.current;
        const myActive = activeId ? prev.find((s) => s.id === activeId) : undefined;
        const latestActive = activeId ? latest.find((s) => s.id === activeId) : undefined;
        if (myActive && !latestActive) {
          // 다른 탭이 내가 보던 씬을 삭제 — 비파괴: 내 상태 전체 유지, 알림만.
          notify("다른 탭에서 이 씬이 삭제됐습니다 — 새로고침하면 반영됩니다.");
          return prev;
        }
        // 활성 씬은 내 것 유지(편집 보존), 나머지는 최신으로.
        const merged = myActive
          ? latest.map((s) => (s.id === activeId ? myActive : s))
          : latest;
        if (myActive && latestActive && JSON.stringify(latestActive) !== JSON.stringify(myActive)) {
          notify("다른 탭에서 이 씬이 변경됐습니다 — 새로고침하면 반영됩니다.");
        }
        return merged;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
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
  // 파일에서 불러온 스냅샷을 새 씬 탭으로 만들고 그 탭으로 전환(현재 캔버스는 보존).
  const importSceneSnapshot = (snap: SceneSnapshot): Scene => {
    const s = importScene(null, snap);
    refreshScenes();
    selectScene(s.id);
    return s;
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
    importSceneSnapshot,
    renameScene,
    removeSceneById,
    patchActiveScene,
  };
}

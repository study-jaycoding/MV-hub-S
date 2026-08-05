// Canvas 씬(빈 캔버스) 상태·CRUD 를 App.tsx 에서 추출.
//  · 씬 목록/활성/바인딩/선택 상태 + 씬 CRUD(선택·추가·이름변경·삭제)를 한곳에.
//  · patchSceneById/patchActiveScene: 대상 씬을 갱신하고 목록을 다시 읽는 반복 패턴을 DRY.
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
import { clearSceneHistory } from "./sceneUndoStore";
import { initSceneBackup, subscribeSceneRestore } from "./sceneBackup";
import { STORAGE_KEYS } from "./storageKeys";
import type { Generation } from "../types";

// 백그라운드 씬의 비동기 결과가 도착해도, 현재 씬의 아직 디바운스 저장 전인 입력은 React 메모리에서
// 보존한다. target 씬만 최신 저장본으로 교체하고 나머지는 최신 목록을 사용한다.
export function mergePatchedSceneList(
  previous: Scene[],
  latest: Scene[],
  activeSceneId: string | null,
  patchedSceneId: string,
): Scene[] {
  if (!activeSceneId || activeSceneId === patchedSceneId) return latest;
  const inMemoryActive = previous.find((scene) => scene.id === activeSceneId);
  if (!inMemoryActive) return latest;
  let found = false;
  const merged = latest.map((scene) => {
    if (scene.id !== activeSceneId) return scene;
    found = true;
    return inMemoryActive;
  });
  if (found) return merged;
  // 다른 탭이 활성 씬을 삭제한 순간 백그라운드 결과가 도착해도, 기존 비파괴 정책처럼 화면은 유지한다.
  const previousIndex = previous.findIndex((scene) => scene.id === activeSceneId);
  merged.splice(Math.min(Math.max(previousIndex, 0), merged.length), 0, inMemoryActive);
  return merged;
}

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
  // DB 백업 미러 — 저장 관문에 디바운스 푸시 배선 + 초기 reconcile + 로컬 버킷이 통째로 없을 때만
  //  DB 에서 복구(브라우저 캐시 삭제 대비. 로컬이 항상 정답 — 빈 배열 버킷(정상 삭제)은 복구 안 함).
  //  ★구독 방식: 최초 복구뿐 아니라 백그라운드 복구(미로그인 401 → 로그인 후 백오프 재시도 성공)도
  //   같은 탭 화면에 즉시 반영돼야 한다 — storage 이벤트는 같은 탭엔 오지 않는다(코덱스 P1).
  useEffect(() => {
    const unsubscribe = subscribeSceneRestore(() => {
      setScenes(listScenes(null));
      flashRef.current?.("씬을 DB 백업에서 복구했습니다.");
    });
    void initSceneBackup();
    return unsubscribe;
  }, []);
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
  const sceneActionRef = useRef<{
    deleteSelected: () => void;
    setCardRefs: (cardId: string, refs: SceneRef[]) => SceneRef[];
    flushPending: () => void; // 밀린 입력 저장 확정 — 씬 전환 직전 호출
  } | null>(null);
  // 비동기 결과가 현재 씬에 합쳐지기 직전, 아직 SceneBoard 메모리에만 있는 입력을 먼저 저장한다.
  // patchSceneById 안에서 자동 호출하면 flush→onChange→patch 재귀가 되므로 명시 관문으로 분리한다.
  const flushScenePending = (sceneId: string) => {
    if (activeSceneIdRef.current === sceneId) sceneActionRef.current?.flushPending();
  };

  const refreshScenes = () => setScenes(listScenes(null));
  const selectScene = (id: string | null) => {
    // ★씬을 바꾸기 전에 SceneBoard 의 밀린 입력 저장을 확정 — 그때는 activeScene 이 아직 옛 씬이라 정확히
    //  저장된다. add/import/delete 도 모두 이 selectScene 을 거치므로 전환 경로 전체가 여기서 커버된다.
    sceneActionRef.current?.flushPending();
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
    clearSceneHistory(id); // 삭제된 씬의 undo 히스토리(모듈 store)도 정리 — 메모리 누적 방지
    refreshScenes();
    if (activeSceneId === id) selectScene(null);
  };
  // 명시한 씬 patch + 목록 재읽기. 비동기 작업은 완료 시 활성 씬이 바뀔 수 있으므로 반드시 시작할 때
  // 캡처한 sceneId 로 이 관문을 호출한다. 삭제된 씬은 updateScene 이 재생성하지 않는다.
  const patchSceneById = (sceneId: string, patch: Partial<Scene>) => {
    updateScene(null, sceneId, patch);
    const latest = listScenes(null);
    setScenes((previous) =>
      mergePatchedSceneList(previous, latest, activeSceneIdRef.current, sceneId),
    );
  };
  // 동기 UI 편집용 활성 씬 관문.
  const patchActiveScene = (patch: Partial<Scene>) => {
    if (!activeScene) return;
    patchSceneById(activeScene.id, patch);
  };

  // setScenes/refreshScenes 는 내부 전용(반환 안 함) — 외부는 CRUD·두 patch 관문으로만 씬을 바꾼다.
  return {
    scenes,
    activeSceneId,
    activeScene,
    sceneBinding,
    setSceneBinding,
    sceneSelGens,
    setSceneSelGens,
    sceneActionRef,
    flushScenePending,
    selectScene,
    addScene,
    importSceneSnapshot,
    renameScene,
    removeSceneById,
    patchSceneById,
    patchActiveScene,
  };
}

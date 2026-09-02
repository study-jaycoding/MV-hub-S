// Canvas 씬(빈 캔버스) 상태·CRUD 를 App.tsx 에서 추출.
//  · 씬 목록/활성/바인딩/선택 상태 + 씬 CRUD(선택·추가·이름변경·삭제)를 한곳에.
//  · patchSceneById/patchActiveScene: 대상 씬을 갱신하고 목록을 다시 읽는 반복 패턴을 DRY.
// 씬은 프로젝트 무관 전역(S1) — 모든 scenes 호출에 projectId=null. localStorage 데이터계층(scenes.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Scene, SceneRef, SceneSnapshot } from "./scenes";
import {
  createScene,
  deleteScene,
  getActiveSceneId,
  importScene,
  listScenes,
  setActiveSceneId as persistActiveScene,
  saveScenes,
  updateScene,
} from "./scenes";
import { clearSceneHistory } from "./sceneUndoStore";
import {
  countBackupOnlyScenes,
  importFromBackup,
  initSceneBackup,
  subscribeSceneRestore,
} from "./sceneBackup";
import {
  initSceneCardLinks,
  mergeCardLinksIntoScenes,
  serverCardLinks,
  subscribeCardLinksLoaded,
} from "./sceneCardLinks";
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
  // DB 백업에만 있고 이 브라우저엔 없는 씬 수 — 0 이면 '가져오기'를 아예 노출하지 않는다.
  const [backupOnly, setBackupOnly] = useState(0);
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
    // ★순서: 씬 복구 판정(initSceneBackup)이 먼저다. 카드 소속 백필이 앞서면 아직 복구 안 된
    //  빈 로컬을 기준으로 "올릴 게 없다"고 판단한다(멱등이라 사고는 아니지만 한 사이클 헛돈다).
    // 카드 소속 합치기 — DB 가 아는 소속을 화면 씬에 반영한다(다른 브라우저에서 담은 결과가 보이게).
    //  바뀐 게 없으면 merge 가 null 을 주므로 저장→알림 고리가 돌지 않는다.
    const unsubscribeLinks = subscribeCardLinksLoaded(() => {
      // ★병합 전에 활성 캔버스의 디바운스 저장을 먼저 확정한다 — listScenes()는 저장본이라,
      //  막 입력한 텍스트/파라미터가 아직 디바운스 중이면 그걸 지운 옛 상태로 병합·저장해
      //  입력이 유실된다(적대 리뷰 P2). flush 가 저장본을 최신으로 만든 뒤 병합한다.
      sceneActionRef.current?.flushPending();
      const merged = mergeCardLinksIntoScenes(listScenes(null), serverCardLinks());
      if (!merged) return;
      saveScenes(null, merged);
      setScenes(merged);
    });
    void initSceneBackup()
      .catch(() => false)
      .then(() => initSceneCardLinks())
      // 자동 복구가 닿지 못한 씬(다른 브라우저 프로필이 올려 둔 것)이 있으면 개수를 알아 둔다.
      .then(() => countBackupOnlyScenes().then(setBackupOnly, () => setBackupOnly(0)));
    return () => {
      unsubscribe();
      unsubscribeLinks();
    };
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
    zoomFit: () => void; // 툴바 '맞춤'(f 키 프레이밍과 동일)
    zoomStep: (dir: 1 | -1) => void; // 툴바 −/+ 한 단계 확대/축소
  } | null>(null);
  // 비동기 결과가 현재 씬에 합쳐지기 직전, 아직 SceneBoard 메모리에만 있는 입력을 먼저 저장한다.
  // patchSceneById 안에서 자동 호출하면 flush→onChange→patch 재귀가 되므로 명시 관문으로 분리한다.
  // ★참조 안정성(useCallback deps []): App 의 캔버스 복구 이펙트가 이 두 함수를 의존성으로
  //  갖는다. 매 렌더 새 함수를 만들면 이펙트가 렌더마다 재실행돼 2.5초 백오프 폴링이
  //  '렌더 주기 폴링'으로 변질된다(생성 중 초당 수 건의 복구 API 폭주). 내부는 ref/모듈
  //  함수만 쓰므로 빈 deps 가 안전하다.
  const flushScenePending = useCallback((sceneId: string) => {
    if (activeSceneIdRef.current === sceneId) sceneActionRef.current?.flushPending();
  }, []);

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
    // 활성 씬을 지우면 남은 씬으로 이동 — null(계보 뷰)로 떨어뜨리면 '히스토리' 고정 탭이
    // 없어진 지금은 아무 탭도 안 켜진 낯선 화면에 갇힌 느낌을 준다. 씬이 하나도 없을 때만 null.
    if (activeSceneId === id) {
      const next = listScenes(null).find((s) => s.id !== id);
      selectScene(next ? next.id : null);
    }
  };
  // DB 백업에만 있는 씬을 이 브라우저로 가져온다(로컬은 덮지 않는다 — 같은 id 는 로컬 유지).
  const importBackupScenes = async () => {
    try {
      const added = await importFromBackup();
      // 가져온 씬에도 '카드에서 뺀 생성물' 표시를 입힌다 — 이미 로드된 소속 목록은 바뀌지 않아
      // 구독 통지가 오지 않으므로, 여기서 한 번 직접 병합한다(코덱스 P2).
      if (added) {
        const merged = mergeCardLinksIntoScenes(listScenes(null), serverCardLinks());
        if (merged) saveScenes(null, merged);
      }
      refreshScenes();
      flashRef.current?.(
        added ? `DB 백업에서 씬 ${added}개를 가져왔습니다.` : "가져올 씬이 없습니다.",
      );
    } catch (e) {
      flashRef.current?.(e instanceof Error ? e.message : "씬을 가져오지 못했습니다.");
    }
    // 성공·실패와 무관하게 남은 개수를 다시 센다(부분 실패·다른 프로필의 새 백업 반영).
    countBackupOnlyScenes().then(setBackupOnly, () => setBackupOnly(0));
  };
  // 명시한 씬 patch + 목록 재읽기. 비동기 작업은 완료 시 활성 씬이 바뀔 수 있으므로 반드시 시작할 때
  // 캡처한 sceneId 로 이 관문을 호출한다. 삭제된 씬은 updateScene 이 재생성하지 않는다.
  const patchSceneById = useCallback((sceneId: string, patch: Partial<Scene>) => {
    // 성공하면 저장된 목록을 그대로 받는다(재파싱 제거). 저장 실패(용량 초과·접근 차단)면 null 이므로
    // 미저장 편집을 화면에 채택하지 않고, 저장본을 다시 읽어 화면을 되돌린다 — 편집이 사라지는 것이
    // 사용자에게 실패 신호가 된다(이 반환 계약 도입 전과 같은 체감).
    const latest = updateScene(null, sceneId, patch) ?? listScenes(null);
    setScenes((previous) =>
      mergePatchedSceneList(previous, latest, activeSceneIdRef.current, sceneId),
    );
  }, []);
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
    backupOnly,
    importBackupScenes,
  };
}

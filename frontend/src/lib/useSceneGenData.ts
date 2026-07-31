// SceneBoard 의 'genId → 실제 생성물' 바인딩·폴링·계보(레퍼런스 부모)·비활성/삭제 상태를 컴포넌트에서 추출.
//  · 카드의 모든 변형(genIds) 생성물을 조회하고, 진행 중이면 그것만 재폴링(N+1 폴링 제거).
//  · 외부에서 삭제(404/410)된 id 는 missingIds 로 표시, deactivated(회색)는 disabledIds 로.
//  · 각 생성물의 레퍼런스 부모(materials)는 새 id 만 1회 조회(계보는 생성 시 확정·불변).
// 미러 ref(genDataRef/refParentsRef)는 렌더 중 대입해야 한다(useEffect 로 옮기면 한 렌더 늦음). refParentsRef 는 내부 전용.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { APP_EVENTS } from "./appEvents";
import { onLibraryChanged } from "./libraryBroadcast";
import { DISABLED_EVENT, loadDisabledFolders, loadDisabledGen } from "./deactivated";
import { expandDisabledGenerationIds } from "./generationDisplay";
import { useCustomEvent } from "./useCustomEvent";
import { variantIds, type SceneCard } from "./scenes";
import {
  putGen,
  putParents,
  markGenMissing,
  hydrateGen,
  hydrateParents,
  hydrateMissing,
} from "./sceneGenDataStore";
import type { Generation } from "../types";

export interface SceneGenDataApi {
  genData: Record<string, Generation>; // 바인딩된 genId → 실제 생성물
  setGenData: React.Dispatch<React.SetStateAction<Record<string, Generation>>>;
  genDataRef: React.MutableRefObject<Record<string, Generation>>; // 명령형 로직이 최신값을 읽는 미러(반환)
  missingIds: Set<string>; // 외부 삭제(404/410)로 사라진 id — '삭제됨' 표시
  disabledIds: Set<string>; // 비활성(회색) — deactivated 로컬 소스
  refParents: Record<string, string[]>; // genId → 레퍼런스 부모(materials) id들
}

export function useSceneGenData(cards: SceneCard[]): SceneGenDataApi {
  // 마운트 초기값 = 캐시(sceneGenDataStore)에서 즉시 복원 — 탭 왕복(언마운트→재마운트) 시 빈 화면 없이 바로 표시.
  const initialGenIds = (): string[] =>
    cards
      .filter((c) => c.kind === "generation" || (c.kind === "comfy" && (c.genIds?.length || c.genId)))
      .flatMap((c) => variantIds(c));
  const [genData, setGenData] = useState<Record<string, Generation>>(() => hydrateGen(initialGenIds()));
  const genDataRef = useRef(genData);
  genDataRef.current = genData;
  // 외부(라이브러리)에서 삭제(휴지통 이동)돼 404 로 사라진 생성물 id — 카드가 무한 'Generating' 대신 '삭제됨' 표시.
  const [missingIds, setMissingIds] = useState<Set<string>>(() => hydrateMissing(initialGenIds()));
  const [refParents, setRefParents] = useState<Record<string, string[]>>(() => hydrateParents(initialGenIds()));
  const refParentsRef = useRef(refParents);
  refParentsRef.current = refParents;
  // 비활성(회색) 표시 — 라이브러리/계보와 같은 로컬 소스(deactivated). 어디서 토글해도 즉시 반영.
  const [disabledTick, setDisabledTick] = useState(0);
  useCustomEvent(DISABLED_EVENT, () => setDisabledTick((t) => t + 1));
  const disabledIds = useMemo(
    () => expandDisabledGenerationIds(Object.values(genData), loadDisabledGen(), loadDisabledFolders()),
    [genData, disabledTick],
  );
  const genIdSig = cards
    // 생성 카드 + Comfy 노드(출력을 생성물로 저장해 genIds 를 가진 것) 모두 생성물 데이터를 조회한다.
    .filter((c) => c.kind === "generation" || (c.kind === "comfy" && (c.genIds?.length || c.genId)))
    .flatMap((c) => variantIds(c))
    .join(",");
  // 생성물 변경 브로드캐스트(담기/폴더이동/미분류/삭제 등)를 구독 → refreshTick 을 올려 현재 카드들의
  // 생성물을 즉시 재조회한다. 완료 카드는 평소 재폴링을 안 해 folder_path/project_id 가 stale 이었고,
  // 그래서 캔버스에서 폴더로 담은 직후 그 폴더를 눌러도(탭 왕복 전) 딤이 옛 값으로 잘못 표시되던 버그.
  const [refreshTick, setRefreshTick] = useState(0);
  // 라이브러리 변경이 연속으로(배치 태깅·담기 등) 오면 매번 전 variant 재조회는 과하다 →
  // 트레일링 300ms 디바운스로 버스트를 1회로 합친다(마지막 이벤트 후 실행이라 folder 신선도 유지).
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const bumpRefresh = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => setRefreshTick((t) => t + 1), 300);
  };
  useEffect(() => onLibraryChanged(bumpRefresh), []); // 창 간
  useCustomEvent(APP_EVENTS.libraryChanged, bumpRefresh); // 같은 창(내 담기·생성 즉시)
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);
  useEffect(() => {
    const ids = Array.from(new Set(genIdSig.split(",").filter(Boolean)));
    if (!ids.length) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async (pollIds: string[]) => {
      // id 별로 성공/삭제(404·410)/일시오류를 구분 — 삭제는 '없음' 표시, 일시오류는 그대로 둔다.
      const rs = await Promise.all(
        pollIds.map(async (id) => {
          try {
            return { id, gen: await api.getGeneration(id), gone: false };
          } catch (e) {
            return { id, gen: null, gone: /\b(404|410)\b/.test(String(e)) };
          }
        }),
      );
      if (!alive) return;
      // 캐시에도 기록 — 탭 왕복·씬 전환 시 재조회 없이 즉시 복원되게(성공=저장/재등장, 삭제=missing 표시).
      for (const r of rs) {
        if (r.gen) {
          putGen(r.gen);
          markGenMissing(r.id, false);
        } else if (r.gone) markGenMissing(r.id, true);
      }
      setGenData((prev) => {
        const next = { ...prev };
        for (const r of rs) {
          if (r.gen) next[r.gen.id] = r.gen;
          else if (r.gone) delete next[r.id]; // 삭제 확정 → stale 결과 제거(캐시서도 제거됨) → '삭제됨' 표시가 드러나게
        }
        return next;
      });
      setMissingIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const r of rs) {
          if (r.gen && next.delete(r.id)) changed = true; // 되살아나면(복원) 해제
          else if (r.gone && !next.has(r.id)) {
            next.add(r.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // 재폴은 '아직 진행 중'인 id 만 — 완료 카드를 매 2.5초 다시 조회하던 N+1 폴링 제거.
      const stillPending = rs
        .filter((r) => r.gen && ["pending", "queued", "running", "processing"].includes(String(r.gen.status)))
        .map((r) => r.id);
      if (stillPending.length) timer = window.setTimeout(() => tick(stillPending), 2500);
    };
    void tick(ids); // 1회차만 전체 조회(상태 파악), 이후엔 진행 중인 것만
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // refreshTick = 라이브러리 변경 브로드캐스트 시 전체 재조회(담기 직후 folder_path 최신화).
  }, [genIdSig, refreshTick]);

  // 각 생성물의 '레퍼런스 부모'(materials) 조회 — 새로 등장한 id 만(계보는 생성 시 확정, 이후 불변).
  useEffect(() => {
    const ids = Array.from(new Set(genIdSig.split(",").filter(Boolean)));
    const need = ids.filter((id) => !(id in refParentsRef.current));
    if (!need.length) return;
    let alive = true;
    void Promise.all(
      need.map(async (id) => {
        try {
          const h = await api.history(id);
          return { id, parents: (h.materials || []).map((m) => m.id), store: true };
        } catch (e) {
          // 확정적 부재(404/410)만 [] 로 캐시. 일시 오류는 저장하지 않아 다음 변경 때 재조회(false 실선 고정 방지).
          return { id, parents: [] as string[], store: /\b(404|410)\b/.test(String(e)) };
        }
      }),
    ).then((rs) => {
      if (!alive) return;
      for (const r of rs) if (r.store) putParents(r.id, r.parents); // 계보도 캐시 — 탭 왕복 시 재조회 없이 복원
      setRefParents((prev) => {
        const next = { ...prev };
        for (const r of rs) if (r.store) next[r.id] = r.parents;
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [genIdSig]);

  // 씬 전환(genIdSig 변경) 시 새 씬 카드들의 생성물을 캐시에서 즉시 복원 — tick 서버조회를 기다리는 빈 화면 제거.
  //  (prev 우선 병합이라 이미 최신인 값은 덮지 않는다. 아래 prune 이 현재 카드 밖 id 를 곧 정리한다.)
  useEffect(() => {
    const ids = genIdSig.split(",").filter(Boolean);
    if (!ids.length) return;
    const g = hydrateGen(ids);
    const p = hydrateParents(ids);
    const m = hydrateMissing(ids);
    if (Object.keys(g).length) setGenData((prev) => ({ ...g, ...prev }));
    if (Object.keys(p).length) setRefParents((prev) => ({ ...p, ...prev }));
    if (m.size)
      setMissingIds((prev) => {
        // id 단위 병합 — 이전 씬 missing 이 남아있어도 새 씬 캐시 missing 을 누락 없이 반영(아래 prune 이 live 밖 제거).
        let changed = false;
        const next = new Set(prev);
        for (const id of m) if (!next.has(id)) { next.add(id); changed = true; }
        return changed ? next : prev;
      });
  }, [genIdSig]);

  // 장기 누적 방지 — 현재 카드가 더 이상 참조하지 않는 id 의 캐시(genData/refParents/missingIds)를 정리.
  // 카드 삭제·씬 전환을 반복하는 긴 세션에서 옛 생성물 데이터가 무한 쌓이지 않게(옛 forward-merge 만 함).
  // (진행 중 폴은 genIdSig 변경 시 위 effect cleanup 이 alive=false 로 무효화 → 지운 id 를 되살리는 레이스 없음)
  useEffect(() => {
    const live = new Set(genIdSig.split(",").filter(Boolean));
    const pruned = <T,>(obj: Record<string, T>): Record<string, T> | null => {
      const keys = Object.keys(obj);
      if (keys.every((k) => live.has(k))) return null; // 지울 것 없음 → 참조 유지(불필요 리렌더 방지)
      const next: Record<string, T> = {};
      for (const k of keys) if (live.has(k)) next[k] = obj[k];
      return next;
    };
    setGenData((prev) => pruned(prev) ?? prev);
    setRefParents((prev) => pruned(prev) ?? prev);
    setMissingIds((prev) =>
      [...prev].every((id) => live.has(id)) ? prev : new Set([...prev].filter((id) => live.has(id))),
    );
  }, [genIdSig]);

  return { genData, setGenData, genDataRef, missingIds, disabledIds, refParents };
}

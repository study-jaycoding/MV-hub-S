// SceneBoard 의 'genId → 실제 생성물' 바인딩·폴링·계보(레퍼런스 부모)·비활성/삭제 상태를 컴포넌트에서 추출.
//  · 카드의 모든 변형(genIds) 생성물을 조회하고, 진행 중이면 그것만 재폴링(N+1 폴링 제거).
//  · 외부에서 삭제(404/410)된 id 는 missingIds 로 표시, deactivated(회색)는 disabledIds 로.
//  · 각 생성물의 레퍼런스 부모(materials)는 새 id 만 1회 조회(계보는 생성 시 확정·불변).
// 미러 ref(genDataRef/refParentsRef)는 렌더 중 대입해야 한다(useEffect 로 옮기면 한 렌더 늦음). refParentsRef 는 내부 전용.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { DISABLED_EVENT, loadDisabledFolders, loadDisabledGen } from "./deactivated";
import { expandDisabledGenerationIds } from "./generationDisplay";
import { useCustomEvent } from "./useCustomEvent";
import { variantIds, type SceneCard } from "./scenes";
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
  const [genData, setGenData] = useState<Record<string, Generation>>({});
  const genDataRef = useRef(genData);
  genDataRef.current = genData;
  // 외부(라이브러리)에서 삭제(휴지통 이동)돼 404 로 사라진 생성물 id — 카드가 무한 'Generating' 대신 '삭제됨' 표시.
  const [missingIds, setMissingIds] = useState<Set<string>>(new Set());
  const [refParents, setRefParents] = useState<Record<string, string[]>>({});
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
    .filter((c) => c.kind === "generation")
    .flatMap((c) => variantIds(c))
    .join(",");
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
      setGenData((prev) => {
        const next = { ...prev };
        for (const r of rs) if (r.gen) next[r.gen.id] = r.gen;
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
  }, [genIdSig]);

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

  return { genData, setGenData, genDataRef, missingIds, disabledIds, refParents };
}

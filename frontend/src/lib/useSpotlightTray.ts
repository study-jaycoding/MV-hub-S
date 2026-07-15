// 스포트라이트 레퍼런스 트레이(확장 '+' 모드) + Canvas 씬 카드 양방향 바인딩 로직을 SpotlightPrompt 에서 추출.
//  · 일반 트레이(localTrayRefs)와 씬 카드 바인딩 트레이(boundTrayRefs)를 분리 — 씬 카드를 선택해도
//    원래 프롬프트 트레이가 보존되고, 이탈하면 그대로 복원된다. sceneMode 로 어느 쪽을 쓸지 고른다.
//  · 트레이 드래그/드롭/재정렬 핸들러 포함. 외부 파일(이미지·영상·오디오) 임포트는 컴포넌트에서
//    onImportFiles 콜백으로 주입받는다(파일→레퍼런스 변환은 카드/에셋 도메인이라 여기 두지 않는다).
// 동작 보존이 목적이므로 핸들러는 (기존과 동일하게) 렌더마다 생성되는 평범한 함수로 둔다 — 메모이제이션 없음.
import { useEffect, useRef, useState } from "react";
import { DRAG_TYPES } from "./dragTypes";
import { dataTransferHasFiles } from "./media";
import {
  parseSpotlightAssetItems,
  readSpotlightAssetPayload,
  spotlightAssetRefBase,
} from "./spotlightAssetRefs";
import { sceneRefFingerprint, type SceneRef } from "./scenes";
import type { SpotlightTrayRef } from "../components/spotlight/SpotlightRefTray";

interface Params {
  // 씬의 생성 카드 1개를 선택하면 그 카드의 레퍼런스를 이 트레이에 바인딩. null=일반 모드.
  //  key = `${sceneId}:${cardId}` (카드 바뀜 감지) · refs = 카드에 연결된 레퍼런스(순서).
  trayBinding?: { key: string; refs: SceneRef[] } | null;
  onTrayBindingRefsChange?: (refs: SceneRef[]) => void;
  // 외부 파일 드롭을 레퍼런스로 임포트 — 컴포넌트가 주입(카드/에셋 도메인). 렌더마다 최신 클로저를 받는다.
  onImportFiles: (files: File[]) => void;
}

export interface SpotlightTrayApi {
  trayRefs: SpotlightTrayRef[];
  setTrayRefs: React.Dispatch<React.SetStateAction<SpotlightTrayRef[]>>;
  sceneMode: boolean;
  trayUidRef: React.MutableRefObject<number>;
  addAssetToTray: (raw: string) => void;
  removeTrayRef: (i: number) => void;
  onTrayKeyDown: (e: React.KeyboardEvent) => void;
  onTrayDragOver: (e: React.DragEvent) => void;
  onTrayDrop: (e: React.DragEvent) => void;
  onTrayItemDragStart: (i: number) => (e: React.DragEvent) => void;
  onTrayItemDrop: (i: number) => (e: React.DragEvent) => void;
}

export function useSpotlightTray({
  trayBinding,
  onTrayBindingRefsChange,
  onImportFiles,
}: Params): SpotlightTrayApi {
  // ── 확장(+) 레퍼런스 트레이 — 에셋 폴더 드래그 전용. 순서 = 생성 --image 순서 ──
  // uid: 같은 파일을 중복으로 넣을 수 있어 file_path 가 겹치므로 React key·재정렬용 고유키.
  const [localTrayRefs, setLocalTrayRefs] = useState<SpotlightTrayRef[]>([]);
  const [boundTrayRefs, setBoundTrayRefs] = useState<SpotlightTrayRef[]>([]);
  const sceneMode = !!trayBinding;
  const trayRefs = sceneMode ? boundTrayRefs : localTrayRefs;
  const setTrayRefs = sceneMode ? setBoundTrayRefs : setLocalTrayRefs;
  const trayDragIdx = useRef<number | null>(null); // 트레이 내부 재정렬 시작 인덱스
  const trayUidRef = useRef(0); // 트레이 항목 고유키 카운터(중복 허용)

  // ── Canvas 씬 트레이 양방향 동기화 ──────────────────────────────────────
  // lastSyncFp: (A)로드와 (B)통지가 서로의 결과를 되받아 무한 갱신하지 않도록 마지막으로 맞춘 지문.
  const bindingKey = trayBinding?.key ?? null;
  const bindingRefs = trayBinding?.refs ?? null;
  const lastSyncFpRef = useRef<string>("");
  // (A) 씬 카드 선택/그 카드의 레퍼런스가 외부에서 바뀌면 → 트레이에 로드. 내 편집의 에코면 무시.
  useEffect(() => {
    if (!bindingKey || !bindingRefs) return;
    const fp = sceneRefFingerprint(bindingRefs);
    if (fp === lastSyncFpRef.current) return;
    lastSyncFpRef.current = fp;
    // 왕복(로드↔통지)이 지문 안정적이도록 name/thumb 는 값 보존(빈 값 대체 안 함).
    setBoundTrayRefs(
      bindingRefs.map((r) => ({
        file_path: r.file_path,
        type: r.type === "video" ? "video" : r.type === "audio" ? "audio" : "image",
        role: r.type === "video" ? "@Video" : r.type === "audio" ? "@Audio" : "@Image",
        name: r.name ?? "",
        thumb: r.thumb ?? "",
        source_gen_id: r.source_gen_id ?? undefined,
        uid: `t${trayUidRef.current++}`,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, bindingRefs]);
  // (B) 씬 트레이를 편집(순서변경/추가/삭제)하면 → 씬 카드로 되돌림. (A)로드로 인한 변경은 통지 안 함.
  // 의존성은 boundTrayRefs 만 — bindingKey(카드 전환)엔 반응하지 않는다. 카드 전환 커밋에선 이 시점
  // boundTrayRefs 가 아직 '이전 카드' 값이라, bindingKey 로 트리거하면 이전 refs 를 새 카드에 잘못
  // 써버리는 stale echo 가 발생한다. 새 카드 로드는 (A)가 setBoundTrayRefs 로 처리하고, 그때 다음
  // 커밋에서 이 effect 가 돌지만 fp===lastSync 라 스킵된다.
  useEffect(() => {
    if (!bindingKey) return;
    const fp = sceneRefFingerprint(boundTrayRefs);
    if (fp === lastSyncFpRef.current) return;
    lastSyncFpRef.current = fp;
    onTrayBindingRefsChange?.(
      boundTrayRefs.map((t) => ({
        file_path: t.file_path,
        type: t.type,
        name: t.name || undefined, // "" → undefined 로 되돌려 원본 SceneRef 와 지문 일치
        thumb: t.thumb || null,
        source_gen_id: t.source_gen_id ?? null,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundTrayRefs]);

  // ── 레퍼런스 트레이(확장 모드) — 에셋 폴더 드래그로 추가 + 드래그로 재정렬 ──
  // 에셋 셀 dragstart 가 심은 application/x-ch-asset 만 받는다(카드·@ 아님). 값은 항상 배열 —
  // 다중선택을 그리드 순서대로 한 번에 받는다(옛 단건 객체도 하위호환으로 수용).
  const addAssetToTray = (raw: string) => {
    // 중복 허용(같은 파일도 여러 번) — dedup 안 함. uid 로 구분. 다중선택은 배열로 한 번에 추가.
    const additions: SpotlightTrayRef[] = parseSpotlightAssetItems(raw).map((d) => ({
      ...spotlightAssetRefBase(d),
      uid: `t${trayUidRef.current++}`,
      role: d.type === "video" ? "@Video" : "@Image", // 제출 시 순서대로 재번호
    }));
    if (additions.length) setTrayRefs((prev) => [...prev, ...additions]);
  };
  const removeTrayRef = (i: number) => setTrayRefs((prev) => prev.filter((_, j) => j !== i));
  // 트레이에 포커스를 둔 채 Shift+Backspace = 레퍼런스만 전체 삭제(프롬프트는 그대로).
  const onTrayKeyDown = (e: React.KeyboardEvent) => {
    const isBackspace =
      e.key === "Backspace" || e.code === "Backspace" || (e.nativeEvent as KeyboardEvent).keyCode === 8;
    if (isBackspace && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setTrayRefs([]);
    }
  };
  const onTrayDragOver = (e: React.DragEvent) => {
    const tps = e.dataTransfer.types;
    if (tps.includes(DRAG_TYPES.asset) || tps.includes(DRAG_TYPES.trayIndex) || dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation(); // 패널의 카드-드롭 핸들러로 번지지 않게(트레이는 에셋 전용)
      e.dataTransfer.dropEffect = trayDragIdx.current !== null ? "move" : "copy";
    }
  };
  const onTrayDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      addAssetToTray(readSpotlightAssetPayload(e.dataTransfer)); // 빈 영역 = 끝에 추가(재정렬은 항목에서)
      return;
    }
    if (dataTransferHasFiles(e.dataTransfer)) {
      onImportFiles(Array.from(e.dataTransfer.files));
    }
  };
  const onTrayItemDragStart = (i: number) => (e: React.DragEvent) => {
    trayDragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPES.trayIndex, String(i));
  };
  const onTrayItemDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 내부 재정렬은 파일/에셋보다 우선 — 썸네일 네이티브 드래그로 files 가 섞여 들어와도 순서변경 유지.
    if (e.dataTransfer.types.includes(DRAG_TYPES.trayIndex)) {
      const from = trayDragIdx.current;
      trayDragIdx.current = null;
      if (from === null || from === i) return;
      setTrayRefs((prev) => {
        const arr = [...prev];
        const [m] = arr.splice(from, 1);
        arr.splice(i, 0, m);
        return arr;
      });
      return;
    }
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      addAssetToTray(readSpotlightAssetPayload(e.dataTransfer)); // 항목 위에 에셋 떨어뜨려도 추가
      trayDragIdx.current = null;
      return;
    }
    if (dataTransferHasFiles(e.dataTransfer)) {
      onImportFiles(Array.from(e.dataTransfer.files));
      trayDragIdx.current = null;
      return;
    }
    const from = trayDragIdx.current;
    trayDragIdx.current = null;
    if (from === null || from === i) return;
    setTrayRefs((prev) => {
      const arr = [...prev];
      const [m] = arr.splice(from, 1);
      arr.splice(i, 0, m); // from → i 위치로 이동
      return arr;
    });
  };

  return {
    trayRefs,
    setTrayRefs,
    sceneMode,
    trayUidRef,
    addAssetToTray,
    removeTrayRef,
    onTrayKeyDown,
    onTrayDragOver,
    onTrayDrop,
    onTrayItemDragStart,
    onTrayItemDrop,
  };
}

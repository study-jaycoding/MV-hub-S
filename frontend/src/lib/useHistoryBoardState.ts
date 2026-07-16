// 구성탭 히스토리 보드(계보 트리) 상태를 App.tsx 에서 추출.
//  · 포커스/새로고침신호/자동정렬/선택노드/통계/줌제어 + 마지막 포커스(재시작 복원용 localStorage).
//  · ref 미러(boardFocusIdRef/boardSelectedRef)는 렌더 중 대입(명령형 핸들러가 최신값 읽음).
//  · bumpBoard: 생성·재생성·동기화 시 트리 refetch 신호(++). setBoardSignal 은 내부 전용.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Store } from "./storage";
import type { Generation } from "../types";

export function useHistoryBoardState(LS: Store) {
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null); // 히스토리 트리 포커스
  const [boardSignal, setBoardSignal] = useState(0); // 트리 refetch 신호(++)
  const bumpBoard = useCallback(() => setBoardSignal((s) => s + 1), []);
  const [boardArrange, setBoardArrange] = useState(0); // '구성에서 보기' 진입 시 자동 정렬
  const [boardSelected, setBoardSelected] = useState<Generation[]>([]); // 선택 노드(부모·선택바용)
  const boardSelectedRef = useRef<Generation[]>([]);
  boardSelectedRef.current = boardSelected;
  // 보드가 보고하는 노드 수(타입필터 기준)·줌% → 상단 LibraryToolbar 표시용.
  const [boardStats, setBoardStats] = useState({ count: 0, zoomPct: 100, viewMoved: false });
  // 상단 크기 슬라이더 → 보드 줌 직접 제어(imperative). 보드가 zoomTo 를 여기에 등록.
  const boardControl = useRef<{ zoomTo: (v: number) => void } | null>(null);
  const boardFocusIdRef = useRef<string | null>(null); // 진입(포커스) 카드 — 선택 없을 때 기본 부모
  boardFocusIdRef.current = boardFocusId;
  // ★마지막으로 본 카드의 히스토리 — 다른 탭 갔다가 히스토리 탭으로 돌아오면 빈 화면 대신 이걸 복원.
  // (다른 카드의 히스토리를 보기 전까지 유지. 재시작에도 살아남게 localStorage 에도 보관.)
  const lastBoardFocusRef = useRef<string | null>(LS.get("boardFocusId", "") || null);
  useEffect(() => {
    if (boardFocusId) {
      lastBoardFocusRef.current = boardFocusId;
      LS.set("boardFocusId", boardFocusId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardFocusId]);

  return {
    boardFocusId,
    setBoardFocusId,
    boardFocusIdRef,
    boardSignal,
    bumpBoard,
    boardArrange,
    setBoardArrange,
    boardSelected,
    setBoardSelected,
    boardSelectedRef,
    boardStats,
    setBoardStats,
    boardControl,
    lastBoardFocusRef,
  };
}

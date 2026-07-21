// 히스토리 패널 — 세로 컬럼: 연결 카드(현재 앞쪽 체인·번호) · 이전 카드(직속 부모) · 현재 카드 · 파생 카드 · (우측) 미니 트리.
// 이 패널 안에서 조작이 끝난다(창을 닫지 않음):
//   클릭 = 선택(하나) · Shift+클릭 = 복수 선택(→ 비교) · 더블클릭 = 크게 보기 · 미들클릭 = 카드 정보.
//   이전 카드의 '해제' → 흑백으로 남아 '연결'로 되돌릴 수 있음. 본격 편집은 '구성에서 보기'(보드).
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { matchShortcut } from "../lib/shortcuts";
import { HistoryMiniTree } from "./HistoryMiniTree";
import { HistoryNode } from "./history/HistoryNode";
import type { Generation, History, HistoryGraph, InfoTarget, PreviewTarget } from "../types";

export function HistoryPanel({
  history,
  onClose,
  onPreview,
  onInfo,
  onCompare,
  onChanged,
  onOpenInBoard,
}: {
  history: History;
  onClose: () => void;
  onPreview: (t: PreviewTarget) => void;
  onInfo: (t: InfoTarget) => void; // 미들클릭 정보 팝업(그리드와 동일)
  onCompare: (gens: Generation[]) => void; // 복수 선택 비교(DAM 버전 비교 모달)
  onChanged?: () => void; // 수동 히스토리 편집 시 라이브러리(뱃지) 새로고침
  onOpenInBoard?: (g: Generation) => void; // '구성에서 보기' → 구성탭 히스토리 트리
}) {
  const [lin, setLin] = useState<History>(history);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 패널 안 복수 선택(비교용)
  // 해제했지만 '연결'로 되돌릴 수 있게 흑백으로 남겨두는 카드(이 세션 한정).
  const [unlinked, setUnlinked] = useState<Generation[]>([]);
  // 연결된 가계 트리 전체(구성 카드 컬럼 + 우측 미니 트리 공용). 연결/해제 시 함께 갱신.
  const [treeGraph, setTreeGraph] = useState<HistoryGraph | null>(null);
  const { ancestors, target, children } = lin;

  const directParent = ancestors[0]; // 해제 가능한 직계 파생 부모(있으면)

  // 패널 단축키: Esc = 닫기 · h(=히스토리 보기 단축키) 한 번 더 = '구성에서 보기'(보드 진입).
  // 캡처 단계 + stopPropagation 으로 그리드의 h·전역 Esc 가 함께 발동하지 않게 먼저 가로챈다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (matchShortcut(e, "showHistory")) {
        e.preventDefault();
        e.stopPropagation();
        onOpenInBoard?.(target); // 현재 카드로 구성에서 보기
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onOpenInBoard, target]);

  useEffect(() => {
    let alive = true;
    api
      .historyTree(target.id)
      .then((g) => alive && setTreeGraph(g))
      .catch(() => alive && setTreeGraph(null));
    return () => {
      alive = false;
    };
    // treeRefetch 마다 갱신 — refresh() 가 setLin(새 객체)로 lin 을 바꾸므로 그걸 트리거로 쓴다.
  }, [target.id, lin]);

  // 연결 카드 = 현재 카드 '앞쪽(위)'으로 이어진 연결 체인 중 직속 부모보다 더 위(조부모→루트)만.
  //   ancestors 는 '직속부모 → 루트' 순 → 직속부모(0번)를 빼고 루트가 1번이 되게 뒤집는다.
  //   앞 카드가 1장뿐(직속부모만)이면 체인이 비어 연결 카드 칸은 빈 채로 둔다.
  const linkChain = useMemo(() => [...ancestors].slice(1).reverse(), [ancestors]);

  // 패널 안 모든 카드 id→Generation (선택 → 비교 대상 해석용)
  const allById: Record<string, Generation> = {};
  for (const g of [target, ...ancestors, ...children, ...unlinked]) {
    allById[g.id] = g;
  }
  const selectedGens = [...selected].map((id) => allById[id]).filter(Boolean) as Generation[];

  // 클릭=단일 선택 · Shift+클릭=복수(토글). 여러 장 골라 '비교'.
  const selectCard = (g: Generation, additive: boolean) => {
    setSelected((prev) => {
      if (additive) {
        const next = new Set(prev);
        next.has(g.id) ? next.delete(g.id) : next.add(g.id);
        return next;
      }
      return new Set([g.id]);
    });
  };
  const showInfo = (g: Generation, x: number, y: number) =>
    onInfo({ kind: "generation", gen: g, x, y });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged?.();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  // 이전 카드 '해제' — 흑백으로 남겨 되돌릴 수 있게 한다.
  const unlinkParent = (g: Generation) =>
    run(async () => {
      setLin(await api.removeHistory(target.id, g.id)); // parent=g, child=target 엣지 제거
      setUnlinked((prev) => [...prev.filter((u) => u.id !== g.id), g]);
    });
  // 해제했던 부모를 다시 '연결'.
  const relinkParent = (g: Generation) =>
    run(async () => {
      setLin(await api.addHistory(target.id, g.id, "derived")); // parent=g, child=target 복원
      setUnlinked((prev) => prev.filter((u) => u.id !== g.id));
    });

  // 현재 라이브 목록에 이미 있는 것은 '해제됨' 목록에서 빼고 보여준다(중복/유령 방지).
  const liveIds = new Set(ancestors.map((g) => g.id));
  const unlinkedDerived = unlinked.filter((u) => !liveIds.has(u.id));

  return (
    <div className="lin-overlay" onClick={onClose}>
      <div className="lin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lin-head">
          <span className="lin-title">히스토리</span>
          {busy && <span className="lin-busy">…</span>}
          {selectedGens.length > 0 && (
            <div className="lin-selbar">
              <span className="lin-selcount">{selectedGens.length}개 선택</span>
              <button
                className="lin-cmp"
                disabled={selectedGens.length < 2}
                title={selectedGens.length < 2 ? "2장 이상 선택하면 비교할 수 있어요" : "선택한 카드 비교"}
                onClick={() => onCompare(selectedGens)}
              >
                비교
              </button>
              <button className="lin-selclear" onClick={() => setSelected(new Set())}>
                선택 해제
              </button>
            </div>
          )}
          {onOpenInBoard && (
            <button
              className="lin-board-btn"
              title="구성탭에서 원본 → 파생 트리로 한눈에 보기"
              onClick={() => onOpenInBoard(target)}
            >
              ⧉ 히스토리 보기
            </button>
          )}
          <button className="lin-close" title="닫기" onClick={onClose}>
            ×
          </button>
        </div>
        {err && <div className="lin-err">{err}</div>}
        <div className="lin-body">
          {/* 연결 카드 — 현재 카드 '앞쪽(위)'으로 이어진 연결 체인(루트=①). 1장뿐이면 비움(이전 카드에만). */}
          <div className="lin-row">
            <div
              className="lin-row-label"
              title="현재 카드 앞쪽(위)으로 이어진 연결 체인 — 루트가 ①, 생성 순서대로 번호. 앞 카드가 1장뿐이면 비어 있고 이전 카드에만 보입니다."
            >
              연결 카드 <span className="lin-row-n">{linkChain.length}</span>
            </div>
            <div className="lin-strip">
              {linkChain.map((g, i) => (
                <HistoryNode
                  key={g.id}
                  g={g}
                  seq={i + 1}
                  selected={selected.has(g.id)}
                  onSelect={selectCard}
                  onPreview={onPreview}
                  onInfo={showInfo}
                />
              ))}
            </div>
          </div>
          {/* 이전 카드 — 현재 카드 바로 앞(직속 부모) 1장. 해제 가능, 해제된 것은 흑백+연결 */}
          <div className="lin-row">
            <div className="lin-row-label" title="현재 카드 바로 앞(직속 부모)">
              이전 카드 ⬆ <span className="lin-row-n">{directParent ? 1 : 0}</span>
            </div>
            <div className="lin-strip">
              {directParent && (
                <HistoryNode
                  key={directParent.id}
                  g={directParent}
                  selected={selected.has(directParent.id)}
                  onSelect={selectCard}
                  onPreview={onPreview}
                  onInfo={showInfo}
                  onUnlink={unlinkParent}
                />
              )}
              {unlinkedDerived.map((g) => (
                <HistoryNode
                  key={g.id}
                  g={g}
                  grayed
                  selected={selected.has(g.id)}
                  onSelect={selectCard}
                  onPreview={onPreview}
                  onInfo={showInfo}
                  onConnect={relinkParent}
                />
              ))}
            </div>
          </div>
          {/* 현재 카드 */}
          <div className="lin-row">
            <div className="lin-row-label lin-row-target">현재 카드</div>
            <div className="lin-strip">
              <HistoryNode
                g={target}
                isTarget
                selected={selected.has(target.id)}
                onSelect={selectCard}
                onPreview={onPreview}
                onInfo={showInfo}
              />
            </div>
          </div>
          {/* 파생 카드 ⬇ — 없어도 빈 컬럼 유지 */}
          <div className="lin-row">
            <div className="lin-row-label" title="이 결과물을 재생성·가져오기로 만든 것">
              파생 카드 ⬇ <span className="lin-row-n">{children.length}</span>
            </div>
            <div className="lin-strip">
              {children.map((g) => (
                <HistoryNode
                  key={g.id}
                  g={g}
                  selected={selected.has(g.id)}
                  onSelect={selectCard}
                  onPreview={onPreview}
                  onInfo={showInfo}
                />
              ))}
            </div>
          </div>
          {/* 우측: 이 카드의 간략 트리(연결된 가계 전체). 편집은 '구성에서 보기'(보드). */}
          <HistoryMiniTree
            focusId={target.id}
            graph={treeGraph}
            onPreview={onPreview}
            onInfo={onInfo}
          />
        </div>
        <div className="lin-foot">
          클릭=선택 · Shift+클릭=복수 선택(→ 비교) · 더블클릭=크게 보기 · 미들클릭=정보 · 번호=생성 순서 · 편집은 ‘히스토리 보기’
        </div>
      </div>
    </div>
  );
}

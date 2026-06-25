// 공용 인라인 태그 에디터.
//   showInput=true (포커스 카드): 입력 + 칩(×) + (# 두 번) 전역 picker. 추가는 multi 면 선택 전체에.
//   showInput=false (다중선택의 '비포커스' 선택 카드): 입력 없이 그 카드의 칩(× 해제) + 전역 picker
//     (그 카드에 부여/해제)만. 전역 표시 여부는 forcedGlobalMode(포커스 카드의 모드)를 따른다.
//
// 비포커스 카드는 로컬 사본이 아니라 부모 prop(tags/global.assigned)을 그대로 미러 → 포커스 카드의
// 일괄 추가/부여가 낙관 반영되면 즉시 같이 갱신된다('모두 같이 보이게').
// 칩·전역칩 버튼은 onMouseDown preventDefault 로 포커스 입력의 blur(닫힘)를 막아, 다른 카드의 칩을
// 눌러도 편집 세션이 끊기지 않는다.
import { useState } from "react";

export interface TagEditorGlobal {
  all: string[]; // 내 전역(auto) 태그 목록(사이드바에서 만든 것)
  assigned: string[]; // 이 카드에 부여된 전역 태그
  onChange: (next: string[]) => void; // 교체(부여/해제 결과 전체) — 이 카드
  onBulkAdd?: (names: string[]) => void; // 다중선택 시 전역 '부여'를 다른 선택 카드에도(이 카드 제외)
  onBulkRemove?: (names: string[]) => void; // 다중선택 시 전역 '해제'를 다른 선택 카드에도(이 카드 제외)
}

export function TagEditor({
  tags,
  onChange,
  onBulkAdd,
  onBulkRemove,
  selectedCount = 1,
  global = null,
  onGlobalModeChange,
  showInput = true,
  forcedGlobalMode,
  onClose,
  placeholder,
}: {
  tags: string[];
  onChange: (next: string[]) => void; // 이 카드의 일반 태그 교체
  onBulkAdd?: (names: string[]) => void; // 다중선택 시 추가를 다른 선택 카드에도(이 카드 제외)
  onBulkRemove?: (names: string[]) => void; // 다중선택 시 ×해제를 다른 선택 카드에도(공통 태그 일괄 삭제)
  selectedCount?: number; // 다중선택에 포함될 때 N. >1 이면 '선택된 카드 …' 배지.
  global?: TagEditorGlobal | null;
  onGlobalModeChange?: (on: boolean) => void; // 전역 모드 토글을 부모로 보고(다른 선택 카드 표시 동기화)
  showInput?: boolean; // false = 비포커스 선택 카드(입력 없음)
  forcedGlobalMode?: boolean; // 비포커스 카드: 전역 picker 표시를 포커스 카드 모드에 맞춤
  onClose?: () => void;
  placeholder?: string;
}) {
  const [chips, setChips] = useState<string[]>(tags);
  const [assignedLocal, setAssignedLocal] = useState<string[]>(global?.assigned ?? []);
  const [draft, setDraft] = useState("");
  const [internalGlobalMode, setInternalGlobalMode] = useState(false);
  const multi = selectedCount > 1;
  const globalMode = forcedGlobalMode !== undefined ? forcedGlobalMode : internalGlobalMode;

  // 포커스(showInput): 로컬 사본으로 즉시 편집. 비포커스: 부모 prop 미러(라이브 갱신).
  const baseTags = showInput ? chips : tags;
  const baseAssigned = showInput ? assignedLocal : global?.assigned ?? [];

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const keepFocus = (e: React.MouseEvent) => e.preventDefault(); // 포커스 입력 blur(닫힘) 방지

  const applyTags = (next: string[]) => {
    if (showInput) setChips(next);
    onChange(next);
  };
  const commitDraft = () => {
    const add = draft.split(",").map((s) => s.trim()).filter(Boolean);
    const fresh = add.filter((t) => !baseTags.includes(t));
    if (fresh.length) {
      applyTags([...baseTags, ...fresh]); // 이 카드
      if (multi) onBulkAdd?.(fresh); // 나머지 선택 카드
    }
    setDraft("");
  };
  const removeChip = (t: string) => {
    applyTags(baseTags.filter((x) => x !== t)); // 이 카드
    if (multi) onBulkRemove?.([t]); // 포커스 카드면 다른 선택 카드에서도(공통이면 일괄 삭제). 비포커스는 콜백 없어 개별.
  };
  const setMode = (on: boolean) => {
    setInternalGlobalMode(on);
    onGlobalModeChange?.(on);
  };
  const toggleGlobal = (name: string) => {
    if (!global) return;
    const has = baseAssigned.includes(name);
    const next = has ? baseAssigned.filter((x) => x !== name) : [...baseAssigned, name];
    if (showInput) setAssignedLocal(next);
    global.onChange(next); // 이 카드
    // 포커스 카드(onBulkAdd/onBulkRemove 보유)는 부여·해제 모두 선택 전체에. 비포커스 카드는
    // 이 콜백들이 없어 자기 카드만(개별) 토글된다.
    if (multi) {
      if (has) global.onBulkRemove?.([name]);
      else global.onBulkAdd?.([name]);
    }
  };

  return (
    <div
      className={"tag-editor" + (showInput ? "" : " tag-strip")}
      onClick={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
    >
      {multi && (
        <div className="te-multi" title="추가는 선택한 카드 전체에, ×(해제)는 이 카드만">
          {globalMode ? "선택된 카드 전역 적용" : "선택된 카드 태그 적용"}
        </div>
      )}
      {baseTags.length > 0 && (
        <div className="te-chips">
          {baseTags.map((t) => (
            <span className="te-chip" key={t}>
              {t}
              <button className="te-x" onMouseDown={keepFocus} onClick={() => removeChip(t)} title="태그 해제">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {showInput && (
        <input
          className="cs-tag-input"
          autoFocus
          value={draft}
          placeholder={placeholder ?? (global ? "태그(쉼표) ⏎ · # 전역태그" : "태그(쉼표) ⏎")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              commitDraft();
            } else if (e.key === "Escape") {
              onClose?.();
            } else if (e.key === "#" && global && draft === "") {
              // 입력이 비어 있을 때만 전역 모드 토글(태그 안에 # 입력은 허용)
              e.preventDefault();
              setMode(!internalGlobalMode);
            }
          }}
          onBlur={onClose}
        />
      )}
      {globalMode && global && (
        <div className="te-global">
          {global.all.length === 0 ? (
            <span className="te-empty">사이드바에서 전역 태그를 먼저 만드세요</span>
          ) : (
            global.all.map((t) => {
              const on = baseAssigned.includes(t);
              return (
                <button
                  key={t}
                  className={"te-gchip" + (on ? " on" : "")}
                  onMouseDown={keepFocus}
                  onClick={() => toggleGlobal(t)}
                  title={on ? "이 카드에서 전역 태그 해제" : "이 카드에 전역 태그 부여"}
                >
                  {t}
                  {on && <span className="te-gx">×</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// 공용 인라인 태그 에디터 — 카드(#)에서 연다.
//   위: 이 카드의 일반 태그 칩(각 ×로 해제) / 입력: 쉼표·⏎로 추가
//   '#'를 한 번 더 누르면 전역(auto) 태그 모드 토글 → 입력 "아래"에 전역 태그를 조금 크게 표시,
//   클릭으로 이 카드에 부여/해제(생성/공유 카드만; 에셋은 global 미전달이라 전역 모드 없음).
//
// 칩·전역칩 버튼은 onMouseDown preventDefault 로 입력 포커스를 뺏지 않아, 클릭해도 onBlur(닫힘)가
// 먼저 돌지 않는다. 칩 표시는 로컬 사본으로 즉시 갱신(부모 reload 지연과 무관).
import { useState } from "react";

export interface TagEditorGlobal {
  all: string[]; // 내 전역(auto) 태그 목록(사이드바에서 만든 것)
  assigned: string[]; // 이 카드에 부여된 전역 태그
  onChange: (next: string[]) => void; // 교체(부여/해제 결과 전체)
}

export function TagEditor({
  tags,
  onChange,
  global = null,
  onClose,
  placeholder,
}: {
  tags: string[];
  onChange: (next: string[]) => void; // 교체(에디터가 전체 목록 소유 — 부모 reload 지연/레이스 무관)
  global?: TagEditorGlobal | null;
  onClose: () => void;
  placeholder?: string;
}) {
  const [chips, setChips] = useState<string[]>(tags);
  const [assigned, setAssigned] = useState<string[]>(global?.assigned ?? []);
  const [draft, setDraft] = useState("");
  const [globalMode, setGlobalMode] = useState(false);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const keepFocus = (e: React.MouseEvent) => e.preventDefault(); // 입력 blur 방지

  const applyTags = (next: string[]) => {
    setChips(next);
    onChange(next);
  };
  const commitDraft = () => {
    const add = draft.split(",").map((s) => s.trim()).filter(Boolean);
    const fresh = add.filter((t) => !chips.includes(t));
    if (fresh.length) applyTags([...chips, ...fresh]);
    setDraft("");
  };
  const removeChip = (t: string) => applyTags(chips.filter((x) => x !== t));
  const toggleGlobal = (name: string) => {
    if (!global) return;
    const has = assigned.includes(name);
    const next = has ? assigned.filter((x) => x !== name) : [...assigned, name];
    setAssigned(next);
    global.onChange(next);
  };

  return (
    <div
      className="tag-editor"
      onClick={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
    >
      {chips.length > 0 && (
        <div className="te-chips">
          {chips.map((t) => (
            <span className="te-chip" key={t}>
              {t}
              <button className="te-x" onMouseDown={keepFocus} onClick={() => removeChip(t)} title="태그 해제">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
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
            onClose();
          } else if (e.key === "#" && global && draft === "") {
            // 입력이 비어 있을 때만 전역 모드 토글(태그 안에 # 입력은 허용)
            e.preventDefault();
            setGlobalMode((v) => !v);
          }
        }}
        onBlur={onClose}
      />
      {globalMode && global && (
        <div className="te-global">
          {global.all.length === 0 ? (
            <span className="te-empty">사이드바에서 전역 태그를 먼저 만드세요</span>
          ) : (
            global.all.map((t) => {
              const on = assigned.includes(t);
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

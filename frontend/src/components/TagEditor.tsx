// 공용 인라인 태그 에디터.
//   showInput=true (포커스 카드): 입력 + 칩(×) + (# 두 번) 전역 picker. 추가는 multi 면 선택 전체에.
//   showInput=false (다중선택의 '비포커스' 선택 카드): 입력 없이 그 카드의 칩(× 해제) + 전역 picker
//     (그 카드에 부여/해제)만. 전역 표시 여부는 forcedGlobalMode(포커스 카드의 모드)를 따른다.
//
// 비포커스 카드는 로컬 사본이 아니라 부모 prop(tags/global.assigned)을 그대로 미러 → 포커스 카드의
// 일괄 추가/부여가 낙관 반영되면 즉시 같이 갱신된다('모두 같이 보이게').
// 칩·전역칩 버튼은 onMouseDown preventDefault 로 포커스 입력의 blur(닫힘)를 막아, 다른 카드의 칩을
// 눌러도 편집 세션이 끊기지 않는다.
import { useEffect, useMemo, useState } from "react";
import {
  parseWorkspacePickerCommand,
  type WorkspaceCommandOperation,
  type WorkspaceCommandTarget,
  workspaceCommandLabels,
} from "../lib/workspaceCommand";

// #+ 워크스페이스 목록 프리페치+세션 캐시는 lib/workspaceOptionsCache 로 공용화
// (전역태그 모달의 #+ 등록 피커와 공유). ## 전역 모드 진입 시 미리 받아 '+' 입력 전에 준비.
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "../lib/workspaceOptionsCache";

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
  onWorkspaceCommand,
  currentWorkspaceId,
  currentWorkspaceName,
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
  onWorkspaceCommand?: (
    operation: WorkspaceCommandOperation,
    workspace: WorkspaceCommandTarget,
  ) => Promise<boolean>; // ## 모드의 #+ 적용/#- 제거 선택. 태그 저장과 완전히 분리.
  currentWorkspaceId?: string | null; // 이름은 중복될 수 있으므로 현재 귀속은 UUID로 판정.
  currentWorkspaceName?: string | null; // 포커스 카드의 현재 귀속 — 목록에서 활성 칩 표시.
  showInput?: boolean; // false = 비포커스 선택 카드(입력 없음)
  forcedGlobalMode?: boolean; // 비포커스 카드: 전역 picker 표시를 포커스 카드 모드에 맞춤
  onClose?: () => void;
  placeholder?: string;
}) {
  const [chips, setChips] = useState<string[]>(tags);
  const [assignedLocal, setAssignedLocal] = useState<string[]>(global?.assigned ?? []);
  const [draft, setDraft] = useState("");
  const [internalGlobalMode, setInternalGlobalMode] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<{ id: string; name: string }[]>([]);
  const [workspaceOptionsLoading, setWorkspaceOptionsLoading] = useState(false);
  const workspaceLabels = useMemo(
    () => workspaceCommandLabels(workspaceOptions),
    [workspaceOptions],
  );
  const currentWorkspaceNameMatches = currentWorkspaceName
    ? workspaceOptions.filter((workspace) => workspace.name === currentWorkspaceName)
    : [];
  const multi = selectedCount > 1;
  const globalMode = forcedGlobalMode !== undefined ? forcedGlobalMode : internalGlobalMode;
  const workspacePicker = parseWorkspacePickerCommand(draft, globalMode);
  const workspacePickerOpen = Boolean(showInput && onWorkspaceCommand && workspacePicker);

  // ## 전역 모드 진입 즉시 프리페치 — '+'를 누르기 전에 목록이 준비된다(실패는 피커가 다시 시도).
  useEffect(() => {
    if (globalMode && onWorkspaceCommand) fetchWorkspaceOptions().catch(() => {});
  }, [globalMode, onWorkspaceCommand]);

  useEffect(() => {
    if (!workspacePickerOpen) return;
    let active = true;
    const cached = cachedWorkspaceOptions();
    if (cached) {
      // 캐시 즉시 표시(대기 없음) — 아래 요청이 끝나면 최신으로 조용히 교체된다.
      setWorkspaceOptions(cached);
      setWorkspaceOptionsLoading(false);
    } else {
      setWorkspaceOptionsLoading(true);
    }
    fetchWorkspaceOptions()
      .then((items) => {
        if (!active) return;
        setWorkspaceOptions(items);
        setWorkspaceError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        // 캐시가 이미 떠 있으면 갱신 실패는 조용히 무시(다음 열기에서 재시도).
        if (cachedWorkspaceOptions()) return;
        const message = error instanceof Error ? error.message : String(error);
        setWorkspaceOptions([]);
        setWorkspaceError(message.replace(/^\d+:\s*/, "") || "워크스페이스 목록을 불러오지 못했습니다");
      })
      .finally(() => {
        if (active) setWorkspaceOptionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspacePickerOpen]);

  // 포커스(showInput): 로컬 사본으로 즉시 편집. 비포커스: 부모 prop 미러(라이브 갱신).
  const baseTags = showInput ? chips : tags;
  const baseAssigned = showInput ? assignedLocal : global?.assigned ?? [];

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const keepFocus = (e: React.MouseEvent) => e.preventDefault(); // 포커스 입력 blur(닫힘) 방지

  const applyTags = (next: string[]) => {
    if (showInput) setChips(next);
    onChange(next);
  };
  const applyWorkspaceCommand = async (
    operation: WorkspaceCommandOperation,
    workspace: WorkspaceCommandTarget,
  ): Promise<boolean> => {
    if (!onWorkspaceCommand) {
      setWorkspaceError("이 화면에서는 워크스페이스를 변경할 수 없습니다");
      return false;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const ok = await onWorkspaceCommand(operation, workspace);
      if (ok) setDraft("");
      return ok;
    } finally {
      setWorkspaceBusy(false);
    }
  };
  const commitDraft = async () => {
    // `##` 전역 모드는 칩 선택 전용이다. 워크스페이스 이름이나 태그를 직접 제출하지 않는다.
    if (globalMode) {
      setDraft("");
      return;
    }
    const add = draft.split(",").map((s) => s.trim()).filter(Boolean);
    const fresh = add.filter((t) => !baseTags.includes(t));
    if (fresh.length) {
      applyTags([...baseTags, ...fresh]); // 이 카드
      if (multi) onBulkAdd?.(fresh); // 나머지 선택 카드
    }
    setWorkspaceError(null);
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
          {globalMode ? "선택된 카드 전역/워크스페이스 적용" : "선택된 카드 태그 적용"}
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
          readOnly={workspaceBusy}
          aria-busy={workspaceBusy}
          placeholder={
            placeholder ??
            (globalMode
              ? "#+ 워크스페이스 적용 · #- 워크스페이스 제거"
              : global
                ? "태그(쉼표) ⏎ · # 전역태그"
                : "태그(쉼표) ⏎")
          }
          onChange={(e) => {
            const next = e.target.value;
            // 전역 모드에서는 선택 목록을 여는 두 명령만 받는다. 이름 직접 입력·붙여넣기는 무시한다.
            if (globalMode && !["", "#", "#+", "#-"].includes(next)) return;
            setDraft(next);
            setWorkspaceError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (workspaceBusy) {
              e.preventDefault();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              void commitDraft();
            } else if (e.key === "Escape") {
              onClose?.();
            } else if (e.key === "#" && global && draft === "" && !globalMode) {
              // 첫 #은 카드 태그 편집을 열고, 입력 안의 두 번째 #은 전역 모드로 전환한다.
              // 전역 모드에 들어온 뒤의 #은 막지 않아 `#+`/`#-` 명령을 만들게 한다.
              e.preventDefault();
              setMode(true);
            }
          }}
          onBlur={() => {
            if (!workspaceBusy) onClose?.();
          }}
        />
      )}
      {showInput && workspaceError && (
        <span className="te-empty" role="alert">{workspaceError}</span>
      )}
      {/* 처리 중 안내 — 리스트 밖(버튼 위치 불변)에 표시. 프록시(위임) 모드는 서버 왕복이라 수 초. */}
      {showInput && workspaceBusy && (
        <span className="te-empty">적용 중… 완료 알림이 뜰 때까지 잠시 기다려 주세요</span>
      )}
      {workspacePickerOpen && workspacePicker ? (
        <div
          className={`te-global te-workspaces ${workspacePicker.operation}`}
          role="listbox"
          aria-label={workspacePicker.operation === "assign" ? "적용할 워크스페이스" : "제거할 워크스페이스"}
        >
          {workspaceOptionsLoading ? (
            <span className="te-empty">워크스페이스 불러오는 중…</span>
          ) : workspaceOptions.length === 0 ? (
            <span className="te-empty">등록된 워크스페이스가 없습니다</span>
          ) : (
            <>
              {workspaceOptions.map((workspace) => {
                const current = currentWorkspaceId
                  ? workspace.id === currentWorkspaceId
                  : currentWorkspaceNameMatches.length === 1
                    && workspace.name === currentWorkspaceName;
                const sign = workspacePicker.operation === "assign" ? "+" : "−";
                const label = workspaceLabels.get(workspace.id) ?? workspace.name;
                return (
                  <button
                    key={workspace.id}
                    // ★disabled 금지 — disabled 버튼은 mousedown 을 못 받아 keepFocus(blur 방지)가
                    //  무력화되고, 처리 중 재클릭 한 번에 입력이 blur 로 닫혀버린다.
                    // ★click 아닌 mousedown 에서 실행 — click 은 누름과 뗌 사이에 리렌더·요소 이동이
                    //  끼면 통째로 유실된다(실측: '여러 번 눌러야 적용'). 누르는 순간 확정해
                    //  어떤 환경에서도 1클릭 = 1적용을 보장한다. preventDefault 로 blur 도 함께 방지.
                    className={"te-gchip te-wchip" + (current ? " on" : "") + (workspaceBusy ? " busy" : "")}
                    onMouseDown={(e) => {
                      keepFocus(e);
                      if (workspaceBusy) return;
                      void applyWorkspaceCommand(workspacePicker.operation, workspace);
                    }}
                    aria-disabled={workspaceBusy}
                    role="option"
                    aria-selected={current}
                    title={`${label} 워크스페이스 ${workspacePicker.operation === "assign" ? "적용" : "제거"}`}
                  >
                    <span className="te-wsign">{sign}</span>
                    {label}
                  </button>
                );
              })}
            </>
          )}
        </div>
      ) : globalMode && global ? (
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
      ) : null}
    </div>
  );
}

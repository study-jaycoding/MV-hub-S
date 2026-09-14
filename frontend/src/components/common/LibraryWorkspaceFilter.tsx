// 워크스페이스로 걸러 보기 — 툴바의 회색 dot 왼쪽에 [칩…][버튼] 으로 붙는다(Jay 2026-09-14).
//
// ★왜 새로 만드나: 전역태그 블록에도 워크스페이스 침이 있지만, 거기는 `#+` 로 **먼저 등록해야**
//  누를 수 있다. 여기서는 등록 없이 내 워크스페이스 전부에서 바로 고른다(힉스필드와 같은 방식).
//
// ★중복 선택(Jay 2026-09-14). 고른 것끼리는 OR. 화면 규칙은 셋이다.
//   · 칩은 **3개까지만** 보이고 나머지는 `+N` — 툴바에는 색 dot·S/T/C·크기 슬라이더가 이미 있어
//     칩을 전부 펼치면 오른쪽 컨트롤이 툴바 밖으로 밀려난다(1000px 에서도 잘리는 것을 실측).
//   · 버튼에는 **고른 개수**를 붙인다 — `+N` 에 가려진 것까지 몇 개인지 한눈에 보이게.
//   · 좁은 창에서는 **칩이 먼저 줄어든다**(이름이 … 로). 나머지 툴바 요소는 안 줄어든다.
//
// ★걸러지는 기준은 '지금 귀속된 공간'이지 '생성 당시 과금된 공간'이 아니다 — 나중에 손으로
//  옮기면 필터 결과도 따라 움직인다(backend `generations_query.py` 의 workspace_id 조건).
//
// 목록·로딩·실패는 컨테이너 훅(useWorkspaceFilterOptions)이 들고 있고 이 컴포넌트는 그리기만 한다.
import { useCallback, useRef, useState } from "react";

import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { workspaceCommandLabels } from "../../lib/workspaceCommand";
import type { WorkspaceCommandTarget } from "../../lib/workspaceCommand";
import { WorkspaceMark } from "./WorkspaceMark";

/** 툴바에 펼쳐 보일 칩 수. 넘치면 `+N`. */
export const VISIBLE_CHIPS = 3;

export interface WorkspaceFilterProps {
  value: string[]; // 지금 걸린 워크스페이스 id 들 (빈 배열 = 전체)
  options: WorkspaceCommandTarget[];
  loading: boolean;
  failed: boolean;
  onOpen: () => void; // 메뉴를 열 때 목록 갱신(stale-while-revalidate)
  onToggle: (id: string) => void; // 하나 넣고 빼기
  onClear: () => void; // 전체 보기로
}

export function LibraryWorkspaceFilter({
  value,
  options,
  loading,
  failed,
  onOpen,
  onToggle,
  onClear,
}: WorkspaceFilterProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const closeMenuOnEscape = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useOutsideMouseDown(wrapRef, closeMenu, open);
  // 메뉴만 닫고 카드 선택은 유지 — 라이브러리 전역 Esc 보다 캡처 단계에서 먼저 처리한다.
  useEscapeClose(closeMenuOnEscape, open, true, true);

  const labels = workspaceCommandLabels(options);
  // 이름은 목록에서 찾되, **칩은 선택에서 만든다** — 목록 조회가 실패했거나 탈퇴한 공간이어도
  // 칩과 ✕ 는 남아야 한다. 여기서 선택을 자동으로 지우면 보던 화면이 말없이 전체로 되돌아간다.
  const labelOf = (id: string) => labels.get(id) ?? "…";
  const shown = value.slice(0, VISIBLE_CHIPS);
  const hidden = value.length - shown.length;
  // 목록에 없는데 골라져 있는 공간 — 메뉴에도 넣어야 `+N` 에 가려진 것을 풀 수 있다.
  const orphans = value.filter((id) => !options.some((option) => option.id === id));

  return (
    <>
      {shown.map((id) => (
        <span
          key={id}
          className="lib-ws-chip"
          title={`지금 "${labelOf(id)}" 워크스페이스에 속한 것만 보는 중 (만든 곳이 아니라 현재 소속)`}
        >
          <WorkspaceMark label={labelOf(id)} id={id} />
          <span className="lib-ws-chip-name">{labelOf(id)}</span>
          <button
            className="lib-ws-chip-x"
            title="이 워크스페이스만 빼기"
            onClick={() => onToggle(id)}
          >
            ×
          </button>
        </span>
      ))}
      {hidden > 0 && (
        <span className="lib-ws-more" title="나머지는 버튼을 눌러 목록에서 뺄 수 있습니다">
          +{hidden}
        </span>
      )}
      <div className="lib-ws-wrap" ref={wrapRef}>
        <button
          ref={buttonRef}
          className={"af-btn lib-ws-btn" + (value.length ? " on" : "")}
          title="워크스페이스로 걸러 보기"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
            if (!open) onOpen();
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 6h18M6.5 12h11M10 18h4" />
          </svg>
          {value.length > 0 && <span className="lib-ws-count">{value.length}</span>}
        </button>
        {open && (
          <div className="lib-ws-menu" role="menu">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={value.length === 0}
              className={"lib-ws-item" + (value.length ? "" : " on")}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              <span className="lib-ws-all">All</span>
            </button>
            {[...options, ...orphans.map((id) => ({ id, name: labelOf(id) }))].map((option) => {
              const on = value.includes(option.id);
              return (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  key={option.id}
                  className={"lib-ws-item" + (on ? " on" : "")}
                  // 여러 개를 이어서 고르는 일이 흔하므로 **메뉴는 닫지 않는다**.
                  onClick={() => onToggle(option.id)}
                >
                  <WorkspaceMark label={labels.get(option.id) ?? option.name} id={option.id} />
                  <span className="lib-ws-item-name">{labels.get(option.id) ?? option.name}</span>
                  {on && (
                    <span className="lib-ws-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
            {loading && !options.length && <div className="lib-ws-note">불러오는 중…</div>}
            {failed && (
              <button type="button" className="lib-ws-note warn" onClick={onOpen}>
                목록을 못 받았습니다 — 다시 시도
              </button>
            )}
            {!loading && !failed && !options.length && !orphans.length && (
              <div className="lib-ws-note">속한 팀 워크스페이스가 없습니다.</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

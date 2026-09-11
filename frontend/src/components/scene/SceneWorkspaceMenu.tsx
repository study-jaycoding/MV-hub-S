// 씬 탭 우클릭 메뉴 — 이 캔버스의 **이름**과 **워크스페이스**를 여기서 바꾼다(Jay 2026-09-11).
//  이름은 머리줄 입력칸에서 고친다(예전의 더블클릭 window.prompt 는 없앴다 — 브라우저 기본 창이라
//  화면과 어울리지 않고, 탭을 끄는 동작과도 헷갈렸다).
// 목록은 workspaceOptionsCache(stale-while-revalidate) — 팀 공간만 담긴다(개인 공간은 1차 제외).
// 머리줄 오른쪽에 **지금 지정된 공간**을 라임 점과 함께 보여 주고(Jay 2026-09-11 A안), 목록은 이름만 담백하게.
// 고른 항목은 라임 점 + 은은한 배경 — 글자는 그대로 읽히게 둔다(라임 배경 위 검은 글자는 목록엔 과하다).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "../../lib/workspaceOptionsCache";
import type { SceneWorkspace } from "../../lib/sceneWorkspace";

export interface SceneMenuTarget {
  sceneId: string;
  sceneName: string;
  current: SceneWorkspace | undefined;
  x: number;
  y: number;
}

const MENU_W = 230;

export function SceneWorkspaceMenu({
  target,
  onAssign,
  onRename,
  onClose,
}: {
  target: SceneMenuTarget;
  onAssign: (sceneId: string, workspace: SceneWorkspace | null) => void;
  onRename: (sceneId: string, name: string) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState(() => cachedWorkspaceOptions() ?? []);
  const [loading, setLoading] = useState(() => !cachedWorkspaceOptions());
  const ref = useRef<HTMLDivElement>(null);
  // 씬 이름 — 입력칸에서 바로 고친다. 확정은 Enter·포커스 이탈, Esc 는 되돌리기(메뉴는 안 닫는다).
  const [name, setName] = useState(target.sceneName);
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(target.sceneName); // 빈 이름은 받지 않는다
      return;
    }
    if (trimmed !== target.sceneName) onRename(target.sceneId, trimmed);
  };

  useEffect(() => {
    let alive = true;
    fetchWorkspaceOptions()
      .then((items) => {
        if (!alive) return;
        setOptions(items);
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // 바깥 클릭·Esc 로 닫기. Esc 는 캡처 단계에서 삼켜 캔버스 전역 Esc(선택 해제)까지 가지 않게 한다.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // 화면 밖으로 나가지 않게 위치 보정 — 가로는 바로, 세로는 **실제 높이를 잰 뒤** 넘치면 위로 연다
  // (여러 줄 탭·작은 창에서 아래쪽을 우클릭하면 목록과 이동 단추에 손이 닿지 않는다 — 코덱스 P2).
  const left = Math.max(8, Math.min(target.x, window.innerWidth - MENU_W - 8));
  const [top, setTop] = useState(() => Math.max(8, target.y));
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    const room = window.innerHeight - 8;
    if (target.y + height <= room) {
      setTop(Math.max(8, target.y));
      return;
    }
    // 위로 열되(우클릭 지점 위), 그래도 안 들어가면 화면 안에 맞춘다.
    setTop(Math.max(8, Math.min(target.y - height, room - height)));
  }, [target.x, target.y, options.length, loading]);

  // 머리줄에 보여줄 '지금 지정' — 목록에 같은 id 가 있으면 현재 이름을 쓴다(이름이 바뀌어도 맞게).
  const currentLabel = target.current
    ? options.find((option) => option.id === target.current?.id)?.name || target.current.name || target.current.id
    : null;

  return (
    <div className="scene-ws-menu" ref={ref} style={{ left, top, width: MENU_W }} role="menu">
      <div className="scene-ws-menu-head">
        <input
          className="scene-ws-menu-name"
          value={name}
          aria-label="씬 이름"
          title="이름을 고치고 Enter"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitName();
              onClose();
              return;
            }
            if (event.key === "Escape") {
              // 편집만 되돌리고 메뉴는 유지 — 메뉴의 Esc(닫기)까지 가지 않게 막는다.
              event.preventDefault();
              event.stopPropagation();
              setName(target.sceneName);
            }
          }}
          onBlur={commitName}
        />
        {currentLabel ? (
          <span className="scene-ws-menu-now" title={`지금 지정: ${currentLabel}`}>
            <i aria-hidden="true" />
            {currentLabel}
          </span>
        ) : (
          <span className="scene-ws-menu-now none">None</span>
        )}
      </div>
      <div className="scene-ws-menu-list">
        <button
          type="button"
          className={"scene-ws-item none" + (target.current ? "" : " on")}
          onClick={() => {
            onAssign(target.sceneId, null);
            onClose();
          }}
        >
          <span className="scene-ws-item-name">None</span>
          <small>모든 공간에서 보임</small>
        </button>
        {loading && !options.length ? <div className="scene-ws-empty">불러오는 중…</div> : null}
        {!loading && !options.length ? (
          <div className="scene-ws-empty">고를 수 있는 워크스페이스가 없습니다.</div>
        ) : null}
        {options.map((option) => (
          <button
            type="button"
            key={option.id}
            className={"scene-ws-item" + (target.current?.id === option.id ? " on" : "")}
            onClick={() => {
              onAssign(target.sceneId, { id: option.id, name: option.name });
              onClose();
            }}
          >
            <span className="scene-ws-item-name">{option.name}</span>
          </button>
        ))}
        {/* 목록에 없는데 지정돼 있으면(삭제·권한 상실) 그 사실을 보여 주고 값은 보존한다. */}
        {target.current && !options.some((option) => option.id === target.current?.id) ? (
          <div className="scene-ws-empty warn">
            지금 지정: {target.current.name || target.current.id} — 이 계정에서 찾을 수 없습니다.
          </div>
        ) : null}
      </div>
    </div>
  );
}

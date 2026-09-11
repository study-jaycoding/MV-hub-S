// 씬 탭 우클릭 메뉴 — 이 캔버스의 워크스페이스 지정 + 탭 순서 옮기기(드래그를 못 쓸 때의 대안).
// 목록은 workspaceOptionsCache(stale-while-revalidate) — 팀 공간만 담긴다(개인 공간은 1차 제외).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "../../lib/workspaceOptionsCache";
import type { SceneWorkspace } from "../../lib/sceneWorkspace";

export interface SceneMenuTarget {
  sceneId: string;
  sceneName: string;
  current: SceneWorkspace | undefined;
  x: number;
  y: number;
  canMoveLeft: boolean;
  canMoveRight: boolean;
}

const MENU_W = 230;

export function SceneWorkspaceMenu({
  target,
  onAssign,
  onMove,
  onClose,
}: {
  target: SceneMenuTarget;
  onAssign: (sceneId: string, workspace: SceneWorkspace | null) => void;
  onMove: (sceneId: string, direction: -1 | 1) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState(() => cachedWorkspaceOptions() ?? []);
  const [loading, setLoading] = useState(() => !cachedWorkspaceOptions());
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div className="scene-ws-menu" ref={ref} style={{ left, top, width: MENU_W }} role="menu">
      <div className="scene-ws-menu-head">{target.sceneName}</div>
      <div className="scene-ws-menu-label">워크스페이스</div>
      <div className="scene-ws-menu-list">
        <button
          type="button"
          className={"scene-ws-item" + (target.current ? "" : " on")}
          onClick={() => {
            onAssign(target.sceneId, null);
            onClose();
          }}
        >
          지정 안 함
          <small>어느 공간에서나 보임</small>
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
            {option.name}
          </button>
        ))}
        {/* 목록에 없는데 지정돼 있으면(삭제·권한 상실) 그 사실을 보여 주고 값은 보존한다. */}
        {target.current && !options.some((option) => option.id === target.current?.id) ? (
          <div className="scene-ws-empty warn">
            지금 지정: {target.current.name || target.current.id} — 이 계정에서 찾을 수 없습니다.
          </div>
        ) : null}
      </div>
      <div className="scene-ws-menu-sep" />
      <div className="scene-ws-menu-move">
        <button
          type="button"
          disabled={!target.canMoveLeft}
          onClick={() => {
            onMove(target.sceneId, -1);
            onClose();
          }}
        >
          ← 왼쪽으로
        </button>
        <button
          type="button"
          disabled={!target.canMoveRight}
          onClick={() => {
            onMove(target.sceneId, 1);
            onClose();
          }}
        >
          오른쪽으로 →
        </button>
      </div>
    </div>
  );
}

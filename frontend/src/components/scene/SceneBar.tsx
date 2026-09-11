// 씬 선택/추가 바 — 구성 탭 상단. 씬을 전환/추가/이름변경/삭제하고, **끌어서 순서를 바꾸고**,
// **우클릭으로 그 캔버스의 워크스페이스를 지정**한다(Jay 2026-09-11).
// 계보(히스토리) 뷰는 고정 탭이 아니라 정보팝업 '⧉ 히스토리'·미리보기 '구성에서 보기'로만 진입
// (activeId=null 상태 — 그때는 어떤 씬 탭도 켜지지 않는다).
//
// ★드래그는 포인터 이벤트로 한다(HTML5 DnD 는 자식 요소가 부모 드래그를 막고 투명 고스트가 생긴다).
//  5px 임계 전에는 클릭이고, 드래그가 끝나면 그 뒤에 합성되는 click/dblclick 을 한 번 삼킨다 —
//  안 그러면 순서만 바꾸려다 씬이 열리고 워크스페이스까지 바뀐다(코덱스 P1).
import { Fragment, useEffect, useRef, useState } from "react";
import type { Scene } from "../../lib/scenes";
import {
  dropIndexAt,
  normalizeSceneWorkspace,
  sceneDimmed,
  sceneTabTitle,
  sceneWorkspaceLabel,
  sceneWorkspaceMissing,
  type SceneMove,
  type SceneWorkspace,
} from "../../lib/sceneWorkspace";
import { cachedWorkspaceOptions } from "../../lib/workspaceOptionsCache";
import { SceneWorkspaceMenu, type SceneMenuTarget } from "./SceneWorkspaceMenu";
import type { WorkspaceContext } from "../../types";

const DRAG_THRESHOLD = 5; // px — 이보다 덜 움직이면 클릭

interface Props {
  scenes: Scene[];
  activeId: string | null; // null = 계보(히스토리) 뷰
  workspaceContext: WorkspaceContext;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReorder: (move: SceneMove) => void;
  onAssignWorkspace: (sceneId: string, workspace: SceneWorkspace | null) => void;
  onHoverChange?: (hover: boolean) => void; // 씬 패널(저장/불러오기) 호버 표시용
  backupOnly?: number; // DB 백업에만 있는 씬 수(0 이면 '가져오기'를 숨긴다)
  onImportBackup?: () => void;
  switchingSceneId?: string | null; // 워크스페이스 전환 중인 씬(스피너 대신 표시만)
}

interface DragState {
  sceneId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean; // 임계를 넘겨 실제 드래그로 전환됐는가
  // 놓을 자리를 **기준 씬의 id** 로 들고 있는다(숫자 인덱스가 아니라) — 끌고 있는 동안 다른 창이
  // 씬을 지우면 같은 인덱스가 다른 자리를 뜻하게 된다(코덱스 P2). null = 맨 뒤.
  dropBeforeId: string | null;
}

export function SceneBar({
  scenes,
  activeId,
  workspaceContext,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onReorder,
  onAssignWorkspace,
  onHoverChange,
  backupOnly = 0,
  onImportBackup,
  switchingSceneId = null,
}: Props) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<SceneMenuTarget | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const suppressClickRef = useRef(false); // 드래그 직후의 합성 클릭 한 번을 삼킨다
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // 워크스페이스 이름은 캐시에서 현재 값을 쓴다(관리자가 이름을 바꿔도 맞게 보이도록).
  const [options, setOptions] = useState(() => cachedWorkspaceOptions());
  useEffect(() => {
    // 메뉴가 목록을 받아 캐시를 채우면 탭 이름도 따라 갱신되게 — 가벼운 폴링 대신 메뉴 닫힘에 맞춰 읽는다.
    if (!menu) setOptions(cachedWorkspaceOptions());
  }, [menu]);

  const endDrag = (commit: boolean) => {
    const current = dragRef.current;
    setDrag(null);
    if (!current?.active) return;
    // 드래그 뒤에 오는 합성 click 한 번을 삼킨다. 해제는 **포인터를 놓은 뒤**(releaseSuppression)에
    // 예약한다 — Esc 로 취소하고 버튼을 나중에 놓으면, 그 사이 타이머가 풀려 클릭이 통과해
    // 씬이 열리고 워크스페이스까지 바뀐다(코덱스 P2).
    suppressClickRef.current = true;
    if (!commit) return;
    if (current.dropBeforeId === current.sceneId) return; // 자기 앞 = 제자리
    onReorder({ id: current.sceneId, beforeId: current.dropBeforeId });
  };

  const onPointerDown = (event: React.PointerEvent, sceneId: string) => {
    if (event.button !== 0 || !event.isPrimary) return; // 좌클릭·주 포인터만
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({
      sceneId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      dropBeforeId: sceneId, // 제자리
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const rects = scenes
      .map((scene) => tabRefs.current.get(scene.id)?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => !!rect);
    if (rects.length !== scenes.length) return; // 목록이 바뀌는 중 — 이번 이동은 건너뛴다
    const dropIndex = dropIndexAt(rects, event.clientX, event.clientY);
    setDrag({ ...current, active: true, dropBeforeId: scenes[dropIndex]?.id ?? null });
  };

  // 포인터를 놓은 뒤(합성 click 이 지나간 뒤) 억제를 푼다. click 은 pointerup 과 같은 태스크에서 오므로
  // 이 타이머보다 먼저 도착한다.
  const releaseSuppression = () => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (current && current.pointerId !== event.pointerId) return;
    endDrag(true);
    releaseSuppression(); // Esc 로 이미 취소된 뒤여도 여기서 푼다
  };

  // 드래그 중 Esc 는 취소(캔버스 전역 Esc 로 넘기지 않는다). 창 포커스를 잃어도 취소.
  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    };
    const onBlur = () => {
      endDrag(false);
      releaseSuppression(); // 창 포커스를 잃으면 pointerup 이 안 올 수 있다
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.active]);

  const takeSuppressedClick = (): boolean => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  return (
    <div
      className="scene-bar"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {scenes.map((scene) => {
        const assigned = normalizeSceneWorkspace(scene.workspace);
        const label = sceneWorkspaceLabel(scene, options ?? []);
        const missing = sceneWorkspaceMissing(scene, options);
        const dimmed = sceneDimmed(scene, workspaceContext);
        const dragging = drag?.active && drag.sceneId === scene.id;
        const showLine = drag?.active && drag.dropBeforeId === scene.id && drag.sceneId !== scene.id;
        return (
          <Fragment key={scene.id}>
          {/* 삽입선은 탭 바깥에 그린다 — .scene-tab-wrap 은 overflow:hidden 이라 안에 그리면 잘린다(코덱스 P2). */}
          {showLine ? <span className="scene-drop-line" /> : null}
          <span
            ref={(element) => {
              if (element) tabRefs.current.set(scene.id, element);
              else tabRefs.current.delete(scene.id);
            }}
            className={
              "scene-tab-wrap" +
              (activeId === scene.id ? " on" : "") +
              (dimmed ? " off-ws" : "") +
              (dragging ? " dragging" : "") +
              (switchingSceneId === scene.id ? " switching" : "")
            }
          >
            <button
              className="scene-tab"
              onPointerDown={(event) => onPointerDown(event, scene.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                endDrag(false);
                releaseSuppression();
              }}
              onLostPointerCapture={() => {
                endDrag(false);
                releaseSuppression();
              }}
              onClick={() => {
                if (takeSuppressedClick()) return;
                onSelect(scene.id);
              }}
              onDoubleClick={() => {
                if (takeSuppressedClick()) return;
                const name = window.prompt("씬 이름", scene.name);
                if (name && name.trim()) onRename(scene.id, name.trim());
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  sceneId: scene.id,
                  sceneName: scene.name,
                  current: assigned,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              title={sceneTabTitle(scene, workspaceContext, label, missing)}
            >
              {assigned ? (
                <span
                  className={"scene-tab-ws" + (missing ? " missing" : "")}
                  aria-hidden="true"
                  title={label || undefined}
                />
              ) : null}
              {scene.name}
            </button>
            <button
              className="scene-del"
              title="씬 삭제"
              onClick={() => {
                if (window.confirm(`'${scene.name}' 씬을 삭제할까요?`)) onDelete(scene.id);
              }}
            >
              ×
            </button>
          </span>
          </Fragment>
        );
      })}
      {/* 맨 뒤에 놓을 때의 삽입선 */}
      {drag?.active && drag.dropBeforeId === null ? <span className="scene-drop-line" /> : null}
      <button className="scene-add" onClick={onAdd} title="씬 추가">
        +
      </button>
      {backupOnly > 0 && onImportBackup ? (
        // 다른 브라우저(앱 전용 프로필)에서 만든 씬이 이 PC 의 DB 백업에 남아 있을 때만 뜬다.
        <button
          className="scene-restore"
          onClick={onImportBackup}
          title={`이 브라우저에 없는 씬 ${backupOnly}개가 이 PC 의 백업에 있습니다. 눌러서 가져옵니다(현재 씬은 그대로 둡니다).`}
        >
          ⤓ 백업에서 씬 {backupOnly}개 가져오기
        </button>
      ) : null}
      {menu ? (
        <SceneWorkspaceMenu
          target={menu}
          onAssign={onAssignWorkspace}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

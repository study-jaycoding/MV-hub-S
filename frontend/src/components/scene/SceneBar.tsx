// 씬 선택/추가 바 — 구성 탭 상단. 씬을 전환/추가/이름변경/삭제하고, **끌어서 순서를 바꾸고**,
// **우클릭으로 그 캔버스의 워크스페이스를 지정**한다(Jay 2026-09-11).
// 계보(히스토리) 뷰는 고정 탭이 아니라 정보팝업 '⧉ 히스토리'·미리보기 '구성에서 보기'로만 진입
// (activeId=null 상태 — 그때는 어떤 씬 탭도 켜지지 않는다).
// 탭 폴더(Jay 2026-11-11): '+' 우클릭 [씬 추가 · 폴더 추가]. 탭을 폴더 위에 끌어 놓으면 들어가고, 폴더를 눌러 연 목록에서
//  끌어 탭 줄에 놓으면 그 자리로 돌아온다(넣고 빼는 단추는 없다). 폴더 규칙은 lib/sceneWorkspace 의 탭 폴더 절.
//
// ★드래그는 포인터 이벤트로 한다(HTML5 DnD 는 자식 요소가 부모 드래그를 막고 투명 고스트가 생긴다).
//  5px 임계 전에는 클릭이고, 드래그가 끝나면 그 뒤에 합성되는 click/dblclick 을 한 번 삼킨다 —
//  안 그러면 순서만 바꾸려다 씬이 열리고 워크스페이스까지 바뀐다(코덱스 P1).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Scene } from "../../lib/scenes";
import {
  dropIndexAt,
  normalizeSceneWorkspace,
  normalizeTabFolder,
  sceneDimmed,
  sceneTabTitle,
  shortSceneName,
  sceneWorkspaceLabel,
  sceneWorkspaceMissing,
  tabRowItems,
  type SceneMove,
  type SceneWorkspace,
  type TabFolder,
  type TabFolderOp,
  type TabRowItem,
} from "../../lib/sceneWorkspace";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { cachedWorkspaceOptions } from "../../lib/workspaceOptionsCache";
import { HostConfirm } from "../common/HostConfirm";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { NodeTip } from "./NodeTip";
import { SceneIoButtons, type SceneIoAction } from "./SceneIoButtons";
import { SceneNameInput, SceneTipName } from "./SceneNameInput";
import { SceneWorkspaceMenu, type SceneMenuTarget } from "./SceneWorkspaceMenu";
import type { WorkspaceContext } from "../../types";

const DRAG_THRESHOLD = 5; // px — 이보다 덜 움직이면 클릭
const FOLDER_EDGE = 0.2; // 폴더 칸 양 끝 이 비율은 '앞·뒤 자리', 가운데만 '폴더에 넣기'
const BAR_SLACK = 8; // 폴더 목록에서 끈 탭은 탭 줄(± 이만큼) 안에 놓아야 돌아온다 — 밖이면 취소

interface Props {
  scenes: Scene[];
  activeId: string | null; // null = 계보(히스토리) 뷰
  workspaceContext: WorkspaceContext;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onReorder: (move: SceneMove) => void;
  onTabFolder?: (op: TabFolderOp) => void; // 탭 폴더 — 없으면 '+' 우클릭 메뉴(폴더 추가)를 띄우지 않는다
  onAssignWorkspace: (sceneId: string, workspace: SceneWorkspace | null) => void;
  onWheelTab?: (sceneId: string) => void; // 탭 휠 클릭 → 그 탭 밑에 씬 패널(Import·Export·레퍼런스 찾기)
  tabActions?: SceneIoAction[]; // 탭 설명 창의 단추(Jay 2026-11-02)
  onTabAction?: (sceneId: string, action: SceneIoAction) => void;
  backupOnly?: number; // DB 백업에만 있는 씬 수(0 이면 '가져오기'를 숨긴다)
  onImportBackup?: () => void;
  saveFailing?: boolean; // 캔버스가 저장소에 확정되지 못하고 있다 — 그동안 '저장 안 됨'을 계속 띄운다
  onExportAll?: () => void; // 지금 상태 전체를 파일로 내려받는다
  backupSkippedIds?: ReadonlySet<string>; // DB 백업에서 빠진 씬(5MB 초과 — Jay 결정 7A)
}

type FolderItem = Extract<TabRowItem, { kind: "folder" }>;

// 탭 설명 창이 뜬 요소의 씬 — 탭 단추일 때만(탭 안 '백업 안 됨' 표식은 설명만)
const tipSceneId = (element: HTMLElement) =>
  element.classList.contains("scene-tab") ? element.closest<HTMLElement>("[data-scene-tab]")?.dataset.sceneTab : undefined;

const BACKUP_SKIPPED_TITLE = "5MB 를 넘어 이 PC 의 DB 백업에서 빠졌습니다 — 카드를 줄이면 다시 백업됩니다. 설정의 [전체 내보내기]로 따로 받아 두세요.";

const newFolderId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `f${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

function FolderIcon() {
  return (
    <svg className="scene-tab-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.5 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg className="scene-tab-icon" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" />
        <rect x="4" y="5" width="3" height="3" rx=".7" />
        <rect x="9" y="8.5" width="3" height="3" rx=".7" />
        <path d="M7 6.5h1.5v3.5H9" />
      </g>
    </svg>
  );
}

// 탭 줄의 작은 떠 있는 메뉴('+' 우클릭 · 폴더 우클릭 · 폴더 안 목록) — 바깥 누름·Esc 로 닫히고, 화면 밖으로 나가지 않게 자리를 맞춘다.
//  ignore = 바깥 누름으로 치지 않을 요소(폴더 목록의 그 폴더 칸 — 닫았다 바로 다시 여는 것을 막는다).
function FloatingMenu({ x, y, label, ignore, onClose, children }: { x: number; y: number; label: string; ignore?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - element.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - element.offsetHeight - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || (ignore && target?.closest?.(ignore))) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ignore, onClose]);
  useEscapeClose(onClose, true, true, true);
  return (
    <div ref={ref} className="scene-tab-menu" role="menu" aria-label={label} style={pos}>
      {children}
    </div>
  );
}

// 이름 뒤 호박색 '백업 안 됨' — 누르는 동작은 없다(탭 누름 그대로). 이 표시 때문에 이름이 잘리면 '⚠' 하나만 둔다. 한 번 줄이면 그 이름 동안
//  그대로 — 줄이면 이름이 다시 들어가 늘였다 줄였다 깜빡이지 않게.
function BackupSkippedBadge({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [narrowFor, setNarrowFor] = useState<string | null>(null);
  const narrow = narrowFor === name;
  useLayoutEffect(() => {
    if (narrow) return;
    const label = ref.current?.previousElementSibling;
    if (label && label.scrollWidth > label.clientWidth) setNarrowFor(name);
  });
  return (
    <span ref={ref} className="scene-tab-backup" title={BACKUP_SKIPPED_TITLE} aria-label="백업 안 됨">
      {narrow ? "⚠" : "백업 안 됨"}
    </span>
  );
}

// 씬 삭제 확인 — 앱 확인창(common/HostConfirm). × 는 탭 닫기가 아니라 저장된 카드·연결까지 지우는 삭제라 문구도 삭제로 쓴다.
function SceneDeleteConfirm({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <HostConfirm label="씬 삭제" title="🗑 씬 삭제" confirmLabel="삭제" onConfirm={onConfirm} onCancel={onCancel}>
      '{name}' 씬을 삭제할까요?
      <br />
      이 씬의 카드·연결이 모두 사라집니다.
    </HostConfirm>
  );
}

interface DragState {
  sceneId: string | null; // 끄는 탭(폴더를 끌면 null)
  folderId: string | null; // 끄는 폴더(폴더째 옮기기)
  fromList: boolean; // 폴더 안 목록에서 끌기 시작 — 탭 줄 밖에 놓으면 취소
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean; // 임계를 넘겨 실제 드래그로 전환됐는가
  // 놓을 자리를 **줄 칸의 열쇠**(t:씬 id · f:폴더 id)로 들고 있는다(숫자 인덱스가 아니라) — 끌고 있는 동안 다른 창이
  // 씬을 지우면 같은 인덱스가 다른 자리를 뜻하게 된다(코덱스 P2). null = 맨 뒤, undefined = 놓을 곳 없음.
  dropBeforeKey: string | null | undefined;
  dropFolderId: string | null; // 폴더 칸 가운데에 놓는다 = 그 폴더에 넣기
}

const ownKey = (drag: DragState) => (drag.folderId ? `f:${drag.folderId}` : `t:${drag.sceneId}`);

export function SceneBar({
  scenes,
  activeId,
  workspaceContext,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onReorder,
  onTabFolder,
  onAssignWorkspace,
  onWheelTab,
  tabActions,
  onTabAction,
  backupOnly = 0,
  onImportBackup,
  saveFailing = false,
  onExportAll,
  backupSkippedIds,
}: Props) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<SceneMenuTarget | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null); // 삭제 확인창의 씬
  const deleting = deleteId ? scenes.find((scene) => scene.id === deleteId) : undefined; // 그사이 다른 창이 지웠으면 닫는다
  const [editingId, setEditingId] = useState<string | null>(null); // 더블클릭으로 이름을 고치는 탭
  // 탭 폴더 — 빈 폴더는 씬에 담을 곳이 없어 이 창의 화면 상태에만 둔다(새로 고치면 사라진다, 탭을 넣으면 씬에 남는다).
  const [emptyFolders, setEmptyFolders] = useState<TabFolder[]>([]);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: TabFolder; x: number; y: number } | null>(null);
  const [openFolder, setOpenFolder] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const items = tabRowItems(scenes, activeId, emptyFolders);
  const openItem = openFolder ? items.find((item): item is FolderItem => item.kind === "folder" && item.folder.id === openFolder.id) : undefined;
  const barRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>()); // 줄 칸 열쇠 → 요소(탭은 .scene-tab-wrap, 폴더는 칸 단추)
  const suppressClickRef = useRef(false); // 드래그 직후의 합성 클릭 한 번을 삼킨다
  const suppressTimerRef = useRef<number | undefined>(undefined); // 그 억제를 푸는 예약(releaseSuppression) — 새 누름이 거둔다
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // 끄는 동안 칸 위치는 안 바뀐다(움직이는 건 삽입선뿐). 포인터가 움직일 때마다 모든 칸을
  // 다시 재면 탭이 많을수록 레이아웃 계산이 쌓이므로, 드래그가 시작될 때 한 번만 재서 쓴다.
  // 그 사이 칸 수가 달라지면(다른 창이 추가·삭제) 버리고 다시 잰다.
  const dragRectsRef = useRef<DOMRect[] | null>(null);
  // 워크스페이스 이름은 캐시에서 현재 값을 쓴다(관리자가 이름을 바꿔도 맞게 보이도록).
  const [options, setOptions] = useState(() => cachedWorkspaceOptions());
  useEffect(() => {
    // 메뉴가 목록을 받아 캐시를 채우면 탭 이름도 따라 갱신되게 — 가벼운 폴링 대신 메뉴 닫힘에 맞춰 읽는다.
    if (!menu) setOptions(cachedWorkspaceOptions());
  }, [menu]);

  const setItemRef = (key: string) => (element: HTMLElement | null) => {
    if (element) itemRefs.current.set(key, element);
    else itemRefs.current.delete(key);
  };
  const folderItem = (folderId: string | null | undefined) =>
    items.find((item): item is FolderItem => item.kind === "folder" && item.folder.id === folderId);
  // 그 칸 앞에 놓는다 = 이 씬 앞으로. 폴더 칸 앞 = 그 폴더 첫 탭 앞(빈 폴더는 줄 맨 뒤에 있으니 맨 뒤). undefined = 그 칸이 사라짐.
  const beforeIdOf = (key: string | null): string | null | undefined => {
    if (key === null) return null;
    const item = items.find((candidate) => candidate.key === key);
    if (!item) return undefined;
    return item.kind === "tab" ? item.scene.id : item.members[0]?.id ?? null;
  };
  // 폴더에 넣을 때는 그 폴더 마지막 탭 바로 뒤로 옮긴다 — 폴더 자리 = 첫 탭 자리라, 앞쪽 탭을 넣어도 폴더가 튀지 않게.
  const afterFolder = (item: FolderItem, movingId: string): string | null => {
    const last = item.members[item.members.length - 1];
    if (!last) return null;
    const at = scenes.findIndex((scene) => scene.id === last.id);
    return scenes.slice(at + 1).find((scene) => scene.id !== movingId)?.id ?? null;
  };
  const rememberEmpty = (folder: TabFolder) =>
    setEmptyFolders((previous) =>
      previous.some((item) => item.id === folder.id) ? previous.map((item) => (item.id === folder.id ? folder : item)) : [...previous, folder],
    );
  // 마지막 탭을 빼면 폴더가 사라지지 않게 빈 폴더로 남긴다(이 창 안에서 — 다시 넣을 수 있게).
  const keepIfLast = (folder: TabFolder | undefined, sceneId: string) => {
    const item = folderItem(folder?.id);
    if (item && item.members.length === 1 && item.members[0].id === sceneId) rememberEmpty(item.folder);
  };

  const commitDrop = (current: DragState) => {
    if (current.folderId) {
      // 폴더째 옮기기 — 제자리(자기 칸·자기 폴더 바로 뒤의 보는 탭)는 건너뛴다
      if (current.dropBeforeKey === undefined || current.dropBeforeKey === ownKey(current)) return;
      const target = current.dropBeforeKey === null ? null : items.find((item) => item.key === current.dropBeforeKey);
      if (target === undefined || (target?.kind === "tab" && target.inFolder?.id === current.folderId)) return;
      const beforeId = beforeIdOf(current.dropBeforeKey);
      if (beforeId === undefined) return;
      onTabFolder?.({ type: "moveFolder", folderId: current.folderId, beforeId });
      return;
    }
    const sceneId = current.sceneId;
    const scene = sceneId ? scenes.find((candidate) => candidate.id === sceneId) : undefined;
    if (!sceneId || !scene) return;
    const from = normalizeTabFolder(scene.tabFolder);
    if (current.dropFolderId) {
      const target = folderItem(current.dropFolderId);
      if (!target || from?.id === target.folder.id) return; // 자기 폴더 위 = 그대로
      keepIfLast(from, sceneId);
      onTabFolder?.({ type: "put", id: sceneId, folder: target.folder, beforeId: afterFolder(target, sceneId) });
      return;
    }
    if (current.dropBeforeKey === undefined) return;
    if (current.dropBeforeKey === ownKey(current) && !current.fromList) return; // 자기 앞 = 제자리
    const beforeId = beforeIdOf(current.dropBeforeKey);
    if (beforeId === undefined) return;
    if (from && onTabFolder) {
      // 폴더 안 탭을 줄에 놓았다 = 폴더에서 빼서 그 자리로
      keepIfLast(from, sceneId);
      onTabFolder({ type: "put", id: sceneId, folder: null, beforeId });
      return;
    }
    if (beforeId === sceneId) return;
    onReorder({ id: sceneId, beforeId });
  };

  const endDrag = (commit: boolean) => {
    const current = dragRef.current;
    // 바로 비운다 — 안 비우면 다시 그리기 전에 온 움직임이 옛 값을 읽어 끝난 끌기를 다시 켠다(포인터를 놓친 뒤 삽입선이 뗀 마우스를
    //  따라왔고, 나중의 pointerup 이 그 자리로 순서를 확정했다 — 2026-10-11 격리 실측 2/2).
    dragRef.current = null;
    setDrag(null);
    dragRectsRef.current = null;
    if (!current?.active) return;
    // 드래그 뒤에 오는 합성 click 한 번을 삼킨다. 해제는 **포인터를 놓은 뒤**(releaseSuppression)에
    // 예약한다 — Esc 로 취소하고 버튼을 나중에 놓으면, 그 사이 타이머가 풀려 클릭이 통과해
    // 씬이 열리고 워크스페이스까지 바뀐다(코덱스 P2).
    suppressClickRef.current = true;
    if (current.fromList) setOpenFolder(null); // 목록에서 끈 뒤에는 목록을 닫는다(놓았든 취소했든)
    if (commit) commitDrop(current);
  };

  const onPointerDown = (event: React.PointerEvent, source: { sceneId?: string; folderId?: string; fromList?: boolean }) => {
    if (event.button !== 0 || !event.isPrimary) return; // 좌클릭·주 포인터만
    // 새 누름이다 — 앞 끌기에 딸린 click 은 이미 지나갔다. 안 풀면, click 이 오지 않은 끌기(탭 밖에서 놓음) 바로 뒤의 탭 누름이
    //  타이머(releaseSuppression)가 돌기 전에 삼켜진다(입력은 타이머보다 먼저 처리된다 — lib/useSceneCardMove 의 swallowDropClick 과 같은 약속)
    //  앞 끌기가 예약해 둔 해제도 거둔다 — 남겨 두면 이 누름으로 시작한 끌기를 Esc 로 취소한 뒤(억제가 선다) 그 타이머가 억제를 풀어,
    //  단추를 놓을 때의 click 이 씬을 연다(Codex 코드 리뷰).
    suppressClickRef.current = false;
    window.clearTimeout(suppressTimerRef.current);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    const next: DragState = {
      sceneId: source.sceneId ?? null,
      folderId: source.folderId ?? null,
      fromList: !!source.fromList,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      dropBeforeKey: undefined,
      dropFolderId: null,
    };
    if (!next.fromList) next.dropBeforeKey = ownKey(next); // 제자리
    setDrag(next);
  };

  const nearBar = (x: number, y: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    return !!rect && x >= rect.left - BAR_SLACK && x <= rect.right + BAR_SLACK && y >= rect.top - BAR_SLACK && y <= rect.bottom + BAR_SLACK;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // 단추를 뗀 채 온 움직임 = pointerup 을 놓쳤다(창 밖에서 뗌 등) — 순서를 바꾸지 않고 끝낸다(창을 떠날 때와 같은 길, 조작 규칙 21)
    if (event.buttons === 0) {
      endDrag(false);
      releaseSuppression();
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    let rects = dragRectsRef.current;
    if (!rects || rects.length !== items.length) {
      rects = items
        .map((item) => itemRefs.current.get(item.key)?.getBoundingClientRect())
        .filter((rect): rect is DOMRect => !!rect);
      dragRectsRef.current = rects;
    }
    if (rects.length !== items.length) {
      dragRectsRef.current = null; // 목록이 바뀌는 중 — 이번 이동은 건너뛰고 다음에 다시 잰다
      return;
    }
    const measured = rects;
    const x = event.clientX;
    const y = event.clientY;
    // 폴더 칸 가운데 = 그 폴더에 넣기. 폴더를 끌 때는 넣지 않는다(폴더 안 폴더 없음).
    const folderAt = current.folderId
      ? -1
      : items.findIndex((item, index) => {
          if (item.kind !== "folder") return false;
          const rect = measured[index];
          const edge = (rect.right - rect.left) * FOLDER_EDGE;
          return x >= rect.left + edge && x <= rect.right - edge && y >= rect.top && y <= rect.bottom;
        });
    let dropBeforeKey: string | null | undefined;
    let dropFolderId: string | null = null;
    if (folderAt >= 0) dropFolderId = (items[folderAt] as FolderItem).folder.id;
    else if (!current.fromList || nearBar(x, y)) dropBeforeKey = items[dropIndexAt(measured, x, y)]?.key ?? null;
    setDrag({ ...current, active: true, dropBeforeKey, dropFolderId });
  };

  // 포인터를 놓은 뒤(합성 click 이 지나간 뒤) 억제를 푼다. click 은 pointerup 과 같은 태스크에서 오므로
  // 이 타이머보다 먼저 도착한다.
  const releaseSuppression = () => {
    window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (current && current.pointerId !== event.pointerId) return;
    endDrag(true);
    releaseSuppression(); // Esc 로 이미 취소된 뒤여도 여기서 푼다
  };

  const cancelDrag = () => {
    endDrag(false);
    releaseSuppression();
  };
  // 탭·폴더 칸·폴더 목록 줄이 같이 쓰는 끌기 처리
  const dragHandlers = { onPointerMove, onPointerUp, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag };

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

  const addFolder = () => {
    const folder = { id: newFolderId(), name: "새 폴더" };
    setEmptyFolders((previous) => [...previous, folder]);
    setEditingFolderId(folder.id); // 이름이 골라진 채 열린다 — Enter·바깥 = 저장, Esc = '새 폴더' 그대로
  };
  const renameFolder = (folder: TabFolder, name: string) => {
    setEmptyFolders((previous) => previous.map((item) => (item.id === folder.id ? { ...item, name } : item)));
    if (folderItem(folder.id)?.members.length) onTabFolder?.({ type: "rename", folderId: folder.id, name });
  };
  const ungroupFolder = (folder: TabFolder) => {
    setEmptyFolders((previous) => previous.filter((item) => item.id !== folder.id));
    if (folderItem(folder.id)?.members.length) onTabFolder?.({ type: "ungroup", folderId: folder.id });
  };
  const toggleFolder = (folderId: string, element: HTMLElement) => {
    if (openFolder?.id === folderId) {
      setOpenFolder(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    setOpenFolder({ id: folderId, x: rect.left, y: rect.bottom + 4 });
  };

  // 삽입선 자리 — 줄 칸 열쇠 앞(null = 맨 뒤). 폴더에 넣는 중·놓을 곳 없음·제자리면 긋지 않는다.
  const dropLineKey = (() => {
    if (!drag?.active || drag.dropFolderId || drag.dropBeforeKey === undefined) return undefined;
    if (drag.dropBeforeKey === ownKey(drag) && !drag.fromList) return undefined;
    if (drag.folderId) {
      const target = items.find((item) => item.key === drag.dropBeforeKey);
      if (target?.kind === "tab" && target.inFolder?.id === drag.folderId) return undefined;
    }
    return drag.dropBeforeKey;
  })();

  const workspaceMarkOf = (scene: Scene) => {
    const assigned = normalizeSceneWorkspace(scene.workspace);
    if (!assigned) return null;
    const label = sceneWorkspaceLabel(scene, options ?? []);
    const missing = sceneWorkspaceMissing(scene, options);
    return <WorkspaceMark label={label || assigned.name || assigned.id} id={assigned.id} className={"sm" + (missing ? " missing" : "")} />;
  };

  const renderTab = (item: Extract<TabRowItem, { kind: "tab" }>) => {
    const { scene } = item;
    const assigned = normalizeSceneWorkspace(scene.workspace);
    const label = sceneWorkspaceLabel(scene, options ?? []);
    const missing = sceneWorkspaceMissing(scene, options);
    const dimmed = sceneDimmed(scene, workspaceContext);
    const dragging = drag?.active && !drag.fromList && drag.sceneId === scene.id;
    // 어느 공간인지 **점이 아니라 표식으로** 보여 준다(Jay 2026-09-14) — 라임 점은 '지정됨' 만 말할 뿐 어느 공간인지는 못 알려 줬다.
    //  메뉴·툴바와 같은 표식이다.
    const mark = workspaceMarkOf(scene);
    return (
      <span
        ref={setItemRef(item.key)}
        className={
          "scene-tab-wrap" +
          (activeId === scene.id ? " on" : "") +
          (dimmed ? " off-ws" : "") +
          (dragging ? " dragging" : "")
        }
        data-scene-tab={scene.id}
      >
        {/* 고치는 동안은 단추가 아니다 — 끌기·클릭이 글칸 조작을 가로채지 않고, 단추 안에 입력칸을 두지 않는다 */}
        {editingId === scene.id ? (
          <span className="scene-tab editing">
            {mark}
            <SceneNameInput name={scene.name} onRename={(next) => onRename(scene.id, next)} onDone={() => setEditingId(null)} />
          </span>
        ) : (
        <button
          className="scene-tab"
          onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} // 휠 클릭의 자동 스크롤 막기
          onDoubleClick={() => setEditingId(scene.id)}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            onWheelTab?.(scene.id);
          }}
          onPointerDown={(event) => onPointerDown(event, { sceneId: scene.id })}
          {...dragHandlers}
          onClick={() => {
            if (takeSuppressedClick()) return;
            onSelect(scene.id);
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
          // 탭은 190px 에서 이름을 … 로 줄인다(scene.css) — 전체 이름은 여기 첫 줄로 본다. 앱 설명 창은 위 NodeTip(Jay 2026-11-02).
          title={[scene.name, sceneTabTitle(scene, workspaceContext, label, missing)].filter(Boolean).join("\n")}
          data-tip-head={scene.name}
          data-tip-tone={missing ? "bad" : dimmed ? "warn" : undefined}
          data-tip-ws-id={assigned?.id}
          data-tip-ws-label={assigned ? label || assigned.name || assigned.id : undefined}
          data-tip-ws-missing={missing ? "" : undefined}
        >
          {mark}
          <span className="scene-tab-name">{shortSceneName(scene.name)}</span>
          {backupSkippedIds?.has(scene.id) ? <BackupSkippedBadge name={scene.name} /> : null}
        </button>
        )}
        <button className="scene-del" title="씬 삭제" onClick={() => setDeleteId(scene.id)}>
          ×
        </button>
      </span>
    );
  };

  // 폴더 칸 — 누름 = 안의 탭 목록, 더블클릭 = 이름, 우클릭 = 이름·풀기, 끌기 = 폴더째 옮기기. × 는 없다(탭 × 는 씬 삭제라 헷갈리지 않게).
  const renderFolder = (item: FolderItem) => {
    const { folder, members } = item;
    if (editingFolderId === folder.id) {
      return (
        <span ref={setItemRef(item.key)} className="scene-tab-folder editing" data-tab-folder={folder.id}>
          <FolderIcon />
          <SceneNameInput name={folder.name} label="폴더 이름" onRename={(next) => renameFolder(folder, next)} onDone={() => setEditingFolderId(null)} />
        </span>
      );
    }
    const open = openFolder?.id === folder.id;
    return (
      <button
        ref={setItemRef(item.key)}
        type="button"
        className={
          "scene-tab-folder" +
          (open ? " open" : "") +
          (members.some((scene) => scene.id === activeId) ? " has-cur" : "") +
          (drag?.active && drag.dropFolderId === folder.id ? " drop" : "") +
          (drag?.active && drag.folderId === folder.id ? " dragging" : "")
        }
        data-tab-folder={folder.id}
        aria-haspopup="menu"
        aria-expanded={open}
        title={members.length ? `${folder.name} — 탭 ${members.length}개` : `${folder.name} — 비어 있음, 탭을 끌어 넣으세요`}
        onPointerDown={(event) => onPointerDown(event, { folderId: folder.id })}
        {...dragHandlers}
        onClick={(event) => {
          if (takeSuppressedClick()) return;
          toggleFolder(folder.id, event.currentTarget);
        }}
        onDoubleClick={() => {
          setOpenFolder(null);
          setEditingFolderId(folder.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setOpenFolder(null);
          setFolderMenu({ folder, x: event.clientX, y: event.clientY });
        }}
      >
        <FolderIcon />
        <span className="scene-tab-folder-name">{folder.name}</span>
        {members.length ? <span className="scene-tab-folder-count">{members.length}</span> : null}
      </button>
    );
  };

  return (
    <div className="scene-bar" ref={barRef}>
      <NodeTip
        rootRef={barRef}
        within=".scene-tab"
        className="tab"
        actions={(element, { close }) => {
          const sceneId = tipSceneId(element);
          if (!sceneId || !tabActions?.length) return null;
          return (
            <SceneIoButtons
              actions={tabActions}
              run={(action) => {
                close();
                onTabAction?.(sceneId, action);
              }}
            />
          );
        }}
        head={(element, { close, pin }) => {
          const sceneId = tipSceneId(element);
          if (!sceneId) return null;
          return <SceneTipName name={element.dataset.tipHead ?? ""} onRename={(next) => onRename(sceneId, next)} pin={pin} close={close} />;
        }}
      />
      {items.map((item) => (
        <Fragment key={item.key}>
          {/* 삽입선은 칸 바깥에 그린다 — .scene-tab-wrap 은 overflow:hidden 이라 안에 그리면 잘린다(코덱스 P2). */}
          {dropLineKey === item.key ? <span className="scene-drop-line" /> : null}
          {item.kind === "tab" ? renderTab(item) : renderFolder(item)}
        </Fragment>
      ))}
      {/* 맨 뒤에 놓을 때의 삽입선 */}
      {dropLineKey === null ? <span className="scene-drop-line" /> : null}
      <button
        className="scene-add"
        onClick={onAdd}
        onContextMenu={
          onTabFolder
            ? (event) => {
                event.preventDefault();
                setAddMenu({ x: event.clientX, y: event.clientY });
              }
            : undefined
        }
        title={onTabFolder ? "씬 추가 · 우클릭 = 폴더 추가" : "씬 추가"}
      >
        +
      </button>
      {saveFailing && onExportAll ? (
        // 알림 한 줄은 다른 알림에 덮인다 — 실패하는 동안 여기 계속 떠 있고, 누르면 그 자리에서 건진다.
        <button
          className="scene-restore scene-unsaved"
          onClick={onExportAll}
          title="캔버스를 이 PC 저장소에 쓰지 못하고 있습니다. 작업은 화면에 그대로 있고 계속 다시 시도합니다. 눌러서 지금 상태 전체를 파일로 내려받아 두세요."
        >
          ⚠ 저장 안 됨 — 눌러서 파일로 내려받기
        </button>
      ) : null}
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
      {addMenu ? (
        <FloatingMenu x={addMenu.x} y={addMenu.y} label="추가" onClose={() => setAddMenu(null)}>
          <button type="button" role="menuitem" className="scene-tab-menu-item" onClick={() => { setAddMenu(null); onAdd(); }}>
            <CanvasIcon />
            씬 추가
          </button>
          <button type="button" role="menuitem" className="scene-tab-menu-item" onClick={() => { setAddMenu(null); addFolder(); }}>
            <FolderIcon />
            폴더 추가
          </button>
        </FloatingMenu>
      ) : null}
      {openFolder && openItem ? (
        <FloatingMenu
          key={openItem.folder.id}
          x={openFolder.x}
          y={openFolder.y}
          label={`${openItem.folder.name} 폴더`}
          ignore={`[data-tab-folder="${openItem.folder.id}"]`}
          onClose={() => setOpenFolder(null)}
        >
          {openItem.members.length ? (
            openItem.members.map((scene) => (
              <button
                key={scene.id}
                type="button"
                role="menuitem"
                className={
                  "scene-tab-menu-item" +
                  (scene.id === activeId ? " cur" : "") +
                  (drag?.active && drag.fromList && drag.sceneId === scene.id ? " dragging" : "")
                }
                title={scene.name}
                onPointerDown={(event) => onPointerDown(event, { sceneId: scene.id, fromList: true })}
                {...dragHandlers}
                onClick={() => {
                  if (takeSuppressedClick()) return;
                  setOpenFolder(null);
                  onSelect(scene.id);
                }}
              >
                {workspaceMarkOf(scene) ?? <CanvasIcon />}
                <span className="scene-tab-menu-name">{scene.name}</span>
              </button>
            ))
          ) : (
            <div className="scene-tab-menu-empty">비어 있음 — 탭을 끌어 넣으세요</div>
          )}
        </FloatingMenu>
      ) : null}
      {folderMenu ? (
        <FloatingMenu key={folderMenu.folder.id} x={folderMenu.x} y={folderMenu.y} label="폴더" onClose={() => setFolderMenu(null)}>
          <SceneNameInput
            name={folderMenu.folder.name}
            label="폴더 이름"
            onRename={(next) => renameFolder(folderMenu.folder, next)}
            onDone={() => setFolderMenu(null)}
          />
          <div className="scene-tab-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="scene-tab-menu-item"
            onClick={() => {
              setFolderMenu(null);
              ungroupFolder(folderMenu.folder);
            }}
          >
            폴더 풀기
            <span className="scene-tab-menu-key">탭은 줄로</span>
          </button>
        </FloatingMenu>
      ) : null}
      {menu ? (
        <SceneWorkspaceMenu
          // 다른 탭의 메뉴로 바뀌면 새로 만든다 — 메뉴는 바깥을 '눌러야' 닫히므로, 키보드(Shift+F10)로 다른 탭의 메뉴를 열면 떠 있는 채
          //  대상만 바뀐다. 그때 이름칸에 앞 탭의 이름이 남아 Enter 가 그 이름을 새 탭에 저장했다(조작 규칙 43).
          key={menu.sceneId}
          target={menu}
          onAssign={onAssignWorkspace}
          onRename={onRename}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {deleting ? (
        <SceneDeleteConfirm
          key={deleting.id} // 다른 탭의 × 로 바뀌면 새로 띄운다(초점도 다시 삭제 단추로)
          name={deleting.name}
          onConfirm={() => {
            setDeleteId(null);
            onDelete(deleting.id);
          }}
          onCancel={() => setDeleteId(null)}
        />
      ) : null}
    </div>
  );
}

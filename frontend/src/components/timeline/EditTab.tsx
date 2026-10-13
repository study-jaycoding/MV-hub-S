// 편집 탭 — 공유된 생성물을 컷(폴더) 순서대로 이어 보는 다빈치식 화면. 계약·한계는 docs/EDIT_TAB.md.
//  왼쪽 = 시퀀스 폴더 고르기 · 그 옆 = 미디어 풀(재생헤드가 있는 컷의 생성물) · 오른쪽 = 뷰어 판(싱글/듀얼 — 판마다 타임라인·
//  소스·한 트랙만 중에서 고른다) · 아래 = 트랙 타임라인(트랙 추가·삭제·옮기기, 마크 인/아웃, 북마크). 컷 자리는 폴더 순서고
//  (이름순 — 컷 머리를 끌어 내 순서로 바꿀 수 있다), 고른 생성물만 들어간다(휠 클릭 메뉴, 또는 풀의 카드를 끌어 놓기).
//  편집은 이 브라우저(계정)에만 저장한다.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import type { CardMark, Generation, PreviewTarget, WorkspaceContext } from "../../types";
import { APP_EVENTS, isLibraryPollTick } from "../../lib/appEvents";
import { backgroundKeysBlocked, focusCameByTab, useDragKeyHold } from "../../lib/keyGate";
import { isKeyHandled, markKeyHandled } from "../../lib/keyHandled";
import { isFolderDisabled } from "../../lib/deactivated";
import {
  addMarker,
  addTrack,
  buildLayout,
  clearMarkers,
  clipIsOn,
  clipKey,
  cutIsOff,
  cutPaths,
  DEFAULT_SEC,
  deleteEmptyTracks,
  deleteTrack,
  EDIT_FPS,
  editPoints,
  emptyEditDoc,
  fillEmptyCuts,
  genSeconds,
  groupByCut,
  linkClip,
  markerAt,
  marksOf,
  moveClipToTrack,
  moveCut,
  moveTrack,
  nearestPoint,
  patchMarker,
  placeClip,
  placeState,
  posAt,
  setClipTrim,
  removeClips,
  removeMarker,
  resetCutOrder,
  setClipDurs,
  setMark,
  setTrackColor,
  shiftClips,
  shownMarkers,
  stepPoint,
  timecode,
  toggleClipsOff,
  toggleCutOff,
  toggleTrack,
  visibleClip,
  type EditDoc,
  type SlotClip,
} from "../../lib/editTimeline";
import {
  EDIT_SPEEDS, editDocKey, isSourceView, loadEditTarget, loadEditUi, saveEditTarget, saveEditUi,
  type EditTarget, type EditUi, type ViewMode,
} from "../../lib/editTimelineStore";
import { buildTimelineExport, timelineExportName } from "../../lib/editResolveExport";
import type { FolderMenuKind } from "../../lib/folderContextMenu";
import { generationListMeta } from "../../lib/generationDisplay";
import { previewTargetFromGenerations } from "../../lib/generationGrid";
import { reviewTargets, type ReviewAction } from "../../lib/generationReview";
import { TEAM_SCOPE } from "../../lib/generationViews";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import { useCustomEvent } from "../../lib/useCustomEvent";
import { useDisabledFolders } from "../../lib/useDisabledFolders";
import { useEditDoc } from "../../lib/useEditDoc";
import { useEditPlayback, type EditSource } from "../../lib/useEditPlayback";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useVideoPair } from "../../lib/editVideoPair";
import { workspaceViewKey } from "../../lib/libraryWorkspaceScope";
import type { ResolveProjectTarget, ResolveTimelineResult } from "../../lib/resolveTransfer";
import {
  allFolderPaths,
  editWorkspaceReady,
  findFolder,
  useEditGenerations,
  useEditProjects,
} from "../../lib/useEditSequence";
import { dropQueuedVideoMeasures, knownVideoSeconds, measureVideoSeconds } from "../../lib/videoDuration";
import { editMarkLabel } from "./EditCard";
import { EditExportConfirm } from "./EditExportConfirm";
import { EditMarkerColorMenu, EditMarkerMenu } from "./EditMarkerMenu";
import { arrangePool, EditPool, type PoolItem } from "./EditPool";
import { EditSidebar } from "./EditSidebar";
import { EditSoloViewer } from "./EditSoloViewer";
import { dropLabel, EditTimeline, ZOOM_MAX, ZOOM_MIN, type ClipLink, type DropHint } from "./EditTimeline";
import { EditClipMenu, EditListMenu, EditTrackHeadMenu, EditTrackMenu, type TrackAct, type TrackRow } from "./EditTrackMenu";
import { EditTrimPop } from "./EditTrimPop";
import { EditTrimView } from "./EditTrimView";
import { EditViewer, writeText, type ViewerControls, type ViewerMarking, type ViewOption } from "./EditViewer";
import { ResizableSidebar } from "../common/ResizableSidebar";

interface Props {
  authKey: string; // 계정·서버 — 바뀌면 받던 조회를 버린다
  authReady: boolean;
  workspace: WorkspaceContext;
  keysActive: boolean; // false = 위에 다른 창이 떠 있다(편집 키를 듣지 않는다)
  flash: (message: string) => void;
  // 컷을 더블클릭 — 공유 & 리뷰의 '폴더 보기' 창을 그 컷 폴더로 연다(창은 App 의 것, 여기는 무엇을 열지만 알린다).
  onOpenCutFolder: (target: EditCutFolder) => void;
  reloadSignal: number; // 그 창이 닫혔다 — 창에서 공유를 풀거나 지웠을 수 있으니 공유 목록을 다시 받는다
  // 그 창이 떠 있는 동안(peekPath = 그 컷 폴더): 창의 카드를 휠 클릭하면 App 이 cardMenuRef 로 넘겨주고(넣을 트랙 메뉴),
  //  표는 창에서 넣고 바꾸는 대로 다시 알린다(onPeekMarks).
  peekPath: string | null;
  onPeekMarks: (marks: Record<string, CardMark>) => void;
  cardMenuRef: MutableRefObject<EditCardMenu | null>;
  // 미디어 풀의 더블클릭·비교 — 앱의 크게 보기 창·비교 창을 그대로 쓴다(둘 다 보기 전용).
  onPreview: (target: PreviewTarget) => void;
  onCompare: (gens: Generation[]) => void;
  // 풀에서 고른 것·타임라인의 클립을 Resolve 보내기 — 앱의 보내기 줄(대기열·연결 확인)을 그대로 쓴다.
  //  sendTimeline = 막대의 [타임라인 Resolve 보내기] — 원본을 보내고 그 프로젝트에 새 타임라인을 짓는다(같은 줄에 선다).
  //  끝나면 결과로 풀린다(보내지 못했으면 null). timelineBusy = 그 일이 줄에 있다(탭을 떠났다 와도 남는다).
  resolve: {
    send: (gens: Generation[]) => void;
    busy: boolean;
    pendingCount: number;
    sendTimeline: (plan: unknown, gens: Generation[], target: ResolveProjectTarget) => Promise<ResolveTimelineResult | null>;
    timelineBusy: boolean;
  };
  // 왼쪽 폴더 트리의 폴더 메뉴(공유 저장 · 최종 저장 · 원본 위치 열기) — 앱의 것 그대로(공유 & 리뷰 탭과 같은 길)
  onFolderAction: (kind: FolderMenuKind, projectId: string, path: string, name: string) => void | Promise<void>;
  // 최종 확정(Jay 2026-10-13 — 클립 메뉴의 '최종 선택' · 목록 단추의 '모두 최종으로 확정') — 앱의 것 그대로(공유 & 리뷰의 여러 장
  //  등급 처리와 같은 길: 바꿀 수 있는 것만 거르고, 요청하고, 결과를 알리고, 목록을 다시 받는다. 서버가 권한을 다시 확인한다).
  //  canFinalize = 그 생성물에 내가 최종을 줄 수 있나(그 프로젝트의 supervisor·PM). 안 주면 두 줄 모두 없다.
  review?: {
    canFinalize: (gen: Generation) => boolean;
    apply: (gens: Generation[], action: ReviewAction) => void | Promise<void>;
  };
}

export type EditCardMenu = (gen: Pick<Generation, "id">, x: number, y: number) => void;

export interface EditCutFolder {
  projectId: string;
  projectName: string;
  path: string;
  focusId: string | null; // 창이 열릴 때 보이게 할 카드(지금 뷰어에 보이는 것)
  marks: Record<string, CardMark>; // 타임라인에 넣은 카드의 표 — "V1 - 선택 카드"
}

export function EditTab(props: Props) {
  return props.authReady ? <EditTabInner {...props} /> : <main className="main ed-root" />;
}

// '전체 보기'를 켠 워크스페이스 — 탭을 오가도 남고 새로고침하면 사라진다(공유 & 리뷰 탭의 전체 보기와 같은 수명).
let allWorkspacesIn = "";

const NO_CUTS: ReadonlySet<string> = new Set();
const NO_MARKS: readonly number[] = [];
const AROUND_SEC = 2; // 다이나믹 트림 모드 — 재생이 편집점의 앞뒤로 트는 길이(초)
export const MEASURE_SAVE_MS = 500; // 잰 영상 길이를 모아 한 번에 적는 간격 — 첫 값이 온 뒤 이만큼
// 소스 뷰어 — 생성물마다 컷 하나·클립 하나짜리 가상 시퀀스(소스 클립 = 고른 것 하나, 소스 테이프 = 이 컷의 풀 목록).
//  컷 경로는 `@src/<생성물 id>`. 편집 문서와 무관하다.
const SRC_CUT = "@src";
const NO_GENS: Generation[] = [];
const NO_SOURCE = { doc: emptyEditDoc(), layout: buildLayout([], emptyEditDoc()), byId: new Map<string, Generation>() };
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" || element.isContentEditable);
};

function EditTabInner({
  authKey, workspace, keysActive, flash, onOpenCutFolder, reloadSignal, peekPath, onPeekMarks, cardMenuRef, onPreview, onCompare,
  resolve, onFolderAction, review,
}: Props) {
  const t = useT();
  const [target, setTarget] = useState<EditTarget | null>(loadEditTarget);
  const [openProject, setOpenProject] = useState<string | null>(() => target?.projectId ?? null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(20); // px/초
  // 화면 설정(미디어 풀의 보기 방식·크기·정렬, 싱글/듀얼 뷰어) — 이 브라우저에 남는다. 편집 내용이 아니다.
  const [ui, setUi] = useState<EditUi>(loadEditUi);
  const patchUi = useCallback((change: Partial<EditUi>) => {
    setUi((prev) => {
      const next = { ...prev, ...change };
      saveEditUi(next);
      return next;
    });
  }, []);
  // 미디어 풀에서 고른 생성물(고른 순서) — 마지막 것이 듀얼 뷰어의 소스, 2장 이상이면 비교할 수 있다.
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const pickGen = useCallback((gen: Generation, additive: boolean) => {
    setPickedIds((prev) => (!additive ? [gen.id] : prev.includes(gen.id) ? prev.filter((id) => id !== gen.id) : [...prev, gen.id]));
  }, []);
  const clearPicked = useCallback(() => setPickedIds([]), []);
  // 구간 반복 재생(뷰어 오른쪽 아래의 단추) — 켜져 있으면 타임라인이 마크 인/아웃 구간을 되풀이한다. 저장하지 않는다.
  const [rangeLoop, setRangeLoop] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  // 타임라인 판의 영상 요소 둘(앞 · 다음 것을 미리 받는 뒤)과 그 묶음 — 컷이 넘어갈 때 받느라 서지 않게(editVideoPair)
  const tlVideo = useVideoPair();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const barTimeRef = useRef<HTMLSpanElement>(null);
  // 뷰어 판들의 '지금 시각'·타임바 — 판이 그리기 함수를 걸어 두면 시계가 프레임마다 부른다(React 를 거치지 않는다).
  const painters = useRef(new Set<(time: number) => void>());
  const srcPainters = useRef(new Set<(time: number) => void>());

  const { projects, projectsState, tree, reload: reloadTree, reloadCounts, freshByProject } =
    useEditProjects({ authKey, workspace, projectId: openProject });
  // 워크스페이스를 못 정한 계정의 출구 — 공유 & 리뷰 탭의 '전체 보기'와 같다(이번 공간에서만, 저장하지 않는다).
  const workspaceKey = workspaceViewKey(workspace);
  const [allIn, setAllIn] = useState(() => allWorkspacesIn);
  const allWorkspaces = allIn === workspaceKey;
  const list = useEditGenerations({
    authKey, workspace, projectId: target?.projectId ?? null, seq: target?.seq ?? null, allWorkspaces,
  });
  const edit = useEditDoc(target ? editDocKey(target.projectId, target.seq) : null, flash);
  const { doc, applyEdit } = edit;
  const seq = target?.seq ?? "";

  // 타임라인의 컷은 '시퀀스가 있는 프로젝트'의 폴더에서 나온다 — 왼쪽에서 다른 프로젝트를 펼쳐 둘러봐도 유지한다.
  const [targetTree, setTargetTree] = useState<{ projectId: string; paths: string[] } | null>(null);
  useEffect(() => {
    if (tree.state === "ready" && openProject && openProject === target?.projectId) {
      setTargetTree({ projectId: openProject, paths: allFolderPaths(tree.roots) });
    }
  }, [tree, openProject, target?.projectId]);
  const treePaths = targetTree && targetTree.projectId === target?.projectId ? targetTree.paths : null;

  const byCut = useMemo(() => groupByCut(seq, list.gens), [seq, list.gens]);
  const cuts = useMemo(
    () => (seq ? cutPaths(seq, [...(treePaths ?? []), ...byCut.keys()], doc) : []),
    [seq, treePaths, byCut, doc],
  );
  const links = useMemo(() => {
    const map = new Map<string, ClipLink>();
    for (const clip of doc.clips) map.set(clipKey(clip), linkClip(clip, byCut.get(clip.cut), list.complete));
    return map;
  }, [doc, byCut, list.complete]);
  // 컷(폴더) 비활성(Jay 2026-10-08) — 기본값: 공유물도 넣은 것도 없는 빈 폴더, 그리고 다른 탭의 사이드바에서 비활성(d)으로 둔
  //  폴더. '비었다'는 공유 목록을 한 번이라도 끝까지 받은 뒤에만 믿는다(list.known — 받는 중에 전부 비활성으로 보이지 않게).
  //  여기서 켜고 끈 것은 이 편집 문서에만 적는다 — 다른 탭의 폴더 비활성(회색·생략)은 읽기만 하고 바꾸지 않는다.
  const disabledFolders = useDisabledFolders();
  const autoOff = useCallback((path: string) =>
    (!!target && isFolderDisabled(disabledFolders, target.projectId, path)) ||
    (list.known && !byCut.get(path)?.length && !doc.clips.some((clip) => clip.cut === path)),
  [target, disabledFolders, list.known, byCut, doc]);
  const offCuts = useMemo(
    () => new Set(cuts.filter((path) => cutIsOff(doc, path, autoOff(path)))),
    [cuts, doc, autoOff],
  );
  // 숨기기를 켜면 비활성 컷은 배치에 아예 없다 — 타임라인에도 재생에도 없다. 문서의 클립은 그대로 남는다.
  const shownCuts = useMemo(
    () => (doc.hideOff ? cuts.filter((path) => !offCuts.has(path)) : cuts),
    [cuts, doc.hideOff, offCuts],
  );
  const layout = useMemo(
    () => buildLayout(shownCuts, doc, (clip) => {
      const gen = links.get(clipKey(clip))?.gen; // 길이가 안 적힌 옛 클립만 여기로 온다
      return gen?.assets[0]?.type === "video" ? gen.params?.duration : undefined;
    }),
    [shownCuts, doc, links],
  );
  // 마크 인/아웃·북마크(Jay 2026-10-08) — 문서에는 (컷, 컷 안 시각)으로 적혀 있고, 여기서 지금 배치의 시각으로 바꾼다.
  //  숨긴 컷에 있거나 컷이 그 자리보다 짧아진 것은 빠진다(문서에는 남는다).
  const marks = useMemo(() => marksOf(layout, doc), [layout, doc]);
  const hasBand = !!marks.band;
  useEffect(() => {
    if (!hasBand) setRangeLoop(false); // 구간이 사라지면 구간 반복도 꺼진다(새로 찍은 구간이 말없이 돌지 않게)
  }, [hasBand]);
  const bookmarks = useMemo(() => shownMarkers(layout, doc), [layout, doc]);
  const flags = useMemo(() => bookmarks.map((item) => ({ time: item.time, color: item.marker.color })), [bookmarks]);
  const sourceOf = useCallback((clip: SlotClip): EditSource => {
    const link = links.get(clipKey(clip));
    const asset = link?.gen?.assets[0];
    return {
      state: link?.state ?? "unknown", url: asset?.file_path ?? null, type: asset?.type ?? clip.kind ?? null,
      thumb: link?.gen ? thumbOf(link.gen, 512) : null,
    };
  }, [links]);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const playingRef = useRef(false);
  const paint = useCallback((time: number) => {
    const x = time * zoomRef.current;
    if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
    const code = timecode(time);
    writeText(barTimeRef.current, code);
    painters.current.forEach((draw) => draw(time));
    const scroll = scrollRef.current; // 재생 중에는 재생헤드가 화면 밖으로 나가면 따라간다
    if (scroll && playingRef.current && (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40)) {
      scroll.scrollLeft = Math.max(0, x - 80);
    }
  }, []);
  const playback = useEditPlayback({
    scope: target ? `${target.projectId}\n${target.seq}` : "", layout, doc, sourceOf, videoRef: tlVideo.pair, paint, loop: ui.loop,
    range: rangeLoop ? marks.band : null, // 구간 반복 재생 — 반복(전체)과 따로 켠다
    speed: ui.speed,
    order: cuts, // 보던 컷이 빠졌을 때 '그다음 컷'을 내가 정한 순서에서 찾는다(숨긴 컷 포함)
  });
  const { view, now, seek, seekPos, stop, toggle, shuttle, playRange, playAround } = playback;
  playingRef.current = view.playing;
  useEffect(() => paint(now()), [zoom, paint, now]);
  const registerPaint = useCallback((draw: (time: number) => void) => {
    painters.current.add(draw);
    draw(now());
    return () => {
      painters.current.delete(draw);
    };
  }, [now]);

  // 편집 화면이 키를 받게 초점을 둔다 — 탭 단추나 검색칸에 초점이 남아 있으면 Space·J·K·L 이 그쪽으로 간다.
  //  (화면 안의 단추들은 mousedown 에서 초점을 가져가지 않으므로, 누른 뒤에도 키는 계속 편집 화면 것이다.)
  const grabFocus = useCallback(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, []);
  useEffect(grabFocus, [grabFocus]);

  // 폴더를 고른다 — 하위 폴더가 있으면 그 폴더가 시퀀스, 없으면(온전한 트리에서) 부모가 시퀀스고 그 컷으로 간다.
  const pendingCut = useRef<string | null>(null);
  const pickFolder = useCallback((path: string) => {
    if (!openProject) return;
    const node = findFolder(tree.roots, path);
    const parent = parentOf(path);
    const asCut = !node?.children?.length && tree.complete && !!parent;
    const next = { projectId: openProject, seq: asCut ? parent : path };
    pendingCut.current = asCut ? path : null;
    stop();
    setSelected(new Set());
    setTarget(next);
    saveEditTarget(next);
    if (asCut && target?.projectId === next.projectId && target.seq === next.seq) seekPos({ cut: path, local: 0 });
  }, [openProject, tree, target, stop, seekPos]);
  useEffect(() => {
    const cut = pendingCut.current;
    if (!cut || !layout.cuts.some((slot) => slot.path === cut)) return;
    pendingCut.current = null;
    seekPos({ cut, local: 0 });
  }, [layout, seekPos]);

  // 길이 — 목록을 끝까지 받았으면 길이가 안 적힌 클립을 채우고, 영상은 실측값이 오면 고쳐 적는다(Undo 단계 아님).
  const rev = edit.rev;
  useEffect(() => {
    if (!list.complete) return;
    const durs = new Map<string, number>();
    for (const clip of doc.clips) {
      if (clip.dur !== undefined) continue;
      const gen = links.get(clipKey(clip))?.gen;
      durs.set(clipKey(clip), gen ? genSeconds(gen, knownVideoSeconds(gen.assets[0]?.file_path)) : DEFAULT_SEC);
    }
    if (durs.size) applyEdit((current) => setClipDurs(current, durs), { undo: false, rev });
  }, [list.complete, doc, links, applyEdit, rev]);
  //  · 영상 클립은 페이지를 열 때마다 다시 잰다(같은 페이지에서는 lib/videoDuration 이 기억한 값이 바로 온다). 적힌 길이만 보고
  //    '이미 쟀다'고 건너뛰지 않는다 — dur 에는 요청 길이와 실측값이 구분 없이 적히고, 요청 길이(params.duration)는 동기화로 바뀔 수
  //    있어 '지금의 요청 길이와 다르다'가 쟀다는 증거가 아니다. 건너뛰면 옛 요청 길이가 실측값인 양 굳는다(Codex 코드 리뷰 4회째 —
  //    10-13 에 그렇게 넣었다가 뺐다). 건너뛰려면 문서에 '쟀다'는 표시가 있어야 한다.
  //  · 잰 값은 첫 값이 온 뒤 MEASURE_SAVE_MS 동안 모아 한 번에 적는다 — 클립마다 적으면 영상 N개에 저장·다시 그리기가 N번이다.
  //    모으는 중에 문서가 바뀌거나 탭을 떠나면 그 자리에서 적는다. 시퀀스를 바꾸면 버려진다(rev 가 다르다) — 돌아오면 다시 잰다.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const frame = 1 / EDIT_FPS;
    const measured = new Map<string, number>();
    const save = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (measured.size) applyEdit((current) => setClipDurs(current, measured), { undo: false, rev });
      measured.clear();
    };
    for (const clip of doc.clips) {
      const asset = links.get(clipKey(clip))?.gen?.assets[0];
      if (asset?.type !== "video" || !asset.file_path) continue;
      const key = clipKey(clip);
      void measureVideoSeconds(asset.file_path).then((seconds) => {
        if (!alive || !seconds || Math.abs(seconds - (clip.dur ?? 0)) < frame) return;
        measured.set(key, seconds);
        timer ||= window.setTimeout(save, MEASURE_SAVE_MS);
      });
    }
    return () => {
      alive = false;
      save();
    };
  }, [doc, links, applyEdit, rev]);

  // 시퀀스를 바꾸거나 떠나면 줄 서 있던 길이 재기는 버린다(새 시퀀스의 것이 그 뒤로 밀리지 않게).
  useEffect(() => dropQueuedVideoMeasures, [target?.projectId, target?.seq]);

  // 고른 클립 중 타임라인에서 사라진 것은 고르기에서도 뺀다 — 문서에서 빠졌거나(되돌리기·다른 창의 변경) 그 컷이 숨겨졌다.
  //  안 빼면 D·Delete 가 보이지 않는 클립을 바꾼다(Codex 코드 리뷰).
  const shownKeys = useMemo(
    () => new Set(layout.cuts.flatMap((slot) => slot.clips.map(clipKey))),
    [layout],
  );
  useEffect(() => {
    setSelected((prev) => {
      const keep = [...prev].filter((key) => shownKeys.has(key));
      return keep.length === prev.size ? prev : new Set(keep);
    });
  }, [shownKeys]);

  const revNow = useRef(rev);
  revNow.current = rev;
  const act = useCallback((change: (current: EditDoc) => EditDoc | null, options?: { rev?: number }) => {
    // 끌기·메뉴를 시작한 뒤 문서가 갈렸다(rev 가 낡았다) — 그 조작은 말없이 버린다. '잠긴 트랙…' 안내는 틀린 말이다(Codex 3회째 P3).
    if (options?.rev !== undefined && options.rev !== revNow.current) return;
    // 'stopped'(다른 창의 저장 때문에 버림)에는 그 알림이 이미 떴다 — 덮지 않는다
    if (applyEdit(change, options) === "none") flash(t("바꾸지 못했습니다 — 잠긴 트랙이 있거나 옮길 자리가 없습니다."));
  }, [applyEdit, flash, t]);

  const cut = view.cut;
  // 이 컷의 공유 생성물과 넣은 트랙. '지금 보이는 것' 표는 따로 붙인다 — 그 표는 재생헤드가 클립을 넘을 때마다 바뀌는데,
  //  소스 테이프(아래)가 그때마다 다시 지어지면 안 된다(Codex 설계 검토).
  const cutItems = useMemo<PoolItem[]>(() => {
    if (!cut) return [];
    const placed = doc.clips.filter((clip) => clip.cut === cut);
    return (byCut.get(cut) ?? []).map((gen) => ({
      gen, track: placed.find((item) => links.get(clipKey(item))?.gen?.id === gen.id)?.track ?? null, showing: false,
    }));
  }, [cut, byCut, doc, links]);
  const showingTrack = view.clip?.track ?? null; // (컷, 트랙)에 클립은 하나뿐이다
  const poolItems = useMemo<PoolItem[]>(
    () => cutItems.map((item) => (item.track !== null && item.track === showingTrack ? { ...item, showing: true } : item)),
    [cutItems, showingTrack],
  );
  // 고른 생성물은 컷을 옮겨도 소스 뷰어에 남는다(이 시퀀스의 공유 목록에 있는 동안).
  const pickedId = pickedIds[pickedIds.length - 1] ?? null;
  const pickedGen = useMemo(() => (pickedId ? list.gens.find((gen) => gen.id === pickedId) ?? null : null), [pickedId, list.gens]);
  // ── 소스(Jay 2026-10-08) ── 소스 판은 두 방식이다(다빈치 컷 페이지의 Source Clip · Source Tape):
  //   · 소스 클립("source") — 풀에서 고른 생성물 하나.
  //   · 소스 테이프("tape") — 재생헤드가 있는 컷의 풀 목록 전체를 풀의 정렬 순서대로 이어 붙인 것(검색어는 따지지 않는다).
  //  둘 다 생성물마다 컷 하나·클립 하나짜리 가상 시퀀스를 같은 엔진으로 튼다 — 조작·훑기·반복이 타임라인과 같다. 엔진이
  //  하나라 두 방식을 두 판에 같이 띄울 수는 없다(setMode). 편집 문서에는 아무것도 쓰지 않는다.
  // 다이나믹 트림 모드(아래 tlToggle) — 켜져 있는 동안 뷰어 자리는 타임라인 판 하나다: 나뉘어 있던 판들이 한 창이 된다.
  //  화면 설정(views·dual)은 건드리지 않으므로 끄면 보던 대로 돌아온다. 저장하지 않는다.
  const [trim, setTrim] = useState(false);
  const slots: ViewMode[] = trim ? ["timeline"] : ui.dual ? ui.views : [ui.views[1]]; // 보이는 판들(왼쪽부터)
  const srcOrder = slots.findIndex(isSourceView);
  const srcShown = srcOrder >= 0;
  const tapeOn = slots[srcOrder] === "tape";
  const srcVideo = useVideoPair(); // 소스 테이프도 클립에서 클립으로 넘어간다
  // 소스 판이 안 보이면 소스는 비워 둔다 — 싱글 뷰어(기본)에서 풀의 영상 카드를 누를 때마다 안 보이는 판이 그 영상을 끝까지
  //  받았다(2026-10-13 격리 실측). 판을 올리면 그때 고른 것을 올린다. 보던 자리는 판을 내릴 때 엔진이 기억해 둔다(아래 scope).
  const srcGens = useMemo<Generation[]>(
    () => (!srcShown ? NO_GENS : tapeOn ? arrangePool(cutItems, "", ui.sort).map((item) => item.gen) : pickedGen ? [pickedGen] : NO_GENS),
    [srcShown, tapeOn, cutItems, ui.sort, pickedGen],
  );
  // 길이 — 실측값이 오면 고친다(타임라인에 안 넣은 영상은 적어 둔 길이가 없다 — 안 고치면 기본 5초에서 끝난다).
  //  하나씩 차례로 잰다: 길이 재기의 큐는 앱 전체가 같이 쓰고 동시에 4개라, 테이프의 영상을 한꺼번에 줄 세우면 타임라인
  //  클립이나 방금 고른 소스의 길이 재기가 그 뒤로 밀린다. 목록·방식이 바뀌거나 떠나면 더 신청하지 않는다(Codex 설계 검토).
  // ponytail: 영상이 아주 많은 컷은 끝까지 재는 데 오래 걸린다 — 안 잰 것은 그동안 적힌 길이·기본 5초로 지나간다.
  const [srcSeconds, setSrcSeconds] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const gen of srcGens) {
        const asset = gen.assets[0];
        if (asset?.type !== "video" || !asset.file_path || knownVideoSeconds(asset.file_path)) continue;
        const url = asset.file_path;
        const seconds = await measureVideoSeconds(url);
        if (!alive) return;
        if (seconds) setSrcSeconds((prev) => new Map(prev).set(url, seconds));
      }
    })();
    return () => {
      alive = false;
    };
  }, [srcGens]);
  const src = useMemo(() => {
    if (!srcGens.length) return NO_SOURCE;
    const made: EditDoc = {
      ...emptyEditDoc(),
      clips: srcGens.map((gen) => {
        const asset = gen.assets[0];
        const seconds = srcSeconds.get(asset.file_path) ?? knownVideoSeconds(asset.file_path);
        return { cut: `${SRC_CUT}/${gen.id}`, gen: gen.id, track: 1, kind: asset.type, dur: genSeconds(gen, seconds) };
      }),
    };
    return {
      doc: made, layout: buildLayout(made.clips.map((clip) => clip.cut), made),
      byId: new Map(srcGens.map((gen) => [gen.id, gen])),
    };
  }, [srcGens, srcSeconds]);
  const srcSourceOf = useCallback((clip: SlotClip): EditSource => {
    const gen = src.byId.get(clip.gen);
    const asset = gen?.assets[0];
    return { state: "ok", url: asset?.file_path ?? null, type: asset?.type ?? null, thumb: gen ? thumbOf(gen, 512) : null };
  }, [src]);
  const paintSrc = useCallback((time: number) => srcPainters.current.forEach((draw) => draw(time)), []);
  const srcPlay = useEditPlayback({
    // 판이 안 보이는 동안은 다른 범위다 — 범위가 바뀔 때 엔진이 보던 자리를 적어 두고, 판을 다시 올리면 그 자리로 돌아온다
    scope: !srcShown ? "src-off" : tapeOn ? `tape\n${target?.projectId ?? ""}\n${cut ?? ""}` : pickedGen ? `src\n${pickedGen.id}` : "src",
    layout: src.layout, doc: src.doc, sourceOf: srcSourceOf, videoRef: srcVideo.pair, paint: paintSrc, loop: ui.loopSrc,
    speed: ui.speed,
  });
  const srcNow = srcPlay.now;
  const registerSrcPaint = useCallback((draw: (time: number) => void) => {
    srcPainters.current.add(draw);
    draw(srcNow());
    return () => {
      srcPainters.current.delete(draw);
    };
  }, [srcNow]);

  // ── 뷰어 판(Jay 2026-10-08) ── 판마다 무엇을 볼지 고른다: 타임라인 · 소스 · 한 트랙만. 두 판은 늘 서로 다른 것을 본다
  //  (같은 것을 고르면 서로 자리를 바꾼다 — 같은 것을 두 판에 띄우는 경우를 만들지 않는다).
  //  시계는 둘뿐이다: 타임라인(위의 playback — 판이 무엇을 보든 언제나 '위 트랙 우선'을 튼다)과 소스(srcPlay). 한 트랙만
  //  보는 판은 타임라인의 시계를 따라가는 보기다(EditSoloViewer). 그래서 재생헤드·편집점·풀의 '지금 보이는 것' 표는 판이
  //  무엇을 보든 달라지지 않는다(Codex 설계 검토 — 엔진에 트랙만 거른 배치를 주면 다른 판과 아래 타임라인의 편집점이 바뀐다).
  const tlOrder = slots.indexOf("timeline");
  const tlShown = tlOrder >= 0;
  const setMode = (order: number, next: ViewMode) => {
    const views: [ViewMode, ViewMode] = [ui.views[0], ui.views[1]];
    const slot = ui.dual ? order : 1;
    // 옆 판이 같은 것을 보고 있으면 자리를 바꾼다. 소스 클립·소스 테이프는 같은 판(소스 엔진 하나)의 두 방식이라 같은 것으로 친다
    if (views[1 - slot] === next || (isSourceView(views[1 - slot]) && isSourceView(next))) views[1 - slot] = views[slot];
    views[slot] = next;
    patchUi({ views });
    setKeyTarget(isSourceView(next) ? "source" : "timeline"); // 방금 고른 것이 재생 키를 받는다
  };
  // 재생 키(Space·J·K·L·←→·↑↓·Home·End)는 마지막에 누른 판의 시계로 간다(다빈치). 편집 키는 언제나 타임라인 것이다.
  //  보이는 판이 한 종류뿐이면 그 시계로 간다 — 소스만 보이는데(싱글·소스, 저장된 화면으로 다시 들어온 때 포함) 재생 키가
  //  안 보이는 타임라인을 틀지 않게(Codex 코드 리뷰). 두 종류가 같이 보일 때만 '마지막에 누른 쪽'을 따른다.
  const [keyTarget, setKeyTarget] = useState<"timeline" | "source">("timeline");
  const clockShown = slots.some((mode) => !isSourceView(mode)); // 타임라인의 시계를 쓰는 판(타임라인·한 트랙만)이 보인다
  const onSource = srcShown && (!clockShown || keyTarget === "source");
  // 다이나믹 트림 모드(Jay 2026-10-08 — 다빈치의 Dynamic Trim Mode(W), 보기만) — 막대의 단추·W 로 켜면 나뉘어 있던 뷰어가 한
  //  창이 되고(위의 slots), 그 창에 가장 가까운 편집점의 앞 컷 | 뒤 컷이 나란히 뜬다(EditTrimView). 재생은 한 번이다 — 재생헤드가
  //  있는 쪽 칸에서 화면이 간다. 재생(Space·재생 단추)은 보는 편집점의 앞 2초에서 뒤 2초까지를 튼다: 반복이 꺼져 있으면 한 번
  //  틀고 그 편집점으로 돌아와 멈추고, 켜져 있으면 되풀이한다. ↑·↓ 는 재생헤드가 아니라 **보는 편집점**에서 앞·뒤로 간다
  //  (재생헤드가 편집점 사이에 있으면 둘이 다르다 — 안 그러면 ↓ 를 눌러도 화면이 그대로다, Codex 설계 검토). J·K·L·프레임
  //  이동·훑기는 그대로다. 트림(클립 길이 바꾸기)은 없다.
  const focusPoint = () => nearestPoint(editPoints(layout), now());
  const tlToggle = () => {
    if (!trim) return toggle();
    if (view.playing) return stop();
    const at = posAt(layout, focusPoint());
    if (at) playAround(at, AROUND_SEC, !ui.loop);
  };
  const tlStepEdit = (dir: 1 | -1) =>
    (trim ? seek(stepPoint(editPoints(layout), focusPoint(), dir)) : playback.stepEdit(dir));
  const toggleTrim = () => {
    setTrim(!trim);
    setKeyTarget("timeline"); // 그 창은 타임라인의 시계다
  };
  const keys = onSource ? srcPlay : { ...playback, toggle: tlToggle, stepEdit: tlStepEdit };
  // 타임라인과 소스는 같이 틀지 않는다 — 한쪽을 틀면 다른 쪽은 멈춘다(소리가 겹치지 않고, K 가 멈출 것이 하나다).
  //  소스 판을 내리면 소스도 멈춘다. 타임라인 판이 없으면 타임라인의 영상은 소리를 끈다(아래 muted).
  const stopSrc = srcPlay.stop;
  const srcPlaying = srcPlay.view.playing;
  useEffect(() => {
    if (view.playing || !srcShown) stopSrc();
  }, [view.playing, srcShown, stopSrc]);
  useEffect(() => {
    if (srcPlaying) stop();
  }, [srcPlaying, stop]);
  const tlControls: ViewerControls = { toggle: tlToggle, stop, shuttle, seek };
  const { toggle: srcToggle, shuttle: srcShuttle, seek: srcSeek, seekPos: srcSeekPos } = srcPlay;
  const srcControls = useMemo<ViewerControls>(
    () => ({ toggle: srcToggle, stop: stopSrc, shuttle: srcShuttle, seek: srcSeek }), [srcToggle, stopSrc, srcShuttle, srcSeek]);
  const viewOptions = useMemo<ViewOption[]>(() => [
    { value: "timeline", label: t("타임라인"), hint: t("위 트랙이 보인다") },
    { value: "source", label: t("소스 클립"), hint: t("풀에서 고른 것") },
    { value: "tape", label: t("소스 테이프"), hint: t("이 컷의 생성물을 이어서") },
    ...Array.from({ length: layout.tracks }, (_, i) => layout.tracks - i)
      .map((track) => ({ value: track, label: t("V{track} 만 보기").replace("{track}", String(track)) })),
  ], [layout.tracks, t]);
  // 소스 테이프의 클립 경계(재생바의 얇은 줄)와, 지금 소스 판에 보이는 생성물
  const srcStarts = useMemo(() => (tapeOn ? src.layout.cuts.slice(1).map((item) => item.start) : NO_MARKS), [tapeOn, src]);
  const srcGen = src.byId.get(srcPlay.view.clip?.gen ?? "") ?? (tapeOn ? null : pickedGen);
  // 풀의 카드를 고른다 — 소스 테이프를 보고 있으면 테이프가 그 카드의 처음으로 간다(다빈치).
  const pickInPool = (gen: Generation, additive: boolean) => {
    pickGen(gen, additive);
    if (tapeOn && src.byId.has(gen.id)) srcSeekPos({ cut: `${SRC_CUT}/${gen.id}`, local: 0 });
  };

  // 크게 보기·비교·폴더 창으로 넘길 때는 두 시계를 다 멈춘다 — 그 창이 떠 있는 동안 편집 키는 막혀 있어(backgroundKeysBlocked)
  //  뒤에서 도는 재생을 멈출 길이 없고, 크게 보기의 소리와 겹친다(Codex 배포 전 검토 2026-10-13).
  const stopBoth = useCallback(() => {
    stop();
    stopSrc();
  }, [stop, stopSrc]);
  // 더블클릭 = 크게 보기(재생) — 앱의 크게 보기 창. 앞뒤 넘기기는 풀에 지금 보이는 순서, '마지막으로 본'은 공유 & 리뷰 칸에 남는다.
  const openGen = useCallback((gen: Generation, shown: Generation[]) => {
    const target = previewTargetFromGenerations(shown, gen, 512);
    if (!target) return;
    stopBoth();
    onPreview({ ...target, sceneId: TEAM_SCOPE });
  }, [onPreview, stopBoth]);
  const openCompare = useCallback((gens: Generation[]) => {
    stopBoth();
    onCompare(gens);
  }, [onCompare, stopBoth]);
  // 카드의 트랙 메뉴(Jay 2026-10-08 — 10-13 부터 우클릭이 아니라 **휠 클릭**: 풀 카드의 우클릭은 폴더 창을 연다) — 미디어 풀의
  //  카드, 폴더 창의 카드를 휠 클릭하면 지금 있는 트랙을 보여 주고, 고르면 그 트랙에 넣는다(찬 트랙은 교체). 넣을 컷은 여는 순간에 정한다(풀 = 재생헤드가 있는 컷, 창 = 그 창의 컷). 편집 탭의 그 컷
  //  공유 목록에 있는 카드만 받는다 — 창에서 W 를 '전체'로 바꿔 보이는 다른 공간의 카드 등은 넣어도 '미디어 없음'으로 본다.
  //  그 카드가 그 컷의 '확인 못 한' 클립과 같은 것일 수 있으면 넣지 않는다: job 으로 이은 클립은 공유 목록을 끝까지 받기
  //  전에는 어느 카드인지 모른다 — 그때 넣으면 같은 생성물이 두 트랙에 들어가거나, 교체하면서 그 클립의 꺼짐이 사라진다.
  //  그 카드만 막는다: 컷 전체를 막으면 목록이 2,000건에서 잘린 시퀀스에서는 영영 풀리지 않는다(Codex 코드 리뷰).
  const maybePlaced = useCallback((path: string, gen: Generation) =>
    doc.clips.some((clip) => clip.cut === path && !!clip.job && clip.job === gen.job_id &&
      links.get(clipKey(clip))?.state === "unknown"), [doc, links]);
  const [menu, setMenu] = useState<{ gen: Generation; cut: string; x: number; y: number } | null>(null);
  const menuBackRef = useRef<HTMLElement | null>(null); // 메뉴가 닫히면 초점을 돌려줄 곳(메뉴가 초점을 가져간다)
  const openMenu = useCallback((card: Pick<Generation, "id">, menuCut: string | null, x: number, y: number) => {
    const gen = menuCut ? byCut.get(menuCut)?.find((item) => item.id === card.id) : undefined;
    if (!gen || !menuCut) return flash(t("이 카드는 넣을 수 없습니다 — 편집 탭의 이 컷 공유 목록에 없습니다."));
    if (maybePlaced(menuCut, gen)) return flash(t("이 카드는 이미 넣은 클립일 수 있습니다 — 공유 목록을 다 받은 뒤에 다시 해 주세요."));
    menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ gen, cut: menuCut, x, y });
  }, [byCut, maybePlaced, flash, t]);
  // 트랙 머리 우클릭 메뉴·북마크 편집 창 — 여는 순간의 rev 를 잡아 둔다. 떠 있는 사이 다른 창이 이 편집을 바꾸면(rev 가
  //  갈린다) 닫고, 그 뒤에 고른 것은 저장하지 않는다(옛 화면을 보고 고른 것이 새 문서를 덮지 않게 — Codex 설계 검토).
  const [trackMenu, setTrackMenu] = useState<{ track: number; x: number; y: number; rev: number } | null>(null);
  const [markerMenu, setMarkerMenu] = useState<{ key: string; x: number; y: number; rev: number } | null>(null);
  const [colorMenu, setColorMenu] = useState<{ x: number; top: number; bottom: number; rev: number } | null>(null); // 막대의 북마크 단추 옆 ▾
  const [listMenu, setListMenu] = useState<{ x: number; top: number; bottom: number } | null>(null); // 막대의 목록 단추
  // 그 두 단추 — 메뉴가 뜬 채 다시 누르면 닫는다. 메뉴는 자기를 연 단추의 누름을 바깥 누름으로 치지 않는다(EditMenu 의 trigger):
  //  치면 누르는 순간 닫히고 뒤따르는 click 이 다시 열어, 다시 눌러도 닫히지 않았다(2026-10-11 조작 점검 R45).
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  // 클립 우클릭 메뉴(Jay 2026-10-08) — Resolve 보내기. 고른 클립 위에서 누르면 고른 것 모두, 아니면 그 클립 하나(고른 것은
  //  그대로 둔다). 문서가 바뀌면 닫는다 — 그 클립이 이미 없을 수 있다.
  const [clipMenu, setClipMenu] = useState<{ keys: string[]; x: number; y: number } | null>(null);
  const openClipMenu = useCallback((key: string, x: number, y: number) => {
    menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setClipMenu({ keys: selected.has(key) ? [...selected] : [key], x, y });
  }, [selected]);
  // 클립 길이 조절 창(Jay 2026-10-13) — 타임라인의 클립을 휠 클릭. 영상만이고 잠긴 트랙은 안 된다(setClipTrim 의 거부와 같다 — 창을
  //  띄우기 전에 까닭을 알린다). group = 이 창을 한 번 연 동안의 걸음들을 되돌리기 한 단계로 묶는 이름(useEditDoc).
  //  **떠 있는 창이다**(같은 날 밤 Jay: "플로팅창으로") — 메뉴가 아니라서 다른 메뉴를 여닫아도(closeMenu) 떠 있고, 떠 있는 동안 타임라인을
  //  그대로 쓴다. 떠 있는 채 다른 클립을 휠 클릭하면 창이 그 클립으로 바뀐다(새 group). 닫는 것: ✕ · 창 안의 Esc · 아래의 셋.
  //  문서가 갈리면(rev) 닫는다 — 아래 효과. **저장 충돌을 알게 됐을 때도 닫는다**(edit.conflict): 슬라이더를 끄는 도중이면 같은 끌기의
  //  다음 걸음이 '알고 이어 가는 편집'으로 저장돼, 알림을 읽기도 전에 다른 창의 저장을 덮는다(Codex 코드 리뷰 2회째 P1).
  const [trimPop, setTrimPop] = useState<{ key: string; group: string; rev: number } | null>(null);
  const trimSerial = useRef(0);
  const openTrim = useCallback((key: string) => {
    const clip = doc.clips.find((item) => clipKey(item) === key);
    if (!clip) return;
    if (doc.tracksLocked.includes(clip.track)) return flash(t("잠긴 트랙의 클립은 길이를 바꿀 수 없습니다."));
    // 그림인지는 이어진 생성물로 먼저 본다 — kind 가 안 적힌 옛 클립은 문서만으로는 영상으로 보인다
    if ((links.get(key)?.gen?.assets[0]?.type ?? clip.kind) === "image") return flash(t("그림은 길이를 줄일 수 없습니다 — 영상 클립만 됩니다."));
    stopBoth(); // 창을 열면 초점(키)이 창으로 간다 — Space 는 창 안의 재생이 되므로 뒤에서 도는 재생은 멈춰 둔다
    setTrimPop({ key, group: `trim:${key}:${++trimSerial.current}`, rev });
  }, [doc, links, flash, t, stopBoth, rev]);
  const editConflict = edit.conflict;
  useEffect(() => {
    if (editConflict) setTrimPop(null);
  }, [editConflict]);
  const openTrackMenu = useCallback((track: number, x: number, y: number) => {
    menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTrackMenu({ track, x, y, rev });
  }, [rev]);
  const openMarkerMenu = useCallback((key: string, x: number, y: number) => {
    menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMarkerMenu({ key, x, y, rev });
  }, [rev]);
  useEffect(() => {
    setTrackMenu(null);
    setMarkerMenu(null);
    setColorMenu(null);
    setListMenu(null);
    setClipMenu(null);
    setTrimPop(null);
  }, [rev]);
  const closeMenu = useCallback(() => {
    setMenu(null);
    setTrackMenu(null);
    setMarkerMenu(null);
    setColorMenu(null);
    setListMenu(null);
    setClipMenu(null);
    const back = menuBackRef.current;
    menuBackRef.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);
  // 길이 조절 창을 닫는다 — 초점을 편집 화면으로 돌려 키가 바로 타임라인의 것이 되게 한다(창은 body 에 그려져 있어, 그대로 두면
  //  초점이 body 로 떨어진다).
  const closeTrim = useCallback(() => {
    setTrimPop(null);
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  // 그 두 단추를 왼쪽이 아닌 단추(오른쪽·가운데)로 누른 것은 여닫기가 아니다(click 이 오지 않는다). 메뉴가 그 단추의 누름을
  //  바깥 누름에서 뺐으므로 여기서 닫는다 — 안 닫으면 그 누름에만 메뉴가 남는다(전에는 어느 단추로 눌러도 닫혔다).
  const closeOnAuxPress = (event: { button: number }) => {
    if (event.button !== 0) closeMenu();
  };
  useEffect(() => setMenu(null), [peekPath, cut, target?.projectId, target?.seq]); // 보던 컷·창이 바뀌면 닫는다
  useEffect(() => {
    cardMenuRef.current = (card, x, y) => openMenu(card, peekPath, x, y);
    return () => {
      cardMenuRef.current = null;
    };
  }, [cardMenuRef, openMenu, peekPath]);
  // 보낼 것 — 공유 목록에서 찾은 생성물만(같은 생성물이 두 컷에 있으면 한 번)
  const clipMenuGens = useMemo(() => {
    const found = new Map<string, Generation>();
    for (const key of clipMenu?.keys ?? []) {
      const gen = links.get(key)?.gen;
      if (gen) found.set(gen.id, gen);
    }
    return [...found.values()];
  }, [clipMenu, links]);
  const clipMenuOne = clipMenu?.keys.length === 1 ? doc.clips.find((clip) => clipKey(clip) === clipMenu.keys[0]) : undefined;
  // 길이 조절 창이 보는 클립 — 지금 배치의 것(쓰는 길이·원본 길이가 걸음마다 새로 온다). 작은 화면은 틀 수 있는 영상일 때만.
  const trimClip = trimPop ? layout.cuts.flatMap((slot) => slot.clips).find((clip) => clipKey(clip) === trimPop.key) : undefined;
  const trimSource = trimClip ? sourceOf(trimClip) : null;
  const trimSrc = trimSource?.state === "ok" && trimSource.type === "video" ? trimSource.url : null;
  // 떠 있는 동안 그 클립이 타임라인에서 빠졌거나(지움·숨긴 컷) 그 트랙이 잠기면 창을 닫는다 — 조절할 것이 없다
  const trimGone = !!trimPop && (!trimClip || doc.tracksLocked.includes(trimClip.track));
  useEffect(() => {
    if (trimGone) setTrimPop(null);
  }, [trimGone]);
  const menuOwn = menu && doc.clips.find((clip) => clip.cut === menu.cut && links.get(clipKey(clip))?.gen?.id === menu.gen.id);
  const menuRows: TrackRow[] = !menu ? [] : Array.from({ length: layout.tracks }, (_, i) => layout.tracks - i).map((track) => ({
    track,
    state: placeState(doc, menu.cut, menuOwn, track),
  }));
  // 카드를 그 컷의 그 트랙에 넣는다 — 휠 클릭 메뉴와 끌어 놓기가 같이 쓰는 한 길이다(같은 문지기).
  //  카드는 **지금의 공유 목록**에서 다시 찾는다 — 메뉴가 떠 있거나 끄는 사이 그 카드가 목록에서 빠졌으면(다른 창의 공유 해제 →
  //  다시 받기) 연 순간의 사본으로 넣지 않는다: 잘 있던 클립이 '미디어 없음' 클립으로 갈린다.
  const ownClip = (cutPath: string, genId: string) =>
    doc.clips.find((clip) => clip.cut === cutPath && links.get(clipKey(clip))?.gen?.id === genId);
  const placeCard = (genId: string, cutPath: string, track: number, options?: { rev?: number }) => {
    const gen = byCut.get(cutPath)?.find((item) => item.id === genId);
    if (!gen) return flash(t("이 카드는 넣을 수 없습니다 — 편집 탭의 이 컷 공유 목록에 없습니다."));
    const asset = gen.assets[0];
    if (maybePlaced(cutPath, gen)) return flash(t("이 카드는 이미 넣은 클립일 수 있습니다 — 공유 목록을 다 받은 뒤에 다시 해 주세요.")); // 그사이 다시 받기가 시작됐다
    const own = ownClip(cutPath, genId);
    act((current) => placeClip(current, {
      // job 으로 다시 이은 클립이면 그 클립을 옮긴다(문서에 적힌 옛 id 로 찾는다)
      cut: cutPath, gen: own?.gen ?? gen.id, job: gen.job_id, kind: asset.type,
      dur: genSeconds(gen, knownVideoSeconds(asset.file_path)),
    }, track), options);
  };
  const placeTo = (track: number) => {
    if (!menu) return;
    closeMenu();
    placeCard(menu.gen.id, menu.cut, track);
  };

  // 풀의 카드를 끌어 타임라인에 넣기(Jay 2026-10-13) — 몸짓은 풀(EditPool)이 알리고, 여기서 무엇이 어디에 놓이는지를 정한다.
  //  · 끌기가 시작되는 순간 {컷, 카드 id, 문서의 rev}를 잡아 두고 재생을 멈춘다. 끄는 동안 재생·편집 키는 쉰다(Esc 겹) — Esc = 버림.
  //  · 넣을 컷은 **그때의 컷**이다(풀은 재생헤드가 있는 컷을 보여 주므로, 놓는 순간의 컷으로 보면 다른 컷일 수 있다).
  //  · 그사이 문서가 갈리거나(rev) 풀의 컷이 바뀌거나 그 카드가 목록에서 사라지면 끌기를 버린다.
  //  · 놓을 곳 = 포인터 바로 밑에 실제로 보이는 영상 줄(data-track)뿐 — 소리 줄·눈금자·컷 머리·창에 덮인 곳·화면 밖은 아니다.
  //    가로 위치는 보지 않는다(그 카드의 컷 칸에 들어간다). 이미 그 트랙에 있거나 잠겼으면 아무 일도 없다(메뉴의 흐린 줄과 같다).
  type CardDrag = { id: string; cut: string; rev: number; hint: Omit<DropHint, "cut"> | null };
  const [cardDrag, setCardDragState] = useState<CardDrag | null>(null);
  const cardDragLive = useRef(cardDrag);
  cardDragLive.current = cardDrag;
  // 풀은 start 에 이어 같은 이벤트 안에서 move 를 부른다 — 다음 렌더를 기다리지 않게 ref 를 같이 고친다
  const setCardDrag = (next: CardDrag | null) => {
    cardDragLive.current = next;
    setCardDragState(next);
  };
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostAt = useRef<[number, number]>([0, 0]);
  const moveGhost = () => {
    const [x, y] = ghostAt.current;
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };
  const hintAt = (drag: { id: string; cut: string }, x: number, y: number): Omit<DropHint, "cut"> | null => {
    const lane = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ed-lanes [data-track]");
    const track = Number(lane?.dataset.track);
    return track > 0 ? { track, state: placeState(doc, drag.cut, ownClip(drag.cut, drag.id), track) } : null;
  };
  const onCardDrag = (phase: "start" | "move" | "drop" | "cancel", id: string, x: number, y: number) => {
    ghostAt.current = [x, y];
    if (phase === "start") {
      if (!cut || !byCut.get(cut)?.some((item) => item.id === id)) return;
      stopBoth();
      setCardDrag({ id, cut, rev, hint: null });
      return;
    }
    const drag = cardDragLive.current;
    if (!drag || drag.id !== id) return; // 버린 끌기에 딸려 온 것(Esc 로 버린 뒤의 움직임·놓기)
    if (phase === "cancel") return setCardDrag(null);
    const hint = hintAt(drag, x, y);
    if (phase === "move") {
      moveGhost();
      if (hint?.track !== drag.hint?.track || hint?.state !== drag.hint?.state) setCardDrag({ ...drag, hint });
      return;
    }
    setCardDrag(null);
    if (hint && hint.state !== "here" && hint.state !== "locked") placeCard(drag.id, drag.cut, hint.track, { rev: drag.rev });
  };
  const cardDragging = !!cardDrag;
  useEscapeClose(() => setCardDrag(null), cardDragging, true, true);
  useDragKeyHold(cardDragging); // 초점이 남은 뒤의 단추(재생·트랙 눈)를 Space·Enter 가 누르지 않게
  const cardDragGone = !!cardDrag && (cardDrag.rev !== rev || cardDrag.cut !== cut || !byCut.get(cardDrag.cut)?.some((item) => item.id === cardDrag.id));
  useEffect(() => {
    if (cardDragGone) setCardDrag(null);
  }, [cardDragGone]);
  const cardDragGen = cardDrag ? byCut.get(cardDrag.cut)?.find((item) => item.id === cardDrag.id) ?? null : null;
  const dropHint = useMemo<DropHint | null>(
    () => (cardDrag?.hint ? { cut: cardDrag.cut, track: cardDrag.hint.track, state: cardDrag.hint.state } : null),
    [cardDrag],
  );

  // 컷(폴더) 순서(Jay 2026-10-13) — 타임라인의 컷 머리 칸을 끌어 바꾼다(EditTimeline). before = 놓은 자리의 바로 뒤에 **보이는** 컷
  //  (없으면 맨 뒤). 전체 순서(cuts — 숨긴 컷 포함)에서 그 컷 앞에 끼우므로 숨긴 컷은 제자리에 남는다. 되돌리기 한 단계.
  const moveCutTo = useCallback((path: string, before: string | null, startedRev: number) => {
    act((current) => moveCut(current, cuts, path, before), { rev: startedRev });
  }, [act, cuts]);

  const lockedTrack = (track: number) => doc.tracksLocked.includes(track);
  const trackAct = (action: TrackAct) => {
    if (!trackMenu) return;
    const { track, rev: opened } = trackMenu;
    closeMenu();
    if (typeof action === "object") {
      applyEdit((current) => setTrackColor(current, track, action.color), { rev: opened });
      return;
    }
    // 트랙을 지우면 그 트랙의 클립도 빠진다 — 되돌리기(Ctrl+Z)로 살린다
    act((current) => (action === "add" ? addTrack(current, track) : action === "up" ? moveTrack(current, track, 1)
      : action === "down" ? moveTrack(current, track, -1) : action === "delete" ? deleteTrack(current, track)
        : deleteEmptyTracks(current)), { rev: opened });
  };
  // 북마크 편집 창이 보는 북마크 — 원래 열쇠로 찾는다. 사라졌으면(지움·되돌리기·컷 숨김) 창도 닫는다.
  const editing = markerMenu ? bookmarks.find((item) => item.key === markerMenu.key) ?? null : null;
  useEffect(() => {
    if (markerMenu && !editing) setMarkerMenu(null);
  }, [markerMenu, editing]);

  // 그림(클립)을 누르면 그 컷으로 간다 — 이미 그 컷이면 보던 자리 그대로.
  const pickCut = useCallback((path: string) => {
    if (view.cut !== path) seekPos({ cut: path, local: 0 });
  }, [view.cut, seekPos]);
  // 그 컷에 넣은 카드의 표("V1 - 선택 카드") — 지금 뷰어에 보이는 것(lead)만 라임이고, 창이 열릴 때 그 카드로 내려간다.
  const cutMarks = useCallback((path: string) => {
    const slot = layout.cuts.find((item) => item.path === path);
    const lead = !slot ? null : view.cut === path ? view.clip : visibleClip(doc, slot, 0);
    const marks: Record<string, CardMark> = {};
    let focusId: string | null = null;
    for (const clip of slot?.clips ?? []) {
      const id = links.get(clipKey(clip))?.gen?.id ?? clip.gen; // job 으로 다시 이은 클립은 지금의 카드 id
      const isLead = !!lead && lead.gen === clip.gen;
      marks[id] = { label: editMarkLabel(clip.track, t), lead: isLead };
      if (isLead) focusId = id;
    }
    return { marks, focusId };
  }, [layout, view.cut, view.clip, doc, links, t]);
  // 컷을 더블클릭 — 그 컷으로 재생헤드를 옮기고(이미 그 컷이면 그대로) 재생을 멈춘 뒤, 공유 & 리뷰의 '폴더 보기' 창을 그 컷
  //  폴더로 연다. 창은 App 의 것이라 여기서는 무엇을 열지와, 타임라인에 넣은 카드에 붙일 표만 넘긴다.
  //  미디어 풀의 카드를 우클릭해도 같은 창이다(Jay 2026-10-13) — 그때는 누른 카드가 보이게 연다(focusId).
  const openCut = useCallback((path: string, focusId?: string) => {
    if (!target || !layout.cuts.some((item) => item.path === path)) return;
    stopBoth();
    if (view.cut !== path) seekPos({ cut: path, local: 0 });
    onOpenCutFolder({
      projectId: target.projectId, projectName: projects.find((item) => item.id === target.projectId)?.name ?? "",
      path, ...cutMarks(path), ...(focusId ? { focusId } : null),
    });
  }, [layout, target, stopBoth, view.cut, seekPos, cutMarks, onOpenCutFolder, projects]);
  // 창이 떠 있는 동안 표를 살려 둔다 — 창에서 트랙 메뉴(휠 클릭)로 넣고 바꾸면 그 자리에서 표가 바뀐다. 글로 비교해, 내용이 바뀔
  //  때만 알린다(알릴 때마다 App 이 다시 그려지므로 객체로 비교하면 끝없이 돈다).
  const peekMarks = peekPath ? JSON.stringify(cutMarks(peekPath).marks) : null;
  useEffect(() => {
    if (peekMarks !== null) onPeekMarks(JSON.parse(peekMarks) as Record<string, CardMark>);
  }, [peekMarks, onPeekMarks]);

  // 창에서(또는 다른 화면에서) 공유를 풀거나 지웠을 수 있다 — 창이 닫히면, 그리고 생성물이 바뀌었다는 알림이 오면 공유 목록을
  //  다시 받는다. 알림은 창을 닫은 뒤에 끝난 요청도 잡는다(닫을 때 한 번만 받으면 그 요청보다 먼저 끝날 수 있다).
  const reloadList = list.reload;
  const reloadTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
  }, []);
  useCustomEvent(APP_EVENTS.libraryChanged, (event) => {
    // 밑의 탭이 공유 & 리뷰면 그 목록의 15초 폴링이 끝날 때마다 이 알림이 온다(실제 변경이 아니다 — 사이드바 숫자를 깨우는 틱).
    //  왼쪽의 숫자만 다시 받는다. 공유 목록은 다시 받지 않는다(§3 '폴링 없음' — 그 틱마다 목록 전체를 다시 받고 화면을 다시 그렸다).
    if (isLibraryPollTick(event)) return reloadCounts();
    if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      reloadList();
      reloadCounts(); // 왼쪽 폴더 옆의 개수·최종·보류·새 항목
    }, 400);
  });
  const seenSignal = useRef(reloadSignal);
  useEffect(() => {
    if (seenSignal.current === reloadSignal) return;
    seenSignal.current = reloadSignal;
    reloadList();
    reloadCounts();
  }, [reloadSignal, reloadList, reloadCounts]);

  // 컷(폴더) 켜고 끄기 — 재생헤드가 있는 컷. 숨기기를 켠 채 끄면 그 컷은 타임라인에서 사라지고 재생헤드는 다음 컷으로 간다.
  //  컷은 **누르는 순간의 재생헤드 자리**에서 구한다(I·O·M 과 같다) — 화면 상태의 컷(view.cut)은 한 박자 늦다: 시퀀스를 바꾼 그 박자에는
  //  앞 시퀀스의 컷이 남아 있는데 문서는 이미 새것이라, 거기 없는 컷이 새 문서에 '끈 컷'으로 적혔고, 다른 프로젝트에 같은 이름의 컷이
  //  있으면 재생헤드가 없는 그 컷이 꺼졌다(조작 규칙 46, Codex 코드 리뷰).
  const toggleCut = useCallback(() => {
    const here = posAt(layout, now())?.cut;
    if (here) applyEdit((current) => toggleCutOff(current, here, autoOff(here)));
  }, [layout, now, applyEdit, autoOff]);
  const toggleHideOff = useCallback(() => {
    applyEdit((current) => {
      const next = { ...current };
      if (current.hideOff) delete next.hideOff;
      else next.hideOff = true;
      return next;
    });
  }, [applyEdit]);

  // 빈 곳 채우기(Jay 2026-10-08 — 막대의 목록 단추) — 클립이 하나도 없는 컷마다 생성물 하나를 넣는다: **최종 확인된 것**(검수
  //  골드)이 있으면 그중 최신, 없으면 그 컷의 **최신**(공유 목록은 최신 먼저 온다 — 풀의 '최신순' 맨 위와 같다). 꺼 둔 컷
  //  (비활성)은 건드리지 않는다. 넣는 자리는 넣기와 같다(그 컷에서 켜져 있고 안 잠긴 가장 낮은 트랙). 한 번이 되돌리기 한 단계다.
  //  공유 목록을 다시 받는 중·받지 못한 뒤에는 채우지 않는다 — 그동안 든 목록은 옛 것이라, 방금 공유를 푼 카드를 넣거나
  //  새로 최종이 된 것을 놓친다(Codex 코드 리뷰). 2,000건에서 잘린 목록은 받은 것 안에서 고른다.
  const listFresh = list.state === "ok" || list.state === "capped";
  const fillPicks = useMemo(() => (!listFresh ? [] : cuts.flatMap((path) => {
    if (offCuts.has(path) || doc.clips.some((clip) => clip.cut === path)) return [];
    const gens = byCut.get(path) ?? [];
    const gen = gens.find((item) => item.is_final) ?? gens[0];
    return gen ? [{ cut: path, gen }] : [];
  })), [listFresh, cuts, offCuts, doc, byCut]);
  const fillEmpty = () => {
    closeMenu();
    const picks = fillPicks.map(({ cut: path, gen }) => ({
      cut: path, gen: gen.id, job: gen.job_id, kind: gen.assets[0].type,
      dur: genSeconds(gen, knownVideoSeconds(gen.assets[0].file_path)),
    }));
    // 고른 것은 이 렌더의 문서·비활성 판정으로 만든 것이다 — 그 사이 다른 창이 문서를 바꿨으면(rev) 넣지 않는다: 방금 꺼진
    //  컷에 들어가고, 채운 수도 틀리게 알린다(Codex 코드 리뷰).
    const filled = applyEdit((current) => fillEmptyCuts(current, picks), { rev });
    if (filled === "stopped") return; // 다른 창의 저장을 받아들였다 — 그 알림이 떠 있다
    if (filled === "none") return flash(t("채울 빈 곳이 없습니다."));
    const finals = fillPicks.filter(({ gen }) => gen.is_final).length;
    flash(t("빈 곳 {count}개를 채웠습니다 — 최종 {finals}개 · 최신 {rest}개").replace("{count}", String(picks.length))
      .replace("{finals}", String(finals)).replace("{rest}", String(picks.length - finals)));
  };

  // 최종 확정(Jay 2026-10-13) — 클립 메뉴의 '최종 선택'과 목록 단추의 '모두 최종으로 확정'. 편집 문서를 바꾸지 않는다(되돌리기 단계가
  //  아니다): 생성물의 검수 상태를 바꾸는 것이고, 길은 앱의 것이다(review.apply). 무엇이 바뀔 수 있는지는 앱과 같은 판정으로 미리
  //  본다(reviewTargets — 공유된 완료본이고 내가 그 프로젝트에서 최종을 줄 수 있는 것). 그런 것이 하나도 없으면 줄을 보이지 않는다.
  //  메뉴가 떠 있을 때만 센다(떠 있지 않은 동안의 렌더에 얹지 않는다).
  // · 클립 메뉴: 줄 수 있는 것이 전부 최종이면 ✓ — 누르면 해제(공유로). 아니면 누르면 전부 최종으로.
  const clipFinal = (() => {
    if (!clipMenu || !review) return undefined;
    const raise = reviewTargets(clipMenuGens, "final", review.canFinalize);
    const lower = reviewTargets(clipMenuGens.filter((gen) => gen.is_final), "shared", review.canFinalize);
    if (!raise.length && !lower.length) return undefined;
    const checked = !raise.length;
    return {
      checked,
      count: checked ? lower.length : raise.length,
      // 공유 목록을 다시 받는 중·받지 못한 뒤에는 누르지 못한다('모두 확정'·빈 곳 채우기와 같은 문지기 listFresh) — 그동안 든 목록은
      //  옛 것이다. 그사이 다른 창에서 공유를 푼 생성물을 최종으로 올리면 서버가 **다시 공유한다**(최종 = 공유 동반 — Codex 코드
      //  리뷰 6회째). 목록이 지금 것이어도 받은 뒤에 바뀐 것까지는 알 수 없다 — 그것은 공유 & 리뷰의 카드와 같은 틈이다.
      stale: !listFresh,
      onToggle: () => {
        closeMenu();
        if (!listFresh) return;
        // 해제는 최종인 것만 넘긴다 — 고른 것 전부를 '공유로' 넘기면 보류(R)해 둔 것까지 풀린다
        void review.apply(checked ? lower : clipMenuGens, checked ? "shared" : "final");
      },
    };
  })();
  // · 목록 단추: '타임라인에 있는 것' = 보이는 컷(layout)의 켜진 클립이 가리키는 생성물. 숨긴 컷·꺼진 클립·꺼진 트랙은 뺀다 —
  //   최종은 집계·'최종 저장'에 쓰이고 잘못 올리면 하나씩 풀어야 해서 좁게 잡았다(숨기지 않은 비활성 컷은 재생되므로 든다 —
  //   Resolve 보내기와 같은 기준). 공유 목록을 다시 받는 중에는 누르지 못한다(빈 곳 채우기와 같다 — 그동안 든 목록은 옛 것이다).
  const [finalBusy, setFinalBusy] = useState(false);
  const finalAll = (() => {
    if (!listMenu || !review) return null;
    const shown = layout.cuts.flatMap((slot) => slot.clips);
    const on = shown.filter((clip) => clipIsOn(doc, clip));
    const found = new Map<string, Generation>();
    for (const clip of on) {
      const gen = links.get(clipKey(clip))?.gen;
      if (gen) found.set(gen.id, gen);
    }
    const gens = [...found.values()];
    const targets = reviewTargets(gens, "final", review.canFinalize);
    const finals = gens.filter((gen) => gen.is_final);
    if (!targets.length && !reviewTargets(finals, "shared", review.canFinalize).length) return null; // 내가 최종을 줄 수 있는 것이 없다
    return {
      gens, targets, clips: on.length, finals: finals.length, denied: gens.length - targets.length - finals.length,
      off: shown.length - on.length, hidden: doc.clips.length - shown.length,
      unlinked: on.filter((clip) => !links.get(clipKey(clip))?.gen).length,
    };
  })();
  const finalizeAll = () => {
    const plan = finalAll;
    closeMenu();
    if (!review || !plan || finalBusy || !listFresh) return;
    if (!plan.targets.length) return flash(t("최종으로 확정할 것이 없습니다."));
    stopBoth(); // 확인 창이 떠 있는 동안 뒤에서 도는 재생을 멈출 길이 없다
    const skipped = ([
      [plan.off, t("꺼진 클립·트랙 {count}개")], [plan.hidden, t("숨긴 컷의 클립 {count}개")],
      [plan.denied, t("권한이 없거나 공유가 풀린 것 {count}개")], [plan.unlinked, t("공유 목록에서 못 찾은 클립 {count}개")],
    ] as const).filter(([value]) => value > 0).map(([value, text]) => text.replace("{count}", String(value)));
    const asked = [
      t("타임라인의 생성물 {count}개를 최종으로 확정할까요?").replace("{count}", String(plan.targets.length)),
      "",
      t("· 보이는 컷의 켜진 클립 {clips}개 기준 — 이미 최종인 {finals}개는 그대로 둡니다")
        .replace("{clips}", String(plan.clips)).replace("{finals}", String(plan.finals)),
      ...(skipped.length ? [`${t("· 빼는 것:")} ${skipped.join(" · ")}`] : []),
      t("· 되돌리기(Ctrl+Z)로는 돌아가지 않습니다 — 풀려면 클립 우클릭의 '최종 선택'으로 하나씩 해제합니다"),
    ].join("\n");
    if (!window.confirm(asked)) return;
    setFinalBusy(true);
    void Promise.resolve(review.apply(plan.gens, "final")).finally(() => setFinalBusy(false));
  };

  const fit = useCallback(() => {
    const width = scrollRef.current?.clientWidth ?? 0;
    if (layout.total > 0 && width > 160) setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (width - 140) / layout.total)));
  }, [layout.total]);
  const zoomBy = (factor: number) => setZoom((value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value * factor)));

  // 마크 인/아웃 — 재생헤드 자리에 찍는다. 편집 키라 언제나 타임라인 것이다(소스 판이 재생 키를 받고 있어도).
  const markHere = (which: "markIn" | "markOut") => {
    const pos = posAt(layout, now());
    if (pos) applyEdit((current) => setMark(current, layout, which, pos));
  };
  const clearMarks = (...which: ("markIn" | "markOut")[]) => {
    applyEdit((current) => which.reduce((next, key) => setMark(next, layout, key, null) ?? next, current));
  };
  // 북마크 — 재생헤드 자리에 이미 있으면 그 편집 창을 열고(다빈치: M 을 한 번 더), 없으면 넣는다.
  const bookmarkHere = () => {
    const found = markerAt(layout, bookmarks, now());
    if (found) {
      const box = headRef.current?.getBoundingClientRect();
      openMarkerMenu(found.key, box?.left ?? 0, (box?.top ?? 0) + 16);
      return;
    }
    const pos = posAt(layout, now());
    if (!pos || applyEdit((current) => addMarker(current, pos, ui.markerColor)) === "none") flash(t("이 자리에 북마크를 넣지 못했습니다."));
  };
  const removeBookmarkHere = () => {
    const found = markerAt(layout, bookmarks, now());
    if (found) applyEdit((current) => removeMarker(current, found.key));
  };
  // 구간 반복 재생 — 켜는 순간 구간 처음에서 정방향으로 튼다. 끄면 재생은 그대로 두고 구간만 푼다. 뷰어 오른쪽 아래의 단추와
  //  Alt+/ 가 같은 길이다(좁은 판에서는 단추가 숨는다 — 켜 둔 것을 끌 길이 키로 남는다, Codex 코드 리뷰).
  const rangeOn = rangeLoop && hasBand;
  const toggleRangeLoop = () => {
    if (!marks.band) return;
    setRangeLoop(!rangeOn);
    if (!rangeOn) playRange(marks.band);
  };
  const stepMarker = (dir: 1 | -1) => {
    const time = now();
    const eps = 0.5 / EDIT_FPS;
    const next = dir > 0 ? bookmarks.find((item) => item.time > time + eps)
      : [...bookmarks].reverse().find((item) => item.time < time - eps);
    if (next) seek(next.time);
  };

  // 편집 키 — 글자 키는 물리 키(code)로 본다(한/영 상태와 무관). 실제로 쓴 키만 기본 동작을 막는다.
  const onKey = (event: KeyboardEvent) => {
    // 위에 창·메뉴가 떠 있으면 키는 그쪽 것이다(lib/keyGate) — 풀의 보기·정렬 메뉴, 뷰어의 '무엇을 볼지' 메뉴가 뜬 채 Delete·Space 가
    //  뒤의 클립·재생에 먹었다(2026-10-10 점검).
    if (!keysActive || backgroundKeysBlocked() || isTyping(event.target)) return;
    // 다른 처리가 이미 쓴 키는 건드리지 않는다. Ctrl+A 만 예외 — 앱이 '입력칸 밖 Ctrl+A 는 화면 글자를 긁지 않게' 늘 막아 두므로
    //  (lib/keyGate.usePageSelectAllGuard) 그것은 '쓴 키'가 아니다.
    const selectAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.code === "KeyA";
    if (event.defaultPrevented && !selectAll) return;
    const from = event.target as HTMLElement | null;
    // 상단바 단추에 남은 초점은 '다른 창'이 아니다 — 관리자 창·알림·계정 메뉴를 Esc 로 닫으면 초점이 그 단추에 남아 ←·→·L 이 안 먹었다
    //  (2026-10-10 재실측 3/3). 라이브러리 격자의 '초점 잃은 키'(lib/keyGate.useLooseKeys)와 같은 규칙이다.
    const onTopbar = !!from?.matches?.("button, a") && !!from.closest(".topbar");
    if (from && from !== document.body && !rootRef.current?.contains(from) && !onTopbar) return; // 다른 창 안에서 난 키
    const { code, key } = event;
    const mod = event.ctrlKey || event.metaKey;
    const picked = [...selected];
    // 길게 눌러 반복된 keydown — 토글·찍기·셔틀은 첫 누름에만 한다(기본 동작은 막는다). 반복마다 다시 하면 재생/정지·비활성·트림 모드가
    //  뒤집히고, 재생 중의 I·O·M 은 지나가는 프레임마다 찍히며, L·J 는 배속이 순식간에 끝까지 오른다(조작 규칙 38).
    //  반복이 뜻인 것(프레임·편집점 이동, 되돌리기, 확대·축소, 트랙 옮기기)은 그대로 둔다.
    const once = !event.repeat;
    let used = true;
    if (mod && event.altKey) used = false;
    else if (mod && code === "KeyZ") (event.shiftKey ? edit.redo : edit.undo)();
    else if (mod && code === "KeyA") {
      // 보이는 것만 — 숨긴 컷의 클립은 고르지 않는다
      setSelected(new Set(doc.clips.filter((clip) => !doc.tracksLocked.includes(clip.track)).map(clipKey)
        .filter((key) => shownKeys.has(key))));
    } else if (mod && (key === "=" || key === "+")) zoomBy(1.25);
    else if (mod && key === "-") zoomBy(0.8);
    else if (mod) used = false;
    else if (event.altKey && key === "ArrowUp" && picked.length) act((current) => shiftClips(current, picked, 1));
    else if (event.altKey && key === "ArrowDown" && picked.length) act((current) => shiftClips(current, picked, -1));
    // 마크 인/아웃·북마크(다빈치의 키) — I·O = 찍기, Alt = 지우기, Shift = 그 자리로
    else if (event.altKey && code === "KeyI") clearMarks("markIn");
    else if (event.altKey && code === "KeyO") clearMarks("markOut");
    else if (event.altKey && code === "KeyX") clearMarks("markIn", "markOut");
    else if (event.altKey && code === "KeyM") { if (once) removeBookmarkHere(); } // 재생 중에 길게 누르면 지나가는 북마크가 줄줄이 지워졌다
    else if (event.altKey && code === "Slash") { if (once) toggleRangeLoop(); }
    else if (event.altKey) used = false;
    else if (event.shiftKey && code === "KeyZ") fit();
    else if (event.shiftKey && code === "KeyI") { if (marks.in !== null) seek(marks.in); }
    else if (event.shiftKey && code === "KeyO") { if (marks.out !== null) seek(marks.out); }
    else if (event.shiftKey && key === "ArrowUp") stepMarker(-1);
    else if (event.shiftKey && key === "ArrowDown") stepMarker(1);
    else if (code === "Space") {
      // 초점이 있는 단추의 Space 는 그 단추 것. 마우스로 눌러 초점만 남은 상단바 단추는 예외 — 그 Space 가 방금 Esc 로 닫은 창을
      //  다시 열었다. Tab 으로 옮겨 간 단추는 그대로 그 단추의 것(lib/keyGate.focusCameByTab).
      if (from?.closest("button, a, [role=button]") && !(onTopbar && !focusCameByTab())) used = false;
      else if (once) keys.toggle();
    } else if (code === "KeyL") { if (once) keys.shuttle(1); }
    else if (code === "KeyJ") { if (once) keys.shuttle(-1); }
    else if (code === "KeyK") keys.stop();
    else if (key === "ArrowLeft") keys.stepFrames(event.shiftKey ? -EDIT_FPS : -1);
    else if (key === "ArrowRight") keys.stepFrames(event.shiftKey ? EDIT_FPS : 1);
    else if (key === "ArrowUp") keys.stepEdit(-1);
    else if (key === "ArrowDown") keys.stepEdit(1);
    else if (key === "Home") keys.seek(0);
    else if (key === "End") keys.seek(onSource ? src.layout.total : layout.total);
    else if ((key === "Delete" || key === "Backspace") && picked.length) act((current) => removeClips(current, picked));
    // D = 비활성(앱 공통) — 고른 클립이 있으면 그 클립, 없으면 재생헤드가 있는 컷(폴더)
    else if (code === "KeyD" && picked.length) { if (once) act((current) => toggleClipsOff(current, picked)); }
    else if (code === "KeyD" && cut) { if (once) toggleCut(); }
    else if (code === "KeyI") { if (once) markHere("markIn"); }
    else if (code === "KeyO") { if (once) markHere("markOut"); }
    else if (code === "KeyM") { if (once) bookmarkHere(); }
    else if (code === "KeyW") { if (once) toggleTrim(); }
    else if (key === "Escape" && picked.length && !isKeyHandled(event)) {
      markKeyHandled(event); // 이 Esc 는 여기서 썼다 — 같은 키로 다른 것까지 닫히지 않게(lib/keyHandled)
      setSelected(new Set());
    }
    else used = false;
    if (used) event.preventDefault();
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const select = useCallback((key: string, additive: boolean) => {
    setSelected((prev) => {
      if (!additive) return prev.size === 1 && prev.has(key) ? prev : new Set([key]);
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected((prev) => (prev.size ? new Set() : prev)), []);
  const moveClip = useCallback((key: string, track: number, startedRev: number) => {
    act((current) => moveClipToTrack(current, key, track), { rev: startedRev });
  }, [act]);
  const toggleTrackList = useCallback((which: "tracksOff" | "tracksLocked", track: number) => {
    applyEdit((current) => toggleTrack(current, which, track));
  }, [applyEdit]);
  const toggleMute = useCallback(() => {
    applyEdit((current) => ({ ...current, muted: !current.muted }));
  }, [applyEdit]);

  const project = projects.find((item) => item.id === target?.projectId);
  // 막대의 [타임라인 Resolve 보내기](Jay 2026-10-13) — 누르면 확인 창(무엇이 어디로 가는지 · Resolve 가 켜져 있는지), 거기서
  //  [보내기]를 눌러야 간다. 계획은 창이 떠 있는 동안의 **지금 배치**로 짓는다(lib/editResolveExport). 누를 때마다 새 타임라인이다.
  //  exportDone = 방금 계획대로 끝났다(잠깐 보이는 표시). 다르게 놓였거나 실패한 것은 안내 줄이 말한다.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const exportName = timelineExportName(project?.name ?? "", seq);
  const exported = useMemo(
    () => (exportOpen ? buildTimelineExport({ layout, doc, links, name: exportName }) : null),
    [exportOpen, layout, doc, links, exportName],
  );
  const doneTimer = useRef<number | null>(null);
  useEffect(() => {
    doneTimer.current = null; // 개발 화면(StrictMode)은 effect 를 한 번 걷었다 다시 돌린다 — 다시 살린다
    return () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
      doneTimer.current = -1; // 떠난 뒤에 끝난 보내기는 표시를 켜지 않는다
    };
  }, []);
  const sendTimeline = (to: ResolveProjectTarget) => {
    if (!exported) return;
    setExportOpen(false);
    void resolve.sendTimeline(exported.plan, exported.gens, to).then((result) => {
      if (result?.timeline.status !== "complete" || doneTimer.current === -1) return;
      setExportDone(true);
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
      doneTimer.current = window.setTimeout(() => setExportDone(false), 3000);
    });
  };
  const slot = layout.cuts.find((item) => item.path === cut);
  const empty = !target ? t("왼쪽에서 컷 폴더가 들어 있는 폴더를 고르세요.")
    : !layout.cuts.length ? (treePaths === null && list.state === "loading" ? t("불러오는 중...") : t("이 폴더 안에 컷 폴더가 없습니다."))
      : null;
  const needWorkspace = !!target && !allWorkspaces && !editWorkspaceReady(workspace);
  const poolNotice = !target ? t("폴더를 고르면 그 컷에 공유된 생성물이 여기에 보입니다.")
    : needWorkspace ? t("워크스페이스를 확인한 뒤 공유물을 표시합니다.") : !cut ? t("컷이 없습니다.") : null;
  const filled = layout.cuts.filter((item) => item.clips.length).length;
  const genDetail = (gen: Generation | null | undefined) => (gen ? [gen.creator_name || gen.worker_name, gen.model,
    gen.assets[0]?.type === "video" ? generationListMeta(gen.params ?? {}).duration : null].filter(Boolean).join(" · ") : "");
  const detailOf = (clip: SlotClip | null) => genDetail(clip ? links.get(clipKey(clip))?.gen : null);
  const cutLabel = slot ? slot.path.replace(/\//g, " / ") : "";
  // 두 종류의 판(타임라인 시계·소스 시계)이 같이 떠 있을 때만 어느 쪽이 키를 받는지 표시한다
  const mixed = srcShown && slots.length > 1;
  const firstSolo = slots.find((mode) => typeof mode === "number");
  const pane = (order: number, mode: ViewMode) => ({
    order, mode, options: viewOptions, onMode: (next: ViewMode) => setMode(order, next),
    dualButton: order === slots.length - 1 ? { dual: ui.dual, onToggle: () => patchUi({ dual: !ui.dual }) } : null,
  });
  // 뷰어 오른쪽 아래의 단추 셋(타임라인의 시계를 쓰는 판)
  const marking: ViewerMarking = {
    markIn: () => markHere("markIn"), markOut: () => markHere("markOut"),
    rangeLoop: rangeOn, canRangeLoop: hasBand, onRangeLoop: toggleRangeLoop,
  };
  // 배속 단추(Jay 2026-10-08) — 누를 때마다 다음 값. 두 뷰어가 같이 쓰고, 이 브라우저에 남는다.
  const speedPane = {
    speed: ui.speed,
    onSpeed: () => patchUi({ speed: EDIT_SPEEDS[(EDIT_SPEEDS.indexOf(ui.speed) + 1) % EDIT_SPEEDS.length] }),
  };
  const clockPane = { // 타임라인의 시계를 쓰는 판(타임라인·한 트랙만)이 같이 받는 것
    ...speedPane,
    playing: view.playing, rate: view.rate, total: layout.total, marks: NO_MARKS, io: marks, flags, marking, registerPaint,
    controls: tlControls,
    loop: ui.loop, onLoop: () => patchUi({ loop: !ui.loop }), empty,
    active: mixed && !onSource, onActivate: () => setKeyTarget("timeline"),
  };

  // 왼쪽 폴더 목록 여닫기(Jay 2026-10-13 — 풀 머리줄의 단추, 공유 탭의 '필터 사이드바 닫기'와 같은 것). 닫으면 목록과 그 폭 손잡이가 사라지고
  //  풀·뷰어가 왼쪽으로 붙는다. 편집 문서·재생은 그대로다. **고른 시퀀스가 없으면 닫아 두었어도 연다** — 닫힌 채로는 폴더를 고를 길이 없고,
  //  빈 화면의 안내가 '왼쪽에서 … 고르세요'다. 닫아도 없애지 않고 감춘다 — 펼치고 접어 둔 폴더와 목록의 스크롤 자리가 다시 열 때 그대로다
  //  (Codex 코드 리뷰). 감싸는 칸은 배치에 끼지 않는다(display: contents — styles/edit-tab.css).
  const sideOpen = !ui.sideHidden || !target;

  return (
    <>
      <div className="ed-side-wrap" hidden={!sideOpen}><EditSidebar
        projects={projects}
        projectsState={projectsState}
        openProject={openProject}
        onOpenProject={setOpenProject}
        tree={tree}
        seq={openProject === target?.projectId ? seq : ""}
        cut={openProject === target?.projectId ? cut ?? "" : ""}
        offCuts={openProject === target?.projectId ? offCuts : NO_CUTS}
        freshByProject={freshByProject}
        onPickFolder={pickFolder}
        onReload={reloadTree}
        onGrabFocus={grabFocus}
        onFolderAction={onFolderAction}
      /></div>
      <main className="main ed-root" ref={rootRef} tabIndex={-1} onMouseDownCapture={(event) => {
        grabFocus();
        // 입력칸(풀의 검색·크기)에 초점이 남은 채 타임라인·뷰어를 누르면 키를 편집 화면으로 돌려받는다 — 화면 안의 단추들은 초점을
        //  가져가지 않아(mousedown 을 막는다), 안 돌려받으면 Space·J·K·L 이 계속 그 입력칸으로 갔다(2026-10-10 점검).
        const typing = document.activeElement as HTMLElement | null;
        if (typing && typing !== event.target && isTyping(typing) && !isTyping(event.target)) {
          typing.blur();
          rootRef.current?.focus({ preventScroll: true });
        }
        // 아래 타임라인·막대를 누르면 재생 키는 타임라인 것이다(뷰어 판은 판이 스스로 정한다)
        if ((event.target as HTMLElement).closest(".ed-tl, .ed-bar")) setKeyTarget("timeline");
      }} onClickCapture={(event) => {
        // 키보드로 실행한 click 도 같다(Tab 으로 닿은 컷 이름·막대 단추의 Enter) — mousedown 에만 걸려 있어 컷은 옮겨 가는데 이어 누른
        //  L·→ 는 앞서 고른 소스를 움직였다(조작 규칙 51). 뷰어 판은 이미 click 에서도 받는다.
        if ((event.target as HTMLElement).closest(".ed-tl, .ed-bar")) setKeyTarget("timeline");
      }}>
        {/* 풀의 폭 손잡이는 끌 때 초점을 받는다(방향키로도 폭을 바꾸게) — 놓으면 편집 화면으로 돌려준다. 안 돌려주면
            ←·→ 가 프레임 이동이 아니라 풀 폭을 바꾼다(2026-10-08 격리 실측). Tab 으로 손잡이에 간 키보드 조절은 그대로다. */}
        <div className="ed-top" onPointerUp={(event) => {
          if ((event.target as HTMLElement).classList.contains("sidebar-resize-handle")) rootRef.current?.focus({ preventScroll: true });
        }}>
          {/* 폭은 프로젝트 칸처럼 끌어서 바꾼다(같은 손잡이 — 저장 키와 범위만 다르다) */}
          <ResizableSidebar className="ed-pool-side" widthKey="ch.editTimeline.poolWidth" min={240} max={720} base={392}>
            <EditPool
              title={slot ? slot.path.replace(/\//g, " / ") : ""}
              items={poolItems}
              picked={pickedIds}
              ui={ui}
              onUi={patchUi}
              listState={list.state}
              notice={poolNotice}
              onPick={pickInPool}
              onPickMany={setPickedIds}
              onOpen={openGen}
              onCompare={openCompare}
              resolve={resolve}
              onClearPicked={clearPicked}
              onMenu={(gen, x, y) => openMenu(gen, cut, x, y)}
              sideOpen={sideOpen}
              onToggleSide={() => patchUi({ sideHidden: sideOpen })}
              onFolder={(gen) => cut && openCut(cut, gen.id)}
              onCardDrag={onCardDrag}
            />
          </ResizableSidebar>
          {/* 타임라인 판 — 안 보일 때도 붙어 있다(엔진의 영상 요소를 떼면 안 된다). 안 보이면 소리를 끈다. */}
          <EditViewer
            {...pane(tlOrder, "timeline")}
            {...clockPane}
            // 다이나믹 트림 모드 — 이 판이 뷰어 자리 전체다. 판을 고르거나 나눌 것이 없다(끄기는 무대의 ⊗·W·막대의 단추)
            {...(trim && { options: [{ value: "timeline", label: t("다이나믹 트림 모드") }], dualButton: null })}
            over={trim && (
              <EditTrimView layout={layout} doc={doc} sourceOf={sourceOf} now={now} registerPaint={registerPaint} onClose={toggleTrim}
                failedKey={view.failed && view.clip ? clipKey(view.clip) : ""} />
            )}
            shown={view}
            videoRef={tlVideo.front}
            spareRef={tlVideo.spare}
            muted={!!doc.muted || !tlShown}
            label={cutLabel && view.clip ? `${cutLabel} · V${view.clip.track}` : cutLabel}
            detail={detailOf(view.clip)}
          />
          {/* 소스 판 — 풀에서 고른 것(소스 클립) 또는 이 컷의 풀 목록을 이은 것(소스 테이프). 마찬가지로 붙어 있다. */}
          <EditViewer
            {...pane(srcOrder, tapeOn ? "tape" : "source")}
            {...speedPane}
            shown={srcPlay.view}
            videoRef={srcVideo.front}
            spareRef={srcVideo.spare}
            muted={false}
            playing={srcPlaying}
            rate={srcPlay.view.rate}
            total={src.layout.total}
            marks={srcStarts}
            registerPaint={registerSrcPaint}
            controls={srcControls}
            loop={ui.loopSrc}
            onLoop={() => patchUi({ loopSrc: !ui.loopSrc })}
            label={tapeOn && srcGen ? `${cutLabel} · ${srcGens.indexOf(srcGen) + 1}/${srcGens.length}` : ""}
            detail={genDetail(srcGen)}
            empty={srcGens.length ? null
              : tapeOn ? t("이 컷 폴더에 공유된 생성물이 없습니다.") : t("미디어 풀에서 생성물을 고르면 여기에서 봅니다.")}
            active={mixed && onSource}
            onActivate={() => setKeyTarget("source")}
          />
          {/* 한 트랙만 보는 판 — 타임라인의 시계를 따라간다. 타임라인 판이 없으면 첫 번째 것이 소리를 낸다. */}
          {slots.map((mode, order) => typeof mode === "number" && (
            <EditSoloViewer
              key={mode}
              {...pane(order, mode)}
              {...clockPane}
              track={mode}
              layout={layout}
              sourceOf={sourceOf}
              now={now}
              muted={!!doc.muted || tlShown || mode !== firstSolo}
              labelOf={() => (cutLabel ? `${cutLabel} · V${mode}` : "")}
              detailOf={detailOf}
            />
          ))}
        </div>
        <div className="ed-bar" onMouseDown={(event) => event.preventDefault()}>
          <span className="ed-tc" ref={barTimeRef}>00:00:00:00</span>
          <span className="ed-seq">
            {target ? (
              <>
                <b>{project?.name ? `${project.name} / ` : ""}{seq}</b>
                <i>·</i>{t("컷 {count}").replace("{count}", String(layout.cuts.length))}
                <i>·</i>{t("넣은 컷 {count}").replace("{count}", String(filled))}
                <i>·</i>{t("빈 컷 {count}").replace("{count}", String(layout.cuts.length - filled))}
              </>
            ) : null}
          </span>
          <span className="ed-mine" title={t("이 편집은 이 브라우저(계정)에만 저장됩니다. 팀에 공유되지 않습니다.")}>
            {t("나만 보는 편집")}
          </span>
          {edit.bad && (
            <span className="ed-warn" role="status" title={t("편집을 시작하면 옛 내용은 따로 보관한 뒤 새로 저장합니다.")}>
              {t("저장된 편집을 읽지 못했습니다")}
            </span>
          )}
          {edit.dirty && <span className="ed-warn" role="status">{t("저장 안 됨")}</span>}
          {/* 컷 머리를 끌어 폴더 순서를 바꿔 둔 상태 — 누르면 이름순으로 되돌린다(되돌리기 한 단계) */}
          {!!doc.cutOrder?.length && (
            <button type="button" className="ed-mine ed-orderchip" title={t("이름순으로 되돌립니다")}
              onClick={() => act((current) => resetCutOrder(current))}>
              {t("폴더 순서: 내 순서")} ↺
            </button>
          )}
          {/* 공유 목록의 상태 — 받지 못하면 넣은 카드가 '확인 못 함'·'미디어 없음'으로 보이고, 폴더 창에서 넣을 수도 없다 */}
          {needWorkspace && (
            <span className="ed-warn" role="status">
              {t("워크스페이스를 확인한 뒤 공유물을 표시합니다.")}{" "}
              <button type="button" className="ed-link ed-ws-all" onClick={() => setAllIn((allWorkspacesIn = workspaceKey))}>
                {t("모든 워크스페이스 보기")}
              </button>
            </span>
          )}
          {!needWorkspace && list.state === "error" && (
            <span className="ed-warn" role="status" title={list.error ?? undefined}>
              {t("공유 목록을 받지 못했습니다.")}{" "}
              <button type="button" className="ed-link" onClick={list.reload}>{t("다시 시도")}</button>
            </span>
          )}
          {!needWorkspace && list.state === "capped" && (
            <span className="ed-warn" role="status">{t("최대 2,000건까지만 표시합니다.")}</span>
          )}
          {/* 인/아웃 구간의 길이(누르면 지운다)와 북마크 — 마크 인/아웃 단추는 뷰어 오른쪽 아래에 있다(다빈치) */}
          {target && (
            <span className="ed-marks">
              {/* 타임라인 Resolve 보내기 — 오른쪽 도구들의 맨 앞(다빈치의 Quick Export 자리). 누르면 확인 창이 뜬다 */}
              <button type="button" className={"ed-mbtn ed-export-btn" + (exportDone ? " ed-export-done" : "")}
                disabled={resolve.timelineBusy} aria-busy={resolve.timelineBusy || undefined}
                title={t("지금 타임라인을 DaVinci Resolve 의 새 타임라인으로 보냅니다 — 누르면 확인 창이 뜹니다")}
                onClick={() => {
                  closeMenu();
                  setExportOpen(true);
                }}>
                {!resolve.timelineBusy && !exportDone && (
                  <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true"><path d="M6.5 8.5v-7M3.8 3.8 6.5 1.2l2.7 2.6M1.5 8.5v3h10v-3" /></svg>
                )}
                {resolve.timelineBusy ? t("보내는 중…") : exportDone ? t("✓ Resolve 에 보냄") : t("타임라인 Resolve 보내기")}
              </button>
              <i className="ed-msep" aria-hidden="true" />
              {/* 다빈치의 Dynamic Trim Mode 단추 — [ ‹ | › ] */}
              <button type="button" className={"ed-mbtn ed-mbtn-trim" + (trim ? " ed-on" : "")} aria-pressed={trim} onClick={toggleTrim}
                title={t("다이나믹 트림 모드 (W) — 나뉜 뷰어를 한 창으로 합쳐 편집점의 앞 컷 | 뒤 컷을 이어 봅니다 · ↑↓ 편집점 · Space 앞뒤 2초 재생")}
                aria-label={t("다이나믹 트림 모드 (W) — 나뉜 뷰어를 한 창으로 합쳐 편집점의 앞 컷 | 뒤 컷을 이어 봅니다 · ↑↓ 편집점 · Space 앞뒤 2초 재생")}>
                <svg width="24" height="14" viewBox="0 0 24 14" aria-hidden="true">
                  <path d="M4.5 1.5h-3v11h3M19.5 1.5h3v11h-3M9 4.2 6.2 7 9 9.8M15 4.2 17.8 7 15 9.8M12 5v8" />
                  <circle cx="12" cy="2.8" r="1.4" />
                </svg>
              </button>
              {(doc.markIn || doc.markOut) && (
                <button type="button" className="ed-mclear" onClick={() => clearMarks("markIn", "markOut")}
                  title={t("인/아웃 지우기 (Alt+X)")} aria-label={t("인/아웃 지우기 (Alt+X)")}>
                  {marks.band ? timecode(marks.band.to - marks.band.from) : t("인/아웃")}<i>×</i>
                </button>
              )}
              <button type="button" className="ed-mbtn ed-mbtn-mk" style={{ "--mk": ui.markerColor } as CSSProperties} onClick={bookmarkHere}
                title={t("북마크 (M) · 앞/뒤 북마크로 Shift+↑↓ · 지우기 Alt+M")} aria-label={t("북마크 (M) · 앞/뒤 북마크로 Shift+↑↓ · 지우기 Alt+M")}>
                <svg width="11" height="14" viewBox="0 0 11 14" aria-hidden="true"><path d="M1.5 1.5h8v11l-4-3.2-4 3.2z" /></svg>
                {bookmarks.length > 0 && <i>{bookmarks.length}</i>}
              </button>
              {/* 새 북마크의 색 · 모두 지우기(다빈치의 마커 색 메뉴) */}
              <button type="button" ref={colorBtnRef} className={"ed-mbtn ed-mbtn-color" + (colorMenu ? " ed-on" : "")} aria-haspopup="menu" aria-expanded={!!colorMenu}
                title={t("새 북마크의 색 · 모두 지우기")} aria-label={t("새 북마크의 색 · 모두 지우기")}
                onPointerDown={closeOnAuxPress}
                onClick={(event) => {
                  if (colorMenu) return closeMenu();
                  const box = event.currentTarget.getBoundingClientRect();
                  menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setColorMenu({ x: box.left, top: box.top, bottom: box.bottom, rev });
                }}>
                <svg className="ed-caret" width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0h8L4 5z" /></svg>
              </button>
            </span>
          )}
          <span className="ed-zoom">
            {/* 목록 단추 — 비활성 숨기기 · 빈 곳 채우기. 숨기기가 켜져 있으면 라임이고 옆에 숨긴 폴더 수가 보인다 */}
            {target && (
              <button type="button" ref={listBtnRef} className={"ed-mbtn ed-listbtn" + (doc.hideOff || listMenu ? " ed-on" : "")}
                aria-haspopup="menu" aria-expanded={!!listMenu}
                title={t("타임라인 정리 — 비활성 숨기기 · 빈 곳 채우기")} aria-label={t("타임라인 정리 — 비활성 숨기기 · 빈 곳 채우기")}
                onPointerDown={closeOnAuxPress}
                onClick={(event) => {
                  if (listMenu) return closeMenu();
                  const box = event.currentTarget.getBoundingClientRect();
                  menuBackRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setListMenu({ x: box.left, top: box.top, bottom: box.bottom });
                }}>
                <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><path d="M5.5 3h9M5.5 7h9M5.5 11h9M1.8 3h.4M1.8 7h.4M1.8 11h.4" /></svg>
                {doc.hideOff && offCuts.size > 0 && <i>{offCuts.size}</i>}
              </button>
            )}
            <button type="button" className="ed-link" onClick={fit} title={t("전체 보기 (Shift+Z)")}>{t("전체 보기")}</button>
            <button type="button" className="ed-zbtn" onClick={() => zoomBy(0.8)} title={t("축소 (Ctrl+-)")} aria-label={t("축소 (Ctrl+-)")}>－</button>
            <button type="button" className="ed-zbtn" onClick={() => zoomBy(1.25)} title={t("확대 (Ctrl+=)")} aria-label={t("확대 (Ctrl+=)")}>＋</button>
          </span>
        </div>
        <EditTimeline
          layout={layout}
          doc={doc}
          links={links}
          zoom={zoom}
          rev={rev}
          selected={selected}
          currentCut={cut}
          offCuts={offCuts}
          marks={marks}
          markers={bookmarks}
          scrollRef={scrollRef}
          headRef={headRef}
          getNow={now}
          onSeek={seek}
          onZoom={setZoom}
          onSelect={select}
          onClearSelection={clearSelection}
          onMoveClip={moveClip}
          onPickCut={pickCut}
          onOpenCut={openCut}
          onToggleTrack={toggleTrackList}
          onToggleMute={toggleMute}
          onTrackMenu={openTrackMenu}
          onMarkerMenu={openMarkerMenu}
          onClipMenu={openClipMenu}
          onClipTrim={openTrim}
          dropHint={dropHint}
          onMoveCut={moveCutTo}
        />
      </main>
      {/* 풀에서 끄는 카드 — 포인터를 따라간다(자리는 ref 로 직접 옮긴다 — 움직일 때마다 다시 그리지 않는다). 무엇이 될지를 적는다 */}
      {cardDrag && (
        <div className={"ed-ghost" + (cardDrag.hint ? ` ed-ghost-${cardDrag.hint.state}` : "")} aria-hidden="true"
          ref={(el) => {
            ghostRef.current = el;
            moveGhost();
          }}>
          {cardDragGen && thumbOf(cardDragGen, 256) && <img src={thumbOf(cardDragGen, 256)!} alt="" draggable={false} />}
          <span>{cardDrag.hint ? dropLabel(cardDrag.hint, t) : t("트랙 줄 위에 놓으세요")}</span>
        </div>
      )}
      {exported && target && <EditExportConfirm exported={exported} onSend={sendTimeline} onClose={() => setExportOpen(false)} />}
      {menu && <EditTrackMenu x={menu.x} y={menu.y} rows={menuRows} onPick={placeTo} onClose={closeMenu} />}
      {trimPop && trimClip && (
        <EditTrimPop
          openId={trimPop.group}
          title={`${trimClip.cut.slice(trimClip.cut.lastIndexOf("/") + 1)} · V${trimClip.track}`}
          full={trimClip.full}
          value={trimClip.len}
          trimmed={trimClip.trim !== undefined}
          src={trimSrc}
          // 바꿀 것이 없었던 걸음(none)은 조용히 넘긴다. 버린 걸음(stopped — 다른 창의 저장·떠나는 중)에는 창을 닫는다: 그 알림이 이미
          //  떴고, 이 조절은 여기서 끝이다(다시 열어 조절하면 그때는 알고 하는 편집이다).
          onChange={(seconds) => {
            const done = applyEdit((current) => setClipTrim(current, trimPop.key, seconds), { group: trimPop.group, rev: trimPop.rev });
            if (done === "stopped") closeTrim();
          }}
          onUndo={edit.undo}
          onRedo={edit.redo}
          onClose={closeTrim}
        />
      )}
      {clipMenu && (
        <EditClipMenu
          x={clipMenu.x}
          y={clipMenu.y}
          title={clipMenuOne ? `${clipMenuOne.cut.slice(clipMenuOne.cut.lastIndexOf("/") + 1)} · V${clipMenuOne.track}`
            : t("클립 {count}개").replace("{count}", String(clipMenu.keys.length))}
          count={clipMenuGens.length}
          final={clipFinal}
          busy={resolve.busy}
          pendingCount={resolve.pendingCount}
          onSend={() => {
            closeMenu();
            resolve.send(clipMenuGens);
          }}
          // 길이 조절 — 휠 클릭과 같은 창을 메뉴에서도 연다(휠 단추가 없는 마우스·트랙패드). 클립 하나를 눌렀을 때만.
          onTrim={clipMenuOne ? () => {
            closeMenu();
            openTrim(clipKey(clipMenuOne));
          } : undefined}
          onClose={closeMenu}
        />
      )}
      {trackMenu && trackMenu.track <= layout.tracks && (
        <EditTrackHeadMenu
          x={trackMenu.x}
          y={trackMenu.y}
          track={trackMenu.track}
          can={{
            up: trackMenu.track < layout.tracks && !lockedTrack(trackMenu.track) && !lockedTrack(trackMenu.track + 1),
            down: trackMenu.track > 1 && !lockedTrack(trackMenu.track) && !lockedTrack(trackMenu.track - 1),
            remove: layout.tracks > 1 && !lockedTrack(trackMenu.track),
            removeEmpty: deleteEmptyTracks(doc) !== null,
          }}
          clips={doc.clips.filter((clip) => clip.track === trackMenu.track).length}
          color={doc.trackColors?.[trackMenu.track] ?? null}
          onAct={trackAct}
          onClose={closeMenu}
        />
      )}
      {markerMenu && editing && (
        <EditMarkerMenu
          key={markerMenu.key}
          x={markerMenu.x}
          y={markerMenu.y}
          time={editing.time}
          marker={editing.marker}
          onName={(name) => applyEdit((current) => patchMarker(current, markerMenu.key, { name }), { rev: markerMenu.rev })}
          onColor={(color) => applyEdit((current) => patchMarker(current, markerMenu.key, { color }), { rev: markerMenu.rev })}
          onRemove={() => applyEdit((current) => removeMarker(current, markerMenu.key), { rev: markerMenu.rev })}
          onClose={closeMenu}
        />
      )}
      {listMenu && (
        <EditListMenu
          x={listMenu.x}
          top={listMenu.top}
          bottom={listMenu.bottom}
          hideOff={!!doc.hideOff}
          offCount={offCuts.size}
          fillCount={fillPicks.length}
          finalAll={finalAll ? { count: listFresh ? finalAll.targets.length : 0, busy: finalBusy, onRun: finalizeAll } : undefined}
          trigger={listBtnRef}
          onHide={() => {
            closeMenu();
            toggleHideOff();
          }}
          onFill={fillEmpty}
          onClose={closeMenu}
        />
      )}
      {colorMenu && (
        <EditMarkerColorMenu
          x={colorMenu.x}
          top={colorMenu.top}
          bottom={colorMenu.bottom}
          value={ui.markerColor}
          count={doc.markers?.length ?? 0}
          trigger={colorBtnRef}
          onPick={(color) => {
            patchUi({ markerColor: color });
            closeMenu();
          }}
          onClearAll={() => {
            const opened = colorMenu.rev;
            closeMenu();
            applyEdit(clearMarkers, { rev: opened }); // 안 보이는 것(숨긴 컷)까지 — 되돌리기 한 단계
          }}
          onClose={closeMenu}
        />
      )}
    </>
  );
}

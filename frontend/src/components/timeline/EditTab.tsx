// 편집 탭 — 공유된 생성물을 컷(폴더) 순서대로 이어 보는 다빈치식 화면. 계약·한계는 docs/EDIT_TAB.md.
//  왼쪽 = 시퀀스 폴더 고르기 · 그 옆 = 미디어 풀(재생헤드가 있는 컷의 생성물) · 오른쪽 = 뷰어(싱글, 또는 소스 | 타임라인의
//  듀얼) · 아래 = 트랙 타임라인. 컷 자리는 폴더 순서로 고정이고, 고른 생성물만 들어간다. 편집은 이 브라우저(계정)에만 저장한다.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CardMark, Generation, PreviewTarget, WorkspaceContext } from "../../types";
import { APP_EVENTS } from "../../lib/appEvents";
import { isFolderDisabled } from "../../lib/deactivated";
import {
  buildLayout,
  clipKey,
  cutIsOff,
  cutPaths,
  DEFAULT_SEC,
  EDIT_FPS,
  genSeconds,
  groupByCut,
  linkClip,
  moveClipToTrack,
  placeClip,
  removeClips,
  setClipDurs,
  shiftClips,
  timecode,
  toggleClipsOff,
  toggleCutOff,
  toggleTrack,
  visibleClip,
  type EditDoc,
  type SlotClip,
} from "../../lib/editTimeline";
import {
  editDocKey, loadEditTarget, loadEditUi, saveEditTarget, saveEditUi, type EditTarget, type EditUi,
} from "../../lib/editTimelineStore";
import { generationListMeta } from "../../lib/generationDisplay";
import { previewTargetFromGenerations } from "../../lib/generationGrid";
import { TEAM_SCOPE } from "../../lib/generationViews";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
import { useCustomEvent } from "../../lib/useCustomEvent";
import { useDisabledFolders } from "../../lib/useDisabledFolders";
import { useEditDoc } from "../../lib/useEditDoc";
import { useEditPlayback, type EditSource } from "../../lib/useEditPlayback";
import { workspaceViewKey } from "../../lib/libraryWorkspaceScope";
import {
  allFolderPaths,
  editWorkspaceReady,
  findFolder,
  useEditGenerations,
  useEditProjects,
} from "../../lib/useEditSequence";
import { dropQueuedVideoMeasures, knownVideoSeconds, measureVideoSeconds } from "../../lib/videoDuration";
import { editMarkLabel } from "./EditCard";
import { EditPool, type PoolItem } from "./EditPool";
import { EditSidebar } from "./EditSidebar";
import { EditSourceViewer } from "./EditSourceViewer";
import { EditTimeline, ZOOM_MAX, ZOOM_MIN, type ClipLink } from "./EditTimeline";
import { EditTrackMenu, type TrackRow } from "./EditTrackMenu";
import { EditViewer } from "./EditViewer";
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
  // 그 창이 떠 있는 동안(peekPath = 그 컷 폴더): 창의 카드를 우클릭하면 App 이 cardMenuRef 로 넘겨주고(넣을 트랙 메뉴),
  //  표는 창에서 넣고 바꾸는 대로 다시 알린다(onPeekMarks).
  peekPath: string | null;
  onPeekMarks: (marks: Record<string, CardMark>) => void;
  cardMenuRef: MutableRefObject<EditCardMenu | null>;
  // 미디어 풀의 더블클릭·비교 — 앱의 크게 보기 창·비교 창을 그대로 쓴다(둘 다 보기 전용).
  onPreview: (target: PreviewTarget) => void;
  onCompare: (gens: Generation[]) => void;
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
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" || element.isContentEditable);
};

function EditTabInner({
  authKey, workspace, keysActive, flash, onOpenCutFolder, reloadSignal, peekPath, onPeekMarks, cardMenuRef, onPreview, onCompare,
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
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const barTimeRef = useRef<HTMLSpanElement>(null);
  const viewTimeRef = useRef<HTMLSpanElement>(null);

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
    if (barTimeRef.current) barTimeRef.current.textContent = code;
    if (viewTimeRef.current) viewTimeRef.current.textContent = code;
    const scroll = scrollRef.current; // 재생 중에는 재생헤드가 화면 밖으로 나가면 따라간다
    if (scroll && playingRef.current && (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40)) {
      scroll.scrollLeft = Math.max(0, x - 80);
    }
  }, []);
  const playback = useEditPlayback({
    scope: target ? `${target.projectId}\n${target.seq}` : "", layout, doc, sourceOf, videoRef, paint,
  });
  const { view, now, seek, seekPos, stop, toggle, shuttle, stepFrames, stepEdit } = playback;
  playingRef.current = view.playing;
  useEffect(() => paint(now()), [zoom, paint, now]);

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
  useEffect(() => {
    let alive = true;
    for (const clip of doc.clips) {
      const asset = links.get(clipKey(clip))?.gen?.assets[0];
      if (asset?.type !== "video" || !asset.file_path) continue;
      const key = clipKey(clip);
      void measureVideoSeconds(asset.file_path).then((seconds) => {
        if (!alive || !seconds || Math.abs(seconds - (clip.dur ?? 0)) < 1 / EDIT_FPS) return;
        applyEdit((current) => setClipDurs(current, new Map([[key, seconds]])), { undo: false, rev });
      });
    }
    return () => {
      alive = false;
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

  const act = useCallback((change: (current: EditDoc) => EditDoc | null, options?: { rev?: number }) => {
    if (!applyEdit(change, options)) flash(t("바꾸지 못했습니다 — 잠긴 트랙이 있거나 옮길 자리가 없습니다."));
  }, [applyEdit, flash, t]);

  const cut = view.cut;
  const poolItems = useMemo<PoolItem[]>(() => {
    if (!cut) return [];
    const placed = doc.clips.filter((clip) => clip.cut === cut);
    return (byCut.get(cut) ?? []).map((gen) => {
      const clip = placed.find((item) => links.get(clipKey(item))?.gen?.id === gen.id);
      return { gen, track: clip?.track ?? null, showing: !!clip && view.clip?.gen === clip.gen };
    });
  }, [cut, byCut, doc, links, view.clip]);
  // 고른 생성물은 컷을 옮겨도 소스 뷰어에 남는다(이 시퀀스의 공유 목록에 있는 동안).
  const pickedId = pickedIds[pickedIds.length - 1] ?? null;
  const pickedGen = useMemo(() => (pickedId ? list.gens.find((gen) => gen.id === pickedId) ?? null : null), [pickedId, list.gens]);
  // 더블클릭 = 크게 보기(재생) — 앱의 크게 보기 창. 앞뒤 넘기기는 풀에 지금 보이는 순서, '마지막으로 본'은 공유 & 리뷰 칸에 남는다.
  const openGen = useCallback((gen: Generation, shown: Generation[]) => {
    const target = previewTargetFromGenerations(shown, gen, 512);
    if (target) onPreview({ ...target, sceneId: TEAM_SCOPE });
  }, [onPreview]);
  // 카드 우클릭 메뉴(Jay 2026-10-08) — 미디어 풀의 카드, 폴더 창의 카드를 우클릭하면 지금 있는 트랙을 보여 주고, 고르면 그
  //  트랙에 넣는다(찬 트랙은 교체). 넣을 컷은 여는 순간에 정한다(풀 = 재생헤드가 있는 컷, 창 = 그 창의 컷). 편집 탭의 그 컷
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
  const closeMenu = useCallback(() => {
    setMenu(null);
    const back = menuBackRef.current;
    menuBackRef.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);
  useEffect(() => setMenu(null), [peekPath, cut, target?.projectId, target?.seq]); // 보던 컷·창이 바뀌면 닫는다
  useEffect(() => {
    cardMenuRef.current = (card, x, y) => openMenu(card, peekPath, x, y);
    return () => {
      cardMenuRef.current = null;
    };
  }, [cardMenuRef, openMenu, peekPath]);
  const menuOwn = menu && doc.clips.find((clip) => clip.cut === menu.cut && links.get(clipKey(clip))?.gen?.id === menu.gen.id);
  const menuRows: TrackRow[] = !menu ? [] : Array.from({ length: layout.tracks }, (_, i) => layout.tracks - i).map((track) => ({
    track,
    state: menuOwn?.track === track ? "here"
      : doc.tracksLocked.includes(track) || (!!menuOwn && doc.tracksLocked.includes(menuOwn.track)) ? "locked"
        : doc.clips.some((clip) => clip.cut === menu.cut && clip.track === track) ? "taken" : "empty",
  }));
  const placeTo = (track: number) => {
    if (!menu) return;
    const { gen, cut: menuCut } = menu;
    const asset = gen.assets[0];
    closeMenu();
    if (maybePlaced(menuCut, gen)) return flash(t("이 카드는 이미 넣은 클립일 수 있습니다 — 공유 목록을 다 받은 뒤에 다시 해 주세요.")); // 메뉴가 떠 있는 사이 다시 받기가 시작됐다
    act((current) => placeClip(current, {
      // job 으로 다시 이은 클립이면 그 클립을 옮긴다(문서에 적힌 옛 id 로 찾는다)
      cut: menuCut, gen: menuOwn?.gen ?? gen.id, job: gen.job_id, kind: asset.type,
      dur: genSeconds(gen, knownVideoSeconds(asset.file_path)),
    }, track));
  };

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
  const openCut = useCallback((path: string) => {
    if (!target || !layout.cuts.some((item) => item.path === path)) return;
    stop();
    if (view.cut !== path) seekPos({ cut: path, local: 0 });
    onOpenCutFolder({
      projectId: target.projectId, projectName: projects.find((item) => item.id === target.projectId)?.name ?? "",
      path, ...cutMarks(path),
    });
  }, [layout, target, stop, view.cut, seekPos, cutMarks, onOpenCutFolder, projects]);
  // 창이 떠 있는 동안 표를 살려 둔다 — 창에서 우클릭으로 넣고 바꾸면 그 자리에서 표가 바뀐다. 글로 비교해, 내용이 바뀔
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
  useCustomEvent(APP_EVENTS.libraryChanged, () => {
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
  const toggleCut = useCallback(() => {
    if (cut) applyEdit((current) => toggleCutOff(current, cut, autoOff(cut)));
  }, [cut, applyEdit, autoOff]);
  const toggleHideOff = useCallback(() => {
    applyEdit((current) => {
      const next = { ...current };
      if (current.hideOff) delete next.hideOff;
      else next.hideOff = true;
      return next;
    });
  }, [applyEdit]);

  const fit = useCallback(() => {
    const width = scrollRef.current?.clientWidth ?? 0;
    if (layout.total > 0 && width > 160) setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (width - 140) / layout.total)));
  }, [layout.total]);
  const zoomBy = (factor: number) => setZoom((value) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value * factor)));

  // 편집 키 — 글자 키는 물리 키(code)로 본다(한/영 상태와 무관). 실제로 쓴 키만 기본 동작을 막는다.
  const onKey = (event: KeyboardEvent) => {
    if (!keysActive || event.defaultPrevented || isTyping(event.target)) return;
    const from = event.target as HTMLElement | null;
    if (from && from !== document.body && !rootRef.current?.contains(from)) return; // 다른 창 안에서 난 키
    const { code, key } = event;
    const mod = event.ctrlKey || event.metaKey;
    const picked = [...selected];
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
    else if (event.altKey) used = false;
    else if (event.shiftKey && code === "KeyZ") fit();
    else if (code === "Space") {
      if (from?.closest("button, a, [role=button]")) used = false; // 초점이 있는 단추의 Space 는 그 단추 것
      else toggle();
    } else if (code === "KeyL") shuttle(1);
    else if (code === "KeyJ") shuttle(-1);
    else if (code === "KeyK") stop();
    else if (key === "ArrowLeft") stepFrames(event.shiftKey ? -EDIT_FPS : -1);
    else if (key === "ArrowRight") stepFrames(event.shiftKey ? EDIT_FPS : 1);
    else if (key === "ArrowUp") stepEdit(-1);
    else if (key === "ArrowDown") stepEdit(1);
    else if (key === "Home") seek(0);
    else if (key === "End") seek(layout.total);
    else if ((key === "Delete" || key === "Backspace") && picked.length) act((current) => removeClips(current, picked));
    // D = 비활성(앱 공통) — 고른 클립이 있으면 그 클립, 없으면 재생헤드가 있는 컷(폴더)
    else if (code === "KeyD" && picked.length) act((current) => toggleClipsOff(current, picked));
    else if (code === "KeyD" && cut) toggleCut();
    else if (code === "KeyM") applyEdit((current) => ({ ...current, muted: !current.muted }));
    else if (key === "Escape" && picked.length) setSelected(new Set());
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
  const slot = layout.cuts.find((item) => item.path === cut);
  const shownGen = view.clip ? links.get(clipKey(view.clip))?.gen ?? null : null;
  const empty = !target ? t("왼쪽에서 컷 폴더가 들어 있는 폴더를 고르세요.")
    : !layout.cuts.length ? (treePaths === null && list.state === "loading" ? t("불러오는 중...") : t("이 폴더 안에 컷 폴더가 없습니다."))
      : null;
  const needWorkspace = !!target && !allWorkspaces && !editWorkspaceReady(workspace);
  const poolNotice = !target ? t("폴더를 고르면 그 컷에 공유된 생성물이 여기에 보입니다.")
    : needWorkspace ? t("워크스페이스를 확인한 뒤 공유물을 표시합니다.") : !cut ? t("컷이 없습니다.") : null;
  const filled = layout.cuts.filter((item) => item.clips.length).length;

  return (
    <>
      <EditSidebar
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
      />
      <main className="main ed-root" ref={rootRef} tabIndex={-1} onMouseDownCapture={grabFocus}>
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
              onPick={pickGen}
              onPickMany={setPickedIds}
              onOpen={openGen}
              onCompare={onCompare}
              onClearPicked={clearPicked}
              onMenu={(gen, x, y) => openMenu(gen, cut, x, y)}
            />
          </ResizableSidebar>
          {ui.dual && <EditSourceViewer gen={pickedGen} />}
          <EditViewer
            view={view}
            videoRef={videoRef}
            timecodeRef={viewTimeRef}
            total={timecode(layout.total)}
            label={slot ? `${slot.path.replace(/\//g, " / ")}${view.clip ? ` · V${view.clip.track}` : ""}` : ""}
            detail={shownGen ? [shownGen.creator_name || shownGen.worker_name, shownGen.model,
              generationListMeta(shownGen.params ?? {}).duration].filter(Boolean).join(" · ") : ""}
            muted={!!doc.muted}
            empty={empty}
            dual={ui.dual}
            onToggleDual={() => patchUi({ dual: !ui.dual })}
            onToggle={toggle}
            onStepFrames={stepFrames}
            onStepEdit={stepEdit}
          />
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
          <span className="ed-zoom">
            {target && (
              <button type="button" className={"ed-toggle" + (doc.hideOff ? " ed-on" : "")} aria-pressed={!!doc.hideOff}
                onClick={toggleHideOff}
                title={t("비활성 폴더(빈 폴더·D 로 끈 폴더)를 타임라인에서 숨깁니다. 컷 이름을 누르고 D 를 누르면 그 폴더를 켜고 끕니다.")}>
                {t("비활성화 폴더 숨기기")}
                {offCuts.size > 0 && <i>{offCuts.size}</i>}
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
        />
      </main>
      {menu && <EditTrackMenu x={menu.x} y={menu.y} rows={menuRows} onPick={placeTo} onClose={closeMenu} />}
    </>
  );
}

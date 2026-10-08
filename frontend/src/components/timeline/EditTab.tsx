// 편집 탭 — 공유된 생성물을 컷(폴더) 순서대로 이어 보는 다빈치식 화면. 계약·한계는 docs/EDIT_TAB.md.
//  왼쪽 = 시퀀스 폴더 고르기 · 가운데 = 뷰어 · 오른쪽 = 재생헤드가 있는 컷의 생성물 · 아래 = 트랙 타임라인.
//  컷 자리는 폴더 순서로 고정이고, 고른 생성물만 들어간다. 편집은 이 브라우저(계정)에만 저장한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardMark, Generation, WorkspaceContext } from "../../types";
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
  insertClip,
  linkClip,
  moveClipToTrack,
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
import { editDocKey, loadEditTarget, saveEditTarget, type EditTarget } from "../../lib/editTimelineStore";
import { generationListMeta } from "../../lib/generationDisplay";
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
import { EditTimeline, ZOOM_MAX, ZOOM_MIN, type ClipLink } from "./EditTimeline";
import { EditViewer } from "./EditViewer";

interface Props {
  authKey: string; // 계정·서버 — 바뀌면 받던 조회를 버린다
  authReady: boolean;
  workspace: WorkspaceContext;
  keysActive: boolean; // false = 위에 다른 창이 떠 있다(편집 키를 듣지 않는다)
  flash: (message: string) => void;
  // 컷을 더블클릭 — 공유 & 리뷰의 '폴더 보기' 창을 그 컷 폴더로 연다(창은 App 의 것, 여기는 무엇을 열지만 알린다).
  onOpenCutFolder: (target: EditCutFolder) => void;
  reloadSignal: number; // 그 창이 닫혔다 — 창에서 공유를 풀거나 지웠을 수 있으니 공유 목록을 다시 받는다
}

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

function EditTabInner({ authKey, workspace, keysActive, flash, onOpenCutFolder, reloadSignal }: Props) {
  const t = useT();
  const [target, setTarget] = useState<EditTarget | null>(loadEditTarget);
  const [openProject, setOpenProject] = useState<string | null>(() => target?.projectId ?? null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [zoom, setZoom] = useState(20); // px/초
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const barTimeRef = useRef<HTMLSpanElement>(null);
  const viewTimeRef = useRef<HTMLSpanElement>(null);

  const { projects, projectsState, tree, reload: reloadTree } = useEditProjects({ authKey, workspace, projectId: openProject });
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
  const toggleGen = useCallback((gen: Generation) => {
    if (!cut) return;
    const clip = doc.clips.find((item) => item.cut === cut && links.get(clipKey(item))?.gen?.id === gen.id);
    if (clip) return act((current) => removeClips(current, [clipKey(clip)]));
    const asset = gen.assets[0];
    act((current) => insertClip(current, {
      cut, gen: gen.id, job: gen.job_id, kind: asset.type, dur: genSeconds(gen, knownVideoSeconds(asset.file_path)),
    }));
  }, [cut, doc, links, act]);

  // 그림(클립)을 누르면 그 컷으로 간다 — 이미 그 컷이면 보던 자리 그대로.
  const pickCut = useCallback((path: string) => {
    if (view.cut !== path) seekPos({ cut: path, local: 0 });
  }, [view.cut, seekPos]);
  // 컷을 더블클릭 — 그 컷으로 재생헤드를 옮기고(이미 그 컷이면 그대로) 재생을 멈춘 뒤, 공유 & 리뷰의 '폴더 보기' 창을 그 컷
  //  폴더로 연다. 창은 App 의 것이라 여기서는 무엇을 열지와, 타임라인에 넣은 카드에 붙일 표만 넘긴다.
  const openCut = useCallback((path: string) => {
    const slot = layout.cuts.find((item) => item.path === path);
    if (!target || !slot) return;
    stop();
    const here = view.cut === path;
    if (!here) seekPos({ cut: path, local: 0 });
    const lead = here ? view.clip : visibleClip(doc, slot, 0);
    const marks: Record<string, CardMark> = {};
    let focusId: string | null = null;
    for (const clip of slot.clips) {
      const id = links.get(clipKey(clip))?.gen?.id ?? clip.gen; // job 으로 다시 이은 클립은 지금의 카드 id
      const isLead = !!lead && lead.gen === clip.gen;
      marks[id] = { label: editMarkLabel(clip.track, t), lead: isLead };
      if (isLead) focusId = id;
    }
    onOpenCutFolder({
      projectId: target.projectId, projectName: projects.find((item) => item.id === target.projectId)?.name ?? "",
      path, focusId, marks,
    });
  }, [layout, target, stop, view.cut, view.clip, seekPos, doc, links, t, onOpenCutFolder, projects]);

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
    }, 400);
  });
  const seenSignal = useRef(reloadSignal);
  useEffect(() => {
    if (seenSignal.current === reloadSignal) return;
    seenSignal.current = reloadSignal;
    reloadList();
  }, [reloadSignal, reloadList]);

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
  const poolNotice = !target ? t("폴더를 고르면 그 컷에 공유된 생성물이 여기에 보입니다.")
    : !allWorkspaces && !editWorkspaceReady(workspace) ? t("워크스페이스를 확인한 뒤 공유물을 표시합니다.")
      : !cut ? t("컷이 없습니다.") : null;
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
        onPickFolder={pickFolder}
        onReload={reloadTree}
        onGrabFocus={grabFocus}
      />
      <main className="main ed-root" ref={rootRef} tabIndex={-1} onMouseDownCapture={grabFocus}>
        <div className="ed-top">
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
            onToggle={toggle}
            onStepFrames={stepFrames}
            onStepEdit={stepEdit}
          />
          <EditPool
            title={slot ? slot.path.replace(/\//g, " / ") : ""}
            items={poolItems}
            listState={list.state}
            listError={list.error}
            notice={poolNotice}
            noticeAction={target && !allWorkspaces && !editWorkspaceReady(workspace)
              ? { label: t("전체 보기"), run: () => setAllIn((allWorkspacesIn = workspaceKey)) } : null}
            onToggle={toggleGen}
            onReload={() => {
              list.reload();
              reloadTree();
            }}
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
    </>
  );
}

// 편집 탭 — 공유된 생성물을 컷(폴더) 순서대로 이어 보는 다빈치식 화면. 계약·한계는 docs/EDIT_TAB.md.
//  왼쪽 = 시퀀스 폴더 고르기 · 가운데 = 뷰어 · 오른쪽 = 재생헤드가 있는 컷의 생성물 · 아래 = 트랙 타임라인.
//  컷 자리는 폴더 순서로 고정이고, 고른 생성물만 들어간다. 편집은 이 브라우저(계정)에만 저장한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Generation, WorkspaceContext } from "../../types";
import {
  buildLayout,
  clipKey,
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
  toggleTrack,
  type EditDoc,
  type SlotClip,
} from "../../lib/editTimeline";
import { editDocKey, loadEditTarget, saveEditTarget, type EditTarget } from "../../lib/editTimelineStore";
import { generationListMeta } from "../../lib/generationDisplay";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";
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
}

export function EditTab(props: Props) {
  return props.authReady ? <EditTabInner {...props} /> : <main className="main ed-root" />;
}

// '전체 보기'를 켠 워크스페이스 — 탭을 오가도 남고 새로고침하면 사라진다(공유 & 리뷰 탭의 전체 보기와 같은 수명).
let allWorkspacesIn = "";

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isTyping = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" || element.isContentEditable);
};

function EditTabInner({ authKey, workspace, keysActive, flash }: Props) {
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
  const layout = useMemo(
    () => buildLayout(cuts, doc, (clip) => {
      const gen = links.get(clipKey(clip))?.gen; // 길이가 안 적힌 옛 클립만 여기로 온다
      return gen?.assets[0]?.type === "video" ? gen.params?.duration : undefined;
    }),
    [cuts, doc, links],
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

  // 고른 클립 중 문서에서 사라진 것은 고르기에서도 뺀다(되돌리기·다른 창의 변경).
  useEffect(() => {
    setSelected((prev) => {
      const keep = [...prev].filter((key) => links.has(key));
      return keep.length === prev.size ? prev : new Set(keep);
    });
  }, [links]);

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
      setSelected(new Set(doc.clips.filter((clip) => !doc.tracksLocked.includes(clip.track)).map(clipKey)));
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
    else if (code === "KeyD" && picked.length) act((current) => toggleClipsOff(current, picked));
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
          scrollRef={scrollRef}
          headRef={headRef}
          getNow={now}
          onSeek={seek}
          onZoom={setZoom}
          onSelect={select}
          onClearSelection={clearSelection}
          onMoveClip={moveClip}
          onToggleTrack={toggleTrackList}
          onToggleMute={toggleMute}
        />
      </main>
    </>
  );
}

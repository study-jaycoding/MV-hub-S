import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AuthConfig, Generation } from "../types";
import { APP_EVENTS } from "./appEvents";
import { forgetAuthToken, getAuthToken, setAuthToken, subscribeApiPause } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { t } from "./i18n";
import {
  cacheBatches, contextKey, hasResolveBridge, bridgeCompatible, RECOVERY_PENDING,
  resolvePanelApi as panel, targetView, inventoryAction, stageSummary, panelFailure,
  type PanelIdentity, type PanelSelection, type PanelCut, type TargetResult, type StageResult, type InventoryItem, type DragItem,
} from "./resolvePanelApi";

// folder_path = 고른 컷, 컷을 안 골랐으면 에피소드. cuts = 그 에피소드의 생성물 있는 컷(빈을 만들 것)
//  via = 다빈치에서 들어간 빈을 따라와 고른 것이면 그 빈 ID — 늦게 처리돼도 target 으로 다빈치를 끌고 오지 않는다
//  resolveProject = 고를 때 열려 있던 다빈치 프로젝트 ID — 쓰기마다 expect_project 로 실어 리졸브 쪽이 대조한다
interface Selection extends PanelSelection { ctx: PanelIdentity; seq: number; intent?: number; window: string; revision: number; capped?: boolean; episode: string; cuts: string[]; via: string; resolveProject: string }
interface PanelJob { run: () => Promise<unknown>; finish: () => void; requiresStable: boolean; afterSave: boolean; live: () => boolean }
interface SelectionPreparation { intent: number; seq?: number; done: Promise<void>; finish: () => void; timer?: ReturnType<typeof setTimeout> }
interface EpisodeBins { project_id: string; episode: string; bins: Record<string, string>; episodeBin: string }
// 미리 캐시·미리 띄우기의 컷 = [컷 경로, 생성물 ID(거르기 통과·오래된 200개), 200 을 넘어 잘렸나]
export type PrecacheCut = [string, string[], boolean?];
interface FillCut { cut: PrecacheCut; states: Map<string, string>; failures: Map<string, number> }
interface FillRun { run: number; ctx: PanelIdentity | null; project_id: string; episode: string; cuts: FillCut[]; busy: boolean; receiving?: boolean; blockedBin?: string; waiting?: boolean; renameCuts: Map<string, Set<string>>; renaming?: boolean }
const filled = (state: string | undefined) => !!state && ["staged", "present", "same_file_exists"].includes(state);
export interface PanelFollow { project: string; episode: string; cut: string; n: number }
// [저장] 칸의 상태(C안, Jay 11-12) — saving 의 step = 지금 단계 · done 의 at = 저장 시각(3초 뒤 idle) · blocked = 저장 안 됨(bins = 검사에 걸린 빈)
export type SaveBin = { path: string; count?: number; in_use: boolean; mine: boolean };
export type SaveState = { phase: "idle" } | { phase: "saving"; step: string } | { phase: "done"; at: number } | { phase: "blocked"; bins: SaveBin[] };
// 패널을 닫았다 열어도 남는 선택 — 다빈치 프로젝트마다 따로(Jay 11-12) + 마지막 것. 다시 열 때 inventory 정리가 그 에피소드 컷 빈은 건드리지 않는다
export const PANEL_SELECTION_KEY = "mvhub.resolvePanel.selection";
export interface SavedSelection { project: string; episode: string; cut: string }
const EMPTY_SELECTION: SavedSelection = { project: "", episode: "", cut: "" };
function readSelection(raw: unknown): SavedSelection {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === "string" ? value : "");
  const cut = pick(row.cut);
  return { project: pick(row.project), cut, episode: pick(row.episode) || cut.split("/").slice(0, -1).join("/") };
}
function readSaved(): { last: SavedSelection; byDavinci: Record<string, unknown>; legacy: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_SELECTION_KEY) || "null") as Record<string, unknown> | null;
    if (!raw) return { last: EMPTY_SELECTION, byDavinci: {}, legacy: false };
    if (!("last" in raw)) return { last: readSelection(raw), byDavinci: {}, legacy: true }; // 다빈치 프로젝트를 모르던 옛 모양
    const by = raw.byDavinci && typeof raw.byDavinci === "object" ? raw.byDavinci as Record<string, unknown> : {};
    return { last: readSelection(raw.last), byDavinci: by, legacy: false };
  } catch { return { last: EMPTY_SELECTION, byDavinci: {}, legacy: false }; }
}
// davinci = 다빈치 프로젝트 ID(모르면 마지막 것). 처음 보는 다빈치 프로젝트는 빈 선택 — 묻지 않고 그 프로젝트에 빈을 만들지 않는다(옛 모양은 한 번 넘겨준다)
export function loadSavedSelection(davinci = ""): SavedSelection {
  const saved = readSaved();
  if (!davinci || saved.legacy) return saved.last;
  return saved.byDavinci[davinci] ? readSelection(saved.byDavinci[davinci]) : EMPTY_SELECTION;
}
export function saveSelection(davinci: string, selection: SavedSelection): void {
  const saved = readSaved();
  try {
    localStorage.setItem(PANEL_SELECTION_KEY, JSON.stringify({ last: selection, byDavinci: davinci ? { ...saved.byDavinci, [davinci]: selection } : saved.byDavinci }));
  } catch { /* 저장소가 막혀도 조회는 유지한다 */ }
}
// 패널이 정렬 오류로 삼키지 않는 멈춤 — 다시 짓기 도중이면 빈 ID 가 바뀌었을 수 있다
const STOP_CODES = ["project_changed", "rebuild_recovery_needed", "rebuild_recovery_pending"];
const under = (path: string, base: string) => !!base && (path === base || path.startsWith(base + "/"));
// 부모 폴더가 없는 컷(에피소드 없음)은 지금처럼 컷 하나가 한 묶음이다
const sameEpisode = (a: Selection | null, b: Selection | null) => !!a && !!b && a.project_id === b.project_id
  && (a.episode ? a.episode === b.episode : a.folder_path === b.folder_path);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// 자동 지우기(다른 에피소드로 옮길 때 앞 에피소드 정리 · 패널을 열 때 예전 빈의 안 쓴 것 정리) — Jay 11-12 "자동 지우기는 필요 없다,
//  불러온 뒤 내가 지운다". 코드는 남기고 이 스위치로 끈다(AUTO-CLEANUP-OFF). 쓴 것 NAS 옮기기와 [저장] 단추는 그대로.
const AUTO_CLEANUP = false;
const cacheKey = (ctx: PanelSelection["ctx"], project_id: string, gen_id: string) => `${contextKey(ctx)}\n${project_id}\n${gen_id}`;
const createWindowId = (): string => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID() : `panel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;

export function useResolvePanel() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authRun, setAuthRun] = useState(0);
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [target, setTarget] = useState<TargetResult | null>(null);
  const [current, setCurrent] = useState<TargetResult | null>(null);
  const [stage, setStage] = useState<StageResult | null>(null);
  const [moved, setMoved] = useState(0);
  const [counts, setCounts] = useState({ other_owner: 0, needs_attention: 0 });
  const [failures, setFailures] = useState<string[]>([]);
  const [recoveryRun, setRecoveryRun] = useState(0);
  const [notice, setNotice] = useState("");
  const [follow, setFollow] = useState<PanelFollow | null>(null);
  const [nas, setNas] = useState<ReadonlySet<string>>(() => new Set());
  const [windowId] = useState(createWindowId);
  // 에피소드마다의 빈 표 — 새 에피소드 target 이 앞 에피소드 표를 덮지 않게 따로 둔다(앞 에피소드 정리는 그 target 뒤에 돈다)
  const episodes = useRef(new Map<string, EpisodeBins>());
  const leftovers = useRef<Selection[]>([]); // 정리를 미룬 앞 에피소드
  const followRef = useRef<{ key: string; bin: string } | null>(null); // 따라가기로 고를 자리와 그 빈 ID
  const lastBin = useRef(""); // 마지막으로 안 다빈치 지금 빈 — 바뀔 때만 따라간다
  const [davinci, setDavinci] = useState(""); // 열린 다빈치 프로젝트 ID — 선택이 없어도 2초 current-bin 으로 안다
  const davinciRef = useRef("");
  const [here, setHere] = useState(""); // 다빈치 지금 빈이 이 에피소드의 아는 빈이면 그 MV 폴더(트리의 다빈치 표)
  const cachedIds = useRef(new Set<string>()); // 이 PC 캐시에 받은 것으로 확인된(cached) 생성물 — 미리 받기가 다시 묻지 않는다
  const precacheRun = useRef(0); // 미리 받기 판 — 새 판이 오면 옛 판은 다음 확인에서 끝난다(미리 띄우기·이름 뒤따르기도 같은 판)
  const lastPrecache = useRef<{ project_id: string; episode: string; cuts: PrecacheCut[] } | null>(null); // 저장 뒤 다시 돌릴 목록
  const fillRun = useRef<FillRun | null>(null);
  const stableBin = useRef<{ project: string; bin: string; count: number; ctx: PanelIdentity; at: number } | null>(null);
  const savingRef = useRef(false);
  const [fillProgress, setFillProgress] = useState<{ episode: string; done: number; total: number; active: boolean; waiting?: boolean; receiving?: { done: number; total: number } } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragItems, setDragItems] = useState<Record<string, DragItem>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const readyDrag = useRef<Record<string, DragItem>>({});
  const resolveCheckedAt = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  // 저장됨은 3초 보이고 기본으로(C안 ③)
  useEffect(() => {
    if (saveState.phase !== "done") return;
    const timer = setTimeout(() => setSaveState(state => (state.phase === "done" ? { phase: "idle" } : state)), 3000);
    return () => clearTimeout(timer);
  }, [saveState]);
  const autoTried = useRef(""); // 자동 빈 만들기가 실패한 활성 컷 묶음 — 같은 묶음으로는 다시 자동으로 부르지 않는다
  const autoBusy = useRef(false);
  const autoNext = useRef<string[] | null>(null); // 진행 중에 바뀐 활성 컷 — 끝나면 이어서
  const syncRef = useRef<(cuts: string[]) => void>(() => {});
  const revision = useRef(0);
  const sequence = useRef(0);
  const context = useRef<PanelIdentity | null>(null);
  const checkedAt = useRef(0);
  const selected = useRef<Selection | null>(null);
  const targetRef = useRef<TargetResult | null>(null);
  const currentRef = useRef<TargetResult | null>(null);
  const interactiveJobs = useRef<PanelJob[]>([]);
  const backgroundJobs = useRef<PanelJob[]>([]);
  const running = useRef(false);
  const active = useRef(true);
  const pollPending = useRef(false);
  const intentNumber = useRef(0);
  const intentTarget = useRef<{ intent: number; align: boolean; reason: string; force: boolean; settled?: boolean; done?: Promise<boolean> } | null>(null);
  const preparation = useRef<SelectionPreparation | null>(null);
  const backgroundPaused = useRef(false);
  const quietBin = useRef<{ bin: string; project: string; count: number; at: number } | null>(null);
  const [selectionPhase, setSelectionPhase] = useState("");
  const adopted = useRef(new Set<string>());
  const failedAdoptions = useRef(new Map<string, string>());
  const generations = useRef<Generation[]>([]);
  const claimed = useRef(false);
  const lastContext = useRef("");
  const recovered = useRef("");
  const authEpoch = useRef(0);

  const pump = () => {
    if (running.current) return;
    running.current = true;
    void Promise.resolve().then(async () => {
      try {
        while (true) {
          const stable = quietBin.current;
          if (backgroundPaused.current && !preparation.current && !interactiveJobs.current.length
            && document.visibilityState !== "hidden" && stable && stable.count >= 2 && Date.now() - stable.at <= 2000) backgroundPaused.current = false;
          // 이미 줄에 선 stage도 NAS 버튼을 누른 뒤에는 저장 전체가 끝날 때까지 미룬다.
          const runnable = (job: PanelJob) => !job.live() || !job.afterSave || !savingRef.current;
          const first = interactiveJobs.current.findIndex(runnable);
          const index = backgroundJobs.current.findIndex(job => runnable(job) && (!job.live() || !job.requiresStable || !backgroundPaused.current));
          const job = first >= 0 ? interactiveJobs.current.splice(first, 1)[0] : index >= 0 ? backgroundJobs.current.splice(index, 1)[0] : undefined;
          if (!job) break;
          try { await job.run(); }
          catch (error) { if (active.current) setFailures(previous => [...new Set([...previous, errorText(error)])]); }
          finally { job.finish(); }
        }
      } finally { running.current = false; }
    });
  };
  const enqueue = (work: () => Promise<unknown>, background = false, requiresStable = background, live?: () => boolean, afterSave = false) => {
    const ctx = context.current, rev = revision.current;
    return new Promise<void>(finish => {
      const job = { run: work, finish, requiresStable, afterSave, live: live || (() => active.current && rev === revision.current
        && contextKey(ctx) === contextKey(context.current) && ctx?.generation === context.current?.generation) };
      (background ? backgroundJobs : interactiveJobs).current.push(job);
      pump();
    });
  };
  const endPreparation = (pending: SelectionPreparation | null) => {
    if (!pending) return;
    clearTimeout(pending.timer); pending.finish();
    if (preparation.current === pending) preparation.current = null;
    pump();
  };
  const beginPreparation = (intent: number, seq?: number) => {
    const previous = preparation.current;
    let finish!: () => void;
    const pending: SelectionPreparation = { intent, seq, done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    preparation.current = pending;
    endPreparation(previous);
    if (seq === undefined) pending.timer = setTimeout(() => endPreparation(pending), 5000);
    return pending;
  };
  const interact = (keepTarget = false) => {
    backgroundPaused.current = true; quietBin.current = null;
    const intent = keepTarget ? intentNumber.current : ++intentNumber.current;
    if (!keepTarget) intentTarget.current = null;
    readyDrag.current = {}; setDragItems({}); setSelectionPhase("");
    beginPreparation(intent);
    return intent;
  };
  const resetPreparation = () => {
    intentNumber.current++; intentTarget.current = null;
    quietBin.current = null; backgroundPaused.current = false;
    endPreparation(preparation.current); setSelectionPhase("");
  };
  useEffect(() => {
    active.current = true;
    const visibility = () => { quietBin.current = null; stableBin.current = null; };
    document.addEventListener("visibilitychange", visibility);
    return () => { active.current = false; resetPreparation(); document.removeEventListener("visibilitychange", visibility); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = useCallback(() => {
    resetPreparation();
    setPreviews({});
    readyDrag.current = {}; setDragItems({}); resolveCheckedAt.current = 0;
    claimed.current = false;
    revision.current++;
    context.current = null; checkedAt.current = 0; selected.current = null;
    targetRef.current = null; currentRef.current = null;
    adopted.current.clear(); failedAdoptions.current.clear(); recovered.current = "";
    episodes.current.clear(); leftovers.current = []; followRef.current = null; lastBin.current = "";
    davinciRef.current = ""; autoTried.current = ""; autoNext.current = null;
    precacheRun.current++; lastPrecache.current = null; fillRun.current = null; stableBin.current = null; setFillProgress(null);
    setIdentity(null); setTarget(null); setCurrent(null); setStage(null); setMoved(0); setFailures([]); setNotice("");
    setFollow(null); setNas(new Set()); setDavinci(""); setHere("");
  }, []);
  const resetAuth = useCallback(() => {
    authEpoch.current++; clear(); setAuthReady(false); setAuthRun(n => n + 1);
  }, [clear]);
  // 일반 브라우저는 읽기 전용이며, 대기 중 다리가 사라져도 후속 요청을 보내지 않는다.
  const valid = (selection: Selection) => active.current && hasResolveBridge(window.mvhubResolve) && context.current?.writer === true
    && selection.revision === revision.current && contextKey(context.current) === contextKey(selection.ctx)
    && selection.ctx.generation === context.current.generation;
  const currentIntent = (selection: Selection) => valid(selection) && selection.intent === intentNumber.current && stillAt(selection);
  const currentContents = (selection: Selection) => currentIntent(selection) && selection.seq === selected.current?.seq;
  // 지금도 그 자리를 고르고 있다(목록 갱신으로 같은 컷의 선택 객체만 바뀐 것은 같은 자리) — null = 선택을 푼 채
  const stillAt = (selection: Selection | null) => selection
    ? selected.current?.project_id === selection.project_id && selected.current.folder_path === selection.folder_path : !selected.current;
  // 열린 다빈치 프로젝트가 바뀌었다 — 앞 프로젝트의 정리·빈 표·따라가기를 버리고 늦은 작업을 무효로(다른 프로젝트의 같은 이름 빈을 건드리지 않게)
  const noteDavinci = (id: string | undefined) => {
    if (!id || id === davinciRef.current) return;
    if (davinciRef.current) {
      resetPreparation();
      precacheRun.current++; fillRun.current = null; stableBin.current = null; setFillProgress(null);
      setPreviews({});
      readyDrag.current = {}; setDragItems({}); resolveCheckedAt.current = 0;
      revision.current++;
      selected.current = null; generations.current = []; targetRef.current = null; currentRef.current = null;
      episodes.current.clear(); leftovers.current = []; followRef.current = null; lastBin.current = ""; autoTried.current = "";
      setTarget(null); setCurrent(null); setStage(null); setFollow(null); setHere("");
    }
    davinciRef.current = id; setDavinci(id);
  };
  // 응답이 고를 때와 다른 다빈치 프로젝트에서 왔다(또는 리졸브 쪽이 쓰기 전에 거절) — 버리고 프로젝트 전환으로 다룬다
  const sameDavinci = (selection: Selection, result: Pick<TargetResult, "state" | "resolve_project_id">) => {
    const moved = result.state === "project_changed"
      || (!!selection.resolveProject && !!result.resolve_project_id && result.resolve_project_id !== selection.resolveProject);
    if (moved) noteDavinci(result.resolve_project_id);
    return !moved;
  };
  const writer = (selection: Selection) => ({ ...selection, expect_project: selection.resolveProject || undefined });

  useEffect(() => {
    const epoch = authEpoch.current;
    let mounted = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout>;
    const retry = () => {
      if (!mounted || running) return;
      running = true; clearTimeout(timer);
      void api.authConfig().then(async cfg => {
      if (!mounted || epoch !== authEpoch.current) return;
      setConfig(cfg);
      if (cfg.auth_enabled) {
        if (!getAuthToken()) { setNeedsLogin(true); setAuthReady(false); return; }
        await api.me();
      }
      if (mounted && epoch === authEpoch.current) { setNotice(""); setNeedsLogin(false); setAuthReady(true); }
    }).catch(error => {
      if (mounted && epoch === authEpoch.current) {
        setNotice(errorText(error)); setAuthReady(false);
        timer = setTimeout(retry, 3000);
      }
    }).finally(() => { running = false; });
    };
    const focus = () => { if (!context.current) retry(); };
    retry(); window.addEventListener("focus", focus);
    return () => { mounted = false; clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [authRun]);

  useEffect(() => {
    const expired = () => { authEpoch.current++; clear(); setNeedsLogin(true); setAuthReady(false); };
    const storage = (event: StorageEvent) => {
      if (event.key === null || ([STORAGE_KEYS.authToken, STORAGE_KEYS.activeAccount, STORAGE_KEYS.hubLogoutAt] as string[]).includes(event.key)) {
        // 늦게 도착한 로그아웃은 이 창의 메모리만 비워 다른 창의 새 로그인을 보존한다.
        if (event.key === null || (event.key === STORAGE_KEYS.authToken && !event.newValue)) forgetAuthToken();
        else if (event.key === STORAGE_KEYS.authToken) {
          const token = loadString(STORAGE_KEYS.authToken);
          if (token) setAuthToken(token);
          else forgetAuthToken();
        }
        resetAuth();
      }
    };
    window.addEventListener(APP_EVENTS.authRequired, expired);
    window.addEventListener(APP_EVENTS.accountUpdated, resetAuth);
    window.addEventListener("storage", storage);
    const unsubscribe = subscribeApiPause(expired);
    return () => {
      window.removeEventListener(APP_EVENTS.authRequired, expired);
      window.removeEventListener(APP_EVENTS.accountUpdated, resetAuth);
      window.removeEventListener("storage", storage); unsubscribe();
    };
  }, [clear, resetAuth]);

  useEffect(() => {
    if (!authReady) return;
    let mounted = true, running = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (running || !mounted) return;
      clearTimeout(timer); running = true;
      const epoch = authEpoch.current;
      try {
        const claim = hasResolveBridge(window.mvhubResolve) && !claimed.current && !lastContext.current;
        let next = await panel.identity(windowId, claim);
        if (!mounted || epoch !== authEpoch.current) return;
        if (contextKey(next) !== lastContext.current) { clear(); lastContext.current = contextKey(next); }
        if (claim) claimed.current = true;
        if (hasResolveBridge(window.mvhubResolve) && !claimed.current) {
          // 새 문맥은 다시 열되 실제 다른 담당 창은 자동으로 빼앗지 않는다.
          if (next.owner_state !== "other_window") next = await panel.identity(windowId, true);
          if (!mounted || epoch !== authEpoch.current) return;
          claimed.current = true;
        }
        if (context.current && (context.current.generation !== next.generation || context.current.writer !== next.writer)) resetPreparation();
        context.current = next; checkedAt.current = Date.now(); setIdentity(next);
      } catch (error) {
        if (mounted && epoch === authEpoch.current) { checkedAt.current = 0; setNotice(errorText(error)); }
      } finally { running = false; if (mounted) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    window.addEventListener("focus", poll);
    return () => { mounted = false; clearTimeout(timer); window.removeEventListener("focus", poll); };
  }, [authReady, authRun, clear]);


  const check = (result: { state: string; details?: unknown; cleanup_failed?: boolean }) => {
    if (result.state === "account_changed") { clear(); throw new Error(t("계정 문맥을 확인 중입니다")); }
    if (result.state === "other_window") {
      resetPreparation();
      if (context.current) { context.current = { ...context.current, writer: false }; setIdentity(context.current); }
      throw new Error(t("다른 MV 창이 리졸브를 맡고 있습니다"));
    }
    if (result.cleanup_failed) setNotice(panelFailure("cleanup_pending")); // 문맥을 모르는 공통 검사 — 저장 안내는 [저장] 마무리가 덮어쓴다
  };
  const itemName = (id: string) => {
    const gen = generations.current.find(item => item.id === id);
    return gen ? [gen.creator_name, gen.model, gen.params?.duration ? String(gen.params.duration) + "s" : ""].filter(Boolean).join(" · ") || id : id;
  };
  // force = [저장] 길 — 생성물 단위 기억(이미 옮김·전에 실패)을 쓰지 않고 그 항목 ID 로 다시(같은 생성물을 다시 띄워 새로 쓴 클립도 옮기게)
  const adoptOne = async (selection: Selection, id: string, project: string, bin?: string, itemIds?: string[], recovery = false, force = false) => {
    if (!valid(selection)) return;
    const key = JSON.stringify([contextKey(selection.ctx), project, id]);
    if (!force && adopted.current.has(key)) return;
    if (!force && failedAdoptions.current.has(key)) throw new Error(failedAdoptions.current.get(key));
    try {
    if (!recovery) {
      const ready = await panel.prepare({ ...selection, gen_id: id });
      if (!valid(selection)) return;
      check(ready);
      if (ready.state !== "prepared") throw new Error(id + ": " + (ready.error || ready.state));
    }
    if (!valid(selection)) return;
    const result = await panel.adopt({ ...selection, reason: force ? "save" : recovery ? "recovery" : "adopt", gen_id: id, resolve_project_id: project, bin_id: bin, item_ids: itemIds, defer_save: force });
    if (!valid(selection)) return;
    check(result);
    if (force && result.state === "not_seen" && itemIds?.length && itemIds.every(item => result.missing_record_ids?.includes(item))) return result;
    if (result.state !== "in_bin") throw new Error(itemName(id) + ": " + panelFailure(result.state));
    adopted.current.add(key); setMoved(value => value + 1); setNas(previous => new Set(previous).add(id));
    return result;
    } catch (error) { failedAdoptions.current.set(key, errorText(error)); throw error; }
  };
  const settle = async (selection: Selection) => {
    if (!valid(selection) || sameEpisode(selected.current, selection)) return;
    const result = await panel.currentBin(selection.ctx, selection.project_id, selection.folder_path);
    if (!valid(selection)) return;
    check(result);
    if (!sameDavinci(selection, result)) return; // 다른 다빈치 프로젝트의 같은 이름 빈은 정리하지 않는다
    if (result.state === "ok" && (!result.target_bin_id || result.bin_id === result.target_bin_id)) return; // 다빈치가 그 빈 안이면 남긴다
    if (result.state !== "ok" || result.used === undefined) throw new Error(t("앞 컷 정리를 확인하지 못했습니다"));
    for (const id of result.used) await adoptOne(selection, id, result.resolve_project_id!, result.target_bin_id);
    // 기다리는 사이 그 에피소드를 다시 골랐으면(A→B→A) 지우지 않는다
    if (!valid(selection) || !result.target_bin_id || sameEpisode(selected.current, selection)) return;
    const removed = await panel.unstage({ ...writer(selection), reason: "settle", bin_id: result.target_bin_id });
    check(removed);
    if (!sameDavinci(selection, removed)) return;
    if (!["ok", "not_seen"].includes(removed.state)) throw new Error(t("앞 컷 정리를 확인하지 못했습니다") + ": " + panelFailure(removed.state));
  };
  const episodeKey = (selection: Selection) => JSON.stringify([contextKey(selection.ctx), selection.project_id, selection.episode || selection.folder_path]);
  const episodeOf = (selection: Selection) => episodes.current.get(episodeKey(selection)) ?? null;
  // 이 컷의 빈 ID — 두 컷이 한 빈으로 모이면(이름 다듬기) ID 로 따라가지 않는다
  const binOf = (selection: Selection) => {
    const bins = episodeOf(selection)?.bins || {};
    const bin = bins[selection.folder_path] || "";
    return bin && Object.values(bins).filter(id => id === bin).length === 1 ? bin : "";
  };
  // 따라온 빈 ID 가 지금 빈 표에 아직 있을 때만 — 다시 짓기로 버린 옛 ID 로 stage·따라가기를 하지 않는다
  const viaOf = (selection: Selection) => {
    const ep = episodeOf(selection);
    return selection.via && (selection.via === ep?.episodeBin || Object.values(ep?.bins ?? {}).includes(selection.via)) ? selection.via : "";
  };
  // 다시 짓기(ids_changed)나 다시 짓다 멈춘 응답 — 같은 다빈치 프로젝트면 모든 에피소드의 옛 빈 ID 를 버린다.
  //  응답을 버리는 다른 판단(선택이 바뀜 등)보다 먼저 부른다(버린 응답이 옛 ID 를 살려 두지 않게).
  const noteIds = (result: TargetResult) => {
    if ((result.ids_changed || STOP_CODES.includes(result.code || ""))
        && (!result.resolve_project_id || !davinciRef.current || result.resolve_project_id === davinciRef.current)) {
      episodes.current.clear(); followRef.current = null;
    }
  };
  // 빈 표를 적는다
  const noteBins = (selection: Selection, result: TargetResult) => {
    noteIds(result);
    if (result.bins) episodes.current.set(episodeKey(selection), { project_id: selection.project_id, episode: selection.episode,
      bins: result.bins, episodeBin: result.episode_bin_id || "" });
    const failed = result.bin_create_failed || [];
    if (failed.length) setFailures(previous => [...new Set([...previous, t("컷 빈을 만들지 못했습니다") + ": " + failed.join(", ")])]);
    if (result.order_error) setFailures(previous => [...new Set([...previous, t("빈 순서를 맞추지 못했습니다") + ": " + result.order_error])]);
  };
  // target 응답을 받자마자(선택이 바뀌었는지 보기 전에) 적는다 — 같은 문맥·같은 다빈치 프로젝트면 새 빈 표까지, 아니면 옛 빈 ID 버리기만.
  //  목록 갱신으로 선택 객체만 바뀐 사이에도 새 표를 잃지 않게(그 뒤 실시간 빈 만들기·따라가기가 이 표를 보고 돈다, Codex P2)
  const noteTarget = (selection: Selection, result: TargetResult) => {
    if (valid(selection) && sameDavinci(selection, result)) noteBins(selection, result);
    else noteIds(result);
  };
  const aim = (selection: Selection, reason: string) => {
    stableBin.current = null; // target 전 관측으로 새 지금 빈을 빌리지 않는다.
    return panel.target({ ...writer(selection), reason, create: true,
      ...(selection.episode && selection.cuts.length ? { episode_path: selection.episode, create_paths: selection.cuts } : {}) });
  };
  // 빈 표는 noteTarget 이 이미 적었다
  const aimed = (selection: Selection, result: TargetResult) => {
    if (!sameDavinci(selection, result)) return false;
    targetRef.current = result; setTarget(result); setNotice(targetView(result).message);
    if (result.state !== "ok") return false;
    if (result.bin_id) lastBin.current = result.bin_id;
    setHere(selection.folder_path);
    return true;
  };
  // 다빈치가 이미 그 빈 안이다 — target 없이 그 빈을 맞춘 것으로 본다(따라가기는 지금 빈을 바꾸지 않는다)
  const followed = (bin: string) => {
    const now = currentRef.current;
    const result: TargetResult = { state: "ok", resolve_project_id: now?.resolve_project_id, bin_id: bin, bin_path: now?.bin_path };
    targetRef.current = result; setTarget(result);
  };
  // 돌려주는 값 = 다빈치 지금 빈을 새 목적 빈으로 맞췄다(또는 이미 그 빈 안이다) — 그때만 앞 에피소드를 정리한다
  const alignEpisode = async (selection: Selection, force: boolean, reason = "select") => {
    if (!currentIntent(selection)) return false;
    if (viaOf(selection)) { followed(selection.via); return true; }
    if (!selection.cuts.length) return false;
    const ep = episodeOf(selection);
    if (!force && ep?.episodeBin && lastBin.current === ep.episodeBin) { followed(ep.episodeBin); return true; }
    const result = await aim(selection, reason);
    noteTarget(selection, result);
    if (!currentIntent(selection)) return false;
    check(result);
    if (!aimed(selection, result)) return false;
    setNotice(t("컷 빈 {count}개 — 다빈치에서 컷 빈에 들어가면 가져옵니다").replace("{count}", String(Object.keys(result.bins || {}).length)));
    return true;
  };
  // 다른 에피소드로 옮긴 뒤 앞 에피소드의 컷 빈 정리(Jay 결정 2) — 새 target 뒤에 돈다(사람이 앞 컷 빈 안에 있으면 지금 빈을 지우게 되므로).
  //  컷 빈 전부를 settle 한 번에(Jay 11-12 '하나씩 지워져 느리다') — 쓰인 것·사람 것·다빈치가 들어가 있는 빈·이름 바뀐 빈은 리졸브 쪽이 남긴다.
  //  도는 중에 그 에피소드를 다시 고르면 그 선택의 target·미리 띄우기가 대기열에서 이 뒤에 돌아 다시 채운다.
  const settleEpisode = async (previous: Selection) => {
    const ep = episodeOf(previous);
    if (!ep) return settle(previous); // 빈 표가 없으면(다시 연 뒤 등) 지금처럼 앞 컷만 — 빈은 지우지 않는다
    const bins = Object.entries(ep.bins).filter(([, bin_id]) => bin_id).map(([folder_path, bin_id]) => ({ folder_path, bin_id }));
    if (bins.length) {
      if (!valid(previous) || sameEpisode(selected.current, previous)) return;
      const result = await panel.settle({ ...writer(previous), reason: "settle", folder_path: previous.episode || previous.folder_path, bins });
      if (!valid(previous)) return;
      check(result);
      if (!sameDavinci(previous, result)) return; // 다른 다빈치 프로젝트면 쓰지 않았다
      // restore_failed = 정리는 끝났는데 빈을 지운 뒤 다빈치 지금 빈을 되돌리지 못했다 — 알리고 쓴 것 옮기기는 이어 간다
      if (result.state === "restore_failed") setFailures(list => [...new Set([...list, t("다빈치 지금 빈을 처음 자리로 되돌리지 못했습니다")])]);
      else if (result.state !== "ok") throw new Error(t("앞 컷 정리를 확인하지 못했습니다") + ": " + panelFailure(result.state));
      // 쓰인 것은 지우지 않았다 — 그 뒤 NAS 로(실패는 알림에 모으고 다음 항목)
      for (const { folder_path, bin_id } of bins) {
        for (const id of result.bins?.[folder_path]?.used || []) {
          if (!valid(previous) || sameEpisode(selected.current, previous)) return;
          try { await adoptOne({ ...previous, folder_path }, id, result.resolve_project_id!, bin_id); }
          catch (error) { setFailures(list => [...new Set([...list, errorText(error)])]); }
        }
      }
    }
    if (episodes.current.get(episodeKey(previous)) === ep) episodes.current.delete(episodeKey(previous));
  };
  // 앞 에피소드 정리는 새 목적 빈을 맞춘 뒤에만 — target 이 실패했거나 맞추기 전에 또 옮겼으면 미뤄 두고 다음에 맞췄을 때 같이 한다
  const settleLeftovers = async () => {
    const done = new Set<string>();
    for (const old of leftovers.current.splice(0)) {
      if (done.has(episodeKey(old)) || sameEpisode(selected.current, old)) continue;
      done.add(episodeKey(old));
      await settleEpisode(old);
    }
  };
  // target은 선택 의도로 이어받고 cache·stage는 내용 판까지 대조한다. cache 동안 실행자는 비워 둔다.
  const stageCut = async (selection: Selection, gens: Generation[], align: boolean, reason: string, background = false, force = false) => {
    if (!currentContents(selection)) return;
    const pending = background ? null : beginPreparation(selection.intent!, selection.seq);
    if (!background) { readyDrag.current = {}; setDragItems({}); setSelectionPhase(""); }
    try {
      let targetWork = intentTarget.current;
      if (!targetWork || targetWork.intent !== selection.intent) {
        targetWork = { intent: selection.intent!, align, reason, force };
        intentTarget.current = targetWork;
      }
      if (!targetWork.done) {
        const request = targetWork;
        if (!request.align) request.done = Promise.resolve(true);
        else {
          let moved = false;
          request.done = enqueue(async () => {
            if (!currentIntent(selection)) return;
            const chosen = selected.current!;
            if (chosen.folder_path === chosen.episode) moved = await alignEpisode(chosen, request.force, request.reason);
            else {
              const via = viaOf(chosen), bin = via || binOf(chosen);
              if (bin && (via || lastBin.current === bin)) { followed(bin); moved = true; }
              else {
                const result = await aim(chosen, request.reason);
                noteTarget(chosen, result);
                if (!currentIntent(chosen)) return;
                check(result); moved = aimed(chosen, result);
              }
            }
            if (moved && currentIntent(selection)) await settleLeftovers();
          }).then(() => { request.settled = true; return moved; });
        }
      }
      if (!await targetWork.done || !currentContents(selection) || selection.folder_path === selection.episode) return;
      const capped = selection.capped || gens.length > 200;
      gens = [...gens].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id)).slice(0, 200);
      if (!background) setSelectionPhase(t("받는 중"));
      for (const gen_ids of cacheBatches(gens.map(gen => gen.id))) {
        const cached = await panel.cache({ ...selection, gen_ids });
        if (!currentContents(selection)) return;
        for (const item of cached.items || []) if (item.state === "cached") cachedIds.current.add(cacheKey(selection.ctx, selection.project_id, item.gen_id));
        setPreviews(previous => ({ ...previous, ...Object.fromEntries((cached.items || []).filter(item => item.state === "cached"
          && item.preview_url?.startsWith("/media/")).map(item => [item.gen_id, item.preview_url!])) }));
        if (cached.state) check(cached as { state: string });
        const failed = cached.items.filter(item => item.state !== "cached");
        if (failed.length) throw new Error(failed.map(item => item.gen_id + ": " + item.error).join(", "));
      }
      if (!currentContents(selection)) return;
      await enqueue(async () => {
        if (!currentContents(selection)) return;
        if (!background) setSelectionPhase(t("넣는 중"));
        const bin = viaOf(selection) || binOf(selection);
        const result = await panel.stage({ ...writer(selection), reason, capped, gen_ids: gens.map(gen => gen.id), ...(bin ? { bin_id: bin } : {}) });
        if (!currentContents(selection)) return;
        check(result);
        if (!sameDavinci(selection, result)) return;
        setStage(result);
        if (result.state === "ok" && result.resolve_project_id === davinciRef.current) {
          readyDrag.current = result.drag_items || {}; setDragItems(readyDrag.current);
          resolveCheckedAt.current = Date.now();
        }
        const failed = stageSummary(result).failed.map(item => itemName(item.gen_id) + ": " + panelFailure(item.state));
        if (!["ok", "stale"].includes(result.state)) failed.push(typeof result.details === "string" ? result.details : panelFailure(result.state));
        if (failed.length) setFailures(previous => [...new Set([...previous, ...failed])]);
        const deferred = result.deferred || result.items?.some(item => item.state === "deferred");
        setSelectionPhase(result.state !== "ok" ? panelFailure(result.state) : deferred ? t("선택한 빈에서 가져오기 대기") : "");
        if (result.bin_path) setNotice(t("리졸브 빈") + ": " + result.bin_path);
      }, background, background, () => currentContents(selection), true);
    } catch (error) {
      if (currentContents(selection)) { setSelectionPhase(""); setFailures(previous => [...new Set([...previous, errorText(error)])]); }
    } finally {
      if (currentContents(selection)) setSelectionPhase(phase => phase === t("받는 중") || phase === t("넣는 중") ? "" : phase);
      endPreparation(pending);
    }
  };
  const selectFolder = useCallback((project_id: string, episode: string, cut: string, gens: Generation[], capped = false, cuts: string[] = []) => {
    readyDrag.current = {}; setDragItems({}); setSelectionPhase("");
    const previous = selected.current, ctx = context.current;
    if (previous?.project_id !== project_id || previous?.episode !== episode) {
      precacheRun.current++; fillRun.current = null; stableBin.current = null; setFillProgress(null);
    }
    generations.current = gens;
    const folder_path = cut || episode;
    const via = followRef.current?.key === JSON.stringify([project_id, episode, cut]) ? followRef.current.bin : "";
    followRef.current = null;
    const intent = preparation.current?.seq === undefined && preparation.current ? preparation.current.intent : ++intentNumber.current;
    const selection = ctx && project_id && folder_path
      ? { ctx, project_id, folder_path, episode, cuts, via, capped, resolveProject: davinciRef.current, window: windowId, seq: ++sequence.current, revision: revision.current, intent } : null;
    selected.current = selection; setStage(null); autoTried.current = "";
    intentTarget.current = null;
    if (AUTO_CLEANUP && previous && !sameEpisode(previous, selection)) leftovers.current.push(previous);
    if (selection) void stageCut(selection, gens, true, via ? "follow" : "select", false, !sameEpisode(previous, selection));
    else { endPreparation(preparation.current); void enqueue(settleLeftovers); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId]);
  const updateSet = useCallback((gens: Generation[], capped = false) => {
    const selection = selected.current;
    if (!selection || !currentIntent(selection)) return;
    readyDrag.current = {}; setDragItems({}); setSelectionPhase("");
    generations.current = gens;
    const next = { ...selection, capped, seq: ++sequence.current };
    selected.current = next;
    void stageCut(next, gens, false, "update");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const align = (cuts?: string[]) => {
    if (!selected.current) return;
    const intent = interact();
    const chosen = { ...selected.current, intent, via: "", ...(Array.isArray(cuts) ? { cuts } : {}) };
    selected.current = chosen; autoTried.current = "";
    void stageCut(chosen, generations.current, true, "align", false, true);
  };
  // 실시간 — 고른 에피소드에 빈 표 없는 활성 컷이 생겼다: 사람이 보던 지금 빈을 지키며 만들고 줄 세운다(target keep_current, 지금 선택의 seq).
  //  busy·stale 이 아닌 실패면 같은 활성 컷 묶음으로는 다시 자동으로 부르지 않는다(실패마다 저장·백업이 되풀이되지 않게).
  syncRef.current = (cuts: string[]) => {
    const selection = selected.current;
    const ep = selection && selection.episode ? episodeOf(selection) : null;
    if (!selection || !ep || !cuts.some(path => !ep.bins[path])) return;
    if (autoBusy.current) { autoNext.current = cuts; return; }
    const key = JSON.stringify([episodeKey(selection), [...cuts].sort()]);
    if (autoTried.current === key) return;
    autoBusy.current = true;
    void enqueue(async () => {
      try {
        const now = selected.current;
        if (!valid(selection) || !now || !valid(now) || !sameEpisode(now, selection)) return;
        const result = await panel.target({ ...writer(now), reason: "sync", folder_path: now.episode, create: true, episode_path: now.episode,
          create_paths: cuts, keep_current: true });
        noteTarget(now, result); // 돌려준 bin_id 는 되돌린 사람의 지금 빈 — lastBin·목적 빈으로 쓰지 않는다
        if (!valid(now)) return;
        check(result);
        if (!sameDavinci(now, result)) return;
        // 일부 빈만 못 만든 ok 도 실패 — 안 그러면 목록을 다시 읽을 때마다 빠진 빈을 보고 같은 묶음을 또 부른다
        const partial = !!result.bin_create_failed?.length;
        if (partial || (result.state !== "ok" && !["busy", "stale"].includes(result.state))) {
          autoTried.current = key;
          if (!partial) setFailures(list => [...new Set([...list, t("새 컷 빈을 만들지 못했습니다") + ": " + panelFailure(result.state)])]);
        }
      } catch (error) {
        autoTried.current = key; // 요청 자체가 실패해도 같은 묶음으로 되풀이하지 않는다(대기열이 오류를 알린다)
        throw error;
      } finally {
        autoBusy.current = false;
        const next = autoNext.current;
        autoNext.current = null;
        if (next) syncRef.current(next);
      }
    }, true);
  };
  const syncCuts = useCallback((cuts: string[]) => syncRef.current(cuts), []);
  // 미리 캐시 — 에피소드 컷 순서로 받는다. 고른 컷의 받기·띄우기는 대기열에서 우선한다.
  //  선택의 일이 먼저: 최신 선택 준비가 끝나야 다음 받기를 시작한다. 새 선택의 cache·target 은 허브에서 seq 를 올려 이 요청을 파일 사이에서 멈춘다.
  //  한 판은 시작 때의 프로젝트·에피소드·계정 문맥·목록에 묶인다. seq 는 지금 선택의 것(정리용 순번이 선택을 stale 로 만들지 않게).
  //  cached로 확인된 것만 다시 묻지 않는다. 미완료 항목은 같은 판에서 재개하고 진행 줄에 남긴다.
  // 판이 그대로이고 같은 문맥·프로젝트·에피소드를 고르고 있으면 지금 선택(미리 캐시·미리 띄우기·이름 뒤따르기가 같이 쓴다)
  const runLive = (run: number, ctx: PanelIdentity | null, project_id: string, episode: string) => {
    const now = selected.current;
    return !savingRef.current && run === precacheRun.current && ctx && now && valid(now) && contextKey(now.ctx) === contextKey(ctx)
      && ctx.generation === context.current?.generation
      && now.project_id === project_id && now.episode === episode ? now : null;
  };
  const toCuts = (ep: EpisodeBins, cuts: PrecacheCut[]): PanelCut[] => cuts.filter(([path, ids]) => ep.bins[path] && ids.length)
    .map(([folder_path, gen_ids, capped]) => ({ folder_path, bin_id: ep.bins[folder_path], gen_ids, ...(capped ? { capped } : {}) }));
  // 이름 뒤따르기 — 대기열에 작은 작업(5개·읽기 20개)을 이어 넣는다. 이어갈 자리(after)가 남아 있으면 그 자리부터(자리가 앞으로 가는 것이 진전),
  //  끝까지 훑었는데 도중에 못 바꾼 것이 있었으면 처음부터 한 번만 더. 판이 바뀌면 멈춘다.
  const renameStep = (plan: FillRun) => {
    if (plan.renaming || !plan.renameCuts.size) return;
    const cuts: PrecacheCut[] = [...plan.renameCuts].map(([path, ids]) => [path, [...ids]]);
    plan.renameCuts.clear(); plan.renaming = true;
    const step = (after?: [number, number], failedBefore = false, retried = false) => void enqueue(async () => {
      let continuing = false, complete = false;
      try {
        const now = runLive(plan.run, plan.ctx, plan.project_id, plan.episode);
        const ep = now && episodeOf(now);
        if (!now || !ep || !toCuts(ep, cuts).length) return;
        const result = await panel.rename({ ...writer(now), reason: "rename", folder_path: plan.episode, cuts: toCuts(ep, cuts), limit: 5, ...(after ? { after } : {}) });
        if (!runLive(plan.run, plan.ctx, plan.project_id, plan.episode)) return;
        check(result);
        if (!sameDavinci(now, result) || result.state !== "ok") return;
        const failed = failedBefore || (result.failed || 0) > 0;
        if (result.after) { continuing = true; step(result.after, failed, retried); }
        else if (failed && !retried) { continuing = true; step(undefined, false, true); }
        else complete = !failed;
      } finally {
        if (!continuing) {
          plan.renaming = false;
          if (!complete) for (const [path, ids] of cuts) plan.renameCuts.set(path, new Set([...plan.renameCuts.get(path) || [], ...ids]));
          else renameStep(plan);
        }
      }
    }, true, true, () => !!runLive(plan.run, plan.ctx, plan.project_id, plan.episode));
    step();
  };
  const fillPending = (cut: FillCut) => cut.cut[1].filter(id => !filled(cut.states.get(id)) && (cut.failures.get(id) || 0) < 2);
  const fillFailed = (cut: FillCut, ids: string[], state: string) => {
    for (const id of ids) {
      cut.states.set(id, state);
      cut.failures.set(id, (cut.failures.get(id) || 0) + 1);
    }
  };
  const showFill = (plan: FillRun) => {
    if (fillRun.current !== plan || plan.run !== precacheRun.current) return;
    const done = plan.cuts.filter(cut => cut.cut[1].every(id => filled(cut.states.get(id)))).length;
    const ids = plan.cuts.flatMap(cut => cut.cut[1]);
    const receiving = plan.busy && plan.receiving ? { done: ids.filter(id => plan.ctx && cachedIds.current.has(cacheKey(plan.ctx, plan.project_id, id))).length, total: ids.length } : undefined;
    setFillProgress(done === plan.cuts.length ? null : { episode: plan.episode, done, total: plan.cuts.length, active: plan.busy, ...(plan.waiting ? { waiting: true } : {}), ...(receiving ? { receiving } : {}) });
  };
  // 받기를 끝낸 뒤 조각으로 넣는다. 선택의 일은 받기·조각 사이마다 먼저 끝낸다.
  const fillEpisode = (plan: FillRun, retryBin?: string) => {
    if (plan.busy || !runLive(plan.run, plan.ctx, plan.project_id, plan.episode) || !plan.cuts.some(cut => fillPending(cut).length)) return;
    const remaining = () => plan.cuts.filter(cut => !cut.cut[1].every(id => filled(cut.states.get(id)))).length;
    const remainingIds = () => plan.cuts.reduce((n, cut) => n + cut.cut[1].filter(id => !filled(cut.states.get(id))).length, 0);
    const before = remaining(), beforeIds = remainingIds();
    plan.busy = true; plan.receiving = true; plan.waiting = false; showFill(plan);
    const live = () => runLive(plan.run, plan.ctx, plan.project_id, plan.episode);
    const cached = (id: string) => !!plan.ctx && cachedIds.current.has(cacheKey(plan.ctx, plan.project_id, id));
    void (async () => {
      let chunk: FillCut[] = [], size = 0;
      const send = async () => {
        if (!chunk.length) return;
        const sending = chunk; chunk = []; size = 0;
        await enqueue(async () => {
          const now = live(), ep = now && episodeOf(now);
          if (!now) return;
          const stable = stableBin.current, current = currentRef.current;
          // 기본 읽기 간격(2초)보다 오래된 관측은 다음 읽기까지 기다린다.
          const observed = document.visibilityState !== "hidden" && stable && Date.now() - stable.at <= 2000
            && contextKey(stable.ctx) === contextKey(context.current) && stable.ctx.generation === context.current?.generation
            && stable.project === now.resolveProject && current?.state === "ok"
            && current.resolve_project_id === stable.project && current.bin_id === stable.bin ? stable : null;
          const borrow = !!observed && observed.count >= 2 && !!ep?.episodeBin && observed.bin !== ep.episodeBin;
          const parts: PanelCut[] = [];
          const attempted = new Map<FillCut, string[]>();
          for (const cut of sending) {
            const pending = fillPending(cut).filter(cached);
            if (!pending.length) continue;
            if (!ep?.bins[cut.cut[0]]) { fillFailed(cut, pending, "not_seen"); continue; }
            if (!observed || (!borrow && observed.bin !== ep.episodeBin && observed.bin !== ep.bins[cut.cut[0]])) {
              plan.waiting = true;
              continue;
            }
            // 완료 항목도 wanted에 포함한다. 재시도 상한으로 제외한 항목은 capped로 삭제에서 보호한다.
            const gen_ids = cut.cut[1].filter(id => cached(id) && (filled(cut.states.get(id)) || pending.includes(id)));
            parts.push({ folder_path: cut.cut[0], bin_id: ep.bins[cut.cut[0]], gen_ids, capped: !!cut.cut[2] || gen_ids.length < cut.cut[1].length });
            attempted.set(cut, gen_ids);
          }
          if (!parts.length || !ep) return;
          try {
            const result = await panel.prestage({ ...writer(now), reason: "fill", folder_path: plan.episode, episode_bin_id: ep.episodeBin,
              cuts: parts, borrow, borrow_bin_id: borrow ? observed!.bin : "" });
            // 판이 끝나도 같은 계정·다빈치 프로젝트의 복원/자식 오류는 알려야 한다.
            if (contextKey(now.ctx) === contextKey(context.current) && now.resolveProject === davinciRef.current
              && (!result.resolve_project_id || result.resolve_project_id === now.resolveProject)
              && result.state !== "account_changed" && result.state !== "project_changed" && result.code !== "project_changed") {
              if (borrow) stableBin.current = null;
              const alerts = [
                ...(result.restore_failed ? [t("다빈치 지금 빈을 처음 자리로 되돌리지 못했습니다")] : []),
                ...(["unavailable", "unknown"].includes(result.state) ? [t("다빈치 지금 빈·클립을 확인해 주세요")] : []),
              ];
              if (alerts.length) setFailures(list => [...new Set([...list, ...alerts])]);
            }
            if (!live()) return;
            check(result);
            if (!sameDavinci(now, result) || !live()) return;
            if (result.restore_failed || result.restored === false) stableBin.current = null;
            if (result.state !== "ok") setFailures(list => [...new Set([...list, t("미리 띄우지 못했습니다") + ": " + panelFailure(result.state)])]);
            for (const [cut, ids] of attempted) {
              const done = result.cuts?.[cut.cut[0]];
              const states = new Map(done?.items?.map(item => [item.gen_id, item.state]));
              for (const id of ids) {
                const state = result.state !== "ok" ? result.state : done?.state !== "ok" ? done?.state || "unavailable" : states.get(id) || "import_failed";
                if (["staged", "present"].includes(state) && !["staged", "present"].includes(cut.states.get(id) || "")) {
                  if (!plan.renameCuts.has(cut.cut[0])) plan.renameCuts.set(cut.cut[0], new Set());
                  plan.renameCuts.get(cut.cut[0])!.add(id);
                }
                if (filled(state) || state === "deferred") cut.states.set(id, state);
                else fillFailed(cut, [id], state);
              }
              const failed = stageSummary(done || { state: result.state }).failed;
              if (failed.length) setFailures(list => [...new Set([...list, ...failed.map(item => itemName(item.gen_id) + ": " + panelFailure(item.state))])]);
            }
          } catch (error) {
            if (!live()) return;
            for (const [cut, ids] of attempted) fillFailed(cut, ids, "unavailable");
            stableBin.current = null;
            setFailures(list => [...new Set([...list, errorText(error), t("다빈치 지금 빈·클립을 확인해 주세요")])]);
          }
          showFill(plan);
        }, true, true, () => !!live());
      };
      const interrupted = new Map<FillCut, Set<string>>();
      for (let pass = 0; pass < 2; pass++) for (const cut of plan.cuts) {
        if (!live()) return;
        // 선택의 cache·target·stage 가 먼저 끝난 뒤 현재 seq 로 받는다.
        for (const batch of cacheBatches(fillPending(cut).filter(id => !cached(id) && (!pass || interrupted.get(cut)?.has(id))))) {
          while (preparation.current) { await preparation.current.done; if (!live()) return; }
          const now = live();
          if (!now) return;
          const gen_ids = batch.filter(id => !cached(id));
          if (!gen_ids.length) continue;
          try {
            const result = await panel.cache({ ctx: now.ctx, project_id: plan.project_id, folder_path: cut.cut[0], window: now.window, seq: now.seq, gen_ids });
            if (!live()) return;
            if (result.state) check(result as { state: string });
            const returned = new Map(result.items.map(item => [item.gen_id, item]));
            for (const id of gen_ids) {
              const item = returned.get(id);
              if (item?.state === "cached") cachedIds.current.add(cacheKey(now.ctx, plan.project_id, id));
              else if (item || live()?.seq === now.seq) fillFailed(cut, [id], "cache_failed");
              else {
                cut.states.set(id, "deferred"); // seq 중단은 받기 끝에서 한 번 더, 실패 횟수는 그대로
                if (!interrupted.has(cut)) interrupted.set(cut, new Set());
                interrupted.get(cut)!.add(id);
              }
            }
            setPreviews(previous => ({ ...previous, ...Object.fromEntries(result.items.filter(item => item.state === "cached"
              && item.preview_url?.startsWith("/media/")).map(item => [item.gen_id, item.preview_url!])) }));
          } catch {
            if (!live()) return;
            fillFailed(cut, gen_ids, "cache_failed");
          }
          showFill(plan);
        }
      }
      if (!live()) return;
      plan.receiving = false; showFill(plan);
      for (const cut of plan.cuts) {
        if (!live()) return;
        if (fillPending(cut).some(cached)) {
          const count = cut.cut[1].filter(cached).length;
          if (chunk.length && (size + count > 220 || chunk.length >= 200)) await send();
          chunk.push(cut); size += count;
          if (size >= 220) await send();
        }
      }
      await send();
      if (live()) renameStep(plan);
    })().catch(error => {
      if (live()) setFailures(list => [...new Set([...list, errorText(error)])]);
    }).finally(() => {
      if (live() && !plan.waiting && retryBin && remaining() >= before && remainingIds() >= beforeIds) plan.blockedBin = retryBin;
      plan.busy = false; showFill(plan);
    });
  };
  const precache = useCallback((project_id: string, episode: string, cuts: PrecacheCut[]) => {
    const plan: FillRun = { run: ++precacheRun.current, ctx: context.current, project_id, episode, busy: false, renameCuts: new Map(),
      cuts: [...new Map(cuts.filter(([, ids]) => ids.length).map(cut => [cut[0], cut])).values()]
        .map(cut => ({ cut, states: new Map(), failures: new Map() })) };
    lastPrecache.current = { project_id, episode, cuts };
    fillRun.current = plan; showFill(plan); fillEpisode(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // [저장](Jay 11-12) — 쓴 것은 NAS 로 옮기고 안 쓴 것은 정리한 뒤, 리졸브 자식이 미디어 풀을 훑어 깨끗할 때만 저장한다. 끝나면 다시 미리 띄운다.
  //  저장할 다빈치 프로젝트는 첫 inventory 결과로 고정하고 모든 쓰기에 싣는다(다르면 쓰기 0). '깨끗함'은 그 저장 시점만 — 단축키·자동 저장은 이 단추를 거치지 않는다.
  const saveProject = (project_id: string, folder_path: string) => {
    const ctx = context.current;
    if (savingRef.current || !ctx?.writer || !hasResolveBridge(window.mvhubResolve) || !project_id) return;
    readyDrag.current = {}; setDragItems({});
    savingRef.current = true; fillRun.current = null; setFillProgress(null);
    precacheRun.current++; // 진행 중인 미리 띄우기·이름 뒤따르기를 멈춘다(대기열의 조각 하나까지 기다림)
    setSaving(true); setNotice(t("저장 중")); setSaveState({ phase: "saving", step: t("확인 중") });
    const rev = revision.current;
    const epoch = authEpoch.current, ownerGeneration = ctx.generation;
    const saveContextValid = () => active.current && authEpoch.current === epoch && revision.current === rev
      && contextKey(context.current) === contextKey(ctx) && context.current?.writer === true
      && context.current.generation === ownerGeneration && hasResolveBridge(window.mvhubResolve);
    const checkSaveContext = () => {
      if (saveContextValid()) return;
      const reason = authEpoch.current !== epoch || contextKey(context.current) !== contextKey(ctx) ? "account_changed"
        : !context.current?.writer || context.current.generation !== ownerGeneration ? "other_window" : "project_changed";
      throw new Error(t("저장하지 않았습니다") + ": " + panelFailure(reason));
    };
    let ended = false; // 끝 상태(저장됨·막힘)를 적었나 — 못 적고 끝나면(예외) 막힘
    let savedOk = false;
    let savedProject = "";
    void enqueue(async () => {
      try {
        let after: [string, string] | undefined, fixed = "";
        const all: InventoryItem[] = [];
        do {
          checkSaveContext();
          const result = await panel.inventory(ctx, after);
          checkSaveContext();
          check(result);
          if (result.state !== "ok") throw new Error(t("저장하지 않았습니다") + ": " + panelFailure(result.state));
          if (result.unmanaged_local) throw new Error(t("저장하지 않았습니다") + ": " + t("소유를 확인하지 못한 로컬 클립이 있습니다 — 다빈치에서 확인해 주세요"));
          if (fixed && result.resolve_project_id !== fixed) throw new Error(t("저장하지 않았습니다") + ": " + panelFailure("project_changed"));
          fixed = result.resolve_project_id || "";
          all.push(...result.items || []);
          after = result.more ? result.after : undefined;
          if (result.more && !after) throw new Error(t("저장하지 않았습니다") + ": " + t("확인 못 함"));
        } while (after);
        if (!fixed || rev !== revision.current) throw new Error(t("저장하지 않았습니다") + ": " + panelFailure("project_changed"));
        const pinned = (item: { project_id: string; folder_path: string }): Selection => ({ ctx, project_id: item.project_id, folder_path: item.folder_path,
          episode: "", cuts: [], via: "", resolveProject: fixed, window: windowId, seq: ++sequence.current, revision: rev });
        let moved = 0, cleaned = 0;
        const failed: string[] = [], unused = new Map<string, { bin_id: string; selection: Selection }>();
        const missing = new Set<string>();
        const toMove = all.filter(item => item.resolve_project_id === fixed && ["recover", "adopt"].includes(inventoryAction(item))).length;
        for (const item of all) {
          checkSaveContext();
          if (item.resolve_project_id !== fixed || missing.has(item.item_id)) continue;
          const action = inventoryAction(item);
          if (action === "recover" || action === "adopt") {
            setSaveState({ phase: "saving", step: `NAS ${moved + failed.length + 1}/${toMove}` });
            try {
              const result = await adoptOne(pinned(item), item.gen_id, fixed, item.bin_id, [item.item_id], item.recovery, true);
              for (const id of result?.missing_record_ids || []) missing.add(id);
              if (result?.state === "in_bin") moved++;
            }
            catch (error) { failed.push(errorText(error)); }
          } else if (action === "unstage") unused.set(JSON.stringify([item.project_id, item.bin_id]), { bin_id: item.bin_id, selection: pinned(item) });
        }
        if (unused.size) setSaveState({ phase: "saving", step: t("정리") });
        const groups = new Map<string, { bin_id: string; selection: Selection }[]>();
        for (const { bin_id, selection } of unused.values()) {
          const rows = groups.get(selection.project_id) || [];
          rows.push({ bin_id, selection }); groups.set(selection.project_id, rows);
        }
        for (const rows of groups.values()) for (let start = 0; start < rows.length; start += 200) {
          checkSaveContext();
          const chunk = rows.slice(start, start + 200);
          const removed = await panel.unstage({ ...writer(chunk[0].selection), reason: "save",
            bins: chunk.map(({ bin_id, selection }) => ({ bin_id, folder_path: selection.folder_path })) });
          checkSaveContext();
          check(removed);
          if (removed.state === "project_changed" || removed.code === "project_changed"
              || (removed.resolve_project_id && removed.resolve_project_id !== fixed)) throw new Error(t("저장하지 않았습니다") + ": " + panelFailure("project_changed"));
          if (removed.state !== "ok") throw new Error(t("저장하지 않았습니다") + ": " + panelFailure(removed.state));
          cleaned += removed.removed || 0;
        }
        if (failed.length) { // 쓴 클립이 이 PC 경로인 채 저장되지 않게 — NAS 로 다 옮기지 못하면 저장하지 않는다
          setFailures(list => [...new Set([...list, ...failed])]);
          setNotice(t("저장하지 않았습니다") + ` — ${t("NAS로 못 옮긴 것")} ${failed.length}`);
          ended = true; setSaveState({ phase: "blocked", bins: [] });
          return;
        }
        checkSaveContext();
        setSaveState({ phase: "saving", step: t("검사") });
        const saved = await panel.save({ ctx, project_id, folder_path: folder_path || project_id, window: windowId, expect_project: fixed, reason: "save" });
        checkSaveContext();
        check(saved);
        ended = true;
        if (saved.state === "ok") {
          savedOk = true; savedProject = fixed;
          setNotice(`${t("저장했습니다 — 이 저장 시점의 검사 통과")} · ${t("NAS로 옮김")} ${moved} · ${t("정리")} ${cleaned}`);
          setSaveState({ phase: "done", at: Date.now() });
        } else if (saved.project_saved) {
          const reason = saved.state === "cleanup_failed" ? panelFailure("cleanup_failed")
            : saved.cleanup_failed ? t("전환 기록과 복구 기록 정리를 마치지 못했습니다. 다시 저장해 주세요")
              : t("전환 기록을 마치지 못했습니다. 다시 저장해 주세요");
          setNotice(t("프로젝트는 저장했습니다") + " — " + reason);
          setSaveState({ phase: "blocked", bins: [] });
        } else if (saved.state === "not_clean" && saved.not_clean) {
          const left = saved.not_clean;
          setNotice(`${t("이 PC 클립이 남아 저장하지 않았습니다")} — ${t("내 것")} ${left.mine} · ${t("다른 허브")} ${left.other} · ${t("쓰는 중")} ${left.in_use}`);
          setSaveState({ phase: "blocked", bins: left.bins }); // 걸린 빈은 [저장] 칸 옆 목록에(C안 ④) — 알림 목록에 또 넣지 않는다
        } else {
          setNotice(t("저장하지 않았습니다") + ": " + panelFailure(saved.state));
          setSaveState({ phase: "blocked", bins: [] });
        }
      } catch (error) {
        setNotice(errorText(error));
        throw error;
      } finally {
        readyDrag.current = {}; setDragItems({});
        if (!ended) setSaveState({ phase: "blocked", bins: [] }); // 예외로 끝남(확인 실패·프로젝트 바뀜 등) — 이유는 알림에
        savingRef.current = false; setSaving(false);
        const last = lastPrecache.current;
        if (savedOk && saveContextValid()) {
          const now = selected.current;
          if (now && valid(now) && now.resolveProject === savedProject && now.folder_path !== now.episode) {
            if (!preparation.current) void stageCut(now, generations.current, false, "save-refill", true);
          }
          if (last) precache(last.project_id, last.episode, last.cuts);
        }
      }
    });
  };
  const retry = () => {
    adopted.current.clear(); failedAdoptions.current.clear(); recovered.current = ""; setFailures([]);
    setRecoveryRun(value => value + 1);
    const selection = selected.current;
    if (selection) {
      const target = intentTarget.current;
      const keepTarget = currentIntent(selection) && !!target && target.intent === selection.intent && target.align && !target.settled;
      // 아직 끝나지 않은 이동은 이어받고, 옛 내용의 cache·stage만 무효로 한다.
      const chosen = { ...selection, intent: interact(keepTarget), seq: ++sequence.current };
      selected.current = chosen;
      void stageCut(chosen, generations.current, false, "retry");
    }
  };
  const takeover = async () => {
    if (!hasResolveBridge(window.mvhubResolve)) return;
    const next = await panel.identity(windowId, true);
    context.current = next; setIdentity(next); checkedAt.current = Date.now(); recovered.current = "";
    align();
  };

  useEffect(() => {
    if (!identity?.writer || !hasResolveBridge(window.mvhubResolve)) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    // 선택이 없어도 읽는다 — 열린 다빈치 프로젝트 ID 를 알아야 그 프로젝트의 저장된 선택을 꺼내고, 바뀌면 앞 일을 버린다
    const poll = async () => {
      if (!mounted) return;
      if (document.visibilityState !== "hidden" && context.current?.writer && hasResolveBridge(window.mvhubResolve) && !pollPending.current) {
        pollPending.current = true;
        try { await enqueue(async () => {
          const ctx = context.current;
          if (!mounted || !active.current || !ctx?.writer || document.visibilityState === "hidden") return;
          const selection = selected.current && valid(selected.current) ? selected.current : null;
          let result: TargetResult;
          try { result = await panel.currentBin(ctx, selection?.project_id ?? "", selection?.folder_path ?? ""); }
          catch (error) { stableBin.current = null; quietBin.current = null; throw error; }
          if (contextKey(ctx) !== contextKey(context.current) || ctx.generation !== context.current?.generation || !context.current?.writer) { stableBin.current = null; return; }
          check(result);
          if (result.state === "ok") noteDavinci(result.resolve_project_id);
          if (!selection || !valid(selection)) return; // 다빈치 프로젝트가 바뀌었으면 noteDavinci 가 앞 선택을 무효로 했다
          if (selected.current === selection) {
            currentRef.current = result; setCurrent(result);
            resolveCheckedAt.current = result.state === "ok" ? Date.now() : 0;
          }
          const awaitingTarget = intentTarget.current?.align && !intentTarget.current.settled;
          const changed = !awaitingTarget && stillAt(selection) && result.state === "ok" && !!result.bin_id && result.bin_id !== lastBin.current;
          const ep = episodeOf(selection);
          const owners = ep ? Object.entries(ep.bins).filter(([, id]) => id === result.bin_id) : [];
          const cut = owners.length === 1 ? owners[0][0] : ep && result.bin_id === ep.episodeBin ? "" : null;
          const here = selection.folder_path === selection.episode ? "" : selection.folder_path;
          if (changed) {
            if (ep && cut !== null && (cut !== here || cut !== "")) interact();
            else {
              // 선택 없는 관측은 배경만 보류한다. 진행 중 cache의 준비 표식은 유지한다.
              backgroundPaused.current = true; quietBin.current = null;
              readyDrag.current = {}; setDragItems({});
            }
          }
          const stable = stableBin.current;
          if (result.state === "ok" && result.bin_id && result.resolve_project_id) {
            const quiet = quietBin.current;
            quietBin.current = { bin: result.bin_id, project: result.resolve_project_id, at: Date.now(),
              count: quiet?.bin === result.bin_id && quiet.project === result.resolve_project_id ? quiet.count + 1 : 1 };
            const count = stable?.project === result.resolve_project_id && stable.bin === result.bin_id && stable.ctx.generation === ctx.generation ? stable.count + 1 : 1;
            stableBin.current = { project: result.resolve_project_id, bin: result.bin_id, count, ctx, at: Date.now() };
            const plan = fillRun.current;
            if (plan) {
              // 읽기 실패·창 숨김만으로 진전 없는 같은 빈의 재시도를 다시 열지 않는다.
              if (plan.blockedBin !== result.bin_id) plan.blockedBin = undefined;
              if (!plan.blockedBin) fillEpisode(plan, result.bin_id);
            }
          } else { stableBin.current = null; quietBin.current = null; }
          // 다빈치에서 빈을 옮겼다(바뀔 때 한 번만) — 이 에피소드의 컷 빈이면 그 컷으로, 에피소드 빈이면 컷 선택을 풀고 따라간다.
          //  bins 밖 빈(사람 빈·다른 에피소드)은 아무것도 하지 않는다.
          //  응답을 기다리는 사이 다른 자리를 골랐으면 반영하지 않는다(다음 읽기가 새 선택으로 다시 본다).
          if (changed) {
            lastBin.current = result.bin_id!;
            setHere(ep && cut !== null ? cut || ep.episode : "");
            if (ep && cut !== null && cut !== here) {
              followRef.current = { key: JSON.stringify([ep.project_id, ep.episode, cut]), bin: result.bin_id! };
              setFollow(previous => ({ project: ep.project_id, episode: ep.episode, cut, n: (previous?.n || 0) + 1 }));
            } else if (ep && cut && selected.current) {
              // 이미 고른 컷 빈에 다시 들어왔다(보류됐던 것) — target 없이 한 번 가져온다
              const now = { ...selected.current, intent: intentNumber.current };
              selected.current = now;
              void stageCut(now, generations.current, false, "reenter");
            }
          }
          // 새 NAS 전환은 [저장]에서만 시작한다. 사용 감지는 표시만 갱신한다.
        }); } finally { pollPending.current = false; }
      } else if (document.visibilityState === "hidden") { stableBin.current = null; quietBin.current = null; }
      // 따라갈 빈 표가 있으면 0.7초, 없으면 2초 — 자식 프로세스(~0.17초)를 따라갈 것이 있을 때만 자주 띄운다(11-12 띄움 속도)
      const now = selected.current;
      if (mounted) timer = setTimeout(() => void poll(), now && valid(now) && episodeOf(now) ? 700 : 2000);
    };
    void poll();
    return () => { mounted = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.instance, identity?.account, identity?.epoch, identity?.writer]);

  useEffect(() => {
    if (!identity?.writer || !hasResolveBridge(window.mvhubResolve)) return;
    const key = contextKey(identity) + ":" + identity.generation;
    if (recovered.current === key) return;
    recovered.current = key;
    const ctx = identity, rev = revision.current;
    void enqueue(async () => {
      let after: [string, string] | undefined;
      const all: InventoryItem[] = [];
      do {
        if (!active.current || rev !== revision.current || ctx.generation !== context.current?.generation || !context.current?.writer || !hasResolveBridge(window.mvhubResolve)) return;
        const result = await panel.inventory(ctx, after);
        if (!active.current || rev !== revision.current || ctx.generation !== context.current?.generation || contextKey(ctx) !== contextKey(context.current)) return;
        check(result);
        if (result.state !== "ok") { recovered.current = ""; throw new Error(String(result.details || result.state)); }
        noteDavinci(result.resolve_project_id);
        if (rev !== revision.current) return; // 다빈치 프로젝트가 바뀌었다 — 앞 프로젝트 기준의 정리를 하지 않는다
        setCounts({ other_owner: result.other_owner || 0, needs_attention: result.needs_attention || 0 });
        all.push(...result.items || []);
        after = result.more ? result.after : undefined;
        if (result.more && !after) throw new Error(t("확인 못 함"));
      } while (after);
      const bins = new Map<string, Selection>();
      for (const item of all) {
        const selection = { ctx, project_id: item.project_id, folder_path: item.folder_path, episode: "", cuts: [], via: "",
          resolveProject: item.resolve_project_id, window: windowId, seq: ++sequence.current, revision: rev };
        const action = inventoryAction(item);
        if (action === "recover") {
          try { await adoptOne(selection, item.gen_id, item.resolve_project_id, item.bin_id, [item.item_id], item.recovery); }
          catch (error) { setFailures(previous => [...new Set([...previous, errorText(error)])]); }
        } else if (AUTO_CLEANUP && action === "unstage") bins.set(item.bin_id, selection);
      }
      for (const [bin_id, selection] of bins) {
        if (!valid(selection)) return;
        const now = selected.current;
        if (now?.project_id === selection.project_id && (now.folder_path === selection.folder_path || under(selection.folder_path, now.episode))) continue;
        // 다시 열 때 — 그 다빈치 프로젝트의 저장된 선택의 에피소드 컷 빈은 그대로 둔다(결정 1 을 다시 열기에도). inventory 정리는 빈을 지우지 않는다.
        const saved = loadSavedSelection(selection.resolveProject);
        if (saved.project === selection.project_id && under(selection.folder_path, saved.episode || saved.cut)) continue;
        const result = await panel.unstage({ ...writer(selection), reason: "inventory-cleanup", bin_id, inventory_cleanup: true });
        check(result);
        if (!sameDavinci(selection, result)) return;
        if (!["ok", "active_bin", "not_seen"].includes(result.state)) throw new Error(panelFailure(result.state));
      }
    }, true, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.instance, identity?.account, identity?.epoch, identity?.writer, identity?.generation, recoveryRun]);

  const startNativeDrag = (id: string) => {
    const selection = selected.current, item = readyDrag.current[id];
    if (saving || !selection || !valid(selection) || !bridgeCompatible(window.mvhubResolve, context.current)
      || !item?.item_id || !item.path || !generations.current.some(gen => gen.id === id)
      || !selection.resolveProject || selection.resolveProject !== davinciRef.current
      || Date.now() - checkedAt.current > 2000 || !resolveCheckedAt.current || Date.now() - resolveCheckedAt.current > 5000) {
      setNotice(saveState.phase === "blocked" ? t("저장이 막혔습니다 — 남은 항목을 확인하고 다시 저장해 주세요")
        : t("로컬 클립 준비·리졸브 연결을 확인 중입니다 — 준비 후 다시 끌어 주세요"));
      return;
    }
    try {
      if (!window.mvhubResolve!.startDrag(item.path, { protocol: 1 })) setNotice(t("파일 끌기를 시작하지 못했습니다"));
    } catch (error) { setNotice(t("파일 끌기를 시작하지 못했습니다") + ": " + errorText(error)); }
  };
  return { config, needsLogin, authReady, identity, target, current, notice, stage, moved, counts, failures, follow, nas, davinci, here, dragItems, previews, startNativeDrag,
    canRetry: failures.some(failure => !failure.includes(t(RECOVERY_PENDING))),
    selectionPhase, interact, fillProgress, authKey: contextKey(identity), selectFolder, updateSet, align, retry, takeover, syncCuts, precache, saveProject, saving, saveState,
    onAuthed: () => { setNeedsLogin(false); resetAuth(); } };
}

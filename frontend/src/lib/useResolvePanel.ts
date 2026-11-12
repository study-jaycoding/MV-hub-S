import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AuthConfig, Generation } from "../types";
import { APP_EVENTS } from "./appEvents";
import { forgetAuthToken, getAuthToken, setAuthToken, subscribeApiPause } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { t } from "./i18n";
import {
  cacheBatches, contextKey, hasResolveBridge, RECOVERY_PENDING,
  resolvePanelApi as panel, targetView, inventoryAction, stageSummary, panelFailure,
  type PanelIdentity, type PanelSelection, type TargetResult, type StageResult, type InventoryItem,
} from "./resolvePanelApi";

// folder_path = 고른 컷, 컷을 안 골랐으면 에피소드. cuts = 그 에피소드의 생성물 있는 컷(빈을 만들 것)
//  via = 다빈치에서 들어간 빈을 따라와 고른 것이면 그 빈 ID — 늦게 처리돼도 target 으로 다빈치를 끌고 오지 않는다
interface Selection extends PanelSelection { seq: number; window: string; revision: number; capped?: boolean; episode: string; cuts: string[]; via: string }
interface EpisodeBins { project_id: string; episode: string; bins: Record<string, string>; episodeBin: string }
export interface PanelFollow { project: string; episode: string; cut: string; n: number }
// 패널을 닫았다 열어도 남는 선택 — 다시 열 때 inventory 정리가 이 에피소드의 컷 빈은 건드리지 않는다
export const PANEL_SELECTION_KEY = "mvhub.resolvePanel.selection";
export interface SavedSelection { project: string; episode: string; cut: string }
export function loadSavedSelection(): SavedSelection {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_SELECTION_KEY) || "null") as Record<string, unknown> | null;
    const pick = (value: unknown) => (typeof value === "string" ? value : "");
    const cut = pick(raw?.cut);
    return { project: pick(raw?.project), cut, episode: pick(raw?.episode) || cut.split("/").slice(0, -1).join("/") };
  } catch { return { project: "", episode: "", cut: "" }; }
}
const under = (path: string, base: string) => !!base && (path === base || path.startsWith(base + "/"));
// 부모 폴더가 없는 컷(에피소드 없음)은 지금처럼 컷 하나가 한 묶음이다
const sameEpisode = (a: Selection | null, b: Selection | null) => !!a && !!b && a.project_id === b.project_id
  && (a.episode ? a.episode === b.episode : a.folder_path === b.folder_path);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
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
  const revision = useRef(0);
  const sequence = useRef(0);
  const context = useRef<PanelIdentity | null>(null);
  const checkedAt = useRef(0);
  const selected = useRef<Selection | null>(null);
  const targetRef = useRef<TargetResult | null>(null);
  const currentRef = useRef<TargetResult | null>(null);
  const queue = useRef(Promise.resolve());
  const adopted = useRef(new Set<string>());
  const failedAdoptions = useRef(new Map<string, string>());
  const generations = useRef<Generation[]>([]);
  const claimed = useRef(false);
  const lastContext = useRef("");
  const recovered = useRef("");
  const authEpoch = useRef(0);

  const clear = useCallback(() => {
    claimed.current = false;
    revision.current++;
    context.current = null; checkedAt.current = 0; selected.current = null;
    targetRef.current = null; currentRef.current = null;
    adopted.current.clear(); failedAdoptions.current.clear(); recovered.current = "";
    episodes.current.clear(); leftovers.current = []; followRef.current = null; lastBin.current = "";
    setIdentity(null); setTarget(null); setCurrent(null); setStage(null); setMoved(0); setFailures([]); setNotice("");
    setFollow(null); setNas(new Set());
  }, []);
  const resetAuth = useCallback(() => {
    authEpoch.current++; clear(); setAuthReady(false); setAuthRun(n => n + 1);
  }, [clear]);
  // 일반 브라우저는 읽기 전용이며, 대기 중 다리가 사라져도 후속 요청을 보내지 않는다.
  const valid = (selection: Selection) => hasResolveBridge(window.mvhubResolve) && context.current?.writer === true
    && selection.revision === revision.current && contextKey(context.current) === contextKey(selection.ctx);
  // 지금도 그 자리를 고르고 있다(목록 갱신으로 같은 컷의 선택 객체만 바뀐 것은 같은 자리) — null = 선택을 푼 채
  const stillAt = (selection: Selection | null) => selection
    ? selected.current?.project_id === selection.project_id && selected.current.folder_path === selection.folder_path : !selected.current;

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
        context.current = next; checkedAt.current = Date.now(); setIdentity(next);
      } catch (error) {
        if (mounted && epoch === authEpoch.current) { checkedAt.current = 0; setNotice(errorText(error)); }
      } finally { running = false; if (mounted) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    window.addEventListener("focus", poll);
    return () => { mounted = false; clearTimeout(timer); window.removeEventListener("focus", poll); };
  }, [authReady, authRun, clear]);


  const enqueue = (work: () => Promise<unknown>) => {
    queue.current = queue.current.then(async () => { await work(); }).catch(error => setFailures(previous => [...new Set([...previous, errorText(error)])]));
    return queue.current;
  };
  const check = (result: { state: string; details?: unknown }) => {
    if (result.state === "account_changed") { clear(); throw new Error(t("계정 문맥을 확인 중입니다")); }
    if (result.state === "other_window") {
      if (context.current) { context.current = { ...context.current, writer: false }; setIdentity(context.current); }
      throw new Error(t("다른 MV 창이 리졸브를 맡고 있습니다"));
    }
  };
  const itemName = (id: string) => {
    const gen = generations.current.find(item => item.id === id);
    return gen ? [gen.creator_name, gen.model, gen.params?.duration ? String(gen.params.duration) + "s" : ""].filter(Boolean).join(" · ") || id : id;
  };
  const adoptOne = async (selection: Selection, id: string, project: string, bin?: string, itemIds?: string[], recovery = false) => {
    if (!valid(selection)) return;
    const key = JSON.stringify([contextKey(selection.ctx), project, id]);
    if (adopted.current.has(key)) return;
    if (failedAdoptions.current.has(key)) throw new Error(failedAdoptions.current.get(key));
    try {
    if (!recovery) {
      const ready = await panel.prepare({ ...selection, gen_id: id });
      if (!valid(selection)) return;
      check(ready);
      if (ready.state !== "prepared") throw new Error(id + ": " + (ready.error || ready.state));
    }
    if (!valid(selection)) return;
    const result = await panel.adopt({ ...selection, gen_id: id, resolve_project_id: project, bin_id: bin, item_ids: itemIds });
    if (!valid(selection)) return;
    check(result);
    if (result.state !== "in_bin") throw new Error(itemName(id) + ": " + panelFailure(result.state));
    adopted.current.add(key); setMoved(value => value + 1); setNas(previous => new Set(previous).add(id));
    } catch (error) { failedAdoptions.current.set(key, errorText(error)); throw error; }
  };
  const settle = async (selection: Selection) => {
    if (!valid(selection) || sameEpisode(selected.current, selection)) return;
    const result = await panel.currentBin(selection.ctx, selection.project_id, selection.folder_path);
    if (!valid(selection)) return;
    check(result);
    if (result.state === "ok" && (!result.target_bin_id || result.bin_id === result.target_bin_id)) return; // 다빈치가 그 빈 안이면 남긴다
    if (result.state !== "ok" || result.used === undefined) throw new Error(t("앞 컷 정리를 확인하지 못했습니다"));
    for (const id of result.used) await adoptOne(selection, id, result.resolve_project_id!, result.target_bin_id);
    // 기다리는 사이 그 에피소드를 다시 골랐으면(A→B→A) 지우지 않는다
    if (!valid(selection) || !result.target_bin_id || sameEpisode(selected.current, selection)) return;
    const removed = await panel.unstage({ ...selection, bin_id: result.target_bin_id });
    check(removed);
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
  const aim = (selection: Selection) => panel.target({ ...selection, create: true,
    ...(selection.episode && selection.cuts.length ? { episode_path: selection.episode, create_paths: selection.cuts } : {}) });
  const aimed = (selection: Selection, result: TargetResult) => {
    targetRef.current = result; setTarget(result); setNotice(targetView(result).message);
    if (result.state !== "ok") return false;
    if (result.bin_id) lastBin.current = result.bin_id;
    if (result.bins) episodes.current.set(episodeKey(selection), { project_id: selection.project_id, episode: selection.episode,
      bins: result.bins, episodeBin: result.episode_bin_id || "" });
    const failed = result.bin_create_failed || [];
    if (failed.length) setFailures(previous => [...new Set([...previous, t("컷 빈을 만들지 못했습니다") + ": " + failed.join(", ")])]);
    return true;
  };
  // 다빈치가 이미 그 빈 안이다 — target 없이 그 빈을 맞춘 것으로 본다(따라가기는 지금 빈을 바꾸지 않는다)
  const followed = (bin: string) => {
    const now = currentRef.current;
    const result: TargetResult = { state: "ok", resolve_project_id: now?.resolve_project_id, bin_id: bin, bin_path: now?.bin_path };
    targetRef.current = result; setTarget(result);
  };
  // 돌려주는 값 = 다빈치 지금 빈을 새 목적 빈으로 맞췄다(또는 이미 그 빈 안이다) — 그때만 앞 에피소드를 정리한다
  const alignEpisode = async (selection: Selection, force: boolean) => {
    if (!valid(selection) || selected.current !== selection) return false;
    if (selection.via) { followed(selection.via); return true; }
    if (!selection.cuts.length) return false;
    const ep = episodeOf(selection);
    if (!force && ep?.episodeBin && lastBin.current === ep.episodeBin) { followed(ep.episodeBin); return true; }
    const result = await aim(selection);
    if (!valid(selection) || selected.current !== selection) return false;
    check(result);
    if (!aimed(selection, result)) return false;
    setNotice(t("컷 빈 {count}개 — 다빈치에서 컷 빈에 들어가면 가져옵니다").replace("{count}", String(Object.keys(result.bins || {}).length)));
    return true;
  };
  // 다른 에피소드로 옮긴 뒤 앞 에피소드의 컷 빈 정리(Jay 결정 2) — 새 target 뒤에 돈다(사람이 앞 컷 빈 안에 있으면 지금 빈을 지우게 되므로).
  //  컷마다 오래 걸리므로 그 에피소드를 다시 골랐는지(A→B→A)는 컷마다 본다.
  const settleEpisode = async (previous: Selection) => {
    const ep = episodeOf(previous);
    if (!ep) return settle(previous); // 빈 표가 없으면(다시 연 뒤 등) 지금처럼 앞 컷만 — 빈은 지우지 않는다
    for (const [path, bin_id] of Object.entries(ep.bins)) {
      if (!valid(previous) || sameEpisode(selected.current, previous)) return;
      const cut = { ...previous, folder_path: path };
      const result = await panel.currentBin(previous.ctx, previous.project_id, path);
      if (!valid(previous)) return;
      check(result);
      // 이름이 바뀌었거나 이미 지운 빈, 또는 다빈치가 지금 그 빈 안(새 target 실패·프로젝트 바꿈) — 손대지 않는다
      if (result.state === "ok" && (result.target_bin_id !== bin_id || result.bin_id === bin_id)) continue;
      if (result.state !== "ok" || result.used === undefined) throw new Error(t("앞 컷 정리를 확인하지 못했습니다") + ": " + panelFailure(result.state));
      try { for (const id of result.used) await adoptOne(cut, id, result.resolve_project_id!, bin_id); }
      catch (error) { setFailures(list => [...new Set([...list, errorText(error)])]); continue; } // 쓴 것을 못 옮긴 컷은 정리하지 않는다
      if (!valid(previous) || sameEpisode(selected.current, previous)) return;
      const removed = await panel.unstage({ ...cut, bin_id, delete_empty: true });
      check(removed);
      if (!["ok", "not_seen"].includes(removed.state)) throw new Error(t("앞 컷 정리를 확인하지 못했습니다") + ": " + panelFailure(removed.state));
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
  // 돌려주는 값 = 다빈치 지금 빈을 이 컷 빈으로 맞췄다(또는 이미 그 빈 안이다). 그 뒤 stage 실패는 알림으로만 남긴다.
  const stageCut = async (selection: Selection, gens: Generation[], align: boolean) => {
    if (!valid(selection) || selected.current !== selection) return false;
    const capped = selection.capped || gens.length > 200;
    gens = [...gens].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id)).slice(0, 200);
    for (const gen_ids of cacheBatches(gens.map(gen => gen.id))) {
      const cached = await panel.cache({ ...selection, gen_ids });
      if (!valid(selection) || selected.current !== selection) return false;
      if (cached.state) check(cached as { state: string });
      const failed = cached.items.filter(item => item.state !== "cached");
      if (failed.length) throw new Error(failed.map(item => item.gen_id + ": " + item.error).join(", "));
    }
    let bin = selection.via || binOf(selection);
    // 다빈치에서 이 컷 빈에 들어온 것을 따라왔다 — target 없이 가져온다(그사이 다빈치가 떠났으면 stage 가 보류한다)
    if (align && bin && (selection.via || lastBin.current === bin)) followed(bin);
    else if (align) {
      const result = await aim(selection);
      if (!valid(selection) || selected.current !== selection) return false;
      check(result);
      if (!aimed(selection, result)) return false;
      bin = binOf(selection);
    }
    const result = await panel.stage({ ...selection, capped, gen_ids: gens.map(gen => gen.id), ...(bin ? { bin_id: bin } : {}) });
    if (!valid(selection) || selected.current !== selection) return true;
    check(result);
    setStage(result);
    const failed = stageSummary(result).failed.map(item => itemName(item.gen_id) + ": " + panelFailure(item.state));
    if (!["ok", "stale"].includes(result.state)) failed.push(typeof result.details === "string" ? result.details : panelFailure(result.state));
    if (failed.length) setFailures(previous => [...new Set([...previous, ...failed])]);
    if (result.bin_path) setNotice(t("리졸브 빈") + ": " + result.bin_path);
    return true;
  };
  // 에피소드(cut = "")나 컷을 고른다. 같은 에피소드 안에서는 지우지 않는다(Jay 결정 1) — 다른 에피소드면 새 target 뒤에 앞 에피소드를 정리한다(결정 2).
  const selectFolder = useCallback((project_id: string, episode: string, cut: string, gens: Generation[], capped = false, cuts: string[] = []) => {
    const previous = selected.current, ctx = context.current;
    generations.current = gens;
    const folder_path = cut || episode;
    const via = followRef.current?.key === JSON.stringify([project_id, episode, cut]) ? followRef.current.bin : "";
    followRef.current = null;
    const selection = ctx && project_id && folder_path
      ? { ctx, project_id, folder_path, episode, cuts, via, capped, window: windowId, seq: ++sequence.current, revision: revision.current } : null;
    selected.current = selection; setStage(null);
    if (previous && !sameEpisode(previous, selection)) leftovers.current.push(previous);
    void enqueue(async () => {
      // 선택을 풀면(프로젝트 바꿈) 맞출 빈이 없다 — 그때도 다빈치가 들어가 있는 빈은 settleEpisode 가 건너뛴다
      const moved = !selection || await (cut ? stageCut(selection, gens, true) : alignEpisode(selection, !sameEpisode(previous, selection)));
      if (moved && stillAt(selection)) await settleLeftovers(); // 그사이 또 골랐으면 그 선택이 맞춘 뒤에 정리한다
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId]);
  const updateSet = useCallback((gens: Generation[], capped = false) => {
    generations.current = gens;
    const selection = selected.current;
    if (!selection) return;
    const next = { ...selection, capped, seq: ++sequence.current };
    selected.current = next;
    void enqueue(() => stageCut(next, gens, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // [맞추기]·에피소드를 다시 누름 — 에피소드면 지금 트리의 컷 목록(cuts)으로 그사이 생긴 컷 빈도 만든다
  const align = (cuts?: string[]) => {
    if (!selected.current) return;
    // 사람이 누른 맞추기는 따라온 선택이어도 target 을 낸다
    const chosen = { ...selected.current, via: "", ...(Array.isArray(cuts) ? { cuts } : {}) };
    selected.current = chosen;
    void enqueue(async () => {
      const moved = chosen.folder_path === chosen.episode ? await alignEpisode(chosen, true) : await stageCut(chosen, generations.current, true);
      if (moved && stillAt(chosen)) await settleLeftovers();
    });
  };
  const retry = () => {
    adopted.current.clear(); failedAdoptions.current.clear(); recovered.current = ""; setFailures([]);
    setRecoveryRun(value => value + 1);
    const selection = selected.current;
    if (selection && selection.folder_path !== selection.episode) void enqueue(() => stageCut(selection, generations.current, false));
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
    const poll = async () => {
      const selection = selected.current;
      if (document.visibilityState !== "hidden" && selection && valid(selection)) {
        await enqueue(async () => {
          if (!valid(selection)) return;
          const result = await panel.currentBin(selection.ctx, selection.project_id, selection.folder_path);
          if (!valid(selection)) return;
          check(result);
          if (selected.current === selection) { currentRef.current = result; setCurrent(result); }
          // 다빈치에서 빈을 옮겼다(바뀔 때 한 번만) — 이 에피소드의 컷 빈이면 그 컷으로, 에피소드 빈이면 컷 선택을 풀고 따라간다.
          //  bins 밖 빈(사람 빈·다른 에피소드)은 아무것도 하지 않는다.
          //  응답을 기다리는 사이 다른 자리를 골랐으면 반영하지 않는다(다음 읽기가 새 선택으로 다시 본다).
          if (stillAt(selection) && result.state === "ok" && result.bin_id && result.bin_id !== lastBin.current) {
            lastBin.current = result.bin_id;
            const ep = episodeOf(selection);
            const owners = ep ? Object.entries(ep.bins).filter(([, id]) => id === result.bin_id) : [];
            const cut = owners.length === 1 ? owners[0][0] : ep && result.bin_id === ep.episodeBin ? "" : null;
            const here = selection.folder_path === selection.episode ? "" : selection.folder_path;
            if (ep && cut !== null && cut !== here) {
              followRef.current = { key: JSON.stringify([ep.project_id, ep.episode, cut]), bin: result.bin_id };
              setFollow(previous => ({ project: ep.project_id, episode: ep.episode, cut, n: (previous?.n || 0) + 1 }));
            } else if (ep && cut && selected.current) {
              // 이미 고른 컷 빈에 다시 들어왔다(보류됐던 것) — target 없이 한 번 가져온다
              const now = selected.current;
              void enqueue(() => stageCut(now, generations.current, false));
            }
          }
          for (const id of result.used || []) {
            try { await adoptOne(selection, id, result.resolve_project_id!, result.target_bin_id); }
            catch (error) { setFailures(previous => [...new Set([...previous, errorText(error)])]); }
          }
        });
      }
      if (mounted) timer = setTimeout(() => void poll(), 2000);
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
        if (rev !== revision.current || !context.current?.writer || !hasResolveBridge(window.mvhubResolve)) return;
        const result = await panel.inventory(ctx, after);
        if (rev !== revision.current || contextKey(ctx) !== contextKey(context.current)) return;
        check(result);
        if (result.state !== "ok") { recovered.current = ""; throw new Error(String(result.details || result.state)); }
        setCounts({ other_owner: result.other_owner || 0, needs_attention: result.needs_attention || 0 });
        all.push(...result.items || []);
        after = result.more ? result.after : undefined;
        if (result.more && !after) throw new Error(t("확인 못 함"));
      } while (after);
      const bins = new Map<string, Selection>();
      for (const item of all) {
        const selection = { ctx, project_id: item.project_id, folder_path: item.folder_path, episode: "", cuts: [], via: "", window: windowId, seq: ++sequence.current, revision: rev };
        const action = inventoryAction(item);
        if (action === "recover" || action === "adopt") {
          try { await adoptOne(selection, item.gen_id, item.resolve_project_id, item.bin_id, [item.item_id], item.recovery); }
          catch (error) { setFailures(previous => [...new Set([...previous, errorText(error)])]); }
        } else if (action === "unstage") bins.set(item.bin_id, selection);
      }
      const saved = loadSavedSelection();
      for (const [bin_id, selection] of bins) {
        if (!valid(selection)) return;
        const now = selected.current;
        if (now?.project_id === selection.project_id && (now.folder_path === selection.folder_path || under(selection.folder_path, now.episode))) continue;
        // 다시 열 때 — 저장된 선택의 에피소드 컷 빈은 그대로 둔다(결정 1 을 다시 열기에도). inventory 정리는 빈을 지우지 않는다.
        if (saved.project === selection.project_id && under(selection.folder_path, saved.episode || saved.cut)) continue;
        const result = await panel.unstage({ ...selection, bin_id, inventory_cleanup: true });
        check(result);
        if (!["ok", "active_bin", "not_seen"].includes(result.state)) throw new Error(panelFailure(result.state));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.instance, identity?.account, identity?.epoch, identity?.writer, identity?.generation, recoveryRun]);

  return { config, needsLogin, authReady, identity, target, current, notice, stage, moved, counts, failures, follow, nas,
    canRetry: failures.some(failure => !failure.includes(t(RECOVERY_PENDING))),
    authKey: contextKey(identity), selectFolder, updateSet, align, retry, takeover,
    onAuthed: () => { setNeedsLogin(false); resetAuth(); } };
}

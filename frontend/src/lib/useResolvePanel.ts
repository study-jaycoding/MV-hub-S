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

interface Selection extends PanelSelection { seq: number; window: string; revision: number; capped?: boolean }
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
  const [windowId] = useState(createWindowId);
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
    setIdentity(null); setTarget(null); setCurrent(null); setStage(null); setMoved(0); setFailures([]); setNotice("");
  }, []);
  const resetAuth = useCallback(() => {
    authEpoch.current++; clear(); setAuthReady(false); setAuthRun(n => n + 1);
  }, [clear]);
  // 일반 브라우저는 읽기 전용이며, 대기 중 다리가 사라져도 후속 요청을 보내지 않는다.
  const valid = (selection: Selection) => hasResolveBridge(window.mvhubResolve) && context.current?.writer === true
    && selection.revision === revision.current && contextKey(context.current) === contextKey(selection.ctx);

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


  const enqueue = (work: () => Promise<void>) => {
    queue.current = queue.current.then(work).catch(error => setFailures(previous => [...new Set([...previous, errorText(error)])]));
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
    adopted.current.add(key); setMoved(value => value + 1);
    } catch (error) { failedAdoptions.current.set(key, errorText(error)); throw error; }
  };
  const settle = async (selection: Selection) => {
    if (!valid(selection)) return;
    const result = await panel.currentBin(selection.ctx, selection.project_id, selection.folder_path);
    if (!valid(selection)) return;
    check(result);
    if (result.state === "ok" && !result.target_bin_id) return;
    if (result.state !== "ok" || result.used === undefined) throw new Error(t("앞 컷 정리를 확인하지 못했습니다"));
    for (const id of result.used) await adoptOne(selection, id, result.resolve_project_id!, result.target_bin_id);
    if (!valid(selection) || !result.target_bin_id) return;
    const removed = await panel.unstage({ ...selection, bin_id: result.target_bin_id });
    check(removed);
    if (!["ok", "not_seen"].includes(removed.state)) throw new Error(t("앞 컷 정리를 확인하지 못했습니다") + ": " + removed.state);
  };
  const stageCut = async (selection: Selection, gens: Generation[], align: boolean) => {
    if (!valid(selection) || selected.current !== selection) return;
    const capped = selection.capped || gens.length > 200;
    gens = [...gens].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.id.localeCompare(b.id)).slice(0, 200);
    for (const gen_ids of cacheBatches(gens.map(gen => gen.id))) {
      const cached = await panel.cache({ ...selection, gen_ids });
      if (!valid(selection) || selected.current !== selection) return;
      if (cached.state) check(cached as { state: string });
      const failed = cached.items.filter(item => item.state !== "cached");
      if (failed.length) throw new Error(failed.map(item => item.gen_id + ": " + item.error).join(", "));
    }
    if (align) {
      const result = await panel.target({ ...selection, create: true });
      if (!valid(selection) || selected.current !== selection) return;
      check(result);
      targetRef.current = result; setTarget(result); setNotice(targetView(result).message);
      if (result.state !== "ok") return;
    }
    const result = await panel.stage({ ...selection, capped, gen_ids: gens.map(gen => gen.id) });
    if (!valid(selection) || selected.current !== selection) return;
    check(result);
    setStage(result);
    const failed = stageSummary(result).failed;
    if (failed.length) setFailures(previous => [...new Set([...previous, ...failed.map(item => itemName(item.gen_id) + ": " + panelFailure(item.state))])]);
    if (!["ok", "stale"].includes(result.state)) throw new Error(String(result.details || result.state));
    if (result.bin_path) setNotice(t("리졸브 빈") + ": " + result.bin_path);
  };
  const selectCut = useCallback((project_id: string, folder_path: string, gens: Generation[], capped = false) => {
    const previous = selected.current, ctx = context.current;
    generations.current = gens;
    const selection = ctx && project_id && folder_path ? { ctx, project_id, folder_path, capped, window: windowId, seq: ++sequence.current, revision: revision.current } : null;
    selected.current = selection; setStage(null);
    // 앞 컷 정리는 선택 변경과 분리해 끝낸다 — A로 돌아와도 같은 줄 뒤에서 시작한다.
    if (previous) void enqueue(() => settle(previous));
    if (selection) void enqueue(() => stageCut(selection, gens, true));
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
  const align = () => {
    const selection = selected.current;
    if (selection) void enqueue(() => stageCut(selection, generations.current, true));
  };
  const retry = () => {
    adopted.current.clear(); failedAdoptions.current.clear(); recovered.current = ""; setFailures([]);
    setRecoveryRun(value => value + 1);
    const selection = selected.current;
    if (selection) void enqueue(() => stageCut(selection, generations.current, false));
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
        const selection = { ctx, project_id: item.project_id, folder_path: item.folder_path, window: windowId, seq: ++sequence.current, revision: rev };
        const action = inventoryAction(item);
        if (action === "recover" || action === "adopt") {
          try { await adoptOne(selection, item.gen_id, item.resolve_project_id, item.bin_id, [item.item_id], item.recovery); }
          catch (error) { setFailures(previous => [...new Set([...previous, errorText(error)])]); }
        } else if (action === "unstage") bins.set(item.bin_id, selection);
      }
      for (const [bin_id, selection] of bins) {
        if (!valid(selection)) return;
        if (selected.current?.project_id === selection.project_id && selected.current.folder_path === selection.folder_path) continue;
        const result = await panel.unstage({ ...selection, bin_id, inventory_cleanup: true });
        check(result);
        if (!["ok", "active_bin", "not_seen"].includes(result.state)) throw new Error(result.state);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.instance, identity?.account, identity?.epoch, identity?.writer, identity?.generation, recoveryRun]);

  return { config, needsLogin, authReady, identity, target, current, notice, stage, moved, counts, failures,
    canRetry: failures.some(failure => !failure.includes(t(RECOVERY_PENDING))),
    authKey: contextKey(identity), selectCut, updateSet, align, retry, takeover,
    onAuthed: () => { setNeedsLogin(false); resetAuth(); } };
}

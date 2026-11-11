import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AuthConfig, Generation } from "../types";
import { APP_EVENTS } from "./appEvents";
import { forgetAuthToken, getAuthToken, setAuthToken, subscribeApiPause } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { t } from "./i18n";
import {
  adoptAction, cacheBatches, contextKey, dragPermission, hasResolveBridge, PROTOCOL_MISMATCH, RECOVERY_PENDING,
  resolvePanelApi as panel, startPanelDrag, targetView,
  type AdoptState, type PanelIdentity, type PanelSelection, type TargetResult,
} from "./resolvePanelApi";

interface Selection extends PanelSelection { seq: number; window: string; revision: number }
export interface PanelCard { path?: string; project?: string; message: string; retry?: boolean }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const wait = () => new Promise<void>(resolve => setTimeout(resolve, 1000));
const createWindowId = (): string => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID() : `panel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
const messages: Partial<Record<AdoptState, string>> = {
  conflict: "표시 충돌", elsewhere: "다른 빈에 있음", project_changed: "프로젝트가 바뀜",
  stamp_failed: "클립 표시를 확인하지 못했습니다", save_failed: "프로젝트 저장을 확인하지 못했습니다",
  ledger_failed: "전송 장부를 기록하지 못했습니다", unknown: "확인 못 함",
  not_seen: "확인 못 함 — 놓지 않았거나 다른 빈", busy: "확인 중 — 리졸브가 바쁨",
};

export function useResolvePanel() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authRun, setAuthRun] = useState(0);
  const [identity, setIdentity] = useState<PanelIdentity | null>(null);
  const [target, setTarget] = useState<TargetResult | null>(null);
  const [current, setCurrent] = useState<TargetResult | null>(null);
  const [cards, setCards] = useState<Record<string, PanelCard>>({});
  const [notice, setNotice] = useState("");
  const [windowId] = useState(createWindowId);
  const revision = useRef(0);
  const sequence = useRef(0);
  const context = useRef<PanelIdentity | null>(null);
  const checkedAt = useRef(0);
  const selected = useRef<Selection | null>(null);
  const targetRef = useRef<TargetResult | null>(null);
  const currentRef = useRef<TargetResult | null>(null);
  const cardsRef = useRef<Record<string, PanelCard>>({});
  const pending = useRef(new Map<string, Promise<void>>());
  const adoptions = useRef(new Set<string>());
  const targetPending = useRef<{ selection: Selection; promise: Promise<TargetResult | null> } | null>(null);
  const authEpoch = useRef(0);

  const clear = useCallback(() => {
    revision.current++;
    context.current = null; checkedAt.current = 0; selected.current = null;
    targetRef.current = null; currentRef.current = null; cardsRef.current = {};
    pending.current.clear(); adoptions.current.clear(); targetPending.current = null;
    setIdentity(null); setTarget(null); setCurrent(null); setCards({}); setNotice("");
  }, []);
  const resetAuth = useCallback(() => {
    authEpoch.current++; clear(); setAuthReady(false); setAuthRun(n => n + 1);
  }, [clear]);
  // 일반 브라우저는 읽기 전용이며, 대기 중 다리가 사라져도 후속 요청을 보내지 않는다.
  const alive = (selection: Selection) => hasResolveBridge(window.mvhubResolve) && selected.current === selection && selection.revision === revision.current
    && contextKey(context.current) === contextKey(selection.ctx);
  const card = (selection: Selection, id: string, update: Partial<PanelCard>) => {
    if (!alive(selection)) return;
    cardsRef.current = { ...cardsRef.current, [id]: { ...cardsRef.current[id], message: "", ...update } };
    setCards(cardsRef.current);
  };
  const resetContext = () => { clear(); setAuthRun(n => n + 1); };

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
        const next = await panel.identity();
        if (!mounted || epoch !== authEpoch.current) return;
        if (contextKey(next) !== contextKey(context.current)) clear();
        context.current = next; checkedAt.current = Date.now(); setIdentity(next);
      } catch (error) {
        if (mounted && epoch === authEpoch.current) { checkedAt.current = 0; setNotice(errorText(error)); }
      } finally { running = false; if (mounted) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll();
    window.addEventListener("focus", poll);
    return () => { mounted = false; clearTimeout(timer); window.removeEventListener("focus", poll); };
  }, [authReady, authRun, clear]);

  useEffect(() => {
    if (!identity) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const selection = selected.current;
      if (document.visibilityState !== "hidden" && selection && alive(selection)) {
        try {
          const result = await panel.currentBin(selection.ctx);
          if (!mounted) return;
          if (alive(selection)) {
            if (result.state === "account_changed") { resetContext(); return; }
            currentRef.current = result; setCurrent(result);
          }
        } catch {
          if (mounted && alive(selection)) { currentRef.current = { state: "unavailable" }; setCurrent(currentRef.current); }
        }
      }
      if (mounted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { mounted = false; clearTimeout(timer); };
    // 문맥이 같으면 identity 확인 시각만으로 폴링을 다시 시작하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey(identity)]);

  async function targetFor(selection: Selection, create: boolean): Promise<TargetResult | null> {
    if (!alive(selection)) return null;
    if (targetPending.current?.selection === selection) return targetPending.current.promise;
    const promise = (async () => {
      try {
        const result = await panel.target({ ...selection, create });
        if (!alive(selection)) return null;
        const view = targetView(result);
        if (view.action === "reset") { resetContext(); return null; }
        if (view.action === "ignore") return null;
        targetRef.current = result; setTarget(result); setNotice(view.message);
        return result;
      } catch (error) {
        if (alive(selection)) {
          targetRef.current = { state: "unavailable" }; setTarget(targetRef.current); setNotice(errorText(error));
        }
        return null;
      }
    })();
    targetPending.current = { selection, promise };
    try { return await promise; }
    finally { if (targetPending.current?.promise === promise) targetPending.current = null; }
  }

  const selectCut = useCallback((projectId: string, folderPath: string, gens: Generation[]) => {
    selected.current = null; targetRef.current = null; currentRef.current = null; cardsRef.current = {};
    setTarget(null); setCurrent(null); setCards({}); setNotice("");
    if (!hasResolveBridge(window.mvhubResolve) || !context.current || !projectId || !folderPath) return;
    const selection: Selection = { ctx: context.current, project_id: projectId, folder_path: folderPath,
      seq: ++sequence.current, window: windowId, revision: revision.current };
    selected.current = selection;
    void targetFor(selection, false);
    void cacheCards(selection, gens.map(gen => gen.id));
    // 선택 요청은 ref를 기준으로 처리한다 — 확인 폴링마다 같은 컷을 다시 선택하지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cacheCards(selection: Selection, all: string[]) {
    for (const ids of cacheBatches(all)) {
      if (!alive(selection)) return;
      ids.forEach(id => card(selection, id, { message: t("받는 중") }));
      try {
        const result = await panel.cache({ ...selection, gen_ids: ids });
        if (!alive(selection)) return;
        if (result.state === "account_changed") { resetContext(); return; }
        for (const item of result.items) {
          if (!cardsRef.current[item.gen_id]?.path) card(selection, item.gen_id, { message: item.state === "cached" ? t("로컬 캐시 준비됨") : item.error || t("받지 못했습니다") });
        }
      } catch (error) { if (alive(selection)) ids.forEach(id => card(selection, id, { message: errorText(error) })); return; }
    }
  }

  // 같은 컷을 다시 읽어 새로 생긴 카드 — 컷 선택(target·순번)은 다시 하지 않는다(15초마다 리졸브 지금 빈을 되돌리지 않게).
  const addCards = useCallback((gens: Generation[]) => {
    const selection = selected.current;
    if (!selection || !alive(selection)) return;
    const fresh = gens.map(gen => gen.id).filter(id => !cardsRef.current[id]);
    if (fresh.length) void cacheCards(selection, fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepareCard(id: string): Promise<void> {
    const selection = selected.current;
    if (!selection || !alive(selection)) return;
    const key = `${selection.revision}:${selection.seq}:${id}`;
    if (pending.current.has(key)) return pending.current.get(key);
    const promise = (async () => {
      let destination = targetRef.current;
      if (destination?.state !== "ok") {
        destination = await targetFor(selection, destination?.state === "missing");
        if (destination?.state === "missing") destination = await targetFor(selection, true);
      }
      if (!alive(selection) || destination?.state !== "ok") return;
      if (cardsRef.current[id]?.path && cardsRef.current[id].project === destination.resolve_project_id) return;
      card(selection, id, { message: t("NAS 준비 중"), retry: false });
      try {
        const result = await panel.prepare({ ...selection, gen_id: id });
        if (!alive(selection)) return;
        if (result.state === "account_changed") { resetContext(); return; }
        card(selection, id, result.state === "prepared"
          ? { path: result.path, project: destination.resolve_project_id, message: t("끌 수 있음") }
          : { path: undefined, message: result.error || t("준비하지 못했습니다") });
      } catch (error) { card(selection, id, { message: errorText(error), path: undefined }); }
    })();
    pending.current.set(key, promise);
    try { await promise; } finally { pending.current.delete(key); }
  }

  async function adopt(id: string) {
    const selection = selected.current;
    const project = targetRef.current?.resolve_project_id;
    if (!selection || !alive(selection) || !project) return;
    const key = `${selection.revision}:${selection.seq}:${id}`;
    if (adoptions.current.has(key)) return;
    adoptions.current.add(key);
    card(selection, id, { message: t("확인 중"), retry: false });
    let tries = 0, busyMs = 0, retriedPreparation = false;
    try {
      while (alive(selection) && tries < 8) {
        const began = Date.now();
        await wait();
        if (!alive(selection)) return;
        let result;
        try { result = await panel.adopt({ ...selection, gen_id: id, resolve_project_id: project }); }
        catch (error) { card(selection, id, { message: errorText(error), retry: true }); return; }
        if (!alive(selection)) return;
        const action = adoptAction(result.state);
        if (action === "reset") { resetContext(); return; }
        if (action === "done") { card(selection, id, { message: `${t("리졸브 빈에 있음")}: ${selection.folder_path.split("/").slice(-1)[0]}`, retry: false }); return; }
        if (action === "block") {
          targetRef.current = { state: "rebuild_recovery_pending" }; setTarget(targetRef.current);
          card(selection, id, { message: t(RECOVERY_PENDING), retry: false }); return;
        }
        if (!retriedPreparation && (action === "retry" || action === "busy")) {
          if (action === "retry") tries++;
          else busyMs += Date.now() - began;
          if (tries < 8 && busyMs < 30_000) {
            card(selection, id, { message: t("확인 중"), retry: false });
            continue;
          }
        }
        // not_prepared 뒤에는 재준비와 확인 한 번만 허용한다 — 반복 재준비로 NAS를 계속 건드리지 않게.
        if (!retriedPreparation && action === "prepare") {
          retriedPreparation = true;
          card(selection, id, { path: undefined });
          await prepareCard(id);
          if (!alive(selection) || !cardsRef.current[id]?.path) return;
          continue;
        }
        const details = typeof result.details === "string" ? result.details : result.details && Object.keys(result.details).length ? JSON.stringify(result.details) : "";
        card(selection, id, { message: [t(messages[result.state] || "확인 못 함"), details].filter(Boolean).join(" — "), retry: true });
        return;
      }
    } finally { adoptions.current.delete(key); }
  }

  function drag(id: string, event: { preventDefault(): void }) {
    event.preventDefault();
    const selection = selected.current;
    if (!selection) return;
    const ready = cardsRef.current[id];
    const destination = targetRef.current;
    const result = dragPermission({ bridge: window.mvhubResolve, identity: context.current,
      prepared: !!ready?.path, targetOk: destination?.state === "ok" && !!destination.resolve_project_id
        && ready?.project === destination.resolve_project_id
        && (currentRef.current?.state !== "ok" || currentRef.current.resolve_project_id === destination.resolve_project_id),
      contextCurrent: alive(selection) && checkedAt.current > 0 && Date.now() - checkedAt.current <= 2000 });
    if (!result.ok) { card(selection, id, { message: result.reason }); return; }
    try {
      if (!startPanelDrag(window.mvhubResolve!, ready.path!)) { card(selection, id, { message: t(PROTOCOL_MISMATCH) }); return; }
      void adopt(id);
    } catch (error) { card(selection, id, { message: errorText(error) }); }
  }

  useEffect(() => () => { revision.current++; selected.current = null; }, []);
  return { identity, config, needsLogin, authReady, cards, target, current, notice,
    authKey: contextKey(identity), selectCut, addCards, prepareCard, drag, adopt, onAuthed: resetAuth,
    align: () => { const selection = selected.current; if (selection) void targetFor(selection, false); } };
}

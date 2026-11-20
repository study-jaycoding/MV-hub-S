import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkspaceContext } from "../types";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { runScreenAction, sceneFingerprint, undoScreenAction, type ScreenHost, type ScreenReceipt } from "./agentScreenActions";
import { getAuthToken, jsonBody, jsonFetch, withRequestTimeout } from "./http";
import { EXPECT_ACCOUNT_HEADER, EXTERNAL_SCREEN_FEATURE, hubHasFeature, subscribeHubFeatures } from "./hubFeatures";
import { mcpTabId } from "./mcpTab";
import { STORAGE_KEYS } from "./storageKeys";
import { disabledGenStamp } from "./deactivated";
import { getLang, t } from "./i18n";
import { isCanvasWindow } from "./popupWindows";

export function screenMessage(message: string): string {
  if (getLang() !== "en") return message;
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^새 노드 (\d+)개 만듦$/, m => `Created ${m[1]} cards`],
    [/^고른 카드 (\d+)개$/, m => `${m[1]} selected cards`],
    [/^(\d+)개 이음(?: · (\d+)개 건너뜀)?$/, m => `Connected ${m[1]} pairs${m[2] ? ` · Skipped ${m[2]}` : ""}`],
    [/^생성물 (\d+)개 회색\(비활성\)(으로 바꿈|을 풂) · 이 브라우저 기준$/, m => `${m[2] === "으로 바꿈" ? "Dimmed" : "Undimmed"} ${m[1]} generations · This browser`],
  ];
  for (const [pattern, format] of rules) { const match = message.match(pattern); if (match) return format(match); }
  return t(message);
}

export const SCREEN_CONSENT = "화면 제어를 켜면 연결된 바깥 앱이 허용한 MV Hub 창의 현재 공간·씬과 선택 카드 일부를 읽고, 빈 카드·연결·내 생성물 회색 표시를 바꿀 수 있어요. 화면 동작은 MV 생성 크레딧을 쓰지 않아요. 생성 요청에는 기존 크레딧 규칙이 적용돼요.";
const listeners = new Set<() => void>();
const initial = { available: false, enabled: false, multiple: false, selected: false, note: "" };
let control = initial;
const publish = (value: typeof initial) => { control = value; listeners.forEach(fn => fn()); };
export const useScreenControl = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => control);
export const changeScreenControl = (enabled: boolean) => dispatchAppEvent(APP_EVENTS.mcpScreenControl, { enabled });
export const selectScreenWindow = () => dispatchAppEvent(APP_EVENTS.mcpScreenControl, { select: true });
export function screenStorageKey(hub: string, account: string): string {
  return `${STORAGE_KEYS.mcpScreen}:${JSON.stringify([location.origin, hub, account])}`;
}
export function screenEnabled(key: string): boolean {
  try {
    const value = key && JSON.parse(localStorage.getItem(key) || "null");
    return value?.enabled === true && typeof value.change === "string" && !!value.change;
  } catch { return false; }
}
const storedSetting = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

export interface ScreenNotice extends ScreenReceipt { id: string; client: string; scope: string; note?: string }
interface Props { ready: boolean; authKey: string; workspace: WorkspaceContext; host: ScreenHost; boardVisible: boolean; sceneId: string | null; viewKey: string }
interface Presence { receiver_id: string; receiver_secret?: string; multiple: boolean; selected: boolean }
interface Claim { token: string; name: string; args: Record<string, unknown>; epoch: number; workspace: WorkspaceContext; client_name: string }

export function useMcpScreenActions(props: Props) {
  const current = useRef(props); current.current = props;
  const signal = useRef<() => void>(() => {});
  const [notices, setNotices] = useState<ScreenNotice[]>([]);
  const [hubIdentity, setHubIdentity] = useState("");
  const [supported, setSupported] = useState(() => hubHasFeature(EXTERNAL_SCREEN_FEATURE));
  const currentAccount = getAccountNamespace(), currentToken = getAuthToken(), currentConnection = getConnectionKey();
  const session = useRef({ account: currentAccount, token: currentToken, connection: currentConnection, version: 0 });
  if (session.current.account !== currentAccount || session.current.token !== currentToken || session.current.connection !== currentConnection) {
    session.current = { account: currentAccount, token: currentToken, connection: currentConnection, version: session.current.version + 1 };
  }
  const scope = JSON.stringify([props.authKey, hubIdentity, currentAccount, currentConnection, session.current.version, props.workspace.scope, props.workspace.id]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  useEffect(() => {
    const update = () => setSupported(hubHasFeature(EXTERNAL_SCREEN_FEATURE));
    update(); return subscribeHubFeatures(update);
  }, []);
  // Layout effects observe the actual child board handle, including unmounts and A→B→A.
  useLayoutEffect(() => { signal.current(); });
  useEffect(() => {
    publish(initial);
    setHubIdentity("");
    if (!props.ready || !supported || isCanvasWindow() || new URLSearchParams(location.search).has("embed")) return;
    let alive = true, key = "", hub = "", receiver: Presence | null = null, secret = "";
    let seq = 0, epoch = 0, signature = "", busy = false, dirty = false, choose = false, delay = 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tab = mcpTabId(), account = currentAccount, token = currentToken, connection = currentConnection;
    const abort = new AbortController();
    const seen = new Set<string>();
    const fresh = () => alive && !isCanvasWindow() && current.current.ready && current.current.authKey === props.authKey
      && getAccountNamespace() === account && getAuthToken() === token && getConnectionKey() === connection;
    const snapshot = () => {
      const p = current.current;
      const board = p.host.scene();
      const scene = p.boardVisible && board?.sceneId === p.sceneId ? board : null;
      const enabled = screenEnabled(key), visible = document.visibilityState === "visible";
      const workspace = { scope: p.workspace.scope, id: p.workspace.id || null };
      const next = JSON.stringify([workspace, scene?.sceneId || null, enabled, visible, p.viewKey, storedSetting(key)]);
      if (signature !== next) { signature = next; epoch += 1; }
      return { workspace, scene_id: scene?.sceneId || null, enabled, visible, epoch };
    };
    const headers = { "X-MVHub-Tab": tab, [EXPECT_ACCOUNT_HEADER]: account };
    const post = <T,>(path: string, body: unknown) => withRequestTimeout(signal => jsonFetch<T>(`/api/mcp/v2/app/${path}`, {
      method: "POST", headers, body: jsonBody(body), signal: AbortSignal.any([signal, abort.signal]),
    }), 20_000, "화면 연결을 확인하지 못했어요");
    const readHub = () => withRequestTimeout(signal => jsonFetch<{ mcp_bridge?: { hub_id?: string } }>("/api/health", {
      signal: AbortSignal.any([signal, abort.signal]),
    }), 8000, "화면 연결을 확인하지 못했어요");
    const schedule = (ms: number) => { clearTimeout(timer); if (fresh()) timer = setTimeout(() => { void presence(); }, ms); };
    const presence = async () => {
      if (!fresh()) return;
      if (busy) { dirty = true; return; }
      if (!hub) {
        busy = true;
        try {
          const result = await readHub();
          if (!fresh()) return;
          if (!result.mcp_bridge?.hub_id) throw new Error("identity unavailable");
          hub = result.mcp_bridge.hub_id; key = screenStorageKey(hub, account);
          setHubIdentity(hub);
          publish({ ...initial, available: true, enabled: screenEnabled(key) });
        } catch {
          delay = Math.min(delay * 2, 60_000);
          if (fresh()) publish({ ...initial, note: "화면 연결을 확인하지 못했어요" });
        } finally {
          busy = false;
          if (fresh() && document.visibilityState === "visible") schedule(hub ? 100 : delay);
        }
        return;
      }
      const state = snapshot();
      publish({ ...control, available: true, enabled: state.enabled });
      if ((!state.enabled || !state.visible) && !receiver) return;
      busy = true; dirty = false;
      const select = choose; choose = false;
      try {
        const result = await post<Presence>("screen-presence", { ...state, hub_id: hub, seq: ++seq,
          ...(receiver ? { receiver_id: receiver.receiver_id, secret } : {}), select });
        if (!fresh()) return;
        if (typeof result.receiver_id !== "string" || (!receiver && !result.receiver_secret)
          || (receiver && receiver.receiver_id !== result.receiver_id)) throw new Error("invalid receiver response");
        receiver = result; secret = result.receiver_secret || secret; delay = 10_000;
        publish({ available: true, enabled: screenEnabled(key), multiple: result.multiple, selected: result.selected, note: "" });
      } catch (error) {
        if (fresh()) {
          const rejected = [403, 404].includes(Number((error as { status?: number } | null)?.status));
          const lostReceiver = rejected && receiver !== null;
          if (rejected) { receiver = null; secret = ""; }
          delay = lostReceiver ? 100 : Math.min(Math.max(receiver ? 10_000 : 30_000, delay * 2), 60_000);
          choose = choose || select;
          publish({ ...control, note: "화면 연결을 확인하지 못했어요" });
          // An explicitly rejected capability cannot leave an orphan; retry registration once now.
          const health = lostReceiver ? null : await readHub().catch(() => null);
          if (fresh() && health?.mcp_bridge?.hub_id && health.mcp_bridge.hub_id !== hub) {
            hub = health.mcp_bridge.hub_id; key = screenStorageKey(hub, account); snapshot();
            setHubIdentity(hub);
            publish({ ...initial, available: true, enabled: screenEnabled(key) });
          }
        }
      } finally {
        busy = false;
        if (fresh() && (dirty || (snapshot().enabled && snapshot().visible))) schedule(dirty ? 100 : delay);
      }
    };
    const changed = () => { snapshot(); if (busy) dirty = true; else schedule(100); };
    signal.current = () => { const before = signature; snapshot(); if (before !== signature) changed(); };
    const setting = (event: Event) => {
      if (!fresh() || !key) return;
      const detail = (event as CustomEvent<{ enabled?: boolean; select?: boolean }>).detail;
      if (!detail) return;
      if (typeof detail.enabled === "boolean") {
        try {
          localStorage.setItem(key, JSON.stringify({ enabled: detail.enabled, change: mcpTabId() }));
          if (screenEnabled(key) !== detail.enabled) throw new Error("storage");
          publish({ ...control, enabled: detail.enabled, note: "" });
        } catch { publish({ ...control, enabled: screenEnabled(key), note: "화면 제어 설정을 저장하지 못했어요" }); }
      }
      choose = detail.select === true;
      changed();
    };
    const wake = async (event: Event) => {
      const detail = (event as CustomEvent<{ receiver_id: string; action_id: string }>).detail;
      if (!detail || typeof detail.action_id !== "string" || !fresh() || !receiver || detail.receiver_id !== receiver.receiver_id || seen.has(detail.action_id)) return;
      const before = snapshot(), startScope = scopeRef.current;
      if (!before.enabled || !before.visible) return;
      seen.add(detail.action_id); if (seen.size > 256) seen.delete(seen.values().next().value!);
      const credentials = { receiver_id: receiver.receiver_id, secret };
      const board = current.current.boardVisible ? current.current.host.scene() : null;
      const fingerprint = board ? sceneFingerprint(board.snapshot()) : null;
      const hiddenStamp = disabledGenStamp();
      let claim: Claim;
      try { claim = await post<Claim>(`screen-actions/${encodeURIComponent(detail.action_id)}/claim`, credentials); }
      catch { return; }
      const now = snapshot(), currentBoard = current.current.boardVisible ? current.current.host.scene() : null;
      const valid = fresh() && before.epoch === now.epoch && claim.epoch === now.epoch && now.enabled && now.visible
        && scopeRef.current === startScope && JSON.stringify(claim.workspace) === JSON.stringify(now.workspace)
        && (!claim.name.startsWith("canvas.") || (!!now.scene_id && claim.args.scene_id === now.scene_id))
        && fingerprint === (currentBoard ? sceneFingerprint(currentBoard.snapshot()) : null);
      const result = valid && (claim.name !== "library.set_hidden" || hiddenStamp === disabledGenStamp()) ? runScreenAction(claim.name, claim.args, current.current.host)
        : { ok: false, summary: "화면이 바뀌어 실행하지 않았어요", data: {} };
      if (fresh()) {
        const client = ({ claude: "Claude Code", codex: "Codex", claude_desktop: t("Claude 데스크톱 채팅") } as Record<string, string>)[claim.client_name] || t("바깥 앱");
        const receipt = { ...result, id: detail.action_id, client, scope: startScope };
        setNotices(list => [...list, receipt].slice(-20));
        dispatchAppEvent(APP_EVENTS.flash, `${client}: ${screenMessage(result.summary)}`);
        try {
          const accepted = await post<{ accepted: boolean }>(`screen-actions/${encodeURIComponent(detail.action_id)}/result`, {
            ...credentials, token: claim.token, ok: result.ok, summary: result.summary, data: result.data,
          });
          if (!accepted.accepted) throw new Error("result not accepted");
        } catch {
          if (fresh()) setNotices(list => list.map(n => n.id === receipt.id ? { ...n, note: "화면 결과를 앱에 전달하지 못했어요" } : n));
        }
      }
    };
    window.addEventListener(APP_EVENTS.mcpScreenControl, setting);
    window.addEventListener(APP_EVENTS.mcpScreenAction, wake);
    window.addEventListener("storage", changed);
    document.addEventListener("visibilitychange", changed);
    void presence();
    return () => {
      if (receiver && token === getAuthToken() && account === getAccountNamespace() && connection === getConnectionKey()) {
        void jsonFetch("/api/mcp/v2/app/screen-presence", { method: "POST", headers,
          body: jsonBody({ ...snapshot(), hub_id: hub, receiver_id: receiver.receiver_id, secret,
            seq: ++seq, epoch: ++epoch, visible: false, enabled: false }),
        }).catch(() => {});
      }
      alive = false; abort.abort(); clearTimeout(timer); signal.current = () => {};
      window.removeEventListener(APP_EVENTS.mcpScreenControl, setting);
      window.removeEventListener(APP_EVENTS.mcpScreenAction, wake);
      window.removeEventListener("storage", changed);
      document.removeEventListener("visibilitychange", changed);
      publish(initial);
    };
  }, [props.ready, props.authKey, supported, currentAccount, currentToken, currentConnection]);

  return { notices: notices.filter(n => n.scope === scope), dismiss: (id: string) => setNotices(list => list.filter(n => n.id !== id)),
    undo: (id: string) => {
      const receipt = notices.find(n => n.id === id);
      const p = current.current;
      const actualScope = JSON.stringify([p.authKey, hubIdentity, getAccountNamespace(), getConnectionKey(), session.current.version, p.workspace.scope, p.workspace.id]);
      if (!receipt?.undo || receipt.scope !== actualScope || !p.ready || currentToken !== getAuthToken()) return;
      const result = receipt.undo.kind === "canvas" && !p.boardVisible
        ? { ok: false, message: "그 씬을 이 창의 캔버스에서 열어 주세요" }
        : undoScreenAction(receipt.undo, current.current.host);
      setNotices(list => list.map(n => n.id !== id ? n : { ...n, note: result.message, undo: result.ok ? undefined : result.undo || n.undo }));
    } };
}

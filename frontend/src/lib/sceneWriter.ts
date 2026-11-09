// 허브 답만 임대의 근거다. WS·타이머·창 복귀는 재확인할 신호일 뿐이다.
import { useSyncExternalStore } from "react";
import { getAccountNamespace } from "./accountScope";
import { flashMsg } from "./flash";
import { EXPECT_ACCOUNT_HEADER, hubHasFeature, subscribeHubFeatures } from "./hubFeatures";
import { getApiPause, jsonFetch, subscribeApiPause } from "./http";
import { collectCanvasForWriter, flushWriterInput, hasProfileSceneWriter, isCanvasWindow, setHubCanvasPaused, subscribeProfileSceneWriter } from "./popupWindows";
import { SCENE_WRITER_FEATURE, setSceneNotebookTokenProvider, syncSceneNotebook, subscribeNotebookSyncResult, type NotebookSyncResult, type NotebookToken } from "./sceneNotebook";
import { setAsidePendingWrites, setSceneLeaseGeneration, settleSceneWrites } from "./sceneStore";
import { listScenes, subscribeScenesPersisted } from "./scenes";

export type WriterMode = "disabled" | "writer" | "uncertain" | "away" | "taking" | "giving" | "local_only";
export interface WriterView { mode: WriterMode; handed: boolean; localCount: number }
export interface WriterStatus {
  boot_id: string; account_epoch: number; token?: string;
  writer: { browser_id: string; tab_id: string; generation: string; expires_in_ms: number } | null;
  handoff: { request_id: string; generation: string; browser_id: string; tab_id: string } | null;
  request_id?: string;
}
interface WriterDeps {
  account: () => string;
  eligible: () => boolean;
  send: (account: string, body: Record<string, unknown>) => Promise<WriterStatus>;
  sync: () => Promise<NotebookSyncResult>;
  settle: () => Promise<boolean>;
  lost: () => void;
  generation: (account: string, value: string | null) => void;
  changed: (view: WriterView) => void;
  notice: (text: string) => void;
  names: (ids: string[]) => string;
  localCount: () => number;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })]);
  } finally { clearTimeout(timer); }
}
const blocked = (mode: WriterMode) => mode === "away" || mode === "taking" || mode === "giving";
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const errorCode = (e: unknown) => (e as { detail?: string })?.detail;

/** 환경 의존 동작은 주입한다. 계정 A→B→A도 단조 epoch으로 늦은 응답을 버린다. */
export class SceneWriterClient {
  view: WriterView = { mode: "disabled", handed: false, localCount: 0 };
  private epoch = 0;
  private account = "";
  private lease: NotebookToken | null = null;
  private confirmedUntil = 0;
  private active = false;
  private busy: Promise<void> | null = null;
  private taking = false;
  private boot = "";
  private accountEpoch = -1;
  private localStopped = false;
  private prepared = false;
  private again = false;
  private pendingNotice: string | undefined;
  private mayClaim = true;
  constructor(private deps: WriterDeps, private browserId: string, private tabId: string) {}
  token = (): NotebookToken | null => this.active && this.deps.eligible() && this.account === this.deps.account() &&
    this.prepared && performance.now() < this.confirmedUntil ? this.lease : null;
  private show(mode: WriterMode, handed = this.view.handed) {
    this.view = { mode, handed, localCount: this.deps.localCount() };
    this.deps.changed(this.view);
  }
  configure(enabled: boolean) {
    const account = this.deps.account();
    if (this.active === enabled && this.account === account) return;
    this.epoch++;
    this.active = enabled;
    this.account = account;
    this.lease = null;
    this.confirmedUntil = 0;
    this.busy = null;
    this.taking = false;
    this.boot = "";
    this.accountEpoch = -1;
    this.localStopped = false;
    this.prepared = false;
    this.pendingNotice = undefined;
    this.mayClaim = true;
    if (enabled) this.deps.generation(account, null);
    this.show(enabled ? "uncertain" : "disabled", false);
  }
  private valid(epoch: number) { return this.active && epoch === this.epoch && this.account === this.deps.account() && this.deps.eligible(); }
  private send(action: string, extra: Record<string, unknown> = {}) {
    return this.deps.send(this.account, { action, browser_id: this.browserId, tab_id: this.tabId, ...extra });
  }
  private lose(handed = false) {
    this.mayClaim = false;
    this.confirmedUntil = 0;
    this.lease = null;
    this.prepared = false;
    this.pendingNotice = undefined;
    this.deps.lost();
    this.deps.generation(this.account, null);
    this.show("away", handed);
  }
  uncertain() {
    this.confirmedUntil = 0; // 정지/BFCache 복귀 직후에는 renew보다 업로드가 먼저 갈 수 없다.
    if (!blocked(this.view.mode) && this.active) this.show("uncertain");
  }
  resume() {
    if (!this.active || this.taking || this.view.mode === "giving") return;
    this.epoch++;
    this.busy = null;
    this.uncertain();
  }
  localChanged() { this.localStopped = false; }
  private confirm(status: WriterStatus) {
    if (!status.writer || !status.token) throw new Error("invalid_writer_reply");
    this.boot = status.boot_id;
    this.mayClaim = true;
    this.accountEpoch = status.account_epoch;
    this.lease = { account: this.account, token: status.token, generation: status.writer.generation };
    this.confirmedUntil = performance.now() + Math.max(0, status.writer.expires_in_ms - 1000);
    this.deps.generation(this.account, status.writer.generation);
  }
  private async reconcile(epoch: number) {
    const wasEditing = this.view.mode === "writer" || this.view.mode === "uncertain";
    const result = await this.deps.sync();
    if (!this.valid(epoch)) return;
    if (result.status === "ready") {
      this.show("writer", false);
      if (this.pendingNotice) this.deps.notice(this.pendingNotice);
      this.pendingNotice = undefined;
    } else if (result.status === "local_only") {
      this.confirmedUntil = 0;
      let released = false;
      try { await this.send("release", { token: this.lease?.token }); released = true; }
      catch (error) { released = errorCode(error) === "writer_required"; }
      if (!this.valid(epoch)) return;
      if (released) this.lease = null;
      this.show("local_only");
      this.localStopped = true;
      if (result.reason === "start_too_big") this.deps.notice(`5MiB 넘는 씬이 있어 허브 공책을 시작하지 못했습니다 — 이 브라우저에서만 편집됩니다: ${this.deps.names(result.sceneIds ?? [])}`);
    } else if (result.status === "waiting_token") {
      if (["writer_required", "writer_changed", "writer_expired"].includes(result.reason ?? "")) this.lose();
      else this.uncertain();
    } else if (wasEditing) this.uncertain();
    else this.show("taking"); // 최초 맞추기를 마치기 전에는 편집을 열지 않는다.
  }
  refresh(): Promise<void> {
    if (!this.active || !this.deps.eligible() || this.taking || this.localStopped) return Promise.resolve();
    if (this.busy) { this.again = true; return this.busy; }
    const epoch = this.epoch;
    const work = this.check(epoch).finally(() => {
      if (this.busy !== work) return;
      this.busy = null;
      if (this.again) { this.again = false; void this.refresh(); }
    });
    this.busy = work;
    return work;
  }
  private async check(epoch: number) {
    const ownedAtStart = !!this.lease;
    try {
      // 새 프로세스·계정 세대 확인 뒤에만 claim/renew한다. 신호 내용은 권한으로 쓰지 않는다.
      let renewedFirst = false;
      let status: WriterStatus;
      if (this.lease && !this.token()) {
        try {
          status = await this.send("renew", { token: this.lease.token });
          if (!this.valid(epoch)) return;
          this.confirm(status);
          renewedFirst = true;
        } catch (error) {
          if (!this.valid(epoch)) return;
          if (errorCode(error) !== "writer_required") throw error;
          this.lose();
          status = await this.send("status");
        }
      } else status = await this.send("status");
      if (!this.valid(epoch)) return;
      if (this.lease && (status.boot_id !== this.boot || status.account_epoch !== this.accountEpoch || status.writer?.generation !== this.lease.generation)) {
        this.lose();
      }
      if (!status.writer) {
        // 넘겨준 탭은 자동으로 되찾지 않는다. 요청한 탭에 claim 기회를 남긴다.
        if (!this.mayClaim && !ownedAtStart) return;
        const granted = await this.send("claim");
        if (!this.valid(epoch)) return;
        this.confirm(granted);
        this.show("taking");
        if (!(await this.deps.settle()) || !this.valid(epoch)) return;
        this.prepared = true;
        await this.reconcile(epoch);
      } else if (this.lease && status.writer.generation === this.lease.generation) {
        const renewed = renewedFirst ? status : await this.send("renew", { token: this.lease.token });
        if (!this.valid(epoch)) return;
        this.confirm(renewed);
        if (!this.prepared) {
          if (!(await this.deps.settle()) || !this.valid(epoch)) return;
          this.prepared = true;
        }
        if (status.handoff && status.handoff.generation === this.lease.generation && status.handoff.tab_id !== this.tabId) {
          await this.give(epoch);
        } else await this.reconcile(epoch);
      } else this.lose();
    } catch (error) {
      if (!this.valid(epoch)) return;
      if (["writer_busy", "writer_required", "writer_changed"].includes(errorCode(error) ?? "")) this.lose();
      else this.uncertain(); // 허브가 꺼져도 확정적으로 넘긴 적 없는 브라우저는 로컬 편집 가능.
    }
  }
  private async give(epoch: number) {
    const lease = this.lease;
    if (!lease) return;
    this.show("giving");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      const saved = await Promise.race([
        (async () => {
          if (!(await this.deps.settle()) || expired || !this.valid(epoch)) return false;
          const result = await this.deps.sync();
          return result.status === "ready";
        })(),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => {
          expired = true;
          if (this.valid(epoch) && this.lease === lease) this.lose();
          resolve(false);
        }, 5000); }),
      ]);
      if (!this.valid(epoch) || expired || !saved || this.lease !== lease) {
        if (this.valid(epoch)) this.lose();
        return;
      }
      // release 응답이 유실되면 정상 넘김으로 표시하지 않는다. 본문에는 이 인계의 토큰만 싣는다.
      await this.send("release", { token: lease.token });
      if (this.valid(epoch) && !expired) this.lose(true);
    } catch { if (this.valid(epoch)) this.lose(); }
    finally { clearTimeout(timer); }
  }
  async take(): Promise<void> {
    if (!this.active || !this.deps.eligible() || this.taking || this.view.mode === "giving") return;
    const epoch = ++this.epoch; // 진행 중 조회/맞추기의 늦은 응답도 이 요청을 덮지 못한다.
    this.taking = true;
    this.lease = null;
    this.prepared = false;
    this.confirmedUntil = 0;
    this.show("taking", false);
    try {
      const request = await this.send("request");
      if (!this.valid(epoch)) return;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!this.valid(epoch)) return;
        const status = await beforeDeadline(this.send("status"), deadline);
        if (!this.valid(epoch)) return;
        if (!status || Date.now() >= deadline) break;
        if (!status.writer) {
          const grant = await this.send("claim");
          if (!this.valid(epoch)) return;
          this.confirm(grant);
          if (!(await this.deps.settle()) || !this.valid(epoch)) return;
          this.prepared = true;
          this.pendingNotice = "넘겨받았습니다";
          await this.reconcile(epoch);
          return;
        }
        await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
      }
      const grant = await this.send("force", { request_id: request.request_id });
      if (!this.valid(epoch)) return;
      this.confirm(grant);
      if (!(await this.deps.settle()) || !this.valid(epoch)) return;
      this.prepared = true;
      this.pendingNotice = "강제로 넘겨받았습니다\n다른 브라우저의 마지막 편집은 그 브라우저를 다시 열 때 [옛 창] 탭으로 들어옵니다";
      await this.reconcile(epoch);
    } catch { if (this.valid(epoch)) this.lose(); }
    finally { if (epoch === this.epoch) this.taking = false; }
  }
  releaseBeacon(send: (body: string) => void) {
    const token = this.lease?.token;
    this.epoch++;
    this.busy = null;
    this.taking = false;
    this.confirmedUntil = 0;
    if (this.active && token) send(JSON.stringify({ action: "release", token }));
  }
}

let view: WriterView = { mode: "disabled", handed: false, localCount: 0 };
const subscribers = new Set<() => void>();
export const getSceneWriterView = (): WriterView => view;
export const subscribeSceneWriter = (fn: () => void): (() => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
export const useSceneWriter = (): WriterView => useSyncExternalStore(subscribeSceneWriter, getSceneWriterView);
let client: SceneWriterClient | null = null;
let waitingForFeature = false;
let floatingStarted = false;
let flushPending: () => void = () => {};
export function setSceneWriterFlush(flush: () => void): () => void {
  flushPending = flush;
  return () => { if (flushPending === flush) flushPending = () => {}; };
}
export function signalSceneWriter(): void { void client?.refresh(); }
export function sceneWriterSuspended(): void { client?.resume(); }
export function sceneWriterAccountChanged(): void {
  if (!client) return;
  client.configure(false);
  client.configure(hubHasFeature(SCENE_WRITER_FEATURE) && !getApiPause());
}
export function takeSceneWriter(): void { void client?.take(); }
const GENERATION_KEY = "mvhub.sceneLeaseGeneration";

/** 저장소 부팅 뒤 한 번 연결한다. 분리 창에는 토큰을 넘기지 않는다. */
export function startSceneWriter(): void {
  if (client || floatingStarted) return;
  if (!hubHasFeature(SCENE_WRITER_FEATURE)) {
    if (!waitingForFeature) {
      waitingForFeature = true;
      const off = subscribeHubFeatures(() => {
        if (!hubHasFeature(SCENE_WRITER_FEATURE)) return;
        off(); waitingForFeature = false; startSceneWriter();
      });
    }
    return;
  }
  if (isCanvasWindow()) {
    floatingStarted = true;
    // 창이 열릴 때 복사된 세대를 고정한다. 늦은 인계에 새 세대를 붙이지 않는다.
    const enable = () => {
      if (!hubHasFeature(SCENE_WRITER_FEATURE)) return;
      let generation: string | null = null;
      try { generation = sessionStorage.getItem(GENERATION_KEY); } catch { /* 저장소 차단 */ }
      setSceneLeaseGeneration(getAccountNamespace(), generation);
    };
    subscribeHubFeatures(enable);
    enable();
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("mvhub-scene-lease");
    if (channel) channel.onmessage = (event: MessageEvent<{ account: string; paused: boolean }>) => {
      if (!hubHasFeature(SCENE_WRITER_FEATURE) || event.data.account !== getAccountNamespace()) return;
      if (event.data.paused) flushWriterInput(flushPending);
      setHubCanvasPaused(event.data.paused);
    };
    setInterval(() => { if (!window.opener || window.opener.closed) setHubCanvasPaused(false); }, 1000);
    return;
  }
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("mvhub-scene-lease");
  let browserId: string;
  try { browserId = localStorage.getItem("mvhub.sceneBrowser") || id(); localStorage.setItem("mvhub.sceneBrowser", browserId); }
  catch { browserId = id(); }
  client = new SceneWriterClient({
    account: getAccountNamespace,
    eligible: () => hasProfileSceneWriter() && !getApiPause(),
    send: (account, body) => jsonFetch<WriterStatus>("/api/scenes/writer", { method: "POST", body: JSON.stringify(body), headers: { [EXPECT_ACCOUNT_HEADER]: account }, signal: AbortSignal.timeout(5000) }),
    sync: syncSceneNotebook,
    settle: async () => {
      if (!(await collectCanvasForWriter(4500))) return false;
      return settleSceneWrites(4500, () => flushWriterInput(flushPending));
    },
    lost: () => { flushWriterInput(flushPending); setAsidePendingWrites(); },
    generation: (account, generation) => {
      setSceneLeaseGeneration(account, generation);
      try { if (generation) sessionStorage.setItem(GENERATION_KEY, generation); else sessionStorage.removeItem(GENERATION_KEY); } catch { /* 저장소 차단은 임대의 근거가 아니다. */ }
    },
    changed: (next) => {
      if (blocked(next.mode)) flushWriterInput(flushPending);
      view = next;
      setHubCanvasPaused(blocked(next.mode));
      if (hasProfileSceneWriter()) channel?.postMessage({ account: getAccountNamespace(), paused: blocked(next.mode) });
      subscribers.forEach((fn) => fn());
    },
    notice: flashMsg,
    names: (ids) => listScenes(null).filter((s) => ids.includes(s.id)).map((s) => s.name).join(", "),
    localCount: () => listScenes(null).filter((s) => s.localNotebookCopy === "upload_failed").length,
  }, browserId, id());
  setSceneNotebookTokenProvider(() => client?.token() ?? null);
  const configure = () => {
    client!.configure(hubHasFeature(SCENE_WRITER_FEATURE) && !getApiPause());
    signalSceneWriter();
  };
  subscribeHubFeatures(configure);
  subscribeApiPause(configure);
  subscribeProfileSceneWriter(configure);
  subscribeNotebookSyncResult((result) => {
    if (result.status === "waiting_token" && ["writer_required", "writer_changed", "writer_expired"].includes(result.reason ?? "")) {
      sceneWriterSuspended();
      signalSceneWriter();
    }
  });
  subscribeScenesPersisted(() => { if (client?.view.mode === "local_only") { client.localChanged(); signalSceneWriter(); } });
  setInterval(() => { configure(); }, 20_000);
  const resume = () => { if (document.visibilityState !== "hidden") { sceneWriterSuspended(); configure(); } };
  window.addEventListener("pageshow", resume);
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pagehide", () => {
    client?.releaseBeacon((body) => { if (!getApiPause()) navigator.sendBeacon?.("/api/scenes/writer", new Blob([body], { type: "application/json" })); });
  });
  configure();
}

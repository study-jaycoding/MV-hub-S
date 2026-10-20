// localStorage가 원본이다. 서버 판 번호는 이 탭이 같은 원문으로 확인한 것만 승계한다.
import { getAccountNamespace } from "./accountScope";
import { parseEditDoc } from "./editTimeline";
import { readEditRaw, subscribeEditRaw } from "./editTimelineStore";
import { getApiPause, getAuthToken, jsonFetch, withRequestTimeout } from "./http";
import { EXPECT_ACCOUNT_HEADER } from "./hubFeatures";
import { utf8Bytes } from "./editArchive";

const API = "/api/edit-docs/backup";
const MAX_BYTES = 1024 * 1024;
export interface BackupMeta { revision: number; data_hash: string; updated_at: string; bytes: number; data?: string }
export interface BackupCopy { data_hash: string; kind: string; created_at: string; bytes: number; data?: string }
export interface BackupListing { head: BackupMeta | null; copies: BackupCopy[]; total_copies: number; copy?: BackupCopy }
export type BackupState = "off" | "idle" | "pending" | "saving" | "saved" | "conflict" | "error" | "invalid" | "too_big";
export interface EditBackupStatus { state: BackupState; updatedAt?: string; preservedAt?: string; skipped: number }
interface Entry {
  raw: string; revision: number | null; checked: boolean; acceptedRaw?: string; uncertainRaw?: string; epoch: number;
  conflict: boolean; inFlight: boolean; timer?: ReturnType<typeof setTimeout>; status: EditBackupStatus;
}
interface BackupSession { namespace: string; token: string | null; generation: number }
let session: BackupSession | null = null;
let generation = 0;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const OFF: EditBackupStatus = { state: "off", skipped: 0 };
let idle: EditBackupStatus = { state: "idle", skipped: 0 };
const restoring = new Map<string, BackupSession | null>();
let skipped = 0;
let stopListeners: (() => void) | null = null;
export const subscribeEditBackup = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const notify = () => listeners.forEach((fn) => fn());
export function editBackupDocKey(key: string): string | null {
  for (const prefix of [`mvhub.editDoc:${getAccountNamespace()}:`, `ch.editTimeline:${getAccountNamespace()}:`]) {
    if (key.startsWith(prefix) && !key.endsWith(".bad") && !key.endsWith(".ui")) {
      const id = key.slice(prefix.length);
      return id && id.length <= 4096 ? id : null;
    }
  }
  return null;
}
function current(captured: BackupSession | null): boolean {
  return !!captured && session === captured && captured.namespace === getAccountNamespace()
    && captured.token === getAuthToken() && !getApiPause();
}
export function editBackupActive(): boolean { return current(session); }
export function captureEditBackupGuard(): () => boolean {
  const captured = session;
  return () => current(captured);
}
export function getEditBackupStatus(key: string | null): EditBackupStatus {
  return key && editBackupActive() ? entries.get(editBackupDocKey(key) ?? "")?.status ?? idle : OFF;
}
function status(entry: Entry, state: BackupState, extra: Partial<EditBackupStatus> = {}) {
  entry.status = { ...entry.status, state, skipped, ...extra };
  notify();
}
function recountSkipped() {
  const count = [...entries.values()].filter((entry) => entry.status.state === "invalid" || entry.status.state === "too_big").length + readErrors;
  if (count === skipped) return;
  skipped = count; idle = { state: "idle", skipped };
  for (const entry of entries.values()) entry.status = { ...entry.status, skipped };
  notify();
}
let readErrors = 0;
const validRaw = (raw: string): boolean => { try { return !!parseEditDoc(JSON.parse(raw)); } catch { return false; } };
function schedule(id: string, entry: Entry, delay = entry.conflict ? 5000 : 2000) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { entry.timer = undefined; void send(id, entry); }, delay);
}
function remember(key: string, raw: string | null, source: "write" | "read") {
  if (!editBackupActive() || raw === null) return;
  const id = editBackupDocKey(key);
  if (id === null) return;
  let entry = entries.get(id);
  if (entry?.raw === raw) return;
  if (!entry) {
    entry = { raw, revision: null, checked: false, epoch: 0, conflict: false, inFlight: false,
      status: { state: "pending", skipped } };
    entries.set(id, entry);
  } else {
    entry.raw = raw;
    if (source === "read") { entry.epoch += 1; entry.checked = false; entry.revision = null; entry.acceptedRaw = undefined; entry.uncertainRaw = undefined; }
  }
  if (!validRaw(raw)) { status(entry, "invalid"); recountSkipped(); return; }
  if (utf8Bytes(raw) > MAX_BYTES) { status(entry, "too_big"); recountSkipped(); return; }
  status(entry, entry.conflict ? "conflict" : "pending");
  recountSkipped();
  schedule(id, entry);
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const captured = session;
  if (!current(captured)) throw new Error("편집 백업 연결을 확인하세요.");
  const result = await withRequestTimeout((signal) => jsonFetch<T>(url, { ...init, signal,
    headers: { [EXPECT_ACCOUNT_HEADER]: captured!.namespace } }), 15_000, "편집 백업 응답을 확인하지 못했습니다.");
  if (!current(captured)) throw new Error("계정이 바뀌어 백업 응답을 적용하지 않았습니다.");
  return result;
}
export async function loadEditBackup(key: string, offset = 0, copyHash?: string): Promise<BackupListing> {
  const id = editBackupDocKey(key);
  if (id === null) throw new Error("편집 백업 대상을 확인하세요.");
  return request(`${API}?doc_key=${encodeURIComponent(id)}&include_data=1&offset=${offset}&limit=20${copyHash ? `&copy_hash=${encodeURIComponent(copyHash)}` : ""}`);
}
async function send(id: string, entry: Entry) {
  const captured = session;
  if (!current(captured) || restoring.has(id) || entry.inFlight || !validRaw(entry.raw) || utf8Bytes(entry.raw) > MAX_BYTES) return;
  entry.inFlight = true;
  const epoch = entry.epoch;
  const raw = entry.raw;
  let failed = false;
  let putAttempted = false;
  status(entry, "saving");
  try {
    const uncertainRaw = entry.uncertainRaw;
    const confirmUncertain = uncertainRaw !== undefined && uncertainRaw !== raw;
    if (!entry.checked || confirmUncertain) {
      const listing = await request<BackupListing>(`${API}?doc_key=${encodeURIComponent(id)}&include_data=1&limit=1`);
      if (!current(captured) || entry.epoch !== epoch || entry.raw !== raw) return;
      entry.checked = true;
      if (confirmUncertain) {
        entry.uncertainRaw = undefined;
        entry.acceptedRaw = undefined;
        // 응답을 잃은 자기 원문과 정확히 같을 때만 후속 편집에 판 번호를 승계한다.
        if (listing.head?.data === uncertainRaw) {
          entry.revision = listing.head.revision; entry.acceptedRaw = uncertainRaw; entry.conflict = false;
        }
      } else entry.revision = listing.head?.data === raw ? listing.head.revision : null;
      if (listing.head?.data === raw) {
        entry.revision = listing.head.revision; entry.acceptedRaw = raw; entry.uncertainRaw = undefined; entry.conflict = false;
        status(entry, "saved", { updatedAt: listing.head.updated_at });
        return;
      }
    }
    if (entry.acceptedRaw === raw) { status(entry, entry.conflict ? "conflict" : "saved"); return; }
    putAttempted = true;
    const response = await request<{ status: "saved" | "same" | "conflict"; head: BackupMeta }>(API, {
      method: "PUT", body: JSON.stringify({ doc_key: id, data: raw, base_revision: entry.revision }),
    });
    if (!current(captured) || entry.epoch !== epoch) return;
    entry.uncertainRaw = undefined;
    entry.acceptedRaw = raw;
    entry.conflict = response.status === "conflict";
    if (entry.conflict) entry.checked = false;
    entry.revision = entry.conflict ? null : response.head.revision;
    const latestState = !validRaw(entry.raw) ? "invalid" : utf8Bytes(entry.raw) > MAX_BYTES ? "too_big"
      : entry.conflict ? "conflict" : entry.raw === raw ? "saved" : "pending";
    status(entry, latestState,
      entry.conflict ? { preservedAt: new Date().toISOString() } : { updatedAt: response.head.updated_at });
    recountSkipped();
  } catch {
    // 연결 실패는 이 탭이 확인한 판 번호를 무효화하지 않는다. 재시도도 서버의 비교·저장 검사를 거친다.
    if (current(captured) && entry.epoch === epoch) {
      failed = true;
      if (putAttempted) entry.uncertainRaw = raw;
      status(entry, "error");
    }
  } finally {
    entry.inFlight = false;
    if (current(captured) && (failed || entry.raw !== raw || entry.epoch !== epoch)) schedule(id, entry, failed ? 30_000 : undefined);
  }
}
export function retryEditBackups() {
  for (const [id, entry] of entries) { if (entry.timer) clearTimeout(entry.timer); void send(id, entry); }
}

// 성공 응답을 확인한 뒤에만 호출부가 로컬에 쓴다. 응답 불명은 읽어서 확인하고도 로컬은 유지한다.
export async function restoreEditBackup(key: string, baseRevision: number | null, source: { data: string } | { copy_hash: string },
  localRaw: string | null, kind: "pre_restore" | "pre_adopt" = "pre_restore") {
  const id = editBackupDocKey(key);
  if (id === null) throw new Error("편집 백업 대상을 확인하세요.");
  const entry = entries.get(id);
  // 시작된 자동 백업이 있으면 그 응답을 먼저 끝내고 목록을 다시 고르게 한다.
  if (entry?.inFlight || restoring.has(id)) throw new Error("백업 중입니다. 잠시 뒤 목록을 다시 읽어 주세요.");
  const captured = session;
  restoring.set(id, captured);
  if (entry?.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
  if (entry) entry.inFlight = true;
  try {
    const result = await request<{ status: "saved" | "same" | "conflict"; head: BackupMeta | null; data?: string }>(`${API}/restore`, {
      method: "POST", body: JSON.stringify({ doc_key: id, base_revision: baseRevision, source, local_raw: localRaw, kind }),
    });
    if (!current(captured)) throw new Error("계정이 바뀌어 복원 응답을 적용하지 않았습니다.");
    if (entry && current(captured)) {
      entry.checked = false; entry.revision = null; entry.acceptedRaw = undefined; entry.uncertainRaw = undefined; entry.epoch += 1;
    }
    return result;
  } catch (error) {
    if (current(captured)) await loadEditBackup(key).catch(() => null);
    throw error;
  } finally {
    if (restoring.get(id) === captured) restoring.delete(id);
    if (entry) entry.inFlight = false;
    const latest = entries.get(id);
    if (latest && current(captured)) schedule(id, latest);
  }
}

export function stopEditDocBackup() {
  session = null; generation += 1;
  stopListeners?.(); stopListeners = null;
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
  entries.clear(); restoring.clear(); skipped = 0; readErrors = 0; idle = { state: "idle", skipped: 0 }; notify();
}
export function startEditDocBackup(): () => void {
  stopEditDocBackup();
  const captured = { namespace: getAccountNamespace(), token: getAuthToken(), generation: ++generation };
  session = captured;
  const unsubscribe = subscribeEditRaw(remember);
  const hidden = () => { if (document.visibilityState === "hidden") retryEditBackups(); };
  const external = (event: StorageEvent) => {
    if (!event.key || editBackupDocKey(event.key) === null) return;
    const id = editBackupDocKey(event.key)!;
    const key = `mvhub.editDoc:${captured.namespace}:${id}`;
    const read = readEditRaw(key);
    if (read.kind === "ok") remember(key, read.raw, "read");
  };
  window.addEventListener("online", retryEditBackups);
  window.addEventListener("storage", external);
  document.addEventListener("visibilitychange", hidden);
  stopListeners = () => {
    unsubscribe(); window.removeEventListener("online", retryEditBackups); window.removeEventListener("storage", external);
    document.removeEventListener("visibilitychange", hidden);
  };
  const keys = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && editBackupDocKey(key) !== null) keys.add(`mvhub.editDoc:${captured.namespace}:${editBackupDocKey(key)}`);
    }
  } catch { readErrors += 1; }
  for (const key of keys) {
    const read = readEditRaw(key);
    if (read.kind === "error") { readErrors += 1; continue; }
    remember(key, read.raw, "read");
  }
  // 누락 개수도 문서 상태와 같은 구독으로 보낸다.
  recountSkipped();
  notify();
  return () => { if (session === captured) stopEditDocBackup(); };
}

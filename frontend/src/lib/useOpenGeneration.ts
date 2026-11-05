import { useEffect, useRef } from 'react';
import { APP_EVENTS } from './appEvents';
import { getAccountNamespace, getConnectionKey } from './accountScope';
import { getApiPause, getAuthToken, jsonFetch } from './http';
import { EXPECT_ACCOUNT_HEADER } from './hubFeatures';
import type { GenComment } from '../types';

export interface OpenGeneration { generation_id: string; comment_id: string; open_id: string }
const scope = () => `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken()}`;

export async function handleOpenGeneration(detail: OpenGeneration, windowId: string, open: (id: string) => void) {
  if (getApiPause()) return;
  const before = scope();
  const headers = { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() };
  const body = { open_id: detail.open_id, window_id: windowId };
  try { await jsonFetch('/api/open/claim', { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch { return; }
  let ok = false;
  try {
    const comments = await jsonFetch<GenComment[]>(`/api/generations/${encodeURIComponent(detail.generation_id)}/comments`, { headers });
    if (before !== scope() || getApiPause() || !comments.some(c => c.id === detail.comment_id)) throw new Error('unavailable');
    try { await jsonFetch(`/api/generation-comments/${encodeURIComponent(detail.comment_id)}/seen`, { method: 'POST', headers }); }
    catch { /* Read marking is best effort; acknowledgement reflects opening the panel. */ }
    if (before !== scope() || getApiPause()) throw new Error('changed');
    open(detail.generation_id);
    ok = before === scope() && !getApiPause();
  } catch { /* acknowledge failure without exposing comment data */ }
  try { await jsonFetch('/api/open/ack', { method: 'POST', headers, body: JSON.stringify({ ...body, ok }) }); }
  catch { /* expired request or changed account: never retry opening */ }
}

export function useOpenGeneration(open: (id: string) => void) {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (new URLSearchParams(location.search).has('embed')) return;
    const id = crypto.randomUUID();
    const abort = new AbortController();
    let leader = !navigator.locks;
    let release: (() => void) | undefined;
    let alive = true;
    const seen = new Set<string>();
    if (navigator.locks) {
      void navigator.locks.request('mvhub-slack-open', { signal: abort.signal }, async () => {
        if (!alive) return;
        leader = true;
        await new Promise<void>(resolve => { release = resolve; });
        leader = false;
      }).catch(() => {});
    }
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<OpenGeneration>).detail;
      if (!leader || !detail?.open_id || seen.has(detail.open_id)) return;
      seen.add(detail.open_id);
      if (seen.size > 100) seen.delete(seen.values().next().value!);
      void handleOpenGeneration(detail, id, target => openRef.current(target));
    };
    window.addEventListener(APP_EVENTS.openGeneration, receive);
    return () => { alive = false; abort.abort(); release?.(); window.removeEventListener(APP_EVENTS.openGeneration, receive); };
  }, []);
}

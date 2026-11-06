import { useEffect, useRef } from 'react';
import { APP_EVENTS } from './appEvents';
import { getAccountNamespace, getConnectionKey } from './accountScope';
import { getApiPause, getAuthToken, jsonFetch, withRequestTimeout } from './http';
import { EXPECT_ACCOUNT_HEADER } from './hubFeatures';
import { requestCommentHighlight } from './commentHighlight';
import { isAppWindow } from './appWindow';
import type { GenComment } from '../types';

export interface OpenGeneration { generation_id: string; comment_id: string; open_id: string }
const scope = () => `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken()}`;
// 일반 브라우저 탭은 늦게 받는다 — 앱 창이 있으면 앱 창이 먼저 받아 맨 앞으로 오게(Jay 2026-11-05 A안).
//  일반 탭이 먼저 받으면 그 탭에서만 열리고 창은 안 올라온다(승인 창이 아니라서). 허브의 받기 기한(방송 뒤 3초) 안이다.
export const REGULAR_TAB_CLAIM_DELAY_MS = 500;
// 허브는 방송 뒤 3초까지만 받기·확인(ack)을 받는다 — 받은 때부터(일반 탭 지연 포함) 이 안에 열고 확인을 보낸다.
//  요청마다 3초씩 주면 합쳐서 기한을 넘겨, 허브는 '창 없음'을 답했는데 화면은 열리는 일이 생긴다(Codex 리뷰 P2).
export const OPEN_BUDGET_MS = 2500;
// claim 응답의 남은 시간에서 확인(ack)이 닿을 여유 — 이벤트를 늦게 처리했어도 허브 기한 안에서만 연다(Codex 리뷰 P2)
export const HUB_DEADLINE_MARGIN_MS = 300;
let openingOwner: symbol | null = null;
const openFetch = <T,>(url: string, init: RequestInit, deadline: number) => {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new Error('열기 요청 시간이 지났습니다'));
  return withRequestTimeout(signal => jsonFetch<T>(url, { ...init, signal }), left, '열기 요청 시간이 지났습니다');
};

export async function handleOpenGeneration(detail: OpenGeneration, windowId: string, open: (id: string) => void,
                                           deadline = Date.now() + OPEN_BUDGET_MS, live: () => boolean = () => true) {
  // Reject overlapping opens in this document; a queued claim could already be expired.
  if (openingOwner || getApiPause()) return;
  const owner = Symbol();
  openingOwner = owner;
  try { await openGeneration(detail, windowId, open, owner, deadline, live); }
  finally { if (openingOwner === owner) openingOwner = null; }
}

async function openGeneration(detail: OpenGeneration, windowId: string, open: (id: string) => void, owner: symbol,
                              deadline: number, live: () => boolean) {
  const before = scope();
  // 화면이 떠났거나(언마운트) 계정·연결이 바뀌었거나 기한이 지났으면 읽음 처리·열기를 하지 않는다(Codex 리뷰 P2)
  const still = () => live() && before === scope() && !getApiPause() && Date.now() < deadline;
  const headers = { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() };
  const body = { open_id: detail.open_id, window_id: windowId };
  let claimed: { remaining_ms?: unknown } | null;
  const claimStart = Date.now();
  try { claimed = await openFetch<{ remaining_ms?: unknown } | null>('/api/open/claim', { method: 'POST', headers, body: JSON.stringify(body) }, deadline); }
  catch { return; }
  // 허브가 센 남은 시간으로 기한을 당긴다 — 받은 때부터 센 2.5초는 방송을 늦게 처리하면 허브 기한보다 늦게 끝난다.
  //  허브는 요청을 보낸 뒤에 셌으므로 '보낸 시각 + 남은 시간'은 허브 기한을 넘지 않는다(응답이 늦게 와도 기한이 늘지 않게, Codex 리뷰 3차 P2)
  if (typeof claimed?.remaining_ms === 'number') deadline = Math.min(deadline, claimStart + claimed.remaining_ms - HUB_DEADLINE_MARGIN_MS);
  let ok = false;
  try {
    const comments = await openFetch<GenComment[]>(`/api/generations/${encodeURIComponent(detail.generation_id)}/comments`, { headers }, deadline);
    if (!still() || !comments.some(c => c.id === detail.comment_id)) throw new Error('unavailable');
    try { await openFetch(`/api/generation-comments/${encodeURIComponent(detail.comment_id)}/seen`, { method: 'POST', headers }, deadline); }
    catch { /* Read marking is best effort; acknowledgement reflects opening the panel. */ }
    if (!still()) throw new Error('changed');
    open(detail.generation_id);
    requestCommentHighlight(detail.comment_id); // 누르고 온 코멘트가 3번 깜빡인다(시안 v4)
    ok = live() && before === scope() && !getApiPause();
  } catch { /* acknowledge failure without exposing comment data */ }
  // 열었으면 이 창의 제목을 잠깐 표식으로 바꿔 허브가 그 창(앱 창)을 맨 앞으로 올리게 한다(Jay 2026-11-05 시안 v4).
  //  허브는 ack 를 받은 뒤 이 제목의 최상위 창을 찾아 올리고 답한다 — 답을 받으면 제목을 돌려놓는다.
  const title = document.title;
  const marker = ok ? `MVHubOpen-${crypto.randomUUID()}` : '';
  if (marker) document.title = marker;
  try {
    await withRequestTimeout(signal => jsonFetch('/api/open/ack', {
      method: 'POST', headers, signal, body: JSON.stringify({ ...body, ok, ...(marker ? { marker } : {}) }),
    }), 1500, '열기 확인 시간이 지났습니다');
  }
  catch { /* expired request or changed account: never retry opening */ }
  finally { if (openingOwner === owner && marker && document.title === marker) document.title = title; }
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
    const app = isAppWindow(); // 이 문서가 앱 창인지는 뜰 때 한 번 정해진다 — 잠금 이름과 받기 시점이 같은 판정을 쓴다
    if (navigator.locks) {
      // 앱 창과 일반 탭은 대표를 따로 뽑는다 — 일반 탭이 먼저 잡아 둔 잠금 때문에 같은 프로필의 앱 창이 못 받는 일이 없게(Codex 리뷰 P2).
      //  둘 다 받아도 허브의 받기(claim)는 먼저 온 한 창만 받는다 — 앱 창은 바로, 일반 탭은 0.5초 뒤.
      void navigator.locks.request(app ? 'mvhub-slack-open-app' : 'mvhub-slack-open-tab', { signal: abort.signal }, async () => {
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
      const deadline = Date.now() + OPEN_BUDGET_MS;
      const claim = () => { if (alive) void handleOpenGeneration(detail, id, target => openRef.current(target), deadline, () => alive); };
      if (app) claim();
      else setTimeout(claim, REGULAR_TAB_CLAIM_DELAY_MS);
    };
    window.addEventListener(APP_EVENTS.openGeneration, receive);
    return () => { alive = false; abort.abort(); release?.(); window.removeEventListener(APP_EVENTS.openGeneration, receive); };
  }, []);
}

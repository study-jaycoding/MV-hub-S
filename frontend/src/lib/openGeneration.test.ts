// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./http')>()),
  getApiPause: vi.fn(() => null), getAuthToken: vi.fn(() => 'token'), jsonFetch: vi.fn(),
}));
vi.mock('./accountScope', () => ({ getAccountNamespace: vi.fn(() => 'acct:unit'), getConnectionKey: vi.fn(() => 'server') }));
vi.mock('./appWindow', () => ({ isAppWindow: () => true })); // claim at once (no regular-tab delay)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getAccountNamespace } from './accountScope';
import { APP_EVENTS } from './appEvents';
import { getApiPause, jsonFetch, setApiPause } from './http';
import { handleOpenGeneration, useOpenGeneration } from './useOpenGeneration';
import { takeCommentHighlight } from './commentHighlight';

const detail = { generation_id: 'g', comment_id: 'c', open_id: 'request' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(jsonFetch).mockReset(); vi.mocked(getAccountNamespace).mockReturnValue('acct:unit'); takeCommentHighlight(['c']); });
afterEach(() => vi.useRealTimers());
describe('Slack open navigation', () => {
  it('rejects the overlapping request even when it would finish before the first acknowledgement', async () => {
    document.title = 'Millionvolt Hub';
    let complete!: (value: unknown) => void;
    vi.mocked(jsonFetch).mockImplementation(async url => {
      if (String(url).endsWith('/comments')) return [{ id: 'c' }];
      if (url === '/api/open/ack') return new Promise(resolve => { complete = resolve; });
      return { ok: true };
    });
    const opened = vi.fn();
    const first = handleOpenGeneration(detail, 'window', opened);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const marker = document.title;
    await handleOpenGeneration({ ...detail, open_id: 'second' }, 'window', opened);
    expect(document.title).toBe(marker);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jsonFetch).mock.calls.filter(c => c[0] === '/api/open/claim')).toHaveLength(1);
    complete({ ok: true });
    await first;
    expect(document.title).toBe('Millionvolt Hub');
  });

  it('restores title on ack timeout and a late response cannot overwrite the next owner', async () => {
    vi.useFakeTimers();
    document.title = 'Millionvolt Hub';
    const complete: Array<(value: unknown) => void> = [];
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/comments')) return [{ id: 'c' }];
      if (url === '/api/open/ack') return new Promise((resolve, reject) => {
        complete.push(resolve);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return { ok: true };
    });
    const first = handleOpenGeneration(detail, 'window', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    await first;
    expect(document.title).toBe('Millionvolt Hub');
    const second = handleOpenGeneration({ ...detail, open_id: 'second' }, 'window', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const secondTitle = document.title;
    complete[0]({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.title).toBe(secondTitle);
    complete[1]({ ok: true });
    await second;
    expect(document.title).toBe('Millionvolt Hub');
  });

  it('does not open after the hub deadline even when each request was within its own limit', async () => {
    vi.useFakeTimers();
    vi.mocked(jsonFetch).mockImplementation(async url => {
      if (url === '/api/open/claim') return new Promise(resolve => setTimeout(() => resolve({ ok: true }), 1200));
      if (String(url).endsWith('/comments')) return new Promise(resolve => setTimeout(() => resolve([{ id: 'c' }]), 1400));
      return { ok: true };
    });
    const open = vi.fn();
    const done = handleOpenGeneration(detail, 'window', open); // 1.2초 + 1.4초 = 받은 때부터 2.6초 — 허브 기한(OPEN_BUDGET_MS) 뒤
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(open).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(c => String(c[0]).includes('/seen'))).toBe(false);
    const ack = vi.mocked(jsonFetch).mock.calls.find(c => c[0] === '/api/open/ack');
    expect(JSON.parse(String(ack?.[1]?.body)).ok).toBe(false);
  });

  it('follows the hub remaining time from the claim when the broadcast was handled late', async () => {
    vi.useFakeTimers();
    vi.mocked(jsonFetch).mockImplementation(async url => {
      if (url === '/api/open/claim') return { ok: true, remaining_ms: 400 }; // 이 창이 방송을 늦게 처리해 허브 기한이 0.4초 남음
      if (String(url).endsWith('/comments')) return new Promise(resolve => setTimeout(() => resolve([{ id: 'c' }]), 200));
      return { ok: true };
    });
    const open = vi.fn();
    const done = handleOpenGeneration(detail, 'window', open); // 받은 때부터 센 2.5초로는 아직 열 수 있는 0.2초 뒤
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(open).not.toHaveBeenCalled();
    const ack = vi.mocked(jsonFetch).mock.calls.find(c => c[0] === '/api/open/ack');
    expect(JSON.parse(String(ack?.[1]?.body)).ok).toBe(false);
  });

  it('does not stretch the hub deadline by a slow claim response', async () => {
    vi.useFakeTimers();
    vi.mocked(jsonFetch).mockImplementation(async url => {
      // 허브는 0.4초 남았다고 셌는데 응답이 0.5초 늦게 도착한다
      if (url === '/api/open/claim') return new Promise(resolve => setTimeout(() => resolve({ ok: true, remaining_ms: 400 }), 500));
      if (String(url).endsWith('/comments')) return [{ id: 'c' }];
      return { ok: true };
    });
    const open = vi.fn();
    const done = handleOpenGeneration(detail, 'window', open);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(open).not.toHaveBeenCalled(); // 받은 시각 + 0.4초로 셌다면 0.5초에 열었을 것
    const ack = vi.mocked(jsonFetch).mock.calls.find(c => c[0] === '/api/open/ack');
    expect(JSON.parse(String(ack?.[1]?.body)).ok).toBe(false);
  });

  it('does not replace a title changed by another owner during acknowledgement', async () => {
    vi.mocked(jsonFetch).mockImplementation(async url => {
      if (String(url).endsWith('/comments')) return [{ id: 'c' }];
      if (url === '/api/open/ack') document.title = 'New view';
      return { ok: true };
    });
    await handleOpenGeneration(detail, 'window', vi.fn());
    expect(document.title).toBe('New view');
  });
  it('claims, validates membership, marks seen then opens the matching comment', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValue({ ok: true });
    const open = vi.fn(() => {
      const calls = vi.mocked(jsonFetch).mock.calls;
      expect(calls[calls.length - 1][0]).toBe('/api/generation-comments/c/seen');
    });
    await handleOpenGeneration(detail, 'window', open);
    expect(open).toHaveBeenCalledWith('g');
    expect(vi.mocked(jsonFetch).mock.calls.map(c => c[0])).toEqual(['/api/open/claim', '/api/generations/g/comments', '/api/generation-comments/c/seen', '/api/open/ack']);
  });
  it('asks the panel to flash the comment and marks the window title only while acknowledging', async () => {
    document.title = 'Millionvolt Hub';
    let titleAtAck = '';
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async () => { titleAtAck = document.title; return { ok: true }; });
    await handleOpenGeneration(detail, 'window', vi.fn());
    expect(titleAtAck).toMatch(/^MVHubOpen-[0-9a-f-]{36}$/);
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[3][1]?.body)).marker).toBe(titleAtAck);
    expect(document.title).toBe('Millionvolt Hub');
    expect(takeCommentHighlight(['c'])).toBe('c');
  });
  it('does not mark the title or flash when opening failed', async () => {
    document.title = 'Millionvolt Hub';
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'other' }]).mockResolvedValue({ ok: true });
    await handleOpenGeneration(detail, 'window', vi.fn());
    const calls = vi.mocked(jsonFetch).mock.calls;
    expect(String(calls[calls.length - 1][1]?.body)).not.toContain('marker');
    expect(takeCommentHighlight(['c'])).toBeNull();
    expect(document.title).toBe('Millionvolt Hub');
  });
  it('does not open or mark a comment absent from that generation', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'other' }]).mockResolvedValue({ ok: true });
    const open = vi.fn();
    await handleOpenGeneration(detail, 'window', open);
    expect(open).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenLastCalledWith('/api/open/ack', expect.objectContaining({ body: expect.stringContaining('"ok":false') }));
  });
  it('aborts display and read marking when the account changes during lookup', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockImplementationOnce(async () => {
      vi.mocked(getAccountNamespace).mockReturnValue('acct:other'); return [{ id: 'c' }];
    }).mockResolvedValue({ ok: true });
    const open = vi.fn();
    await handleOpenGeneration(detail, 'window', open);
    expect(open).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(c => c[0].includes('/seen'))).toBe(false);
  });
  it('does nothing when another window already claimed', async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error('claimed'));
    const open = vi.fn();
    await handleOpenGeneration(detail, 'window', open);
    expect(open).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
  it('still opens and acknowledges success when read marking fails', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'c' }])
      .mockRejectedValueOnce(new Error('read marker failed')).mockResolvedValue({ ok: true });
    const open = vi.fn();
    await handleOpenGeneration(detail, 'window', open);
    expect(open).toHaveBeenCalledWith('g');
    expect(jsonFetch).toHaveBeenLastCalledWith('/api/open/ack', expect.objectContaining({ body: expect.stringContaining('"ok":true') }));
  });
  it('acknowledges failure when the panel does not open', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'c' }]).mockResolvedValue({ ok: true });
    await handleOpenGeneration(detail, 'window', () => { throw new Error('panel failed'); });
    expect(jsonFetch).toHaveBeenLastCalledWith('/api/open/ack', expect.objectContaining({ body: expect.stringContaining('"ok":false') }));
  });
  it('does not open if the account changes during read marking', async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce([{ id: 'c' }]).mockImplementationOnce(async () => {
      vi.mocked(getAccountNamespace).mockReturnValue('acct:other'); return { ok: true };
    }).mockResolvedValue({ ok: true });
    const open = vi.fn();
    await handleOpenGeneration(detail, 'window', open);
    expect(open).not.toHaveBeenCalled();
  });
});

// ── 열기 대표 잠금: 다른 탭 로그아웃으로 멈춘 탭은 잠금을 놓는다(배포 전 검토 Codex 1) ──
// 다른 탭(B)은 같은 잠금 이름으로 이 시험이 직접 요청한다 — Web Locks 는 문서 사이에서 이름 하나를 나눈다.
const LOCK = 'mvhub-slack-open-app';
function fakeLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const request = (name: string, opts: { signal?: AbortSignal } | (() => Promise<void>), maybe?: () => Promise<void>) => {
    const options = typeof opts === 'function' ? {} : opts;
    const callback = (typeof opts === 'function' ? opts : maybe)!;
    return new Promise<void>((resolve, reject) => {
      const run = async () => {
        held.add(name);
        try { await callback(); resolve(); } catch (error) { reject(error); }
        finally { held.delete(name); queues.get(name)?.shift()?.(); }
      };
      if (options.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      if (!held.has(name)) { void run(); return; }
      const queue = queues.get(name) ?? [];
      queues.set(name, queue);
      const onAbort = () => { const at = queue.indexOf(entry); if (at >= 0) queue.splice(at, 1); reject(new DOMException('aborted', 'AbortError')); };
      const entry = () => { options.signal?.removeEventListener('abort', onAbort); void run(); };
      options.signal?.addEventListener('abort', onAbort);
      queue.push(entry);
    });
  };
  return { request, held, waiting: (name: string) => queues.get(name)?.length ?? 0 };
}
/** 다른 탭 B 가 잠금을 쥐었다 놓는다. */
function otherTab(locks: ReturnType<typeof fakeLocks>) {
  let release!: () => void;
  let granted = false;
  void locks.request(LOCK, {}, () => { granted = true; return new Promise<void>(resolve => { release = resolve; }); });
  return { get granted() { return granted; }, release: () => release() };
}

describe('Slack open leader lock', () => {
  let host: HTMLDivElement;
  let root: Root;
  let locks: ReturnType<typeof fakeLocks>;
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
  const pause = (value: 'shared' | null) => act(async () => { vi.mocked(getApiPause).mockReturnValue(value); setApiPause(value); });
  const mount = () => act(async () => { root.render(createElement(() => { useOpenGeneration(() => {}); return null; })); });
  const claims = () => vi.mocked(jsonFetch).mock.calls.filter(call => call[0] === '/api/open/claim').length;
  const ask = async (openId: string) => {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.openGeneration, { detail: { ...detail, open_id: openId } }));
    await flush();
  };
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    vi.mocked(jsonFetch).mockResolvedValue(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await pause(null);
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    vi.unstubAllGlobals();
  });

  it('a paused leader hands the lock to a working tab and takes its turn again when resumed', async () => {
    await mount();
    expect(locks.held.has(LOCK)).toBe(true);
    await ask('first');
    expect(claims()).toBe(1);
    await pause('shared');
    expect(locks.held.has(LOCK)).toBe(false);
    const b = otherTab(locks);
    await flush();
    expect(b.granted).toBe(true); // the working tab becomes the leader
    await pause(null);
    expect(locks.waiting(LOCK)).toBe(1); // resumed: queued behind B
    b.release();
    await flush();
    await ask('second');
    expect(claims()).toBe(2);
  });

  it('pausing while still waiting drops the queued request, so it is not granted later', async () => {
    const b = otherTab(locks);
    await mount();
    expect(locks.waiting(LOCK)).toBe(1);
    await pause('shared');
    expect(locks.waiting(LOCK)).toBe(0);
    b.release();
    await flush();
    expect(locks.held.has(LOCK)).toBe(false);
    await ask('while-paused');
    expect(claims()).toBe(0);
  });

  it('a quick pause and resume leaves exactly one request for this tab', async () => {
    const b = otherTab(locks);
    await mount();
    await act(async () => {
      vi.mocked(getApiPause).mockReturnValue('shared'); setApiPause('shared');
      vi.mocked(getApiPause).mockReturnValue(null); setApiPause(null);
    });
    expect(locks.waiting(LOCK)).toBe(1);
    b.release();
    await flush();
    expect(locks.held.has(LOCK)).toBe(true);
  });

  it('a lock granted after unmount, or granted while paused, is released at once', async () => {
    let b = otherTab(locks);
    await mount();
    await act(async () => root.unmount());
    b.release();
    await flush();
    expect(locks.held.has(LOCK)).toBe(false);
    root = createRoot(host);
    b = otherTab(locks);
    await mount();
    vi.mocked(getApiPause).mockReturnValue('shared'); // paused before the grant, the effect has not re-run yet
    b.release();
    await flush();
    expect(locks.held.has(LOCK)).toBe(false);
  });
});

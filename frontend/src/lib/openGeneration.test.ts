// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./http')>()),
  getApiPause: vi.fn(() => null), getAuthToken: vi.fn(() => 'token'), jsonFetch: vi.fn(),
}));
vi.mock('./accountScope', () => ({ getAccountNamespace: vi.fn(() => 'acct:unit'), getConnectionKey: vi.fn(() => 'server') }));
import { getAccountNamespace } from './accountScope';
import { jsonFetch } from './http';
import { handleOpenGeneration } from './useOpenGeneration';
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

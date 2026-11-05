// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => ({ getApiPause: vi.fn(() => null), getAuthToken: vi.fn(() => 'token'), jsonFetch: vi.fn() }));
vi.mock('./accountScope', () => ({ getAccountNamespace: vi.fn(() => 'acct:unit'), getConnectionKey: vi.fn(() => 'server') }));
import { getAccountNamespace } from './accountScope';
import { jsonFetch } from './http';
import { handleOpenGeneration } from './useOpenGeneration';

const detail = { generation_id: 'g', comment_id: 'c', open_id: 'request' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getAccountNamespace).mockReturnValue('acct:unit'); });
describe('Slack open navigation', () => {
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

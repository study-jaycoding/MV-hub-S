// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/http')>()),
  // 받기는 바로 거절(다른 창이 받음) — 열기 진행 표시가 다음 시험으로 새지 않게 한다.
  getApiPause: vi.fn(() => null), getAuthToken: vi.fn(() => 'token'), jsonFetch: vi.fn(async () => { throw new Error('claimed elsewhere'); }),
}));
vi.mock('../src/lib/accountScope', () => ({ getAccountNamespace: vi.fn(() => 'acct:unit'), getConnectionKey: vi.fn(() => 'server') }));
import { jsonFetch } from '../src/lib/http';
import { APP_EVENTS } from '../src/lib/appEvents';
import { REGULAR_TAB_CLAIM_DELAY_MS, useOpenGeneration } from '../src/lib/useOpenGeneration';

function Probe() { useOpenGeneration(() => {}); return null; }
let host: HTMLDivElement;
let root: Root;
const claims = () => vi.mocked(jsonFetch).mock.calls.filter(c => c[0] === '/api/open/claim').length;
const send = (openId: string) => act(() => {
  window.dispatchEvent(new CustomEvent(APP_EVENTS.openGeneration, { detail: { generation_id: 'g', comment_id: 'c', open_id: openId } }));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(jsonFetch).mockReset().mockImplementation(async () => { throw new Error('claimed elsewhere'); });
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  delete (navigator as { locks?: unknown }).locks;
  vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear();
});

it('lets the app window claim at once so it wins over a regular tab', () => {
  sessionStorage.setItem('mvhub.app-window', '1');
  act(() => root.render(<Probe />));
  send('app');
  expect(claims()).toBe(1);
});

it('makes a regular browser tab wait before claiming', () => {
  act(() => root.render(<Probe />));
  send('tab');
  expect(claims()).toBe(0);
  act(() => vi.advanceTimersByTime(REGULAR_TAB_CLAIM_DELAY_MS - 1));
  expect(claims()).toBe(0);
  act(() => vi.advanceTimersByTime(1));
  expect(claims()).toBe(1);
});

it('drops a delayed claim when the tab unmounts meanwhile', () => {
  act(() => root.render(<Probe />));
  send('gone');
  act(() => root.unmount());
  act(() => vi.advanceTimersByTime(REGULAR_TAB_CLAIM_DELAY_MS));
  expect(claims()).toBe(0);
  root = createRoot(host); // afterEach unmounts again
});

it('lets the app window lead even when a regular tab in the same profile took its lock first', () => {
  // Web Locks 흉내 — 이름마다 처음 요청한 문서만 대표가 되고, 뒤 요청은 앞 대표가 놓을 때까지 기다린다
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, _o: unknown, grant: () => Promise<void>) => {
    if (held.has(name)) return new Promise(() => {});
    held.add(name); return grant();
  } } });
  const tabHost = document.createElement('div'); document.body.append(tabHost);
  const tabRoot = createRoot(tabHost);
  act(() => tabRoot.render(<Probe />)); // 일반 탭이 먼저 열려 잠금을 잡는다
  sessionStorage.setItem('mvhub.app-window', '1');
  act(() => root.render(<Probe />)); // 뒤에 열린 앱 창
  // jsdom 은 두 화면이 sessionStorage 를 같이 쓴다 — 실제로는 일반 탭의 저장소에 표식이 없다. 그 상태로 되돌려 둔다.
  sessionStorage.removeItem('mvhub.app-window');
  send('same-profile');
  expect(claims()).toBe(1); // 앱 창이 바로 받는다(옛 한 이름 잠금이면 0 — 일반 탭만 0.5초 뒤 받았다)
  act(() => tabRoot.unmount()); tabHost.remove();
});

it('neither marks read nor opens when the window unmounts after claiming', async () => {
  sessionStorage.setItem('mvhub.app-window', '1');
  let comments: ((value: unknown) => void) | undefined;
  vi.mocked(jsonFetch).mockImplementation(async (url: string) => {
    if (url.endsWith('/comments')) return new Promise(resolve => { comments = resolve; });
    return { ok: true };
  });
  const open = vi.fn();
  function OpenProbe() { useOpenGeneration(open); return null; }
  act(() => root.render(<OpenProbe />));
  send('unmount');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(comments).toBeTypeOf('function');
  act(() => root.unmount());
  await act(async () => { comments!([{ id: 'c' }]); await vi.advanceTimersByTimeAsync(0); });
  expect(open).not.toHaveBeenCalled();
  expect(vi.mocked(jsonFetch).mock.calls.some(c => String(c[0]).includes('/seen'))).toBe(false);
  root = createRoot(host); // afterEach unmounts again
});

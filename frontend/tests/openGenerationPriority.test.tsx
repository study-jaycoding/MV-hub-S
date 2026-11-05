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
  vi.mocked(jsonFetch).mockClear();
  sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
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

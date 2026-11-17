// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BalanceLedger } from "../src/components/manage/console/BalanceLedger";
import { HttpError } from "../src/lib/http";
import type { ManageCaps } from "../src/lib/useManageCaps";
import type { BalanceLedgerResponse } from "../src/shared/contracts/hfBalance";
import { setAccountScope, setConnectionKey } from "../src/lib/accountScope";
import { setLang } from "../src/lib/i18n";

const mocks = vi.hoisted(() => ({ ledger: vi.fn(), balances: vi.fn() }));
vi.mock("../src/lib/hfBalance", () => ({ getBalanceLedger: mocks.ledger, getBalances: mocks.balances }));
vi.mock("../src/lib/useSyncStatus", () => ({ useSyncStatus: () => ({ balance_pending: 2 }) }));

const start = Date.parse('2026-11-16T00:00:00+09:00');
const caps = { loaded: true, authOff: false, system: true, contextKey: 'a/server', viewerUid: 'a', readAll: true } as ManageCaps;
const spaces = [{ id: 'ws', name: 'MV' }, { id: 'sub', name: 'Education' }];
const page = (patch: Partial<BalanceLedgerResponse> = {}): BalanceLedgerResponse => ({
  balance_protocol: 1, workspace_id: 'ws', timezone: 'Asia/Seoul', requested_start_ms: start, requested_end_ms: start + 86400000,
  as_of_ms: start + 86400000, content_read_at_ms: start, manage_read_at_ms: start, basis_signature: 'sig', api_state: 'available', reason_codes: [], api_window_versions: [], plan_revision: 1,
  daily_api: [{ day: '2026-11-16', net_c: null, charged_c: null, refunded_c: null, complete: false, collected_at_ms: null, actual_start_ms: null, actual_end_ms: null, reason_codes: ['missing_day'], window_versions: [] }],
  daily_balances: [{ day: '2026-11-16', observation_count: 2, time_uncertain_count: 0, opening_c: 10000, closing_c: 9900, delta_c: -100 }],
  chart_points: [{ observation_id: '1', observed_at_ms: start + 1000, credits_c: 10000, quality: 'reported' }, { observation_id: '2', observed_at_ms: start + 2000, credits_c: 9900, quality: 'reported' }],
  chart_gaps: [], intervals: [{ from_observation_id: '1', to_observation_id: '2', start_ms: start + 1000, end_ms: start + 2000, opening_c: 10000, closing_c: 9900, delta_c: -100, api_created_net_c: null, residual_c: null, tolerance_c: 0, state: 'api_pending', candidate_classification: 'unclassified', candidate_evidence: [], candidate_count: 0, reason_codes: ['missing_day'] }],
  returned_count: 1, has_more: false, next_cursor: null, ...patch,
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setAccountScope('a'); setConnectionKey('server-a');
  mocks.ledger.mockReset().mockResolvedValue(page());
  mocks.balances.mockReset().mockResolvedValue({ balances: [{ workspace_id: 'ws', credits_c: null, observed_at_ms: null }] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (value = caps, selectedId = 'ws') => { await act(async () => root.render(<BalanceLedger caps={value} spaces={spaces} selectedId={selectedId} />)); };
const click = async (label: string) => { const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!; await act(async () => button.click()); };

it('only renders and requests the ledger for authenticated administrators', async () => {
  await render({ ...caps, system: false }); expect(host.textContent).toBe('');
  await render({ ...caps, authOff: true }); expect(host.textContent).toBe('');
  expect(mocks.ledger).not.toHaveBeenCalled();
  await render(); expect(host.textContent).toContain('잔액 장부'); expect(mocks.ledger).toHaveBeenCalledTimes(1);
});

it('keeps unknown values as dashes and hides internal terms from the displayed ledger', async () => {
  await render();
  const summary = host.querySelector('.bl-summary')!;
  expect([...summary.querySelectorAll('strong')].map((n) => n.textContent)).toEqual(['—', '—', '—', '—']);
  expect(host.textContent).toContain('사용 기록 모으는 중');
  expect(host.textContent).not.toMatch(/잔차|관측|API|precision|legacy/);
  expect(host.querySelectorAll('.bl-interval')).toHaveLength(0);
  await click('11/16 · 확인 2번'); expect(host.querySelectorAll('.bl-interval')).toHaveLength(1);
  await act(async () => host.querySelector('.bl-day td:nth-child(2)')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(host.querySelectorAll('.bl-interval')).toHaveLength(0);
});

it('restarts on analysis changes without appending an old page or interpreting the cursor', async () => {
  mocks.ledger.mockResolvedValueOnce(page({ has_more: true, next_cursor: 'opaque+/=' })).mockRejectedValueOnce(new HttpError(409, 'analysis_changed')).mockResolvedValueOnce(page({ intervals: [] }));
  await render(); await click('더 보기');
  expect(mocks.ledger.mock.calls.map((args) => args[3])).toEqual([null, 'opaque+/=', null]);
  expect(host.textContent).toContain('내용이 바뀌어 처음부터 다시 불러왔습니다');
  expect(host.querySelectorAll('.bl-interval')).toHaveLength(0);
});

it('distinguishes an old server and provides a native keyboard-accessible help button', async () => {
  mocks.ledger.mockRejectedValue(new HttpError(404, 'unsupported'));
  await render(); expect(host.textContent).toContain('서버 업데이트가 필요합니다');
  const help = host.querySelector<HTMLButtonElement>('button[aria-label="잔액 장부 안내"]')!;
  expect(help.tagName).toBe('BUTTON'); expect(help.getAttribute('aria-expanded')).toBe('false'); help.focus();
  // Native button activation from a keyboard has detail=0, as does HTMLElement.click in jsdom.
  await act(async () => help.click());
  expect(help.getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(help);
  expect(host.textContent).toContain('추정 원인은 금액·시각으로 짐작한 것이며 확정이 아닙니다.');
});

it('discards late responses after account, permission and workspace changes', async () => {
  let finish!: (data: BalanceLedgerResponse) => void;
  mocks.ledger.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await render({ ...caps, contextKey: 'b/server' }, 'sub');
  await act(async () => finish(page({ daily_balances: [{ day: '2026-11-16', observation_count: 999, time_uncertain_count: 0, opening_c: 1, closing_c: 1, delta_c: 0 }] })));
  expect(host.textContent).not.toContain('999번');
  await render({ ...caps, system: false }); expect(host.textContent).toBe('');
});

const gapLabels = () => [...host.querySelectorAll('svg > g > text')].filter((n) => n.textContent === '잔액 확인 없음');

it('plots only real checks and marks a missing interval with a dashed line and text', async () => {
  const value = page(); value.chart_points[1].observed_at_ms += 6 * 3600000;
  value.chart_gaps = [{ start_ms: value.chart_points[0].observed_at_ms, end_ms: value.chart_points[1].observed_at_ms }];
  mocks.ledger.mockResolvedValue(value);
  await render(); expect(host.querySelectorAll('circle')).toHaveLength(2);
  expect(host.querySelector('.bl-gap title')?.textContent).toBe('잔액 확인 없음'); expect(gapLabels()).toHaveLength(1);
});

it('keeps narrow missing intervals as dashed lines with a hover note instead of overlapping text', async () => {
  // 하루 범위에 30분 간격 확인 8개, 사이마다 빈 곳 — 폭 약 19단위라 글자가 겹친다
  const points = Array.from({ length: 8 }, (_, n) => ({ observation_id: String(n + 1), observed_at_ms: start + n * 1800000, credits_c: 10000 - n * 10, quality: 'reported' as const }));
  const gaps = points.slice(1).map((p, n) => ({ start_ms: points[n].observed_at_ms, end_ms: p.observed_at_ms }));
  mocks.ledger.mockResolvedValue(page({ chart_points: points, chart_gaps: gaps }));
  await render();
  expect(host.querySelectorAll('.bl-gap')).toHaveLength(7);
  expect([...host.querySelectorAll('.bl-gap title')].map((n) => n.textContent)).toEqual(Array(7).fill('잔액 확인 없음'));
  expect(gapLabels()).toHaveLength(0);
});

it('sizes the gap text to the displayed language so a longer translation does not overlap', async () => {
  // 2.5시간 빈 곳 두 개(폭 약 97) — 한국어 글자는 들어가고 영어 'No balance confirmation'(약 109)은 안 들어간다
  const points = [0, 1, 2].map((n) => ({ observation_id: String(n + 1), observed_at_ms: start + n * 9000000, credits_c: 10000 - n, quality: 'reported' as const }));
  const gaps = points.slice(1).map((p, n) => ({ start_ms: points[n].observed_at_ms, end_ms: p.observed_at_ms }));
  mocks.ledger.mockResolvedValue(page({ chart_points: points, chart_gaps: gaps }));
  await render(); expect(gapLabels()).toHaveLength(2);
  try {
    act(() => setLang('en')); await render();
    const english = 'No balance confirmation';
    expect([...host.querySelectorAll('svg > g > text')].filter((n) => n.textContent === english)).toHaveLength(0);
    expect([...host.querySelectorAll('.bl-gap title')].map((n) => n.textContent)).toEqual([english, english]);
  } finally { act(() => setLang('ko')); }
});

it('does not invent missing checks from downsampled chart spacing or zero totals without intervals', async () => {
  const value = page({ intervals: [] }); value.chart_points[1].observed_at_ms += 3600000;
  mocks.ledger.mockResolvedValue(value);
  await render(); expect(host.querySelector('.bl-gap')).toBeNull();
  expect([...host.querySelectorAll('.bl-summary strong')].map((node) => node.textContent)).toEqual(['—', '—', '—', '—']);
});

it.each(['account', 'server', 'period'] as const)('discards a pending %s response when its scope changes', async (change) => {
  let finish!: (data: BalanceLedgerResponse) => void;
  mocks.ledger.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  if (change === 'account') { setAccountScope('b'); await render(); }
  else if (change === 'server') { setConnectionKey('server-b'); await render(); }
  else await click('이번 달');
  await act(async () => finish(page({ daily_balances: [{ day: '2026-11-16', observation_count: 999, time_uncertain_count: 0, opening_c: 1, closing_c: 1, delta_c: 0 }] })));
  expect(host.textContent).not.toContain('999번');
  expect(mocks.ledger).toHaveBeenCalledTimes(2);
});

it('prioritizes uncertain precision over an unavailable daily comparison', async () => {
  const value = page(); value.intervals[0].state = 'observation_uncertain'; value.intervals[0].reason_codes = ['observation_uncertain', 'precision_unknown'];
  mocks.ledger.mockResolvedValue(value);
  await render(); expect(host.querySelector('.bl-day')?.textContent).toContain('금액 오차 범위를 모름');
});

it('shows known differences as a partial summary without treating missing intervals as zero', async () => {
  const value=page();
  const base=value.intervals[0];
  value.intervals.push({...base,to_observation_id:'positive',residual_c:20000,state:'residual_present'},
    {...base,to_observation_id:'negative',residual_c:-3000,state:'residual_present'});
  mocks.ledger.mockResolvedValue(value);
  await render();
  expect([...host.querySelectorAll('.bl-summary strong')].map((node)=>node.textContent)).toEqual(['—','—','+200','-30']);
  expect(host.querySelectorAll('.bl-summary .wc-chip')).toHaveLength(2);
  expect(host.querySelector('.bl-summary')?.textContent).toContain('일부 구간만');
});

it('shows the recorded extra credits as top-up evidence and distinguishes same-time differing amounts', async () => {
  const value=page();
  value.chart_points[0].quality='conflict';
  value.intervals[0]={...value.intervals[0],state:'residual_present',residual_c:20000,
    candidate_classification:'topup_candidate',candidate_evidence:[{candidate:'topup_candidate',code:'current_plan_match',credits_c:20000,plan_revision:2}]};
  mocks.ledger.mockResolvedValue(value);
  await render();
  expect(host.textContent).toContain('입력한 추가 크레딧 200과 같음');
  expect(host.textContent).not.toContain('정기 충전 계획');
  expect(host.querySelector('.bl-notice')?.textContent).toBe('같은 시각 값이 다름');
});

it('does not label unavailable collection as an ordinary pending comparison', async () => {
  const value = page(); value.intervals[0].state = 'comparison_unavailable'; value.intervals[0].reason_codes = ['not_configured'];
  mocks.ledger.mockResolvedValue(value);
  await render(); expect(host.querySelector('.bl-day')?.textContent).toContain('비교 못 함');
});

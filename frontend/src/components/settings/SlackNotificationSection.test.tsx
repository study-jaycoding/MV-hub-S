import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackNotificationSection } from './SlackNotificationSection';
import { useSlackSettings } from '../../lib/useSlackSettings';

vi.mock('../../lib/useSlackSettings', () => ({ useSlackSettings: vi.fn() }));
vi.mock('./SettingsDescription', () => ({ SettingsDescription: ({ summary, children }: { summary: string; children?: ReactNode }) => <><p>{summary}</p><div data-more="">{children}</div></> }));

const base = { status: { ready: true, linked: false, slack_name: '', slack_email: '' }, email: '', code: '', pending: false,
  busy: false, notice: '', missing: false, action: vi.fn(), setEmail: vi.fn(), setCode: vi.fn() };
describe('Slack settings approved copy', () => {
  it.each([
    [{}, '코드 받기', '연결 안 됨 — 연결하면 코멘트를 DM 으로 받아요'],
    [{ pending: true }, '다시 받기', 'Slack DM 으로 코드를 보냈어요 · 10분 안에 넣기'],
    [{ status: { ...base.status, linked: true, slack_name: 'unit', slack_email: 'unit@slack.test' } }, '연결 끊기', '✓ 연결됨 — 코멘트가 달리면 Slack DM 으로 알려 줘요'],
    [{ missing: true }, 'Slack 알림', '서버 업데이트가 필요해요'],
    [{ status: { ...base.status, ready: false } }, 'Slack 알림', '관리자가 아직 Slack 알림을 켜지 않았어요'],
  ])('renders the specified stage', (changes, button, text) => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base, ...changes });
    const html = renderToStaticMarkup(<SlackNotificationSection />);
    expect(html).toContain(button); expect(html).toContain(text);
    expect(html).not.toContain('…'); expect(html).not.toContain('...');
  });
  it('shows the linked Slack name and email on two lines and keeps unlink inside 더보기', () => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base, status: { ...base.status, linked: true, slack_name: '@제이', slack_email: 'jay@unit.test' } });
    const html = renderToStaticMarkup(<SlackNotificationSection />);
    expect(html).toContain('<div class="slack-linked"><b>@제이</b><span>jay@unit.test</span></div>');
    const more = html.indexOf('data-more');
    expect(more).toBeGreaterThan(-1);
    expect(html.indexOf('Slack 연결 끊기')).toBeGreaterThan(more);
    expect(html.indexOf('slack-unlink')).toBeGreaterThan(more);
  });
  it('keeps unlink usable while Slack is paused or its token failed', () => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base, status: { ready: false, linked: true, slack_name: 'unit', slack_email: 'unit@slack.test' } });
    const html = renderToStaticMarkup(<SlackNotificationSection />);
    expect(html).toContain('<button class="settings-action ghost slack-unlink">Slack 연결 끊기</button>'); // disabled 없음
  });
  it('has no unlink button before linking', () => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base });
    expect(renderToStaticMarkup(<SlackNotificationSection />)).not.toContain('연결 끊기');
  });
  it.each(['', '연결 상태를 확인하지 못했어요'])('does not report unlinked before a successful lookup', notice => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base, status: null, notice });
    const html = renderToStaticMarkup(<SlackNotificationSection />);
    expect(html).not.toContain('연결 안 됨');
    expect(html).toContain(notice || '확인 중');
    if (notice) expect(html).not.toContain('확인 중');
    expect(html).not.toContain('…'); expect(html).not.toContain('...');
  });
});

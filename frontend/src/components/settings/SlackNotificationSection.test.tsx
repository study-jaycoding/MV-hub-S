import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackNotificationSection } from './SlackNotificationSection';
import { useSlackSettings } from '../../lib/useSlackSettings';

vi.mock('../../lib/useSlackSettings', () => ({ useSlackSettings: vi.fn() }));
vi.mock('./SettingsDescription', () => ({ SettingsDescription: ({ summary }: { summary: string }) => <p>{summary}</p> }));

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
  it.each(['', '연결 상태를 확인하지 못했어요'])('does not report unlinked before a successful lookup', notice => {
    vi.mocked(useSlackSettings).mockReturnValue({ ...base, status: null, notice });
    const html = renderToStaticMarkup(<SlackNotificationSection />);
    expect(html).not.toContain('연결 안 됨');
    expect(html).toContain(notice || '확인 중');
    if (notice) expect(html).not.toContain('확인 중');
    expect(html).not.toContain('…'); expect(html).not.toContain('...');
  });
});

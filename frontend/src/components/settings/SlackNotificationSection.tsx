import { useSlackSettings } from '../../lib/useSlackSettings';
import { SettingsDescription } from './SettingsDescription';

export function SlackNotificationSection() {
  const s = useSlackSettings();
  const locked = s.missing || !s.status?.ready;
  const summary = s.missing ? '서버 업데이트가 필요해요' : !s.status ? (s.notice ? '' : '확인 중') : !s.status.ready ? '관리자가 아직 Slack 알림을 켜지 않았어요'
    : s.status?.linked ? '✓ 연결됨 — 코멘트가 달리면 Slack DM 으로 알려 줘요'
    : s.pending ? 'Slack DM 으로 코드를 보냈어요 · 10분 안에 넣기' : '연결 안 됨 — 연결하면 코멘트를 DM 으로 받아요';
  return <section className="settings-section">
    <h4>Slack 알림</h4>
    {s.status?.linked ? <>
      {/* 연결됨 = 이름 한 줄 + 이메일 작은 회색 한 줄(Jay 2026-11-05 시안 B안). 끊기 단추는 아래 [더보기] 안(시안 v3) */}
      <div className="comfy-set-row"><label>연결된 Slack</label><div className="slack-linked"><b>@{s.status.slack_name.replace(/^@/, '')}</b><span>{s.status.slack_email}</span></div></div>
    </> : !locked && <>
      <div className="comfy-set-row"><label htmlFor="slack-email">Slack 이메일</label><input id="slack-email" type="email" placeholder="회사 Slack 에 쓰는 이메일" value={s.email} disabled={s.busy || s.pending} onChange={e => s.setEmail(e.target.value)} /></div>
      {s.pending && <div className="comfy-set-row"><label htmlFor="slack-code">확인 코드</label><input id="slack-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Slack DM 의 6자리" value={s.code} disabled={s.busy} onChange={e => s.setCode(e.target.value.replace(/\D/g, ''))} /></div>}
      <div className="settings-actions-row">
        <button className="settings-action" disabled={s.busy || (s.pending ? s.code.length !== 6 : !s.email.trim())} onClick={() => void s.action(s.pending ? 'verify' : 'start')}>{s.pending ? '연결하기' : '코드 받기'}</button>
        {s.pending && <button className="settings-action ghost" disabled={s.busy} onClick={() => void s.action('start')}>다시 받기</button>}
      </div>
    </>}
    {summary && <SettingsDescription summary={summary}>
      <p>회사 Slack 이메일은 MV Hub 이메일과 달라도 됩니다. 내 생성물의 코멘트와 내 코멘트의 답글을 DM으로 받습니다.</p>
      {s.status?.linked && <button className="settings-action ghost slack-unlink" disabled={s.busy || locked} onClick={() => void s.action('delete')}>Slack 연결 끊기</button>}
    </SettingsDescription>}
    {s.notice && <p className="settings-hint" role="status">{s.notice}</p>}
  </section>;
}

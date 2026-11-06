import { useEffect } from 'react';
import { useSlackSettings } from '../../lib/useSlackSettings';
import { SettingsDescription } from './SettingsDescription';

// onSummary 를 주면 상태 문장을 접는 묶음 제목 밑으로 넘기고 본문에서는 뺀다(펼쳤을 때 같은 줄이 두 번 보이지 않게 — 시안 F).
export function SlackNotificationSection({ onSummary }: { onSummary?: (summary: string) => void } = {}) {
  const s = useSlackSettings();
  const locked = s.missing || !s.status?.ready;
  // 연결된 사람은 연결 상태를 먼저 — 관리자가 멈췄거나 토큰 오류여도 '켜지 않았어요'가 아니다(배포 전 검토 Claude 8)
  const summary = s.missing ? '서버 업데이트가 필요해요' : !s.status ? (s.notice ? '' : '확인 중')
    : s.status.linked ? (s.status.ready ? '✓ 연결됨 — 코멘트가 달리면 Slack DM 으로 알려 줘요' : '연결됨 · 지금은 알림이 멈춰 있어요')
    : !s.status.ready ? '관리자가 아직 Slack 알림을 켜지 않았어요'
    : s.pending ? 'Slack DM 으로 코드를 보냈어요 · 10분 안에 넣기' : '연결 안 됨 — 연결하면 코멘트를 DM 으로 받아요';
  useEffect(() => { onSummary?.(summary); }, [onSummary, summary]);
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
    {summary && <SettingsDescription summary={onSummary ? undefined : summary}>
      <p>회사 Slack 이메일은 MV Hub 이메일과 달라도 됩니다. 내 생성물의 코멘트와 내 코멘트의 답글을 DM으로 받습니다.</p>
      {/* 끊기는 보내기 가능 여부와 무관 — 관리자가 멈췄거나 토큰 오류여도 끊을 수 있다(Codex 리뷰 P2, 서버 DELETE 는 그 상태에서도 된다) */}
      {s.status?.linked && <button className="settings-action ghost slack-unlink" disabled={s.busy} onClick={() => void s.action('delete')}>Slack 연결 끊기</button>}
    </SettingsDescription>}
    {s.notice && <p className="settings-hint" role="status">{s.notice}</p>}
  </section>;
}

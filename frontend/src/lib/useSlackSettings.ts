import { useEffect, useRef, useState } from 'react';
import { getAccountNamespace, getConnectionKey } from './accountScope';
import { HttpError } from './http';
import { slackRequest, type SlackStatus } from './slackApi';

export function useSlackSettings() {
  const scope = getAccountNamespace() + '\0' + getConnectionKey();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    setStatus(null); setPending(false); setEmail(''); setCode(''); setNotice(''); setMissing(false); setBusy(false);
    slackRequest().then(value => { if (live) setStatus(value); }).catch(error => {
      if (live) {
        setMissing(error instanceof HttpError && error.status === 404);
        if (!(error instanceof HttpError && error.status === 404)) setNotice('연결 상태를 확인하지 못했어요');
      }
    });
    return () => { live = false; };
  }, [scope]);
  const action = async (kind: 'start' | 'verify' | 'delete') => {
    if (busy) return;
    const startedScope = scope;
    setBusy(true); setNotice('');
    try {
      if (kind === 'start') {
        await slackRequest('/start', 'POST', { slack_email: email });
        if (scopeRef.current === startedScope) { setPending(true); setCode(''); }
      } else {
        const value = await slackRequest(kind === 'verify' ? '/verify' : '', kind === 'verify' ? 'POST' : 'DELETE',
          kind === 'verify' ? { code } : undefined);
        if (scopeRef.current === startedScope) { setStatus(value); setPending(false); setCode(''); }
      }
    } catch (error) {
      if (scopeRef.current === startedScope) setNotice(error instanceof HttpError ? error.detail : '요청을 마치지 못했어요. 다시 확인해 주세요');
    } finally { if (scopeRef.current === startedScope) setBusy(false); }
  };
  return { status, email, setEmail, code, setCode, pending, busy, notice, missing, action };
}

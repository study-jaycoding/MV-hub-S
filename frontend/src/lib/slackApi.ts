import { jsonFetch } from './http';
import { getAccountNamespace } from './accountScope';
import { EXPECT_ACCOUNT_HEADER } from './hubFeatures';

export interface SlackStatus { ready: boolean; linked: boolean; slack_name: string; slack_email: string }
export function slackRequest<T = SlackStatus>(path = '', method = 'GET', body?: unknown): Promise<T> {
  return jsonFetch<T>('/api/slack/link' + path, {
    method, headers: { [EXPECT_ACCOUNT_HEADER]: getAccountNamespace() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

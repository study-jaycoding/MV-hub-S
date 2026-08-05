import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

// 계정별 localStorage 데이터는 공유되지만, "현재 어느 계정 범위를 쓰는가"는 탭별 상태다.
// localStorage 의 activeAccount 만 매번 읽으면 다른 탭에서 다른 계정으로 로그인한 순간,
// 이미 열려 있던 탭이 상대 계정 버킷에 저장할 수 있다. sessionStorage 에 탭의 계정을 고정하고
// 실제 인증 계정이 확정될 때 useHubAuth 가 갱신한다. 빈 문자열은 AUTH off 로컬 범위다.
const SESSION_ACCOUNT_KEY = "ch.accountScope";

function readSessionAccount(): string | null {
  try {
    return sessionStorage.getItem(SESSION_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function writeSessionAccount(account: string): void {
  try {
    sessionStorage.setItem(SESSION_ACCOUNT_KEY, account);
  } catch {
    // sessionStorage 를 쓸 수 없는 환경은 기존 localStorage 마커를 그대로 사용한다.
  }
}

export function getAccountScope(): string {
  const sessionAccount = readSessionAccount();
  if (sessionAccount !== null) return sessionAccount;
  const account = loadString(STORAGE_KEYS.activeAccount).trim();
  writeSessionAccount(account);
  return account;
}

// 인증이 확인한 계정으로 이 탭의 개인 데이터 범위를 맞춘다. 반환값이 true 면 이미 초기화된
// 계정별 화면 상태도 다른 범위를 가리킬 수 있으므로 호출자가 한 번 새로고침해야 한다.
export function setAccountScope(account: string | null | undefined): boolean {
  const normalized = (account || "").trim();
  const changed = getAccountScope() !== normalized;
  writeSessionAccount(normalized);
  return changed;
}

export function getAccountNamespace(): string {
  const account = getAccountScope();
  return account ? `acct:${account}` : "local";
}

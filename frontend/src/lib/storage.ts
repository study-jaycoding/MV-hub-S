// localStorage 의 JSON 값을 안전하게 읽는다(없거나 파싱 실패 → null).
// 여러 컴포넌트가 각자 정의하던 동일 헬퍼를 통합.
export function loadJSON<T>(key: string): T | null {
  try {
    const r = localStorage.getItem(key);
    return r ? (JSON.parse(r) as T) : null;
  } catch {
    return null;
  }
}

// 저장 성공 여부가 필요한 호출부(씬 데이터 계층)용 — 용량 초과·접근 차단이면 false.
// 실패를 삼키는 saveJSON 은 이 함수를 감싼 버전이라, 기존 호출부의 시그니처·동작은 그대로다.
export function trySaveJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function saveJSON(key: string, value: unknown): void {
  trySaveJSON(key, value);
}

export function loadString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export interface Store {
  get(key: string, fallback: string): string;
  set(key: string, value: string): void;
  loadJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
  loadSet(key: string): Set<string>;
  setSet(key: string, value: Set<string>): void;
}
export function makeStore(prefix: string): Store {
  return {
    get(key, fallback) { try { return localStorage.getItem(prefix + key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(prefix + key, value); } catch { /* ignore */ } },
    loadJSON<T>(key: string) {
      return loadJSON<T>(prefix + key);
    },
    setJSON(key, value) {
      saveJSON(prefix + key, value);
    },
    loadSet(key) {
      try { const r = JSON.parse(localStorage.getItem(prefix + key) || "[]"); return new Set(Array.isArray(r) ? (r as string[]) : []); }
      catch { return new Set(); }
    },
    setSet(key, value) {
      try { localStorage.setItem(prefix + key, JSON.stringify([...value])); }
      catch { /* ignore */ }
    },
  };
}

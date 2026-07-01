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

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
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

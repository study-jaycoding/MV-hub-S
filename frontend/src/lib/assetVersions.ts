// 어셋 파일 '버전'(수정시각 나노초+크기) 전역 표.
//
// 왜: 어셋 패널과 캔버스(SceneBoard)가 같은 파일의 썸네일을 만들 때 '같은 버전'을 붙여야, 원본이 같은
// 이름으로 덮어써지면(=버전 변경) 주소가 바뀌어 양쪽 다 새 썸네일을 불러온다. 버전은 어셋 트리 조회
// (/api/assets/tree) 응답의 node.version 에서 얻어 이 표에 채운다.
//
// 범위: 이 표는 '한 창(window/JS 모듈 인스턴스)' 안에서만 공유된다. 어셋이 별도 창으로 떠 있으면 창마다
// 자기 표를 가지며, 로컬/원격 WS와 BroadcastChannel 변경 신호가 각 창의 트리 재조회·표 갱신을 유도한다.
//
// key = `${project}|${path}`.
import type { AssetNode } from "../types";

const versions = new Map<string, string>();
const listeners = new Set<() => void>();
let tick = 0; // useSyncExternalStore 용 스냅샷 — 표가 바뀔 때만 증가

// ── 영속화(localStorage) ─────────────────────────────────────────────────────
// 새로고침 직후 첫 렌더도 '마지막으로 본 버전'이 붙은 URL 로 그리기 위해 표를 저장해 둔다.
// 표가 비면 v 없는 URL 로 그려지는데, 과거 빌드가 그 주소로 옛 썸네일을 브라우저에 장기 캐시해 둔
// 사용자는 트리 재조회가 끝날 때까지 옛 이미지를 보게 된다(새로고침 시 옛 썸네일 깜빡임의 원인).
//
// ★저장 단위는 '프로젝트별 키' — 어떤 조건에 버전이 바뀌는지(갱신 정책)는 그대로다. 예전 단일 합본
//  키는 방문한 모든 프로젝트를 한 문자열에 쌓아, 파일 하나만 바뀌어도 전체를 직렬화해 동기로 다시
//  썼다(엔트리가 수만 건이면 수 MB·수십 ms, 쿼터를 넘으면 통째로 저장 실패). 이제 이번에 갱신된
//  프로젝트의 버킷만 쓴다.
const LS_PREFIX = "mvhub.assetVersions.v2.";
const LEGACY_LS_KEY = "mvhub.assetVersions.v1"; // 구버전 합본 키 — 1회 이관 후 제거
const lsKeyOf = (project: string) => LS_PREFIX + encodeURIComponent(project);

function keyOf(project: string, path: string): string {
  return `${project}|${path}`;
}

// 한 프로젝트의 버전만 저장(성공 여부 반환 — 이관 판정에 쓴다). 그 프로젝트 엔트리가 하나도 없으면
// 키를 지운다(삭제된 프로젝트가 유령으로 남지 않게).
function persistProject(project: string): boolean {
  const prefix = `${project}|`;
  const obj: Record<string, string> = {};
  for (const [k, v] of versions) if (k.startsWith(prefix)) obj[k.slice(prefix.length)] = v;
  try {
    if (Object.keys(obj).length) localStorage.setItem(lsKeyOf(project), JSON.stringify(obj));
    else localStorage.removeItem(lsKeyOf(project));
    return true;
  } catch {
    return false; // 용량 초과 등 → 무시(다음 갱신 때 재시도)
  }
}

// 저장된 버전표를 표에 싣는다. 프로젝트별 키를 먼저 읽고, 구버전 합본 키가 남아 있으면 그 내용도
// 싣고(하위호환) 프로젝트별 키로 1회 이관한다 — 이관이 전부 성공했을 때만 옛 키를 지운다.
function loadPersisted(): void {
  let legacyRaw: string | null = null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_LS_KEY);
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k); // 먼저 모아 둔다(읽는 중 쓰기로 인덱스가 흔들리지 않게)
    }
    for (const k of keys) {
      const project = decodeURIComponent(k.slice(LS_PREFIX.length));
      const obj = JSON.parse(localStorage.getItem(k) || "null") as Record<string, unknown> | null;
      if (!obj || typeof obj !== "object") continue;
      for (const [path, v] of Object.entries(obj)) {
        if (typeof v === "string") versions.set(keyOf(project, path), v);
      }
    }
  } catch {
    /* localStorage 접근 불가·손상 데이터 → 읽은 만큼만(기능 저하 없음) */
  }
  if (!legacyRaw) return;
  const legacyProjects = new Set<string>();
  try {
    const obj = JSON.parse(legacyRaw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      const cut = k.indexOf("|");
      if (cut <= 0) continue;
      legacyProjects.add(k.slice(0, cut));
      if (!versions.has(k)) versions.set(k, v); // 새 구조에 이미 있는 값이 더 최신 — 덮지 않는다
    }
  } catch {
    /* 손상된 합본 → 이관할 것 없음 */
  }
  let allOk = true;
  for (const p of legacyProjects) if (!persistProject(p)) allOk = false;
  if (allOk) {
    try {
      localStorage.removeItem(LEGACY_LS_KEY);
    } catch {
      /* 제거 실패 → 다음 로드에서 다시 이관 시도(멱등) */
    }
  }
}

loadPersisted();

// 특정 파일의 현재 버전(없으면 undefined). 썸네일 URL 생성 시 붙인다.
export function getAssetVersion(project: string, path: string): string | undefined {
  return versions.get(keyOf(project, path));
}

// 어셋 트리(AssetNode[])를 훑어 파일별 버전을 갱신한다. 실제로 바뀐 값이 있을 때만 리스너에 통지해
// 불필요한 리렌더를 막는다. (폴더는 version 이 없으므로 자식만 재귀)
// 이번 트리에 없는(삭제·이동된) 이 프로젝트의 key 는 제거한다 → 옛 버전 URL 로 삭제 파일이 남지 않게.
// 단 트리가 비어있으면(조회 실패·빈 응답) 통째 제거로 오인하지 않도록 정리를 건너뛴다.
export function ingestAssetTreeVersions(project: string, nodes: AssetNode[]): void {
  let changed = false;
  const prefix = `${project}|`;
  const seen = new Set<string>();
  const walk = (arr: AssetNode[]): void => {
    for (const n of arr) {
      if (n.children) walk(n.children);
      else if (n.version) {
        const k = keyOf(project, n.path);
        seen.add(k);
        if (versions.get(k) !== n.version) {
          versions.set(k, n.version);
          changed = true;
        }
      }
    }
  };
  walk(nodes);
  if (seen.size > 0) {
    for (const k of [...versions.keys()]) {
      if (k.startsWith(prefix) && !seen.has(k)) {
        versions.delete(k);
        changed = true;
      }
    }
  }
  if (changed) {
    persistProject(project); // 다음 새로고침의 첫 렌더가 이 버전을 그대로 쓰게(이번 프로젝트만 기록)
    tick += 1;
    listeners.forEach((l) => l());
  }
}

// React 구독용(useSyncExternalStore). 표가 갱신되면 구독 컴포넌트가 리렌더돼 썸네일 URL 을 다시 만든다.
export function subscribeAssetVersions(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function assetVersionsSnapshot(): number {
  return tick;
}

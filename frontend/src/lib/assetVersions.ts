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
const LS_KEY = "mvhub.assetVersions.v1";

try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") versions.set(k, v);
    }
  }
} catch {
  /* localStorage 접근 불가·손상 데이터 → 빈 표로 시작(기능 저하 없음) */
}

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(versions)));
  } catch {
    /* 용량 초과 등 → 무시(다음 갱신 때 재시도) */
  }
}

function keyOf(project: string, path: string): string {
  return `${project}|${path}`;
}

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
    persist(); // 다음 새로고침의 첫 렌더가 이 버전을 그대로 쓰게
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

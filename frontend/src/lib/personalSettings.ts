import { postAssetSessionReset } from "./assetBroadcast";
import { removeStorage } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

// 계정 전환 시 개인 설정(어셋 폴더·필터·프롬프트 기록 등)이 다음 사용자에게 새지 않도록 정리.
export function clearPersonalSettings() {
  // 보존: 활성계정 마커 + 로그인 토큰(새 계정 토큰을 지우면 새로고침 시 로그아웃된다).
  //  + 씬(캔버스): 이제 계정별로 네임스페이스되므로 전환 때 지우면 안 된다(각 계정의 작업 보존, 서로 안 섞임).
  const KEEP = new Set<string>([
    STORAGE_KEYS.activeAccount,
    STORAGE_KEYS.authToken,
    STORAGE_KEYS.scenes,
    STORAGE_KEYS.scenesActive,
    STORAGE_KEYS.teamSeen, // 계정별 네임스페이스(씬과 동일) — 전환 때 지우면 상대 계정 기준선이 유실
  ]);
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ch.") && !KEEP.has(k)) remove.push(k);
  }
  remove.forEach(removeStorage);
  // 분리된 Assets 팝업은 별도 창이라 옛 계정의 프로젝트·선택·드래그를 메모리에 들고 있다.
  postAssetSessionReset();
}

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
  // 편집 탭 문서의 **옛 자리**(`ch.editTimeline:<계정>:…` — 못 읽은 원문의 보관본 `.bad` 포함. 새 자리 `mvhub.editDoc:` 는 `ch.` 가 아니라
  //  애초에 이 정리의 대상이 아니다 — 아직 못 옮긴 것이 옛 자리에 남을 수 있어 예외를 둔다)와 '마지막으로 연 시퀀스'(`.last:<계정>`)도 계정별
  //  네임스페이스다. 지우면 그 계정의 편집본이 통째로 사라진다 — 브라우저에만 있고 백업이 없다(lib/editTimelineStore). 다른 계정으로
  //  잠깐 로그인했다 돌아오기만 해도 지워졌다(2026-10-10 점검). 화면 설정(`.ui`)은 개인 설정이라 다른 것들처럼 지운다.
  //  캔버스 카드 소속의 '아직 못 보낸 빼기·되살리기' 대기열(lib/sceneCardLinks `ch.sceneCardRemovals.v1.<계정>`·`ch.sceneCardRevives.v1.<계정>`)도
  //  계정별이다 — 지우면 되살리기(Undo)를 보내지 못한 채 계정을 오간 뒤 DB 의 빼기 기록이 되살린 결과를 카드에서 다시 뺐다(Codex 43회차).
  const keepPrefixes = [`${STORAGE_KEYS.editTimeline}:`, `${STORAGE_KEYS.editTimeline}.last:`, "ch.sceneCardRemovals.v1.", "ch.sceneCardRevives.v1."];
  const remove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ch.") && !KEEP.has(k) && !keepPrefixes.some((prefix) => k.startsWith(prefix))) remove.push(k);
  }
  remove.forEach(removeStorage);
  // 분리된 Assets 팝업은 별도 창이라 옛 계정의 프로젝트·선택·드래그를 메모리에 들고 있다.
  postAssetSessionReset();
}

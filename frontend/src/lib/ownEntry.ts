/**
 * id 로 사전(일반 객체)을 조회한다 — **자기 속성만**.
 *
 * 씬에 적힌 id(생성물·카드)는 남이 만든 값일 수 있다(씬 파일·전체 파일 가져오기, 옛 저장소 이관, DB 백업 복구).
 * `map[id]` 로 읽으면 id 가 "toString"·"constructor" 같은 이름일 때 Object.prototype 의 함수가 나와, 그것을
 * 생성물로 믿은 화면이 `generation.assets[0]` 에서 죽는다 — 저장돼 있으니 다시 켜도 죽는다(Codex 코드 리뷰).
 * 사전을 다시 만드는 자리(spread)가 많아 null-prototype 객체로는 막을 수 없으므로 조회하는 쪽에서 막는다.
 */
export function ownEntry<T>(map: Record<string, T>, id: string | null | undefined): T | undefined {
  return id != null && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

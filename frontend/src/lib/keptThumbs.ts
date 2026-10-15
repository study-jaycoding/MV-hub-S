// 캔버스 카드의 썸네일 그림을 씬을 떠난 뒤에도 쥐고 있는다 — 다시 연 씬에서 카드가 먼저 서고 그림이 0.1초쯤 뒤에 차던 것
//  (70·71회차 격리 실측: 놓친 그림을 디스크 캐시에서 다시 받아 왔고 lazy 라 배치가 끝난 뒤에야 요청이 나갔다 — 디코드·래스터 탓 아님.
//  쥐고 있으면 빈 썸네일 시간 95→0ms · 그림 요청 88→6). 그려진(load 끝난) 것만 쥔다 — 화면 밖 카드의 그림을 미리 받지 않는다.
//  최근 KEEP_MAX 장만(가장 오래 안 본 것부터 놓는다). 계정이 바뀌면 화면을 새로 불러오므로 다른 계정으로 새지 않는다.
const KEEP_MAX = 300; // shortcut: 256px 썸네일 300장 ≈ 45MB(추정) — 큰 씬이 늘면 실측 뒤 조정
const kept = new Map<string, HTMLImageElement>();

export function keepThumb(src: string | null | undefined): void {
  if (!src) return;
  const held = kept.get(src);
  if (held) {
    kept.delete(src); // 다시 본 것은 맨 뒤로(가장 최근)
    kept.set(src, held);
    return;
  }
  const img = new Image();
  img.decoding = "async";
  img.src = src; // 방금 그려진 그림이라 메모리 캐시에서 온다 — 요청이 더 나가지 않는다
  kept.set(src, img);
  if (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value as string);
}

/** 시험용 */
export function keptThumbSources(): string[] {
  return [...kept.keys()];
}

/** 시험용 */
export function clearKeptThumbs(): void {
  kept.clear();
}

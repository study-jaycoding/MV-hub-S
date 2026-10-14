// 컷 정보 창의 집계(순수) — 그 폴더의 생성물 목록과 건별 metrics 로 건수·작업자·크레딧·생성일·길이·모델·검토를 센다.
//  화면 없이 시험할 수 있게 모든 계산을 여기에 둔다. 표시(모델 이름·날짜 형식·번역)는 호출하는 쪽의 몫.
import type { Generation } from "../types";

export interface CutMetrics {
  real_credits: number | null;
}

export interface CutSummary {
  total: number;
  videos: number;
  images: number;
  workers: { name: string; count: number }[]; // 많은 순, 같으면 이름 순
  credits: { real: number; known: number; unknown: number }; // real = 실제 크레딧 합(아는 것만), unknown = 아직 모르는 건수
  first: string | null; // created_at 가장 이른 것(원문)
  last: string | null; // 가장 늦은 것(원문)
  seconds: number; // 영상 params.duration 의 합(초)
  models: string[]; // 모델 코드(처음 나온 순)
  review: { final: number; held: number; shared: number };
}

// 작업자 표시 이름 — 정보 창과 같은 규칙(이름 미정이면 나/팀원). uid·이메일은 보이지 않는다.
export function workerLabel(g: Pick<Generation, "creator_name" | "is_mine">): string {
  return g.creator_name || (g.is_mine ? "나" : "팀원");
}

// 영상 길이(초) — params.duration 은 숫자이거나 숫자 문자열("4"). 없거나 못 읽으면 0.
export function durationSec(g: Generation): number {
  const d = g.params?.duration;
  const n = typeof d === "number" ? d : typeof d === "string" && d.trim() !== "" ? Number(d) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 그 폴더(와 하위 폴더)에 든 것만 — 서버 목록의 LIKE 는 대소문자를 안 가리는데 카드의 건수는 가린다(folder_cover.py). 같은 범위로 맞춘다.
export function inFolder(gens: Generation[], path: string): Generation[] {
  return gens.filter((g) => g.folder_path === path || (g.folder_path ?? "").startsWith(path + "/"));
}

export function summarizeCut(gens: Generation[], metrics: ReadonlyMap<string, CutMetrics | null>): CutSummary {
  const workers = new Map<string, number>();
  const models: string[] = [];
  const credits = { real: 0, known: 0, unknown: 0 };
  const review = { final: 0, held: 0, shared: 0 };
  let videos = 0;
  let seconds = 0;
  let first: string | null = null;
  let last: string | null = null;
  for (const g of gens) {
    const name = workerLabel(g);
    workers.set(name, (workers.get(name) ?? 0) + 1);
    if (g.model && !models.includes(g.model)) models.push(g.model);
    const real = metrics.get(g.id)?.real_credits;
    if (typeof real === "number" && Number.isFinite(real)) {
      credits.real += real;
      credits.known += 1;
    } else credits.unknown += 1;
    if (g.is_final) review.final += 1;
    else if (g.is_held) review.held += 1;
    else review.shared += 1;
    if (g.assets?.[0]?.type === "video") {
      videos += 1;
      seconds += durationSec(g);
    }
    // created_at 은 "YYYY-MM-DD HH:MM:SS" 꼴이라 문자열 비교가 시간 순이다(같은 서버의 값끼리).
    if (first === null || g.created_at < first) first = g.created_at;
    if (last === null || g.created_at > last) last = g.created_at;
  }
  return {
    total: gens.length,
    videos,
    images: gens.length - videos,
    workers: [...workers, ].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    credits,
    first,
    last,
    seconds,
    models,
    review,
  };
}

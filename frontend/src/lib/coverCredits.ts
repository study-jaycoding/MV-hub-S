// 폴더 카드의 '크레딧' 줄 — 그 카드에 보이는 그림 한 장의 실제 크레딧. 건마다 따로 묻는 값(api.generationMetrics)이라
//  ① 받은 값은 기억하고(확정된 크레딧은 바뀌지 않는다 — 폴더를 오가도 다시 묻지 않는다) ② 한꺼번에 몇 개만 묻는다:
//  컷 화면은 카드가 수십 장이라, 줄 세우지 않으면 화면을 열 때마다 그 수만큼의 요청이 같이 나간다.
//  **'모름'(값 없음·실패)은 잠깐만 기억한다** — 실제 크레딧은 생성 뒤 나중에 확정되고, 잠깐의 서버 오류가 '미상'으로 굳으면 안 된다
//  (Codex 코드 리뷰). 그 시간이 지난 뒤 그 카드를 다시 그리면 다시 묻는다.
import { useEffect, useState } from "react";
import { api } from "../api";

const AT_ONCE = 4;
const KEEP_MAX = 4000;
const UNKNOWN_KEEP_MS = 60_000;
const known = new Map<string, number>(); // 확정된 값
const unknownAt = new Map<string, number>(); // '모름'으로 받은 시각
const asking = new Map<string, Promise<number | null>>();
const queue: Array<() => void> = [];
let running = 0;
let epoch = 0; // forgetCoverCredits 가 올린다 — 그 전에 출발한 요청의 끝이 새 상태를 건드리지 않게

function next(): void {
  if (running >= AT_ONCE) return;
  const start = queue.shift();
  if (start) start();
}

function remembered(id: string): number | null | undefined {
  const credits = known.get(id);
  if (credits !== undefined) return credits;
  const at = unknownAt.get(id);
  return at !== undefined && Date.now() - at < UNKNOWN_KEEP_MS ? null : undefined;
}

function ask(id: string): Promise<number | null> {
  const going = asking.get(id);
  if (going) return going;
  const born = epoch;
  const promise = new Promise<number | null>((resolve) => {
    queue.push(() => {
      running += 1;
      // 호출 자체가 던져도(약속이 아니라 바로 던지는 경우) 줄이 멎지 않게 약속 안에서 부른다 — 못 받은 것은 '모름'
      Promise.resolve().then(() => api.generationMetrics(id))
        .then((metrics) => metrics.real_credits ?? null)
        .catch(() => null)
        .then((credits) => {
          if (born === epoch) {
            running -= 1;
            asking.delete(id);
            if (credits === null) unknownAt.set(id, Date.now());
            else {
              unknownAt.delete(id);
              known.set(id, credits);
              if (known.size > KEEP_MAX) known.delete(known.keys().next().value as string);
            }
          }
          resolve(credits);
          if (born === epoch) next();
        });
    });
    next();
  });
  asking.set(id, promise);
  return promise;
}

/** 시험용 — 기억과 줄을 비운다(받는 중이던 요청의 끝은 버린다). */
export function forgetCoverCredits(): void {
  epoch += 1;
  known.clear();
  unknownAt.clear();
  asking.clear();
  queue.length = 0;
  running = 0;
}

/** undefined = 받는 중, null = 모름. 그림이 바뀌면(id) 그 그림의 값. */
export function useCoverCredits(id: string): number | null | undefined {
  const [got, setGot] = useState<{ id: string; credits: number | null } | null>(null);
  const have = remembered(id);
  useEffect(() => {
    if (remembered(id) !== undefined) return;
    let alive = true;
    void ask(id).then((credits) => {
      if (alive) setGot({ id, credits });
    });
    return () => {
      alive = false;
    };
  }, [id, have === undefined]); // '모름'의 기억이 다해 다시 그려지면(have 가 undefined 로) 다시 묻는다
  if (have !== undefined) return have;
  return got !== null && got.id === id ? got.credits : undefined;
}

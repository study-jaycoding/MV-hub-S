// 폴더 카드의 '크레딧' 줄 — 그 카드에 보이는 그림 한 장의 실제 크레딧. 건마다 따로 묻는 값(api.generationMetrics)이라
//  ① 한 번 받은 것은 기억하고(생성물의 크레딧은 바뀌지 않는다 — 폴더를 오가도 다시 묻지 않는다) ② 한꺼번에 몇 개만 묻는다:
//  컷 화면은 카드가 수십 장이라, 줄 세우지 않으면 화면을 열 때마다 그 수만큼의 요청이 같이 나간다.
import { useEffect, useState } from "react";
import { api } from "../api";

const AT_ONCE = 4;
const KEEP_MAX = 4000;
const known = new Map<string, number | null>(); // null = 받았지만 모른다(값 없음·실패)
const asking = new Map<string, Promise<number | null>>();
const queue: Array<() => void> = [];
let running = 0;

function next(): void {
  if (running >= AT_ONCE) return;
  const start = queue.shift();
  if (start) start();
}

function ask(id: string): Promise<number | null> {
  const going = asking.get(id);
  if (going) return going;
  const promise = new Promise<number | null>((resolve) => {
    queue.push(() => {
      running += 1;
      // 호출 자체가 던져도(약속이 아니라 바로 던지는 경우) 줄이 멎지 않게 약속 안에서 부른다 — 못 받은 것은 '모름'
      Promise.resolve().then(() => api.generationMetrics(id))
        .then((metrics) => metrics.real_credits ?? null)
        .catch(() => null)
        .then((credits) => {
          running -= 1;
          asking.delete(id);
          known.set(id, credits);
          if (known.size > KEEP_MAX) known.delete(known.keys().next().value as string);
          resolve(credits);
          next();
        });
    });
    next();
  });
  asking.set(id, promise);
  return promise;
}

/** 시험용 — 기억과 줄을 비운다. */
export function forgetCoverCredits(): void {
  known.clear();
  asking.clear();
  queue.length = 0;
  running = 0;
}

/** undefined = 받는 중, null = 모름. 그림이 바뀌면(id) 그 그림의 값. */
export function useCoverCredits(id: string): number | null | undefined {
  const [got, setGot] = useState<{ id: string; credits: number | null } | null>(null);
  useEffect(() => {
    if (known.has(id)) return;
    let alive = true;
    void ask(id).then((credits) => {
      if (alive) setGot({ id, credits });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  if (known.has(id)) return known.get(id);
  return got !== null && got.id === id ? got.credits : undefined;
}

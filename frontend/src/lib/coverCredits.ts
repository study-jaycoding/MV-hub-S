// 폴더 카드의 '크레딧' 줄 — 그 카드에 보이는 그림 한 장의 실제 크레딧. 건마다 따로 묻는 값(api.generationMetrics)이라
//  ① 받은 값은 기억하고(확정된 크레딧은 바뀌지 않는다 — 폴더를 오가도 다시 묻지 않는다) ② 한꺼번에 몇 개만 묻는다:
//  컷 화면은 카드가 수십 장이라, 줄 세우지 않으면 화면을 열 때마다 그 수만큼의 요청이 같이 나간다.
//  **'모름'(값 없음·실패)은 잠깐만 기억한다** — 실제 크레딧은 생성 뒤 나중에 확정되고, 잠깐의 서버 오류가 '미상'으로 굳으면 안 된다
//  (Codex 코드 리뷰). 그 시간이 지난 뒤 그 카드를 다시 그리면 다시 묻는다.
//  ③ **기다리는 화면이 있는 것만 묻는다**(2026-10-13 밤, 배포 전 점검): 컷 화면은 카드를 다 그리므로 화면에 들어온 카드만 묻고
//  (wanted — CoverInfo 가 본다), 기다리는 화면이 없어진 요청은 출발 전이면 줄에서 뺀다 — 안 그러면 떠난 폴더의 요청이 끝까지 나가고
//  지금 보는 카드가 그 뒤에 선다. 이미 출발한 것은 그대로 받아 기억한다.
import { useEffect, useState } from "react";
import { api } from "../api";

const AT_ONCE = 4;
const KEEP_MAX = 4000;
const UNKNOWN_KEEP_MS = 60_000;
const known = new Map<string, number>(); // 확정된 값
const unknownAt = new Map<string, number>(); // '모름'으로 받은 시각
const asking = new Map<string, Promise<number | null>>();
const queue = new Map<string, () => void>(); // 출발을 기다리는 것(넣은 순서대로) — 기다리는 화면이 없어지면 뺀다
const waiters = new Map<string, number>(); // 그 그림의 값을 기다리는 화면 수
let running = 0;
let epoch = 0; // forgetCoverCredits 가 올린다 — 그 전에 출발한 요청의 끝이 새 상태를 건드리지 않게

function next(): void {
  if (running >= AT_ONCE) return;
  const first = queue.entries().next().value;
  if (!first) return;
  queue.delete(first[0]);
  first[1]();
}

function leave(id: string): void {
  const left = (waiters.get(id) ?? 1) - 1;
  if (left > 0) {
    waiters.set(id, left);
    return;
  }
  waiters.delete(id);
  if (queue.delete(id)) asking.delete(id); // 아직 출발 전 — 줄에서 뺀다(다시 기다리는 화면이 생기면 다시 선다)
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
    queue.set(id, () => {
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
  queue.clear();
  waiters.clear();
  running = 0;
}

/** undefined = 받는 중(또는 아직 안 물음), null = 모름. 그림이 바뀌면(id) 그 그림의 값. wanted 가 거짓이면 묻지 않는다(받아 둔 값은 내준다). */
export function useCoverCredits(id: string, wanted = true): number | null | undefined {
  const [got, setGot] = useState<{ id: string; credits: number | null } | null>(null);
  const have = remembered(id);
  useEffect(() => {
    if (!wanted || remembered(id) !== undefined) return;
    let alive = true;
    const born = epoch;
    waiters.set(id, (waiters.get(id) ?? 0) + 1);
    void ask(id).then((credits) => {
      if (alive) setGot({ id, credits });
    });
    return () => {
      alive = false;
      if (born === epoch) leave(id); // 기억을 비운 뒤(시험)에는 세던 수가 이미 없다
    };
  }, [id, wanted, have === undefined]); // '모름'의 기억이 다해 다시 그려지면(have 가 undefined 로) 다시 묻는다
  if (have !== undefined) return have;
  return got !== null && got.id === id ? got.credits : undefined;
}

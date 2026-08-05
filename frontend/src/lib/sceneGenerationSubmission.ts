// 캔버스 생성 배치의 비동기 제출 경계.
// 각 작업을 준비→제출까지 독립 실행해, 한 모델의 느린 파라미터 조회가 다른 모델의 제출을 막지 않게 한다.
// 성공 콜백도 작업별 완료 즉시 호출하므로 전체 배치가 끝나기 전에 화면에 placeholder를 반영할 수 있다.
import type { SceneCard } from "./scenes";
import { variantIds } from "./scenes";

// 같은 씬의 중복 렌더만 막는 작은 실행권. 다른 sceneId는 동시에 획득할 수 있다.
export function acquireSceneGeneration(
  activeSceneIds: Set<string>,
  sceneId: string,
): (() => void) | null {
  if (activeSceneIds.has(sceneId)) return null;
  activeSceneIds.add(sceneId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSceneIds.delete(sceneId);
  };
}

export interface SceneGenerationSubmissionJob<TInput> {
  cardId: string;
  input: TInput;
}

export interface SceneGenerationSubmissionSuccess<TResult> {
  cardId: string;
  result: TResult;
}

export interface SceneGenerationSubmissionSummary<TResult> {
  // Promise.all은 완료 순서와 무관하게 입력 순서를 보존한다. 배치 결과 대표/변형 순서를 안정적으로 유지한다.
  successes: SceneGenerationSubmissionSuccess<TResult>[];
  buildFail: number;
  submitFail: number;
  applyFail: number;
}

export async function executeSceneGenerationBatch<TInput, TBody, TResult>(
  jobs: SceneGenerationSubmissionJob<TInput>[],
  prepare: (input: TInput) => Promise<TBody | null>,
  submit: (body: TBody) => Promise<TResult>,
  onSuccess?: (success: SceneGenerationSubmissionSuccess<TResult>) => void,
): Promise<SceneGenerationSubmissionSummary<TResult>> {
  const outcomes = await Promise.all(
    jobs.map(async (job) => {
      let body: TBody | null;
      try {
        body = await prepare(job.input);
      } catch {
        return { kind: "build-fail" as const };
      }
      if (!body) return { kind: "build-fail" as const };

      let result: TResult;
      try {
        result = await submit(body);
      } catch {
        return { kind: "submit-fail" as const };
      }
      // 제출 성공 뒤의 로컬 반영 오류를 "서버 제출 실패"로 오분류하지 않는다. 콜백 오류는 호출부로
      // 별도 집계해 사용자가 같은 요청을 제출 실패로 오해해 중복 제출하지 않게 한다.
      const success = { cardId: job.cardId, result };
      let applyFailed = false;
      try {
        onSuccess?.(success);
      } catch {
        applyFailed = true;
      }
      return { kind: "success" as const, success, applyFailed };
    }),
  );

  const successes: SceneGenerationSubmissionSuccess<TResult>[] = [];
  let buildFail = 0;
  let submitFail = 0;
  let applyFail = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "success") {
      successes.push(outcome.success);
      if (outcome.applyFailed) applyFail++;
    }
    else if (outcome.kind === "build-fail") buildFail++;
    else submitFail++;
  }
  return { successes, buildFail, submitFail, applyFail };
}

export interface SceneGenerationCardResult {
  cardId: string;
  generationId: string;
}

// 한 배치의 결과를 카드에 누적한다. results 순서가 배치의 정식 순서이며, 이미 점진 반영된 같은 id는
// 잠시 빼고 다시 붙여 최종 순서를 결정적으로 맞춘다. 삭제된 카드는 되살리지 않는다.
export function applySceneGenerationResults(
  cards: SceneCard[],
  results: SceneGenerationCardResult[],
): { cards: SceneCard[]; attachedCardCount: number } {
  const byCard = new Map<string, string[]>();
  for (const result of results) {
    const ids = byCard.get(result.cardId) || [];
    if (!ids.includes(result.generationId)) ids.push(result.generationId);
    byCard.set(result.cardId, ids);
  }
  if (!byCard.size) return { cards, attachedCardCount: 0 };

  let attachedCardCount = 0;
  let changed = false;
  const nextCards = cards.map((card) => {
    const ids = byCard.get(card.id);
    if (!ids?.length) return card;
    attachedCardCount++;
    const batchIds = new Set(ids);
    const genIds = variantIds(card).filter((id) => !batchIds.has(id));
    genIds.push(...ids);
    changed = true;
    return { ...card, genId: ids[0], genIds, status: "pending" as const };
  });
  return { cards: changed ? nextCards : cards, attachedCardCount };
}

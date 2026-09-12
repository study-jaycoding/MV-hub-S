import { api } from "../api";
import type { ModelInfo } from "../types";

// 모델 목록 HTTP 를 훅 인스턴스마다 다시 보내지 않는다.
//
// ★왜(2026-09-12): `useModels` 는 세 곳에서 쓰인다(SpotlightPrompt·SceneModelModal·PartialEditModal).
//  각 인스턴스가 마운트될 때마다 `/api/models` 를 새로 보냈다 — 모달은 열 때마다 마운트된다.
//  실측 응답은 첫 회 1,839ms(CLI), 이후 2.6ms·7.4KB 다.
//
// ★**1.84초를 없애는 작업이 아니다.** 서버가 이미 5분 TTL 캐시와 single-flight 를 한다
//  (`services/cli_bridge.py` `list_models`) — 동시 최초 호출은 서버에서 CLI 1회로 합쳐진다.
//  여기서 줄이는 것은 **HTTP 왕복 그 자체**다.
//
// ★계정 경계: 이 엔드포인트는 **계정 무관으로 설계**돼 있다 — `routers/generation.py` 가
//  "계정 무관 공유 메타데이터… 모두에게 동일한 데이터라 서버의 CLI 가 대표로 제공한다" 고 못박는다.
//  그래서 계정별로 나눌 키가 없다. 게다가 여기 TTL(60초)은 **서버 캐시(5분)보다 짧으므로**,
//  클라이언트가 공유해도 서버가 이미 만들던 것보다 더 낡은 값을 보여 줄 수 없다.
//  (그룹별 사용 가능 모델 제한은 이 목록이 아니라 `modelPolicy` 가 따로 판단한다.)

const TTL_MS = 60_000;

let cached: { at: number; value: ModelInfo[] } | null = null;
let inflight: Promise<ModelInfo[]> | null = null;

export function fetchModelCatalog(
  fetcher: () => Promise<ModelInfo[]> = api.models,
): Promise<ModelInfo[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  if (inflight) return inflight; // 이미 날아간 요청에 합류한다
  const run: Promise<ModelInfo[]> = fetcher().then(
    (models) => {
      if (inflight === run) inflight = null;
      // ★빈 목록은 캐시하지 않는다 — 일시 실패를 60초 동안 굳히면 모델 선택이 통째로 막힌다.
      //  서버도 같은 규칙을 쓴다("성공(비어있지 않음)만 캐시").
      if (models.length) cached = { at: Date.now(), value: models };
      return models;
    },
    (error: unknown) => {
      if (inflight === run) inflight = null;
      throw error; // 실패는 캐시하지 않는다 — 다음 호출이 다시 시도한다
    },
  );
  inflight = run;
  return run;
}

/** 시험용 — 모듈 상태를 비운다. */
export function resetModelCatalogCache(): void {
  cached = null;
  inflight = null;
}

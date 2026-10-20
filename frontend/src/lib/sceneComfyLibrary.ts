import type { MutableRefObject } from "react";
import { comfyApi, type ComfyOutput, type ComfySaveRef } from "./comfyApi";
import { assetIdentity } from "../shared/contracts/assets";
import { comfyTextDriveKeys, incomingTextOf, comfyGenMeta } from "./sceneEdges";
import { gatherComfyMedia, hasTextConnection } from "./sceneComfyInputs";
import { isSceneComfyConfigCurrent, type SceneComfyConfigSnapshot, type SceneComfyRunInputSnapshot } from "./sceneComfyExecutor";
import type { SceneCard, SceneEdge } from "./scenes";
import type { Generation } from "../types";
import { flashMsg } from "./flash";
import { seedPending, observeStatus } from "./sceneRecentDoneStore";
import type { CanvasComfyCommand } from "../features/canvas/api";


export interface SaveComfyOptions {
  silent?: boolean;
  elapsedSeconds?: number;
  outputs?: ComfyOutput[];
  configSnapshot?: SceneComfyConfigSnapshot;
  inputSnapshot?: SceneComfyRunInputSnapshot;
  isInputCurrent?: () => boolean;
}

export interface SaveComfyResult {
  saved: number;
  failed: number;
}

interface SceneComfyLibraryOptions {
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  genDataRef: MutableRefObject<Record<string, Generation>>;
  refParents: Record<string, string[]>;
  commitDocument: (command: CanvasComfyCommand) => boolean;
  isOperationCurrent: () => boolean;
}

export async function saveSceneComfyToLibrary(cardId: string, opts: SaveComfyOptions | undefined, {
  sceneIdRef, cardsRef, edgesRef, genDataRef, refParents, commitDocument, isOperationCurrent,
}: SceneComfyLibraryOptions): Promise<SaveComfyResult> {
  const silent = opts?.silent;
  const sid = sceneIdRef.current; // 저장 대기 중 씬 전환 시 다른 씬 카드에 반영 안 함
  const card = cardsRef.current.find((c) => c.id === cardId);
  const cfg = card?.comfyCfg;
  const runContent = opts?.configSnapshot?.content ?? cfg?.content; // 저장 시작 시점 워크플로 — 응답 도착 전 교체되면 카드 상태는 안 건드린다
  const configSnapshot =
    opts?.configSnapshot ||
    (runContent
      ? {
          name: cfg?.name,
          content: runContent,
          paramValues: { ...(cfg?.paramValues || {}) },
          params: cfg?.params?.map((param) => ({
            ...param,
            choices: param.choices ? [...param.choices] : param.choices,
          })),
        }
      : undefined);
  const outs = (opts?.outputs ?? cfg?.outputs ?? []).filter(
    (o) => (o.kind === "image" || o.kind === "video") && o.url,
  );
  if (!isOperationCurrent()) return { saved: 0, failed: outs.length };
  if (!outs.length) {
    if (!silent) flashMsg("저장할 이미지·영상 출력이 없습니다");
    return { saved: 0, failed: 0 };
  }
  const map = new Map(cardsRef.current.map((c) => [c.id, c] as const));
  // 프롬프트·입력 메타 수집은 '최선 노력' — 여기서 예외가 나도(엣지 순회·malformed 워크플로 등) 출력물 저장은
  //  진행돼야 하고, 렌더 배치 실행(runPlanComfyCopies)이 중단되면 안 된다(silent 자동저장 규약). 이전엔 이 구간이
  //  try 밖이라 의존이 섞인 복잡한 보드에서 예외 1개가 렌더 전체를 죽여 '노드는 완료·저장 실패·생성 미시작'을 유발했다.
  //  실패 시 프롬프트=워크플로명, 입력=빈 목록으로 강등한다.
  let promptText = configSnapshot?.name || "Comfy 출력";
  let inputs: ComfySaveRef[] = [];
  const executedParamValues =
    opts?.inputSnapshot?.executedParamValues ?? configSnapshot?.paramValues ?? {};
  try {
    if (opts?.inputSnapshot) {
      // 자동 저장은 '현재 그래프'를 다시 읽지 않고 실제 API에 들어간 텍스트·미디어를 사용한다.
      // 실행 직후 연결을 바꿔도 옛 출력의 출처와 seed가 새 입력으로 잘못 기록되지 않는다.
      promptText =
        opts.inputSnapshot.textParamKeys
          .map((key) => String(executedParamValues[key] ?? ""))
          .filter((text) => text.trim())
          .join("\n") || configSnapshot?.name || "Comfy 출력";
      inputs = opts.inputSnapshot.media.map((item) => ({
        ...assetIdentity(item),
        url: item.url,
        type: item.type,
        name: item.name,
        source_gen_id: item.source_gen_id ?? null,
      }));
    } else {
      // 수동 저장은 현재 카드 기준으로 메타를 수집한다.
      const driveKeys = [...comfyTextDriveKeys(cfg?.params, cfg?.content)];
      const connected = hasTextConnection(cardId, map, edgesRef.current, refParents);
      const linked = connected ? incomingTextOf(cardId, map, edgesRef.current) : "";
      promptText =
        driveKeys
          .map((key) => (connected ? linked : String(executedParamValues[key] ?? "")))
          .filter((text) => text.trim())
          .join("\n") || configSnapshot?.name || "Comfy 출력";
      inputs = gatherComfyMedia(cardId, cardsRef.current, edgesRef.current, genDataRef.current).map((item) => ({
        ...assetIdentity(item),
        url: item.url,
        type: item.type,
        name: item.name,
        source_gen_id: item.source_gen_id ?? null, // 생성물 입력이면 계보 연결(서버가 열람권한 검증)
      }));
    }
  } catch (e) {
    console.warn("comfy 저장 메타(프롬프트/입력) 수집 실패 — 출력물만 저장:", e);
  }
  try {
    const res = await comfyApi.saveToLibrary({
      outputs: outs.map((o) => ({ url: o.url as string, kind: o.kind })),
      name: configSnapshot?.name,
      prompt: promptText,
      // 파라미터값(노드|필드) + 생성 정보용 표준 메타(model·비율·해상도)를 함께 저장.
      params: {
        ...executedParamValues,
        ...comfyGenMeta(configSnapshot?.content, configSnapshot?.params, executedParamValues),
      },
      inputs,
      elapsed_seconds: opts?.elapsedSeconds ?? null,
    });
    if (!isOperationCurrent() || sceneIdRef.current !== sid) return { saved: res.saved.length, failed: 0 }; // 원래 요청의 저장 성공은 유지하고 현재 화면에는 적용하지 않는다.
    if (opts?.isInputCurrent && !opts.isInputCurrent()) return { saved: res.saved.length, failed: 0 };
    const savedIds = res.saved.map((s) => s.generation_id);
    if (
      configSnapshot &&
      !isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot)
    ) {
      return { saved: res.saved.length, failed: 0 };
    }
    // 시작 때 받은 세션 commit을 유지한다. 현재 카드와 Undo 병합은 세션이 결정한다.
    if (!commitDocument({ type: "saveComfyOutputs", cardId, expectedContent: runContent,
      savedResults: res.saved, executedOutputs: opts?.outputs,
    })) return { saved: res.saved.length, failed: 0 };
    // 방금 만든 결과를 canvas glow 로 강조(#1b) — comfy 결과는 저장 즉시 done 이라 active baseline 을
    //  먼저 심고 done 으로 전환시켜야 glow 규칙(active→done)이 발화한다(generation 카드와 동일 강조).
    if (savedIds.length) {
      seedPending(savedIds);
      for (const id of savedIds) observeStatus(id, "done");
    }
    if (!silent) {
      const created = res.saved.filter((s) => !s.existed).length;
      flashMsg(created ? `${created}개 내 작업에 저장했습니다` : "이미 내 작업에 저장돼 있습니다");
    }
    return { saved: res.saved.length, failed: 0 };
  } catch (e) {
    if (!isOperationCurrent()) return { saved: 0, failed: outs.length };
    // 자동(silent) 저장 실패는 조용히 로그만 — 매 실행 에러 토스트로 도배하지 않는다.
    if (silent) console.warn("comfy 출력 자동 저장 실패:", e);
    else flashMsg(e instanceof Error ? e.message : "내 작업 저장 실패");
    return { saved: 0, failed: outs.length };
  }
}

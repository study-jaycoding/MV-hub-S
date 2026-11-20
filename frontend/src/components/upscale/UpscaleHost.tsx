// 업스케일 호스트 — App 에 1개 mount. 크게 보기·선택 단추 줄이 쏘는 upscale 이벤트(detail={genId, mode, sceneId?, cardId?})를 받아
// 최신 Generation 을 조회한 뒤 창을 연다(PartialEditHost 와 같은 꼴 — 이벤트에 전체 객체를 싣지 않는다). 열려 있으면 새 이벤트는 무시한다.
// sceneId·cardId 가 오면(캔버스에서 연 경우) 결과를 그 캔버스 카드에 쌓는다 — 제출은 App 이 넘긴 canvas 로(재생성과 같은 길).
import { useRef, useState } from "react";
import { api } from "../../api";
import { APP_EVENTS } from "../../lib/appEvents";
import { flashMsg } from "../../lib/flash";
import { useCustomEvent } from "../../lib/useCustomEvent";
import { UpscaleModal, type UpscaleCanvas, type UpscaleCanvasTarget } from "./UpscaleModal";
import type { Generation, WorkspaceContext } from "../../types";

export function UpscaleHost({
  workspace,
  canvas,
  onQueued,
}: {
  workspace: WorkspaceContext;
  canvas: UpscaleCanvas;
  onQueued: (g: Generation) => void; // 생성 카드가 만들어짐 — App 목록 merge + 갱신 알림
}) {
  const [gen, setGen] = useState<Generation | null>(null);
  const [mode, setMode] = useState<"image" | "video">("image");
  const [canvasTarget, setCanvasTarget] = useState<UpscaleCanvasTarget | null>(null);
  const fetchingRef = useRef(false); // 연타 이벤트의 늦은 응답이 열린 창의 원본을 바꿔치기하지 않게
  useCustomEvent(APP_EVENTS.upscale, (e) => {
    const detail = (e as CustomEvent<{ genId?: unknown; mode?: unknown; sceneId?: unknown; cardId?: unknown }>).detail;
    const genId = detail?.genId;
    const requestedMode = detail?.mode === "video" ? "video" : "image";
    const target = typeof detail?.sceneId === "string" && detail.sceneId && typeof detail?.cardId === "string" && detail.cardId
      && canvas.accepts(detail.sceneId, detail.cardId) ? { sceneId: detail.sceneId, cardId: detail.cardId } : null;
    if (typeof genId !== "string" || !genId) return;
    if (gen || fetchingRef.current) {
      flashMsg("업스케일 창이 이미 열려 있습니다 — 닫은 뒤 다시 시도하세요.");
      return;
    }
    fetchingRef.current = true;
    api
      .getGeneration(genId)
      .then((value) => {
        if (value.status !== "done" || value.assets?.[0]?.type !== requestedMode || !value.assets[0].file_path) {
          flashMsg("업스케일: 원본 파일을 확인할 수 없습니다.");
          return;
        }
        setMode(requestedMode);
        setCanvasTarget(target);
        setGen(value);
      })
      .catch(() => flashMsg("업스케일: 생성물 정보를 불러오지 못했습니다."))
      .finally(() => {
        fetchingRef.current = false;
      });
  });
  if (!gen) return null;
  return (
    <UpscaleModal gen={gen} mode={mode} workspace={workspace} canvasTarget={canvasTarget} canvas={canvas}
      onQueued={onQueued} onClose={() => setGen(null)} />
  );
}

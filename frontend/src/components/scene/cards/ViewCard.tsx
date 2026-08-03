// View(미리보기 끝점) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  buildViewClips 는 SceneBoard 의 클로저(disabledIds·genDataRef 의존)라 함수째 prop 으로 받는다.
import type React from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { collectViewTexts } from "../../../lib/sceneEdges";
import { ViewSequencePreview } from "../ViewSequencePreview";
import type { TimelineClip } from "../ViewTimeline";

export function ViewCard({
  card,
  cardsById,
  resolvedEdges,
  buildViewClips,
  playView,
  setViewTextModal,
  onResizeDown,
  t,
}: {
  card: SceneCard;
  cardsById: Map<string, SceneCard>;
  resolvedEdges: SceneEdge[];
  buildViewClips: (viewId: string, byId: Map<string, SceneCard>, es: SceneEdge[]) => TimelineClip[];
  playView: (viewId: string) => void;
  setViewTextModal: (texts: string[]) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
  t: (s: string) => string;
}) {
  // 뷰어 끝점 — 생성물(직접+generation-list)은 미리보기로 재생, 텍스트(text·text-list)는 표시.
  //  clips 는 buildViewClips 가 비활성(회색) 결과를 제외한 목록 → hasMedia 도 이 기준으로 판정.
  const clips = buildViewClips(card.id, cardsById, resolvedEdges);
  const texts = collectViewTexts(card.id, cardsById, resolvedEdges);
  const hasMedia = clips.length > 0;
  const hasText = texts.length > 0;
  return (
    <>
      <div className="scene-card-hd view scene-card-hd-float">{t("미리보기")}</div>
      <div className="scene-card-inner scene-viewnode">
        <div className="scene-viewnode-body">
          {hasMedia ? (
            // '합쳐진 영상' 한 화면 미리보기 — 대표 프레임을 크게, 마우스 올리면 순서대로 이어 재생.
            <ViewSequencePreview clips={clips} />
          ) : hasText ? (
            // 연결된 텍스트의 실제 내용을 표시(개수 대신).
            <div className="scene-viewtext">{texts.join("\n\n")}</div>
          ) : (
            <div className="scene-viewnode-empty">생성물/텍스트를 연결</div>
          )}
        </div>
        {/* 연결이 있을 때만 버튼 노출 — 영상=재생, 텍스트=텍스트 보기, 아무것도 없으면 버튼 없음. */}
        {hasMedia ? (
          <button
            className="scene-view-play"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              playView(card.id);
            }}
          >
            ▶ 재생
          </button>
        ) : hasText ? (
          <button
            className="scene-view-play"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setViewTextModal(texts);
            }}
          >
            📄 텍스트 보기
          </button>
        ) : null}
      </div>
      <span className="scene-port in" title="생성 카드 / 텍스트 / 리스트 / Comfy 결과를 연결" />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}

// 모델 노드 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
import type React from "react";
import type { SceneCard } from "../../../lib/scenes";
import { spotlightParamLabel, spotlightValueLabel } from "../../../lib/spotlightPromptConfig";

export function ModelCard({
  card,
  onOutPortDown,
  onResizeDown,
}: {
  card: SceneCard;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onResizeDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  return (
    <>
      {/* 모델 노드 — 설정한 모델 정보 표시. (더블클릭 모델피커는 후속 단계) */}
      <div className="scene-card-hd model scene-card-hd-float">모델</div>
      <div className="scene-card-inner scene-modelnode">
        {card.modelCfg?.model ? (
          <div className="scene-modelnode-body">
            {/* 상단 중앙 = 모델명·타입, 아래 = 설정한 옵션 전부(라벨: 값) */}
            <div className="scene-modelnode-head">
              <div className="scene-modelnode-name">
                {card.modelCfg.modelName || card.modelCfg.model}
              </div>
              {card.modelCfg.type && (
                <div className="scene-modelnode-type">{card.modelCfg.type}</div>
              )}
            </div>
            {card.modelCfg.params && Object.keys(card.modelCfg.params).length > 0 && (
              <div className="scene-modelnode-params">
                {Object.entries(card.modelCfg.params).map(([k, v]) => (
                  <div key={k} className="scene-modelnode-param">
                    <span className="k">{spotlightParamLabel(k)}</span>
                    <span className="v">{spotlightValueLabel(String(v))}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="scene-modelnode-body">
            <div className="scene-modelnode-empty">더블클릭해 모델 설정</div>
          </div>
        )}
      </div>
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 생성 카드 모델 입력에 연결(주황)"
      />
      <span
        className="scene-resize"
        onMouseDown={(e) => onResizeDown(e, card.id)}
        title="드래그해 크기 조절"
      />
    </>
  );
}

// Input(무선 수신) 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
import type React from "react";
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { inputPickLanes, outputPickGroup, resolveInputSourceId } from "../../../lib/sceneEdges";
import { InputChannelPicker } from "./InputChannelPicker";

export function InputCard({
  card,
  sel,
  cards,
  cardsById,
  edges,
  setNodeChannel,
  onOutPortDown,
}: {
  card: SceneCard;
  sel: boolean;
  cards: SceneCard[];
  cardsById: Map<string, SceneCard>;
  edges: SceneEdge[];
  setNodeChannel: (cardId: string, channel: string) => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  // Input(무선 수신) — output 채널 하나를 골라 그 소스에 직접 연결한 것처럼 사용.
  const outputs = cards.filter((c) => c.kind === "output");
  const chOk = !!card.channel && outputs.some((o) => o.id === card.channel);
  const channelName = chOk ? (cardsById.get(card.channel!)?.text || "").trim() : "";
  // 색 = 고른 OUTPUT 과 같은 무리 색(Jay 2026-10-29) — 못 풀면 회색
  const tone = chOk && resolveInputSourceId(card.id, cardsById, edges) ? outputPickGroup(card.channel!, cardsById, edges) : "none";
  return (
    <>
      <div className={"scene-card-inner scene-portnode in oc-" + tone}>
        <div className="scene-card-hd portin">INPUT</div>
        <div className="scene-portnode-body">
          {/* 본문 = 고른 채널 이름(입력값)만. 출력 선택 드롭다운은 선택 시 카드 아래 툴바에서. */}
          <div className="scene-portnode-val">
            {channelName || (
              <span className="scene-portnode-valph">
                {card.channel ? "⚠ 미연결" : "출력 선택"}
              </span>
            )}
          </div>
        </div>
      </div>
      {sel && (
        <div className="scene-portedit" onMouseDown={(e) => e.stopPropagation()}>
          {/* 출력 고르기 — 종류별 무리·검색·이어진 칸에 맞는 것만(Jay 2026-10-29) */}
          <InputChannelPicker
            items={outputs.map((o) => ({
              id: o.id,
              name: (o.text || "").trim() || "(이름 없음)",
              group: outputPickGroup(o.id, cardsById, edges),
            }))}
            value={chOk ? card.channel! : ""}
            lanes={inputPickLanes(card.id, cardsById, edges)}
            onPick={(id) => setNodeChannel(card.id, id)}
          />
        </div>
      )}
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 원하는 곳에 연결(고른 출력의 소스처럼 동작)"
      />
    </>
  );
}

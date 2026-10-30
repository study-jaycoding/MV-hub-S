// Output(무선 발신) 카드 본문 — SceneBoard 렌더 분할(R2).
// 규칙: 카드 '셸'(.scene-card div — key·클래스·위치·ref 등록·마우스 핸들러)은 SceneBoard 가 소유하고,
// 여기는 Fragment 만 반환한다(.scene-card 직속 자식 순서를 보존해 포트·리사이즈 핸들·높이 측정 불변).
import type { SceneCard, SceneEdge } from "../../../lib/scenes";
import { outputPickGroup } from "../../../lib/sceneEdges";

export function OutputCard({
  card,
  sel,
  edges,
  cardsById,
  setNodeText,
  flushPending,
}: {
  card: SceneCard;
  sel: boolean;
  edges: SceneEdge[];
  cardsById: Map<string, SceneCard>;
  setNodeText: (cardId: string, text: string) => void;
  flushPending: () => void;
}) {
  // Output(무선 발신) — 소스 하나에 붙어 '채널'을 발행. 색은 내보내는 것이 생성 카드의 어느 칸으로 가는지(Jay 2026-10-29) —
  //  레퍼런스 리스트도 레퍼런스와 같은 파랑, 텍스트 리스트는 보라. INPUT 출력 목록의 무리와 같은 판정.
  const inEdge = edges.find((e) => e.to === card.id);
  const src = inEdge ? cardsById.get(inEdge.from) : undefined;
  return (
    <>
      <div className={"scene-card-inner scene-portnode out oc-" + outputPickGroup(card.id, cardsById, edges)}>
        <div className="scene-card-hd portout">OUTPUT</div>
        <div className="scene-portnode-body">
          {/* 본문 = 입력된 값(채널 이름)만. 이름 입력은 선택 시 카드 아래 툴바에서. */}
          <div className="scene-portnode-val">
            {(card.text || "").trim() || (
              <span className="scene-portnode-valph">{src ? "채널 이름" : "소스 연결"}</span>
            )}
          </div>
        </div>
      </div>
      {sel && (
        <div className="scene-portedit" onMouseDown={(e) => e.stopPropagation()}>
          <input
            className="scene-portedit-name"
            value={card.text || ""}
            placeholder="채널 이름 입력"
            onChange={(e) => setNodeText(card.id, e.target.value)}
            onBlur={() => flushPending()} // 입력 끝나면 밀린 저장 확정
          />
        </div>
      )}
      <span className="scene-port in" title={"출력 노드 입력\n내보낼 소스(모델·텍스트·레퍼런스·생성물·리스트)를 잇는다"} />
    </>
  );
}

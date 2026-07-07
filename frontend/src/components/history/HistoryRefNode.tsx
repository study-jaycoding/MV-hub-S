// 원본(root) 입력 레퍼런스 노드 — 히스토리 보드에서 원본 왼쪽에 놓이고 원본에 연결된다.
// "이 원본에 어떤 레퍼런스들이 쓰였나"를 순서대로 보여준다(읽기 전용 표시). 아직 편집·연결 조작은 없음.
import type { Reference } from "../../types";
import { thumbUrl } from "../../lib/media";

interface Props {
  refs: Reference[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export function HistoryRefNode({ refs, x, y, width, height }: Props) {
  return (
    <div
      className="linb-refnode"
      style={{ left: x, top: y, width, height }}
      // 노드 클릭이 배경 마퀴/패닝을 시작하지 않게 차단(순수 표시 노드).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="linb-refnode-hd">레퍼런스 {refs.length}</div>
      <div className="linb-refnode-body">
        {refs.map((r, i) => {
          const src = thumbUrl(r.thumbnail_path || r.file_path, 128);
          return (
            <div className="linb-refthumb" key={r.id || i} title={r.role || `레퍼런스 ${i + 1}`}>
              {src ? (
                <img src={src} alt="" draggable={false} />
              ) : (
                <span className="linb-refthumb-ph" />
              )}
              <span className="linb-refnum">{i + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

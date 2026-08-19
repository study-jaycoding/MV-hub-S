// 씬 선택/추가 바 — 구성 탭 상단. 씬을 전환/추가/이름변경/삭제한다.
// 계보(히스토리) 뷰는 고정 탭이 아니라 정보팝업 '⧉ 히스토리'·미리보기 '구성에서 보기'로만 진입
// (activeId=null 상태 — 그때는 어떤 씬 탭도 켜지지 않는다).
import type { Scene } from "../../lib/scenes";

interface Props {
  scenes: Scene[];
  activeId: string | null; // null = 계보(히스토리) 뷰
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onHoverChange?: (hover: boolean) => void; // 씬 패널(저장/불러오기) 호버 표시용
}

export function SceneBar({ scenes, activeId, onSelect, onAdd, onRename, onDelete, onHoverChange }: Props) {
  return (
    <div
      className="scene-bar"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {scenes.map((s) => (
        <span key={s.id} className={"scene-tab-wrap" + (activeId === s.id ? " on" : "")}>
          <button
            className="scene-tab"
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => {
              const name = window.prompt("씬 이름", s.name);
              if (name && name.trim()) onRename(s.id, name.trim());
            }}
            title="클릭=열기 · 더블클릭=이름 변경"
          >
            {s.name}
          </button>
          <button
            className="scene-del"
            title="씬 삭제"
            onClick={() => {
              if (window.confirm(`'${s.name}' 씬을 삭제할까요?`)) onDelete(s.id);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button className="scene-add" onClick={onAdd} title="씬 추가">
        +
      </button>
    </div>
  );
}

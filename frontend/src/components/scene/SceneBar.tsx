// 씬 선택/추가 바 — 구성 탭 상단. '히스토리'(기존 계보 뷰)와 씬들을 전환하고, 씬을 추가/이름변경/삭제한다.
import { useT } from "../../lib/i18n";
import type { Scene } from "../../lib/scenes";

interface Props {
  scenes: Scene[];
  activeId: string | null; // null = 계보(히스토리) 뷰
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function SceneBar({ scenes, activeId, onSelect, onAdd, onRename, onDelete }: Props) {
  const t = useT();
  return (
    <div className="scene-bar">
      <button
        className={"scene-tab" + (activeId === null ? " on" : "")}
        onClick={() => onSelect(null)}
        title={t("히스토리 보기")}
      >
        {t("히스토리")}
      </button>
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

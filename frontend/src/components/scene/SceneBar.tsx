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
  backupOnly?: number; // DB 백업에만 있는 씬 수(0 이면 '가져오기'를 숨긴다)
  onImportBackup?: () => void;
}

export function SceneBar({
  scenes,
  activeId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onHoverChange,
  backupOnly = 0,
  onImportBackup,
}: Props) {
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
      {backupOnly > 0 && onImportBackup ? (
        // 다른 브라우저(앱 전용 프로필)에서 만든 씬이 이 PC 의 DB 백업에 남아 있을 때만 뜬다.
        <button
          className="scene-restore"
          onClick={onImportBackup}
          title={`이 브라우저에 없는 씬 ${backupOnly}개가 이 PC 의 백업에 있습니다. 눌러서 가져옵니다(현재 씬은 그대로 둡니다).`}
        >
          ⤓ 백업에서 씬 {backupOnly}개 가져오기
        </button>
      ) : null}
    </div>
  );
}

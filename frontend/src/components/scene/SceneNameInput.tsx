// 씬 이름 글칸 — 탭과 탭 설명 창의 이름을 더블클릭하면 그 자리에 뜬다(Jay 2026-11-02 A안). 이름 전체가 골라진 채 열린다.
//  Enter·바깥 누르기 = 저장, Esc = 취소. 빈 이름·같은 이름은 보내지 않는다(우클릭 메뉴의 이름 칸과 같은 규칙).
import { useRef, useState } from "react";

export function SceneNameInput({ name, onRename, onDone }: { name: string; onRename: (next: string) => void; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const doneRef = useRef(false);
  const finish = (save: boolean) => {
    if (doneRef.current) return; // Enter·Esc 로 닫힐 때 뒤따르는 초점 이탈
    doneRef.current = true;
    const trimmed = value.trim();
    if (save && trimmed && trimmed !== name) onRename(trimmed);
    onDone();
  };
  return (
    <input
      className="scene-name-input"
      value={value}
      aria-label="씬 이름"
      autoFocus
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation(); // 캔버스의 Esc(선택 풀기)까지 가지 않게
        finish(event.key === "Enter");
      }}
      onBlur={() => finish(true)}
    />
  );
}

// 탭 설명 창의 제목 — 평소엔 글, 더블클릭하면 글칸. 고치는 동안은 창을 붙들어 두고(pin), 끝나면 닫는다.
export function SceneTipName({
  name,
  onRename,
  pin,
  close,
}: {
  name: string;
  onRename: (next: string) => void;
  pin: (on: boolean) => void;
  close: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <SceneNameInput name={name} onRename={onRename} onDone={close} />;
  return (
    <div
      className="node-tip-head"
      onDoubleClick={() => {
        pin(true);
        setEditing(true);
      }}
    >
      {name}
    </div>
  );
}

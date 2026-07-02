// 값(프로젝트/에피소드/시퀀스/생성자)을 색 라벨로 표시 — 색 지정 없으면 평문, 있으면 색 칩.
import { colorHex, colorKeyOf, type ColorMap } from "./manageColors";

export function ColorTag({
  field,
  value,
  colorMap,
  plainClass,
  title,
}: {
  field: string;
  value?: string | null;
  colorMap?: ColorMap;
  plainClass?: string; // 색 없을 때 평문 span 클래스
  title?: string;
}) {
  if (!value) return <span className="work-cell-txt">—</span>;
  const hex = colorHex(colorMap?.[colorKeyOf(field, value)]);
  if (!hex) {
    return (
      <span className={plainClass || "work-cell-txt"} title={title}>
        {value}
      </span>
    );
  }
  return (
    <span
      className="work-color-tag"
      title={title}
      style={{ background: `${hex}22`, color: hex, borderColor: `${hex}66` }}
    >
      {value}
    </span>
  );
}

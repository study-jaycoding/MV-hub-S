// 에셋 정렬 메뉴 — 그리드/리스트 토글 옆의 정렬 버튼(⇅). 누르면 이름/날짜/유형 + 오름/내림을
// 고르는 드롭다운(윈도우 탐색기 정렬 메뉴와 같은 구성). 바깥을 누르면 닫힘.
import { useEffect, useRef, useState } from "react";
import type { AssetSortDir, AssetSortField } from "./assetsViewModel";

const FIELDS: { key: AssetSortField; label: string }[] = [
  { key: "name", label: "이름" },
  { key: "date", label: "날짜" },
  { key: "type", label: "유형" },
];

export function AssetSortMenu({
  field,
  dir,
  onField,
  onDir,
}: {
  field: AssetSortField;
  dir: AssetSortDir;
  onField: (f: AssetSortField) => void;
  onDir: (d: AssetSortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 바깥 클릭 → 닫기(메뉴 안 클릭은 field/dir 만 바꾸고 열린 채 유지 → 기준·방향을 한 번에 고름).
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const fieldLabel = FIELDS.find((f) => f.key === field)?.label ?? "정렬";

  return (
    <div className="asset-sort" ref={ref}>
      <button
        className={"af-btn asort-btn" + (open ? " on" : "")}
        title={`정렬: ${fieldLabel} · ${dir === "asc" ? "오름차순" : "내림차순"}`}
        onClick={() => setOpen((v) => !v)}
      >
        ⇅
      </button>
      {open && (
        <div className="asort-menu" role="menu">
          {FIELDS.map((f) => (
            <button
              key={f.key}
              className={"asort-item" + (field === f.key ? " sel" : "")}
              onClick={() => onField(f.key)}
            >
              <span className="asort-bullet">{field === f.key ? "●" : ""}</span>
              {f.label}
            </button>
          ))}
          <div className="asort-sep" />
          <button
            className={"asort-item" + (dir === "asc" ? " sel" : "")}
            onClick={() => onDir("asc")}
          >
            <span className="asort-bullet">{dir === "asc" ? "●" : ""}</span>
            오름차순
          </button>
          <button
            className={"asort-item" + (dir === "desc" ? " sel" : "")}
            onClick={() => onDir("desc")}
          >
            <span className="asort-bullet">{dir === "desc" ? "●" : ""}</span>
            내림차순
          </button>
        </div>
      )}
    </div>
  );
}

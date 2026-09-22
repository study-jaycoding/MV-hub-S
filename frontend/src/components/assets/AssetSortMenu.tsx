// 에셋 정렬 메뉴 — 그리드/리스트 토글 옆의 정렬 버튼(위아래 화살표). 누르면 이름/날짜/유형 + 오름/내림을
// 고르는 드롭다운(윈도우 탐색기 정렬 메뉴와 같은 구성). 바깥을 누르면 닫힘.
import { useEffect, useRef, useState } from "react";
import type { AssetSortDir, AssetSortField } from "./assetsViewModel";

// 위아래 화살표(24격자, 가로·세로 모두 12 를 중심으로 대칭). 예전 글자 '⇅' 는 기준선 때문에 단추 안에서
// 1.5px 아래로 치우쳤다(2026-09-22 픽셀 실측) — 아이콘은 SVG 로 정중앙에 둔다.
function SortIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 20V4M4 8l4-4 4 4" />
      <path d="M16 4v16M12 16l4 4 4-4" />
    </svg>
  );
}

const FIELDS: { key: AssetSortField; label: string }[] = [
  { key: "name", label: "이름" },
  { key: "date", label: "날짜" },
  { key: "type", label: "유형" },
];

// 기준 목록을 바꿔 쓰는 곳이 있다 — Resolve 프로젝트 목록은 '유형' 대신 타임라인 수·해상도·프레임 레이트.
// 그래서 기준 키는 부르는 쪽이 정한다(기본은 에셋 기준).
export function AssetSortMenu<F extends string = AssetSortField>({
  field,
  dir,
  fields = FIELDS as unknown as { key: F; label: string }[],
  onField,
  onDir,
}: {
  field: F;
  dir: AssetSortDir;
  fields?: { key: F; label: string }[];
  onField: (f: F) => void;
  onDir: (d: AssetSortDir) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // 바깥 클릭 → 닫기(메뉴 안 클릭은 field/dir 만 바꾸고 열린 채 유지 → 기준·방향을 한 번에 고름).
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const fieldLabel = fields.find((f) => f.key === field)?.label ?? "정렬";

  return (
    <div className="asset-sort" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={"af-btn asort-btn" + (open ? " on" : "")}
        title={`정렬: ${fieldLabel} · ${dir === "asc" ? "오름차순" : "내림차순"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SortIcon />
      </button>
      {open && (
        <div className="asort-menu" role="menu">
          {fields.map((f) => (
            <button
              type="button"
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
            type="button"
            className={"asort-item" + (dir === "asc" ? " sel" : "")}
            onClick={() => onDir("asc")}
          >
            <span className="asort-bullet">{dir === "asc" ? "●" : ""}</span>
            오름차순
          </button>
          <button
            type="button"
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

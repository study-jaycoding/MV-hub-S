// 재사용 검색 입력 — Assets 패널과 같은 스타일(.assets-search). 디바운스 라이브 검색.
import { useEffect, useRef, useState } from "react";

export function SearchBox({
  value,
  placeholder = "Search · Tag",
  className = "",
  onSearch,
}: {
  value?: string;
  placeholder?: string;
  className?: string;
  onSearch: (q?: string) => void;
}) {
  const [q, setQ] = useState(value || "");
  const tRef = useRef<number | null>(null);
  // 외부에서 검색어가 비워지면(필터 초기화 등) 입력도 동기화
  useEffect(() => {
    setQ(value || "");
  }, [value]);
  const apply = (v: string) => {
    setQ(v);
    if (tRef.current) window.clearTimeout(tRef.current);
    tRef.current = window.setTimeout(() => onSearch(v.trim() || undefined), 300);
  };
  return (
    <div className={"assets-search " + className}>
      <span className="as-icon">⌕</span>
      <input
        value={q}
        placeholder={placeholder}
        onChange={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (tRef.current) window.clearTimeout(tRef.current);
            onSearch(q.trim() || undefined);
          }
        }}
      />
      {q && (
        <button
          className="as-clear"
          title="지우기"
          onClick={() => {
            setQ("");
            if (tRef.current) window.clearTimeout(tRef.current);
            onSearch(undefined);
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

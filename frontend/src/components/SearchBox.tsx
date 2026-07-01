// 재사용 검색 입력 — Assets 패널과 같은 스타일(.assets-search). 디바운스 라이브 검색.
import { useEffect, useState } from "react";
import { useDebouncedCallback } from "../lib/useDebouncedCallback";

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
  const searchDebounce = useDebouncedCallback(
    (next: string) => onSearch(next.trim() || undefined),
    300,
  );
  // 외부에서 검색어가 비워지면(필터 초기화 등) 입력도 동기화
  useEffect(() => {
    setQ(value || "");
  }, [value]);
  const apply = (v: string) => {
    setQ(v);
    searchDebounce.run(v);
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
            searchDebounce.cancel();
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
              searchDebounce.cancel();
              onSearch(undefined);
            }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

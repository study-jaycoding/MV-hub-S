// 재사용 검색 입력 — Assets 패널과 같은 스타일(.assets-search). 디바운스 라이브 검색.
import { useEffect, useRef, useState } from "react";
import { useDebouncedCallback } from "../lib/useDebouncedCallback";

export function SearchBox({
  value,
  placeholder = "Search · Tag",
  className = "",
  onSearch,
  resetKey,
}: {
  value?: string;
  placeholder?: string;
  className?: string;
  onSearch: (q?: string) => void;
  resetKey?: unknown; // 바뀌면 예약해 둔 검색을 버리고 입력을 값에 맞춘다(아래)
}) {
  const [q, setQ] = useState(value || "");
  // 내가 마지막으로 보낸 검색어 — 부모에서 돌아온 값이 이것이면 메아리고, 아니면 밖에서 바뀐 것이다(필터 초기화·Resolve 따라가기)
  const sentRef = useRef(value || "");
  const send = (next: string | undefined) => {
    sentRef.current = next || "";
    onSearch(next);
  };
  const searchDebounce = useDebouncedCallback(
    (next: string) => send(next.trim() || undefined),
    300,
  );
  // 외부에서 검색어가 바뀌면(필터 초기화 등) 입력도 맞추고, **예약해 둔 검색을 버린다** — 남겨 두면 0.3초 뒤에 옛 글이 다시 걸려
  //  초기화(자동 따라가기가 찾은 자리 표시 등)를 되돌린다(Codex 검토). 내 검색의 메아리에는 손대지 않는다: 그사이 더 친 글자를
  //  덮거나(끝의 빈칸이 먹혔다) 그 글자의 예약을 버리게 된다.
  //  resetKey = 값이 그대로여도 밖에서 초기화됐다는 신호(자동 따라가기 횟수). 확정된 검색어가 없으면 초기화 전후의 값이 둘 다
  //  undefined 라 값 비교로는 알 수 없다. 입력칸은 그대로 둔다 — 다시 올리면 치던 사람의 초점이 사라진다(Codex 코드 리뷰).
  const seenResetRef = useRef(resetKey);
  useEffect(() => {
    const incoming = value || "";
    const reset = seenResetRef.current !== resetKey;
    seenResetRef.current = resetKey;
    if (!reset && incoming === sentRef.current) return;
    sentRef.current = incoming;
    searchDebounce.cancel();
    setQ(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, resetKey]);
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
            send(q.trim() || undefined);
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
              send(undefined);
            }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// 플로팅 입력창 — 네이티브 window.prompt 대체. 화면을 가리지 않는 작은 떠 있는 입력.
import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeClose } from "../lib/useEscapeClose";
import { workspaceCommandLabels, type WorkspaceCommandTarget } from "../lib/workspaceCommand";
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "../lib/workspaceOptionsCache";

export function FloatingPrompt({
  title,
  initial = "",
  placeholder = "",
  workspaceSuggest = false,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  // true 면 `#+` 입력 시 내 워크스페이스 목록을 아래에 띄워 클릭으로 고른다(전역태그 모달 전용).
  // 선택 결과는 `#+@<id>` 로 제출 — 동명 워크스페이스도 UUID 로 유일하게 특정된다.
  workspaceSuggest?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEscapeClose(onCancel);

  const wsQuery = workspaceSuggest && v.startsWith("#+") ? v.slice(2).trim() : null;
  const wsOpen = wsQuery !== null;
  const [wsOptions, setWsOptions] = useState<WorkspaceCommandTarget[]>(
    () => cachedWorkspaceOptions() ?? [],
  );
  // 캐시 즉시 표시 + 뒤에서 최신 갱신(stale-while-revalidate) — TagEditor #+ 피커와 동일.
  useEffect(() => {
    if (!wsOpen) return;
    let active = true;
    fetchWorkspaceOptions()
      .then((items) => {
        if (active) setWsOptions(items);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [wsOpen]);
  const wsLabels = useMemo(() => workspaceCommandLabels(wsOptions), [wsOptions]);
  const wsFiltered = wsOpen
    ? wsOptions.filter(
        (w) => !wsQuery || w.name.toLowerCase().includes(wsQuery.toLowerCase()),
      )
    : [];

  return (
    <>
      {/* 바깥 클릭 = 취소(화면을 어둡게 가리지 않는 투명 캐처) */}
      <div className="fp-catcher" onMouseDown={onCancel} />
      <div className="fp-panel" role="dialog">
        <div className="fp-title">{title}</div>
        <input
          ref={ref}
          className="fp-input"
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit(v);
          }}
        />
        {wsOpen && (
          <div className="fp-ws-list">
            {wsFiltered.length === 0 && (
              <span className="fp-ws-empty">
                {wsOptions.length ? "일치하는 워크스페이스 없음" : "워크스페이스 목록 불러오는 중…"}
              </span>
            )}
            {wsFiltered.map((w) => (
              <button
                key={w.id}
                className="fp-ws-btn"
                title={`"${w.name}" 를 워크스페이스 필터로 등록`}
                onClick={() => onSubmit("#+@" + w.id)}
              >
                ＋ {wsLabels.get(w.id) || w.name}
              </button>
            ))}
          </div>
        )}
        <div className="fp-actions">
          <button className="fp-cancel" onClick={onCancel}>
            취소
          </button>
          <button className="fp-ok" onClick={() => onSubmit(v)}>
            확인
          </button>
        </div>
      </div>
    </>
  );
}

// 워크스페이스 선택기 — 개인 ↔ 팀(공유 UUID 공간) 전환.
// 전환 시 백엔드가 `workspace set/unset` + 재동기화 → onSwitched 로 라이브러리 리로드.
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../types";

export function WorkspaceSelector({ onSwitched }: { onSwitched: () => void }) {
  const [list, setList] = useState<Workspace[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.workspaces().then(setList).catch(() => {});
  }, []);

  const current = list.find((w) => w.is_selected);
  const label = current ? current.name || "워크스페이스" : "개인 계정";

  const switchTo = async (id: string | null) => {
    setBusy(true);
    try {
      const r = id ? await api.selectWorkspace(id) : await api.unselectWorkspace();
      setList(r.workspaces);
      setOpen(false);
      onSwitched(); // 새 컨텍스트 잡으로 라이브러리 갱신
    } catch (e) {
      alert("워크스페이스 전환 실패: " + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-selector">
      <button
        className={"ws-btn" + (current ? " team" : "")}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title="워크스페이스 — 팀 공유 UUID 공간으로 전환"
      >
        <span className="ws-dot" />
        <span className="ws-label">{busy ? "전환 중…" : label}</span>
        <span className="ws-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="ws-catcher" onClick={() => setOpen(false)} />
          <div className="ws-menu">
            <div className="ws-menu-title">워크스페이스</div>
            <button
              className={"ws-item" + (!current ? " on" : "")}
              onClick={() => switchTo(null)}
            >
              <span className="ws-item-main">
                <span className="ws-item-name">개인 계정</span>
                <span className="ws-item-meta">내 비공개 컨텍스트</span>
              </span>
              {!current && <span className="ws-check">✓</span>}
            </button>
            {list.map((w) => (
              <button
                key={w.id}
                className={"ws-item" + (w.is_selected ? " on" : "")}
                onClick={() => switchTo(w.id)}
              >
                <span className="ws-item-main">
                  <span className="ws-item-name">{w.name || "(이름 없음)"}</span>
                  <span className="ws-item-meta">
                    {w.plan_type} · {Math.round(w.credits)} cr · {w.user_role}
                  </span>
                </span>
                {w.is_selected && <span className="ws-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 외부 폴더 등록(마운트) 관리 — Assets 좌상단 타이틀 클릭으로 열리는 플로팅 창.
//  · 위 입력: 등록할 폴더 경로 + 이름 → 등록하면 아래 목록에 추가
//  · 등록된 이름은 프로젝트 드롭다운에 그대로 뜬다(서버 전역, 모든 팀원 공유)
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AssetMount } from "../../types";

export function MountManager({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void; // 등록/삭제 후 프로젝트 목록 새로고침
}) {
  const [mounts, setMounts] = useState<AssetMount[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reload = () =>
    api.assetMounts().then((r) => setMounts(r.mounts)).catch(() => {});

  useEffect(() => {
    reload();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = async () => {
    const p = path.trim();
    const n = name.trim();
    if (!p || !n) {
      setErr("폴더 경로와 이름을 모두 입력하세요.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.addAssetMount(n, p);
      setMounts(r.mounts);
      setPath("");
      setName("");
      onChanged();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mn: string) => {
    if (!window.confirm(`"${mn}" 등록을 해제할까요? (원본 폴더는 그대로입니다)`)) return;
    try {
      const r = await api.delAssetMount(mn);
      setMounts(r.mounts);
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="manage-float mount-float" role="dialog" aria-label="폴더 등록">
        <header className="admin-head">
          <span className="admin-title">🗂 폴더 등록</span>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className="admin-body">
          <section className="settings-section">
            <h4>새 폴더 등록</h4>
            <div className="mount-form">
              <input
                className="mount-input"
                placeholder="폴더 경로 (예: D:\작업\내폴더)"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
                autoFocus
              />
              <div className="mount-form-row">
                <input
                  className="mount-input mount-name"
                  placeholder="표시 이름"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                />
                <button className="settings-action" onClick={add} disabled={busy}>
                  {busy ? "등록 중…" : "＋ 등록"}
                </button>
              </div>
            </div>
            {err && <p className="manage-msg err">{err}</p>}
            <p className="settings-hint">
              경로의 폴더가 프로젝트 드롭다운에 이 이름으로 추가됩니다. 서버 디스크 기준 경로라 모든
              팀원이 공유합니다.
            </p>
          </section>

          <section className="settings-section">
            <h4>등록된 폴더 ({mounts.length})</h4>
            {mounts.length === 0 ? (
              <p className="settings-hint">아직 등록된 폴더가 없습니다.</p>
            ) : (
              <ul className="mount-list">
                {mounts.map((m) => (
                  <li key={m.name} className={"mount-item" + (m.exists ? "" : " missing")}>
                    <div className="mount-item-main">
                      <span className="mount-item-name">{m.name}</span>
                      <span className="mount-item-path" title={m.path}>
                        {m.path}
                      </span>
                    </div>
                    {!m.exists && <span className="mount-warn" title="폴더를 찾을 수 없음">⚠</span>}
                    <button
                      className="mount-del"
                      title="등록 해제"
                      onClick={() => remove(m.name)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

// 외부 폴더 등록(마운트) 관리 — Assets 좌상단 타이틀 클릭으로 열리는 플로팅 창.
//  · 위 입력: 등록할 폴더 경로 + 이름 → 등록하면 아래 목록에 추가
//  · 등록된 이름은 프로젝트 드롭다운에 그대로 뜬다(서버 전역, 모든 팀원 공유)
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useEscapeClose } from "../../lib/useEscapeClose";
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
  const [pruning, setPruning] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const [err, setErr] = useState("");

  const reload = () =>
    api.assetMounts().then((r) => setMounts(r.mounts)).catch(() => {});

  useEffect(() => {
    reload();
  }, []);
  useEscapeClose(onClose);

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

  const relink = async () => {
    setRelinking(true);
    setErr("");
    try {
      const r = await api.relinkBrokenSources();
      onChanged();
      window.alert(
        r.relinked > 0
          ? `다시 연결 완료: 깨진 소스 ${r.relinked}개를 찾아 이었습니다.`
          : "다시 연결할 소스가 없습니다(모두 정상이거나 원본을 못 찾음).",
      );
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setRelinking(false);
    }
  };

  const prune = async () => {
    if (
      !window.confirm(
        "원본 파일을 못 찾는 소스의 지정을 해제합니다. 파일이 있는 소스는 그대로 둡니다. 진행할까요?",
      )
    )
      return;
    setPruning(true);
    setErr("");
    try {
      const r = await api.pruneBrokenSources();
      onChanged();
      window.alert(`정리 완료: 깨진 소스 ${r.pruned}개의 지정을 해제했습니다.`);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setPruning(false);
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
                      <span className="mount-item-name">
                        {m.name}
                        {m.auto && <span className="mount-auto">프로젝트</span>}
                      </span>
                      <span className="mount-item-path" title={m.path}>
                        {m.path}
                      </span>
                    </div>
                    {!m.exists && <span className="mount-warn" title="폴더를 찾을 수 없음">⚠</span>}
                    {m.auto ? (
                      <span className="mount-lock" title="관리자 프로젝트 설정에서 자동 등록됨">
                        자동
                      </span>
                    ) : (
                      <button
                        className="mount-del"
                        title="등록 해제"
                        onClick={() => remove(m.name)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="settings-section">
            <h4>깨진 소스 관리</h4>
            <div className="mount-form-row">
              <button className="settings-action" onClick={relink} disabled={relinking}>
                {relinking ? "찾는 중…" : "깨진 파일 다시 연결"}
              </button>
              <button className="settings-action" onClick={prune} disabled={pruning}>
                {pruning ? "정리 중…" : "파일 없는 소스 해제"}
              </button>
            </div>
            <p className="settings-hint">
              폴더가 바뀌었으면 <b>다시 연결</b>로 내용이 같은 파일을 찾아 잇습니다. 그래도 못 찾는
              (원본을 지운) 소스는 <b>해제</b>로 정리합니다. 파일이 있는 소스는 건드리지 않습니다.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

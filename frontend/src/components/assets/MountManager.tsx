// 외부 폴더 등록(마운트) 관리 — Assets 좌상단 타이틀 클릭으로 열리는 플로팅 창.
//  · 폴더 탭: 등록할 폴더 경로 + 이름 → 등록하면 아래 목록에 추가
//  · 깨진 소스 탭: 평소 안 쓰는 정리 작업이라 등록과 나눈다(Jay 2026-11-02 C안)
//  · 등록된 이름은 프로젝트 드롭다운에 그대로 뜬다(계정별 목록 — 다른 팀원에게는 안 보인다)
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useModalFocus } from "../../lib/keyGate";
import { urlSegmentProblem } from "../../lib/nameGuard";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { AssetMount } from "../../types";
import { CloseIcon } from "../common/ViewIcons";
import { FolderIcon } from "../FolderIcon";

export function MountManager({
  onClose,
  onChanged,
  workspaceId,
}: {
  onClose: () => void;
  onChanged: () => void; // 등록/삭제 후 프로젝트 목록 새로고침
  workspaceId?: string; // 프로젝트 유래(auto) 항목을 선택 팀으로 좁힌다(수동 등록은 항상 표시)
}) {
  const [tab, setTab] = useState<"folders" | "sources">("folders");
  const [mounts, setMounts] = useState<AssetMount[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [relinking, setRelinking] = useState(false);
  const [err, setErr] = useState("");

  // 가장 나중에 보낸 조회의 응답만 받는다 — 팀을 잇달아 바꾸면 늦게 온 앞 팀의 목록이 지금 팀의 목록을 덮었다(조작 규칙 40)
  const reloadSeqRef = useRef(0);
  const reload = () => {
    const seq = ++reloadSeqRef.current;
    return api.assetMounts(workspaceId).then((r) => { if (seq === reloadSeqRef.current) setMounts(r.mounts); }).catch(() => {});
  };

  // 등록·해제가 끝나면 받은 목록을 그대로 넣지 않고 **지금의 팀으로 다시 묻는다** — 등록·해제의 응답은 팀으로 좁히지 않은 전체라,
  //  그대로 넣으면 다른 팀의 프로젝트 폴더(자동)까지 이 팀의 목록에 나타났다(Codex 코드 리뷰 — 백엔드 `add_mount`·`del_mount`).
  //  끝난 뒤에 부르는 것은 '지금의' reload·onChanged 다: 기다리는 사이 팀이 바뀌었으면 옛 팀의 조회를 새로 시작하지 않는다.
  const latestRef = useRef({ reload, onChanged });
  latestRef.current = { reload, onChanged };
  const afterChange = () => {
    void latestRef.current.reload();
    latestRef.current.onChanged();
  };

  useEffect(() => {
    reload();
  }, [workspaceId]);
  useEscapeClose(onClose);
  const floatRef = useRef<HTMLDivElement>(null);
  useModalFocus(floatRef); // 막(바깥 클릭 캐처)이 있는 창 — Tab 이 창 안에서 돈다. 처음 초점은 경로 칸(autoFocus) 그대로

  const addingRef = useRef(false); // busy 상태는 다음 렌더에야 보인다 — 같은 순간의 연타는 이것으로 막는다
  const add = async () => {
    if (addingRef.current) return;
    const p = path.trim();
    const n = name.trim();
    if (!p || !n) {
      setErr("폴더 경로와 이름을 모두 입력하세요.");
      return;
    }
    // 해제는 이름을 주소 한 칸에 넣어 서버 라우트와 안 맞고(/ · . ..), 레퍼런스 `asset:이름|경로` 는 첫 | 에서 갈라 읽는다(조작 규칙 53 — lib/nameGuard)
    const problem = urlSegmentProblem(n) ?? (/[\\|]/.test(n) ? "이름에 \\ | 는 쓸 수 없습니다" : null);
    if (problem) {
      setErr(`표시 ${problem} — 해제 주소·레퍼런스 표기와 충돌합니다.`);
      return;
    }
    addingRef.current = true;
    setBusy(true);
    setErr("");
    try {
      await api.addAssetMount(n, p);
      setPath("");
      setName("");
      afterChange();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      addingRef.current = false;
      setBusy(false);
    }
  };

  const relink = async () => {
    setRelinking(true);
    setErr("");
    try {
      const r = await api.relinkBrokenSources();
      latestRef.current.onChanged();
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
      latestRef.current.onChanged();
      const relinkedMsg = r.relinked > 0 ? ` (재연결 ${r.relinked}개는 유지)` : "";
      window.alert(`정리 완료: 깨진 소스 ${r.pruned}개의 지정을 해제했습니다.${relinkedMsg}`);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setPruning(false);
    }
  };

  const remove = async (mn: string) => {
    if (!window.confirm(`"${mn}" 등록을 해제할까요? (원본 폴더는 그대로입니다)`)) return;
    setErr(""); // 다시 해서 되면 앞서 실패한 글이 남지 않게(60회차 — 정리·다시 잇기와 같게)
    try {
      await api.delAssetMount(mn);
      afterChange();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div ref={floatRef} className="manage-float mount-float" role="dialog" aria-label="어셋 폴더 등록">
        <header className="admin-head">
          <span className="admin-title"><FolderIcon width={18} height={15} /> 어셋 폴더 등록</span>
          <button className="assets-x" onClick={onClose} title="닫기">
            <CloseIcon />
          </button>
        </header>

        <div className="mount-tabs">
          <span className="lib-cut-seg" role="group" aria-label="어셋 폴더 등록 보기">
            <button type="button" className={tab === "folders" ? "on" : ""} aria-pressed={tab === "folders"} onClick={() => setTab("folders")}>
              어셋 등록 {mounts.length}
            </button>
            <button type="button" className={tab === "sources" ? "on" : ""} aria-pressed={tab === "sources"} onClick={() => setTab("sources")}>
              깨진 소스
            </button>
          </span>
        </div>

        {tab === "folders" ? (
          <div className="admin-body mount-body">
            <section className="settings-section">
              <div className="mount-form">
                <input
                  className="mount-input"
                  placeholder="폴더 경로 (예: D:\작업\내폴더)"
                  value={path}
                  // 등록 중에는 칸을 잠근다(조작 규칙 43) — 끝나면 두 칸을 비우는데, 그사이 다음 폴더를 치고 있었으면 그 글까지 지워졌다
                  readOnly={busy}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  autoFocus
                />
                <div className="mount-form-row">
                  <input
                    className="mount-input mount-name"
                    placeholder="표시 이름"
                    value={name}
                    readOnly={busy}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                  <button className="settings-action" onClick={add} disabled={busy}>
                    {busy ? "등록 중" : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                        등록
                      </>
                    )}
                  </button>
                </div>
              </div>
              {err && <p className="manage-msg err">{err}</p>}
              <p className="settings-hint">내 프로젝트 목록에 이 이름으로 추가됩니다. 원본 폴더는 건드리지 않습니다.</p>
            </section>

            <section className="settings-section">
              {mounts.length === 0 ? (
                <p className="settings-hint">아직 등록된 폴더가 없습니다.</p>
              ) : (
                <ul className="mount-list">
                  {mounts.map((m) => (
                    <li key={m.name} className={"mount-item" + (m.exists === false ? " missing" : "")}>
                      <FolderIcon width={16} height={13} tone={m.exists === false ? "red" : m.auto ? "green" : "blue"} />
                      <div className="mount-item-main">
                        <span className="mount-item-name">
                          {m.name}
                          {m.auto && <span className="mount-auto" title="관리자 프로젝트 설정에서 자동 등록됨">프로젝트</span>}
                        </span>
                        <span className="mount-item-path" title={m.path}>
                          {m.exists === false ? `폴더를 찾을 수 없음 · ${m.path}` : m.path}
                        </span>
                      </div>
                      {!m.auto && (
                        <button className="mount-del" title="등록 해제" onClick={() => remove(m.name)}>
                          <CloseIcon size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <div className="admin-body">
            <div className="mount-act">
              <div className="mount-act-main">
                <div className="mount-act-title">폴더가 바뀌었을 때</div>
                <div className="mount-act-desc">내용이 같은 파일을 찾아 소스를 다시 잇습니다.</div>
              </div>
              <button className="mount-act-btn" onClick={relink} disabled={relinking}>
                {relinking ? "찾는 중" : "다시 연결"}
              </button>
            </div>
            <div className="mount-act">
              <div className="mount-act-main">
                <div className="mount-act-title">원본을 지웠을 때</div>
                <div className="mount-act-desc">못 찾는 소스의 지정을 풉니다. 파일이 있는 소스는 그대로입니다.</div>
              </div>
              <button className="mount-act-btn danger" onClick={prune} disabled={pruning}>
                {pruning ? "정리 중" : "소스 해제"}
              </button>
            </div>
            {err && <p className="manage-msg err">{err}</p>}
          </div>
        )}
      </div>
    </>
  );
}

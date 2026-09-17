import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useLibraryCreators } from "../../lib/useLibraryCreators";
import type { LibraryWorkspaceFilter } from "../../lib/libraryWorkspaceScope";

export function CreatorSection({
  activeUid,
  onFilter,
  tab,
  projectId,
  workspaceFilter,
  folderPath,
  ready = true,
  contextKey,
  deletedOnly = false,
}: {
  activeUid?: string;
  onFilter: (uid?: string) => void;
  onChanged?: () => void;
  tab: "my" | "team";
  projectId?: string;
  workspaceFilter?: LibraryWorkspaceFilter;
  folderPath?: string;
  ready?: boolean;
  contextKey?: string;
  deletedOnly?: boolean;
}) {
  const tr = useT();
  const { creators, loading, error, reload } = useLibraryCreators({ tab, projectId, workspaceFilter, folderPath,
    ready: ready && !deletedOnly, contextKey });
  // 공유 해제·이동으로 선택한 생성자의 마지막 카드가 사라져도 빈 필터에 갇히지 않는다.
  useEffect(() => {
    if (!deletedOnly && ready && !loading && !error && activeUid &&
        !creators.some((creator) => creator.uid === activeUid)) onFilter(undefined);
  }, [deletedOnly, ready, loading, error, activeUid, creators, onFilter]);
  if (!ready) return null;
  // 이 집계는 일반 공유물 기준이다. 휴지통에 적용해 선택을 자동 해제하거나 건수를 오인시키지 않는다.
  if (deletedOnly) return activeUid ? <section>
    <h4>{tr("생성자")}</h4>
    <button className="creator-pick" onClick={() => onFilter(undefined)}>{tr("생성자 필터 해제")}</button>
  </section> : null;
  if (!creators.length && !loading && !error) return null;
  return (
    <section aria-busy={loading}>
      <h4>{tr("생성자")}</h4>
      {loading && !creators.length && <div className="creator-status" role="status">{tr("불러오는 중…")}</div>}
      {error && <div role="status">
        {error === "update" && <p className="creator-status">{tr(tab === "my"
          ? "작업 공간 생성자 표시에는 로컬 앱 업데이트가 필요합니다."
          : "워크스페이스별 생성자 표시에는 공유 서버 업데이트가 필요합니다.")}</p>}
        <button className="creator-pick" onClick={() => void reload()}>{tr("목록을 못 받았습니다 — 다시 시도")}</button>
      </div>}
      {creators.map((creator) => (
        <div key={creator.uid} className={"creator-row" + (activeUid === creator.uid ? " on" : "")}>
          <button
            className="creator-pick"
            onClick={() => onFilter(activeUid === creator.uid ? undefined : creator.uid)}
            title={creator.uid}
          >
            <span
              className="creator-dot"
              style={{ background: creator.is_mine ? "var(--accent)" : "#4ade80" }}
            />
            <span className="creator-name">{creator.name || (creator.is_mine ? "나" : "팀원")}</span>
            <span className="creator-count">{creator.count}</span>
          </button>
        </div>
      ))}
    </section>
  );
}

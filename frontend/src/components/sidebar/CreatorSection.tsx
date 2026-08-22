import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import type { Creator } from "../../types";

export function CreatorSection({
  activeUid,
  onFilter,
  tab,
  projectId,
}: {
  activeUid?: string;
  onFilter: (uid?: string) => void;
  onChanged?: () => void;
  tab: "my" | "team";
  projectId?: string;
}) {
  const tr = useT();
  const [creators, setCreators] = useState<Creator[]>([]);
  // 탭·프로젝트를 빠르게 바꾸면 이전 요청이 늦게 도착해 현재 목록을 덮는다 → 취소 가드로 버린다.
  useEffect(() => {
    let alive = true;
    api
      .creators(tab, projectId)
      .then((items) => {
        if (alive)
          setCreators([...items].sort((a, b) => (a.is_mine === b.is_mine ? 0 : a.is_mine ? -1 : 1)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tab, projectId]);
  if (!creators.length) return null;
  return (
    <section>
      <h4>{tr("생성자")}</h4>
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

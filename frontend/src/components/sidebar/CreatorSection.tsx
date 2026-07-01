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
  const load = () =>
    api
      .creators(tab, projectId)
      .then((items) =>
        setCreators([...items].sort((a, b) => (a.is_mine === b.is_mine ? 0 : a.is_mine ? -1 : 1))),
      )
      .catch(() => {});
  useEffect(() => {
    load();
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

import type { ReactNode } from "react";
import { dayInfoFromEpochSeconds } from "../../lib/dateGroups";
import type { AssetNode } from "../../types";

export function AssetGridCells({
  files,
  cells,
  groupByDate,
  dateGroups,
  selected,
  onToggleDate,
}: {
  files: AssetNode[];
  cells: ReactNode[];
  groupByDate: boolean;
  dateGroups: Map<string, { label: string; idxs: number[] }>;
  selected: Set<number>;
  onToggleDate: (idxs: number[], allSelected: boolean) => void;
}) {
  if (!groupByDate) return <>{cells}</>;

  const out: ReactNode[] = [];
  let lastDay: string | null = null;
  files.forEach((file, index) => {
    const { key, label } = dayInfoFromEpochSeconds(file.mtime);
    if (key !== lastDay) {
      lastDay = key;
      const idxs = dateGroups.get(key)?.idxs ?? [];
      const allSelected = idxs.length > 0 && idxs.every((item) => selected.has(item));
      out.push(
        <label className="gen-date-header" key={"h-" + key}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => onToggleDate(idxs, allSelected)}
          />
          <span className="gen-date-label">{label}</span>
          <span className="gen-date-count">{idxs.length}</span>
        </label>,
      );
    }
    out.push(cells[index]);
  });
  return <>{out}</>;
}

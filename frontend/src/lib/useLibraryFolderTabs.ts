import { useRef } from "react";
import type { useLibraryFilters } from "./useLibraryFilters";
import { useViewTabs } from "./useViewTabs";

export function useLibraryFolderTabs({
  library, authKey, enabled, canLeave, onNavigate,
}: {
  library: ReturnType<typeof useLibraryFilters>;
  authKey: string;
  enabled: boolean;
  canLeave: () => boolean;
  onNavigate: () => void;
}) {
  const names = useRef({ authKey, values: new Map<string, string>() });
  if (names.current.authKey !== authKey) names.current = { authKey, values: new Map() };
  const read = () => ({
    projectName: names.current.values.get(library.filters.project_id || ""),
    filters: library.filters,
    typeFilter: library.typeFilter,
    colorFilter: library.colorFilter, tagFilter: library.tagFilter, filterAutoTags: library.filterAutoTags,
    sharedOnly: library.sharedOnly, reviewFilter: library.reviewFilter,
    commentOnly: library.commentOnly, finalOnly: library.finalOnly, grayOn: library.grayOn,
  });
  const apply = (view: ReturnType<typeof read>) => {
    library.setFilters(view.filters);
    library.adoptShownLocation();
    library.restoredLocationRef.current = true;
    library.setTypeFilter(view.typeFilter);
    library.setColorFilter(view.colorFilter);
    library.setTagFilter(view.tagFilter);
    library.setFilterAutoTags(view.filterAutoTags);
    library.setSharedOnly(view.sharedOnly);
    library.setReviewFilter(view.reviewFilter);
    library.setCommentOnly(view.commentOnly);
    library.setFinalOnly(view.finalOnly);
    library.setGrayOn(view.grayOn);
    onNavigate();
  };
  const keyOf = (view: ReturnType<typeof read>) => JSON.stringify([
    view.filters.project_id, view.filters.folder_path, !!view.filters.deleted_only, !!view.filters.include_deleted,
  ]);
  const options = { read, apply, keyOf, canLeave };
  const my = useViewTabs({
    ...options, scope: authKey,
    enabled: enabled && library.storedTab === "my",
  });
  const team = useViewTabs({
    ...options, scope: JSON.stringify([authKey, library.teamScopeKey]),
    enabled: enabled && library.storedTab === "team" && library.workspaceQueryReady,
  });
  const current = library.storedTab === "team" ? team : my;
  return {
    ...current,
    openFolder: (projectId: string, path: string, projectName?: string) => {
      if (projectName) names.current.values.set(projectId, projectName);
      return current.open({
      ...read(), projectName: projectName ?? names.current.values.get(projectId),
      filters: { ...library.filters, project_id: projectId, folder_path: path || undefined,
        search: undefined, deleted_only: undefined, include_deleted: undefined },
      });
    },
    resume: (tab: "my" | "team") => (tab === "my" ? my : team).resume(),
  };
}

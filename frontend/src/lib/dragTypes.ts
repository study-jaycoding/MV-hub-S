export const DRAG_TYPES = {
  generation: "application/x-ch-gen",
  asset: "application/x-ch-asset",
  trayIndex: "application/x-ch-trayidx",
  chip: "application/x-ch-chip",
  task: "application/x-task-id",
  listItem: "application/x-ch-listitem", // 리스트 노드 썸네일 순서 변경 드래그
  folder: "application/x-ch-project-folder", // 프로젝트 폴더 → 캔버스 Set 노드
} as const;

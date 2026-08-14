export const DRAG_TYPES = {
  generation: "application/x-ch-gen",
  // 복수 생성물 드래그(쉼표구분 id 목록) — 폴더 담기 드롭이 우선 읽음. generation(단일)은
  // 프롬프트 재사용 등 기존 소비처 호환용으로 항상 함께 실린다.
  generationList: "application/x-ch-genlist",
  asset: "application/x-ch-asset",
  trayIndex: "application/x-ch-trayidx",
  chip: "application/x-ch-chip",
  task: "application/x-task-id",
  listItem: "application/x-ch-listitem", // 리스트 노드 썸네일 순서 변경 드래그
  folder: "application/x-ch-project-folder", // 프로젝트 폴더 → 캔버스 Set 노드
} as const;

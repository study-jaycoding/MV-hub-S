import type { Generation } from "../types";
import { jsonBody, jsonFetch } from "./http";

export interface ResolveTransferItem {
  generation_id: string;
  folder_path: string;
  filename: string;
  media_type: string;
  local_path: string;
  status: "pending" | "downloaded" | "skipped" | "error";
  error: string | null;
}

export interface ResolveTransferResult {
  format: string;
  version: number;
  transfer_id: string;
  project_id: string;
  project_name: string;
  source_root: string;
  manifest_path: string;
  status: "pending" | "complete" | "partial" | "failed";
  total: number;
  downloaded: number;
  skipped: number;
  error_count: number;
  items: ResolveTransferItem[];
}

export type ResolveSelectionCheck =
  | { ok: true; genIds: string[] }
  | { ok: false; message: string };

/** 화면에서 먼저 설명할 수 있는 오류를 걸러 불필요한 대용량 요청을 만들지 않는다. */
export function checkResolveSelection(selected: Generation[]): ResolveSelectionCheck {
  if (!selected.length) return { ok: false, message: "Resolve로 보낼 결과물을 선택하세요." };
  if (selected.length > 500) {
    return { ok: false, message: "Resolve 전송은 한 번에 최대 500개까지 가능합니다." };
  }
  if (selected.some((generation) => generation.deleted)) {
    return { ok: false, message: "휴지통 항목을 제외한 뒤 Resolve로 보내세요." };
  }
  if (selected.some((generation) => generation.status !== "done")) {
    return { ok: false, message: "렌더가 완료된 결과물만 Resolve로 보낼 수 있습니다." };
  }
  if (selected.some((generation) => !generation.project_id)) {
    return { ok: false, message: "먼저 선택한 결과물을 프로젝트에 배정하세요." };
  }
  if (selected.some((generation) => !generation.folder_path)) {
    return { ok: false, message: "렌더 폴더 위치가 지정된 결과물만 전송할 수 있습니다." };
  }
  if (selected.some((generation) => !generation.assets.length)) {
    return { ok: false, message: "원본 파일이 없는 결과물이 포함되어 있습니다." };
  }
  const projectIds = new Set(selected.map((generation) => generation.project_id));
  if (projectIds.size !== 1) {
    return { ok: false, message: "Resolve 전송은 같은 프로젝트끼리 선택해야 합니다." };
  }
  return {
    ok: true,
    genIds: [...new Set(selected.map((generation) => generation.id))],
  };
}

export function resolveTransferSummary(result: ResolveTransferResult): string {
  const completed = result.downloaded + result.skipped;
  if (result.error_count) {
    const firstError = result.items.find((item) => item.status === "error")?.error;
    return [
      `Resolve 전송 ${completed}개 완료 · ${result.error_count}개 실패`,
      firstError ? `(${firstError})` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (!result.downloaded && result.skipped) {
    return `선택한 ${result.skipped}개는 이미 ResolveSource에 있습니다.`;
  }
  const skipped = result.skipped ? ` · 기존 ${result.skipped}개` : "";
  return `Resolve 원본 ${result.downloaded}개 저장${skipped} · ${result.source_root}`;
}

export function createResolveTransfer(genIds: string[]): Promise<ResolveTransferResult> {
  return jsonFetch<ResolveTransferResult>("/api/resolve/transfers", {
    method: "POST",
    body: jsonBody({ gen_ids: genIds }),
  });
}

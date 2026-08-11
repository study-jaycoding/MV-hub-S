import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import {
  checkResolveSelection,
  createResolveTransfer,
  resolveTransferSummary,
  type ResolveTransferResult,
} from "../src/lib/resolveTransfer";

function generation(overrides: Partial<Generation> = {}): Generation {
  return {
    id: "g1",
    worker_id: "me",
    worker_name: null,
    prompt: "",
    display_prompt: null,
    model: null,
    params: null,
    color: null,
    status: "done",
    created_at: "2026-08-11 00:00:00",
    assets: [
      {
        id: "a1",
        generation_id: "g1",
        type: "video",
        file_path: "https://cdn.example/a.mp4",
        thumbnail_path: null,
        source_url: null,
        cached: false,
      },
    ],
    references: [],
    tags: [],
    auto_tags: [],
    shared: false,
    parent_gen_id: null,
    is_source: false,
    source_name: null,
    comment: null,
    error: null,
    comment_count: 0,
    has_unread: false,
    local_only: false,
    creator_uid: "u1",
    creator_name: "User",
    is_mine: true,
    workspace_scope: "team",
    workspace_id: "w1",
    workspace_name: "Team",
    project_id: "p1",
    project_name: "P1",
    folder_path: "ep001/c0010",
    deleted: false,
    ...overrides,
  };
}

function result(overrides: Partial<ResolveTransferResult> = {}): ResolveTransferResult {
  return {
    format: "mvhub.resolve-transfer",
    version: 1,
    transfer_id: "t1",
    project_id: "p1",
    project_name: "P1",
    source_root: "D:\\Project\\ResolveSource",
    manifest_path: "D:\\Project\\ResolveSource\\.mvhub\\transfers\\t1.json",
    status: "complete",
    total: 1,
    downloaded: 1,
    skipped: 0,
    error_count: 0,
    items: [],
    resolve_import: {
      status: "complete",
      project_name: "편집 프로젝트",
      target_root: "MV Hub/P1",
      total: 1,
      imported: 1,
      skipped: 0,
      error_count: 0,
      error: null,
      items: [],
    },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Resolve 선택 검증", () => {
  it("같은 프로젝트 완료본은 중복 ID를 제거해 통과시킨다", () => {
    const item = generation();
    expect(checkResolveSelection([item, item])).toEqual({ ok: true, genIds: ["g1"] });
  });

  it("다른 프로젝트가 섞이면 전송 전에 설명한다", () => {
    const checked = checkResolveSelection([
      generation(),
      generation({ id: "g2", project_id: "p2" }),
    ]);
    expect(checked).toEqual({
      ok: false,
      message: "Resolve 전송은 같은 프로젝트끼리 선택해야 합니다.",
    });
  });

  it("진행 중이거나 폴더가 없는 결과물을 거부한다", () => {
    expect(checkResolveSelection([generation({ status: "running" })])).toMatchObject({
      ok: false,
      message: expect.stringContaining("완료"),
    });
    expect(checkResolveSelection([generation({ folder_path: null })])).toMatchObject({
      ok: false,
      message: expect.stringContaining("폴더"),
    });
  });
});

describe("Resolve 전송 API와 결과 안내", () => {
  it("선택 ID를 로컬 전송 API 한 번으로 보낸다", async () => {
    const response = result({ downloaded: 2, total: 2 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(response),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createResolveTransfer(["g1", "g2"])).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resolve/transfers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gen_ids: ["g1", "g2"] }),
      }),
    );
  });

  it("완료·기존·실패 수를 숨기지 않고 알려준다", () => {
    expect(
      resolveTransferSummary(
        result({
          downloaded: 2,
          skipped: 1,
          resolve_import: {
            ...result().resolve_import,
            total: 3,
            imported: 2,
            skipped: 1,
          },
        }),
      ),
    ).toContain("2개 가져오기 완료 · 기존 1개");
    expect(
      resolveTransferSummary(
        result({
          status: "partial",
          downloaded: 1,
          error_count: 1,
          items: [
            {
              generation_id: "g2",
              folder_path: "ep001/c0020",
              filename: "c0020.mp4",
              media_type: "video",
              local_path: "",
              status: "error",
              error: "원본 다운로드 실패",
            },
          ],
        }),
      ),
    ).toContain("1개 완료 · 1개 실패 (원본 다운로드 실패)");
  });

  it("Resolve가 꺼져 있으면 원본 준비와 연결 실패를 구분해 알려준다", () => {
    expect(
      resolveTransferSummary(
        result({
          resolve_import: {
            ...result().resolve_import,
            status: "unavailable",
            imported: 0,
            error: "DaVinci Resolve가 실행 중이지 않습니다",
          },
        }),
      ),
    ).toContain("원본 1개 준비 완료 · DaVinci Resolve가 실행 중이지 않습니다");
  });

  it("가져온 뒤 프로젝트 저장 확인 실패도 성공으로 숨기지 않는다", () => {
    expect(
      resolveTransferSummary(
        result({
          resolve_import: {
            ...result().resolve_import,
            status: "partial",
            error: "Resolve 프로젝트 저장을 확인하지 못했습니다",
          },
        }),
      ),
    ).toContain("Resolve 프로젝트 저장을 확인하지 못했습니다");
  });
});

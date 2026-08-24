import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import {
  cancelResolveQueueTransfer,
  checkResolveSelection,
  createResolveTransfer,
  getResolveConnectionStatus,
  getResolveEnvironmentDiagnostics,
  getResolveQueue,
  getResolveScriptStatus,
  installResolveScript,
  resolveQueueActions,
  resolveQueueDetail,
  resolveQueueStateLabel,
  resumeResolveQueueTransfer,
  retryResolveTransfer,
  resolveTransferAcceptedSummary,
  resolveTransferSummary,
  summarizeResolveQueue,
  type ResolveQueueRow,
  type ResolveQueueState,
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
    version: 2,
    transfer_id: "t1",
    project_id: "p1",
    project_name: "P1",
    source_root: "D:\\Project\\render",
    manifest_root: "D:\\Project\\@davinci",
    manifest_path: "D:\\Project\\@davinci\\.mvhub\\transfers\\t1.json",
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
        body: JSON.stringify({
          gen_ids: ["g1", "g2"],
          resolve_project_id: "",
          resolve_project_name: "",
        }),
      }),
    );
  });

  it("확인한 Resolve 프로젝트 ID와 이름을 전송 요청에 고정한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(result()),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createResolveTransfer(["g1"], {
      project_id: "resolve-project-1",
      project_name: "편집 프로젝트",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resolve/transfers",
      expect.objectContaining({
        body: JSON.stringify({
          gen_ids: ["g1"],
          resolve_project_id: "resolve-project-1",
          resolve_project_name: "편집 프로젝트",
        }),
      }),
    );
  });

  it("연결 상태 확인과 준비된 원본 재가져오기는 전용 로컬 API를 사용한다", async () => {
    const status = {
      status: "ready",
      connected: true,
      process_running: true,
      project_open: true,
      project_id: "resolve-project-1",
      project_name: "편집 프로젝트",
      message: "DaVinci Resolve 연결됨 · 편집 프로젝트",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(status) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(result()) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResolveConnectionStatus()).resolves.toEqual(status);
    await expect(retryResolveTransfer("p1", "t1")).resolves.toEqual(result());
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/resolve/status",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/resolve/transfers/retry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ project_id: "p1", transfer_id: "t1" }),
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

function queueRow(overrides: Partial<ResolveQueueRow> = {}): ResolveQueueRow {
  return {
    transfer_id: "t1",
    project_id: "p1",
    project_name: "EP01",
    resolve_target: { project_id: "resolve-1", project_name: "EP01_EDIT" },
    state: "queued",
    dispatch_policy: "auto",
    created_at: "2026-08-23T10:00:00Z",
    state_changed_at: "2026-08-23T10:00:00Z",
    total: 3,
    downloaded: 0,
    skipped: 0,
    error_count: 0,
    ahead: 0,
    blocked: null,
    recovery: null,
    cancel: null,
    warning: null,
    error_code: null,
    error: null,
    ...overrides,
  };
}

describe("Resolve 큐 배지와 안내", () => {
  it("완료·폐기는 빼고 대기·진행·확인 필요를 나눠 센다", () => {
    const summary = summarizeResolveQueue([
      queueRow({ state: "queued" }),
      queueRow({ state: "preparing" }),
      queueRow({ state: "blocked" }),
      queueRow({ state: "interrupted" }),
      queueRow({ state: "complete" }),
      queueRow({ state: "cancelled" }),
    ]);
    expect(summary).toEqual({
      waiting: 1,
      running: 1,
      blocked: 1,
      failed: 1,
      attention: 2,
      active: 4,
    });
  });

  it("보류는 원인과 다음 행동을 함께 알려준다", () => {
    const text = resolveQueueDetail(
      queueRow({
        state: "blocked",
        blocked: {
          code: "project_changed",
          expected_project_name: "EP01_EDIT",
          observed_project_name: "OTHER",
        },
      }),
    );
    expect(text).toContain("예정 EP01_EDIT");
    expect(text).toContain("현재 OTHER");
    expect(text).toContain("열면 자동으로 이어집니다");

    expect(resolveQueueDetail(queueRow({ state: "blocked", blocked: { code: "not_running" } })))
      .toContain("Resolve를 실행하면");
    expect(
      resolveQueueDetail(
        queueRow({ state: "blocked", blocked: { code: "account_scope_changed" } }),
      ),
    ).toContain("원래 계정");
  });

  it("중단·복구 안내는 누락 수와 백업 경로를 감추지 않는다", () => {
    expect(
      resolveQueueDetail(
        queueRow({
          state: "interrupted",
          recovery: { reason: "interrupted_import_missing_items", missing_count: 2 },
        }),
      ),
    ).toContain("누락 2개");

    const recovery = resolveQueueDetail(
      queueRow({
        state: "recovery_required",
        recovery: {
          reason: "orphan_rebuild_bin",
          staging_bin: "__MVHUB_REBUILD_ab12__",
          drp_path: "D:\\EP01\\backup.drp",
        },
      }),
    );
    expect(recovery).toContain("__MVHUB_REBUILD_ab12__");
    expect(recovery).toContain("backup.drp");
  });

  it("오래 걸리는 가져오기는 Resolve 창 확인을 안내한다", () => {
    expect(
      resolveQueueDetail(
        queueRow({
          state: "importing",
          warning: {
            code: "import_slow",
            elapsed_seconds: 420,
            message: "Resolve 창에 확인을 기다리는 대화상자가 떠 있는지 보세요",
          },
        }),
      ),
    ).toContain("대화상자");
  });

  it("가져오기 중 취소는 2차 확인이 필요하고, 상태별 재시도 문구가 다르다", () => {
    expect(resolveQueueActions(queueRow({ state: "importing" }))).toMatchObject({
      canCancel: true,
      needsForce: true,
    });
    expect(resolveQueueActions(queueRow({ state: "queued" }))).toMatchObject({
      canCancel: true,
      needsForce: false,
      canResume: false,
    });
    expect(resolveQueueActions(queueRow({ state: "interrupted" })).resumeLabel).toBe(
      "누락분 다시 가져오기",
    );
    expect(resolveQueueActions(queueRow({ state: "recovery_required" })).resumeLabel).toBe(
      "Bin 확인함 · 다시 검사",
    );
    // 끝난 전송은 손댈 게 없다.
    for (const state of ["complete", "cancelled"] as ResolveQueueState[]) {
      expect(resolveQueueActions(queueRow({ state }))).toMatchObject({
        canCancel: false,
        canResume: false,
      });
    }
  });

  it("모든 상태에 사람이 읽을 이름이 있다", () => {
    const states: ResolveQueueState[] = [
      "queued",
      "preparing",
      "ready",
      "blocked",
      "importing",
      "complete",
      "failed",
      "interrupted",
      "recovery_required",
      "cancelled",
    ];
    for (const state of states) {
      expect(resolveQueueStateLabel(state)).not.toBe(state);
    }
  });

  it("이미 접수된 요청은 새로 접수했다고 말하지 않는다", () => {
    const accepted = {
      transfer_id: "t1",
      project_id: "p1",
      project_name: "EP01",
      queued: true,
      duplicate: true,
      ahead: 0,
      queue: { state: "queued", dispatch_policy: "auto" },
      resolve_target: { project_id: "", project_name: "" },
      status: "pending",
      total: 3,
      worker_enabled: true,
    };
    expect(resolveTransferAcceptedSummary(accepted)).toContain("이미 대기열에 있습니다");
  });

  it("큐 조회·취소·재시도는 전용 로컬 API를 쓴다", async () => {
    const snapshot = { items: [queueRow()], worker_enabled: true };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(snapshot) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResolveQueue()).resolves.toEqual(snapshot);
    await cancelResolveQueueTransfer("t 1", true);
    await resumeResolveQueueTransfer("t 1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/resolve/queue",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/resolve/queue/t%201/cancel",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ force: true }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/resolve/queue/t%201/resume",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("Resolve 스크립트 설치 API", () => {
  it("설치 상태와 설치 요청은 로컬 Resolve API를 사용한다", async () => {
    const status = {
      installed: true,
      up_to_date: true,
      bundled_version: "0.6.1",
      installed_version: "0.6.1",
      path: "C:\\Resolve\\MVHub Clip Exporter.py",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(status) })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...status, changed: false, previous_version: "0.6.1" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResolveScriptStatus()).resolves.toEqual(status);
    await expect(installResolveScript()).resolves.toMatchObject({ changed: false });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/resolve/script",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/resolve/script/install",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("환경 진단은 설치와 연결 결과를 한 번에 가져온다", async () => {
    const diagnostics = {
      status: "menu_ready",
      summary: "Resolve 메뉴 스크립트는 사용할 수 있습니다.",
      checks: [],
      recommendations: [],
      script: {
        installed: true,
        up_to_date: true,
        bundled_version: "0.6.1",
        installed_version: "0.6.1",
        path: "C:\\Resolve\\MVHub Clip Exporter.py",
      },
      connection: {
        status: "not_running",
        connected: false,
        process_running: false,
        project_open: false,
        project_id: "",
        project_name: "",
        message: "Resolve가 실행 중이지 않습니다",
      },
      environment: {
        windows_user: "worker",
        mvhub_python: { version: "3.14.0", bits: 64, path: "python.exe" },
        system_pythons: [],
        resolve_installations: [],
        api: {
          module_candidates: [],
          existing_module_paths: [],
          library_candidates: [],
          library_path: "",
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(diagnostics),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResolveEnvironmentDiagnostics()).resolves.toEqual(diagnostics);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resolve/diagnostics",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});

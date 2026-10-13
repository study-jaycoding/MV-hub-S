import { afterEach, describe, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import {
  checkResolveSelection,
  createResolveTimeline,
  createResolveTransfer,
  getResolveConnectionStatus,
  getResolveEnvironmentDiagnostics,
  getResolveScriptStatus,
  installResolveScript,
  retryResolveTransfer,
  resolveTimelineSummary,
  resolveTransferSummary,
  type ResolveTimelineBuild,
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

// 타임라인 Resolve 보내기(편집 탭) — 원본 전송 요청에 계획(timeline)이 붙는다. 결과 한 줄은 '만들었다'로 끝내지 않는다.
describe("타임라인 Resolve 보내기", () => {
  const built = (overrides: Partial<ResolveTimelineBuild> = {}): ResolveTimelineBuild => ({
    status: "complete", timeline_name: "P1_e070", timeline_id: "tl-1", step: "done", video: 3, audio: 2,
    markers_added: 0, markers_skipped: 0, mark: false, saved: true, mismatches: [], short_sources: [], warnings: [],
    error: null, error_code: null, ...overrides,
  });

  it("계획을 받는 Resolve 프로젝트와 함께 전용 로컬 API 로 보낸다", async () => {
    const answer = { transfer: result(), timeline: built() };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(answer) });
    vi.stubGlobal("fetch", fetchMock);
    const plan = { format: "mvhub.edit-timeline", version: 1, name: "P1_e070" };

    await expect(createResolveTimeline(["g1"], { project_id: "rp", project_name: "편집" }, plan)).resolves.toEqual(answer);
    expect(fetchMock).toHaveBeenCalledWith("/api/resolve/timelines", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ gen_ids: ["g1"], resolve_project_id: "rp", resolve_project_name: "편집", timeline: plan }),
    }));
  });

  it("결과 한 줄 — 계획대로 · 만들었지만 다르다 · 만들지 못했다를 구분한다", () => {
    expect(resolveTimelineSummary({ transfer: result(), timeline: built({ markers_added: 2 }) }))
      .toBe("Resolve 에 타임라인 'P1_e070' 을 만들었습니다 · 클립 3 · 북마크 2");
    const moved = built({ status: "partial", mismatches: [{ track: "V1", gen_id: "g1", start: 0, expected: 120, actual: 96 }] });
    expect(resolveTimelineSummary({ transfer: result(), timeline: moved }))
      .toBe("Resolve 에 타임라인 'P1_e070' 을 만들었지만 확인이 필요합니다 · 자리가 다른 클립 1개");
    const stopped = built({ status: "partial", step: "audio", error: "소리 클립을 넣지 못했습니다" }); // 만들다 멈췄다 — 타임라인은 남아 있다
    expect(resolveTimelineSummary({ transfer: result(), timeline: stopped })).toContain("확인이 필요합니다 · 소리 클립을 넣지 못했습니다");
    const none = built({ status: "unavailable", timeline_name: "", timeline_id: "", error: "DaVinci Resolve가 실행 중이지 않습니다" });
    expect(resolveTimelineSummary({ transfer: result({ error_count: 1 }), timeline: none }))
      .toBe("타임라인을 만들지 못했습니다 · DaVinci Resolve가 실행 중이지 않습니다 · 원본 준비 실패 1개");
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

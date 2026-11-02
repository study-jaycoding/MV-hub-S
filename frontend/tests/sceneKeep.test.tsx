import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccountNamespace } from "../src/lib/accountScope";
import { HttpError, jsonFetch } from "../src/lib/http";
import { confirmSceneWrite, exportSceneText, parseSceneImport, type Scene, type SceneSnapshot } from "../src/lib/scenes";
import { importCanvasSnapshot } from "../src/features/canvas/session";
import {
  applySceneKeepRestore, buildSceneKeepPreview, captureSceneKeep, defaultSceneKeepProject,
  openSceneKeep, sceneKeepApi,
} from "../src/lib/sceneKeep";
import type { Project } from "../src/types";

vi.mock("../src/lib/accountScope", () => ({ getAccountNamespace: vi.fn(() => "acct:a@example.test") }));
vi.mock("../src/lib/http", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/http")>(), jsonFetch: vi.fn(),
}));
vi.mock("../src/lib/scenes", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/scenes")>(),
  confirmSceneWrite: vi.fn((action: () => unknown) => ({ value: action(), confirmed: Promise.resolve(true), settled: Promise.resolve(true) })),
}));

const scope = "acct:a@example.test";
const scene = (): Scene => ({
  id: "scene-one", name: "원래 이름", created_at: 1,
  workspace: { id: "space-a", name: "공간" },
  camera: { x: 0, y: 0, z: 1 },
  cards: [{ id: "card-one", kind: "generation", x: -50, y: 30, genId: "alias-one", genIds: ["alias-one"],
    pendingGenerationAttempts: [{ attemptId: "attempt", generationId: "alias-one", createdAt: 1 }] }], edges: [],
});
const snapshot = (): SceneSnapshot => parseSceneImport(captureSceneKeep(scene(), "사본").scene_text);
const detail = () => ({ scene_text: captureSceneKeep(scene(), "사본").scene_text, revision: 7, workspace: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAccountNamespace).mockReturnValue(scope);
  vi.mocked(jsonFetch).mockReset();
  vi.mocked(confirmSceneWrite).mockImplementation(action => ({ value: action(), confirmed: Promise.resolve(true), settled: Promise.resolve(true) }));
});

describe("보관 사본", () => {
  it("설명은 캡처에 넣지 않고 Dialog에서 보완한 공백과 줄바꿈을 API로 그대로 보낸다", async () => {
    const captured = captureSceneKeep(scene(), "사본");
    expect(captured).not.toHaveProperty("description");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ status: "saved", id: "a", revision: 1, missing_count: 0 });
    const description = "  Cafe\u0301\n둘째 줄  ";
    await sceneKeepApi.save(scope, { ...captured, project_id: "p", project_name: "프로젝트", description });
    const sent = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0][1]?.body));
    expect(sent.description).toBe(description);
    expect(sent.scene_text).toBe(captured.scene_text);
  });
  it("Comfy 실행 상태만 빼고 설정·결과와 파일 Export는 보존한다", () => {
    const original = scene();
    const cfg = { name: "workflow", content: "{}", paramValues: { seed: 10 }, paramExposed: ["seed"],
      status: "running" as const, runId: 31, error: "old failure", outputs: [{ kind: "text" as const, text: "result" }] };
    original.cards[0].comfyCfg = cfg;
    const kept = JSON.parse(captureSceneKeep(original, "사본").scene_text).scene.cards[0].comfyCfg;
    expect(kept).toEqual({ name: cfg.name, content: cfg.content, paramValues: cfg.paramValues,
      paramExposed: cfg.paramExposed, outputs: cfg.outputs });
    expect(JSON.parse(exportSceneText(original)).scene.cards[0].comfyCfg).toEqual(cfg);
    expect(original.cards[0].comfyCfg).toEqual(cfg);
  });
  it("제출 이름·카메라를 고정하고 실행 표식을 없애지만 파일 내보내기와 원본은 바꾸지 않는다", () => {
    const original = scene();
    const before = JSON.stringify(original);
    const camera = { x: 11, y: 22, z: 2 };
    const captured = captureSceneKeep(original, "  새 이름  ", camera);
    const parsed = JSON.parse(captured.scene_text);
    expect(parsed.savedAt).toBe(0);
    expect(parsed.name).toBe("새 이름");
    expect(parsed.scene.name).toBe("새 이름");
    expect(parsed.scene.camera).toEqual(camera);
    expect(parsed.scene.cards[0].pendingGenerationAttempts).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.parse(exportSceneText(original)).scene.cards[0].pendingGenerationAttempts).toHaveLength(1);
    camera.x = 900;
    original.cards[0].prompt = "나중 편집";
    expect(JSON.parse(captured.scene_text).scene.cards[0].prompt).toBeUndefined();
    expect(JSON.parse(captured.scene_text).scene.camera.x).toBe(11);
  });

  it("같은 사본을 반복해서 캡처해도 시간에 의한 차이가 없다", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(900);
    expect(captureSceneKeep(scene(), "같음")).toEqual(captureSceneKeep(scene(), "같음"));
    vi.restoreAllMocks();
    expect(() => captureSceneKeep(scene(), " ")).toThrow();
    expect(() => captureSceneKeep(scene(), "가".repeat(121))).toThrow();
  });

  it("탭 공간의 보관하지 않은 프로젝트만 고르고 현재 선택을 우선한다", () => {
    const projects = [
      { id: "archived", workspace_id: "space-a", archived: true },
      { id: "other", workspace_id: "space-b", archived: false },
      { id: "first", workspace_id: "space-a", archived: false },
      { id: "chosen", workspace_id: "space-a", archived: false },
    ] as Project[];
    expect(defaultSceneKeepProject(scene(), projects, "chosen")?.id).toBe("chosen");
    expect(defaultSceneKeepProject(scene(), projects, "other")?.id).toBe("first");
    expect(defaultSceneKeepProject({}, projects)).toBeNull();
  });

  it("빈 씬·음수 좌표를 처리하고 미리보기 두 상한을 지킨다", () => {
    expect(buildSceneKeepPreview([])).toEqual([]);
    const cards = Array.from({ length: 250 }, (_, i) => ({ ...scene().cards[0], x: -500 + i * 7, y: -300, w: 0, h: 90 }));
    const preview = buildSceneKeepPreview(cards);
    expect(preview).toHaveLength(200);
    expect(new TextEncoder().encode(JSON.stringify(preview)).length).toBeLessThanOrEqual(8192);
    expect(preview.flatMap(item => item.slice(1)).every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)).toBe(true);
    expect(buildSceneKeepPreview([{ ...cards[0], x: 1e308, y: -1e308, w: 1e308 }])[0].slice(1).every(Number.isFinite)).toBe(true);
  });
});

describe("복원 id 대응", () => {
  it("씬의 두 별칭을 같은 실제 행으로 잇고 거절 id는 모든 칸에서 없앤다", () => {
    const input = snapshot();
    input.cards[0].genId = "rejected";
    input.cards[0].genIds = ["alias-one", "alias-two", "remote", "rejected"];
    input.cards[0].refs = [{ file_path: "https://example.test/image", type: "image", source_gen_id: "rejected" }];
    input.cards[0].comfyCfg = { outputs: [{ kind: "image", saved_generation_id: "alias-two" }, { kind: "image", saved_generation_id: "rejected" }] };
    const before = JSON.stringify(input);
    const copy = applySceneKeepRestore(input, { id_map: { "alias-one": "canonical", "alias-two": "canonical" }, rejected: ["rejected"] });
    expect(copy.cards[0].genIds).toEqual(["canonical", "remote"]);
    expect(copy.cards[0].genId).toBe("remote");
    expect(copy.cards[0].refs?.[0].source_gen_id).toBeNull();
    expect(copy.cards[0].comfyCfg?.outputs?.map(o => o.saved_generation_id)).toEqual(["canonical", undefined]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("전부 거절해도 카드를 남기며 거절이 id_map보다 우선한다", () => {
    const copy = applySceneKeepRestore(snapshot(), { id_map: { "alias-one": "wrong" }, rejected: ["alias-one"] });
    expect(copy.cards).toHaveLength(1);
    expect(copy.cards[0].genId).toBeNull();
    expect(copy.cards[0].genIds).toEqual([]);
  });
});

describe("고정 계정의 열기", () => {
  it.each([null, { id: null, name: null }])("표식 없는 상세 응답은 탭 표식 복원을 시도하지 않는다: %j", async workspace => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail(), workspace })
      .mockResolvedValueOnce({ id_map: {}, rejected: [], restored: 0 });
    const restoreWorkspace = vi.fn();
    await openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: () => scene(), restoreWorkspace });
    expect(restoreWorkspace).not.toHaveBeenCalled();
  });

  it.each([[405, "Method Not Allowed"], [404, "Not Found"]] as const)("구서버 보관 오류 %i를 업데이트 안내로 바꾼다", async (status, message) => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError(status, message));
    await expect(sceneKeepApi.save(scope, { ...captureSceneKeep(scene(), "사본"), description: "", project_id: "", project_name: null }))
      .rejects.toThrow("공유 서버 업데이트가 필요합니다.");
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError(404, "보관본을 찾을 수 없습니다"));
    await expect(sceneKeepApi.detail(scope, "gone")).rejects.toThrow("보관본을 찾을 수 없습니다");
  });

  it("읽기·검증·같은 revision 복원·id 적용·가져오기 순서다", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockResolvedValueOnce({ id_map: { "alias-one": "new-id" }, rejected: [], restored: 1 });
    const importer = vi.fn((snap: SceneSnapshot, captured: string) => {
      expect(captured).toBe(scope);
      expect(jsonFetch).toHaveBeenCalledTimes(2);
      expect(snap.cards[0].genId).toBe("new-id");
      return { ...scene(), ...snap };
    });
    const result = await openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: importer });
    expect(result.restored).toBe(1);
    expect(vi.mocked(jsonFetch).mock.calls[1][1]?.body).toBe(JSON.stringify({ id: "keep", revision: 7 }));
    expect(vi.mocked(jsonFetch).mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ "X-MVHub-Expect-Account": scope }));
  });

  it("읽을 수 없는 씬이면 restore와 가져오기를 하지 않는다", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail(), scene_text: "invalid" });
    const importer = vi.fn();
    await expect(openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: importer })).rejects.toThrow("열 수 없는");
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(importer).not.toHaveBeenCalled();
  });

  it("쓸 수 없는 창과 계정이 다른 범위는 요청·저장 없이 멈춘다", async () => {
    const importer = vi.fn();
    await expect(openSceneKeep({ id: "keep", scope, canWrite: () => false, importSnapshot: importer })).rejects.toThrow("편집할 수 있는");
    vi.mocked(getAccountNamespace).mockReturnValue("acct:other@example.test");
    await expect(sceneKeepApi.list(scope)).rejects.toThrow("계정");
    expect(importCanvasSnapshot(scope, snapshot())).toBeNull();
    expect(jsonFetch).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
  });

  it("상세 응답 도중 계정이 바뀌면 restore하지 않는다", async () => {
    vi.mocked(jsonFetch).mockImplementationOnce(async () => {
      vi.mocked(getAccountNamespace).mockReturnValue("acct:other@example.test");
      return detail();
    });
    await expect(openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: vi.fn() })).rejects.toThrow("계정");
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("복원 후 null 반환·확정 중 계정 변경은 오류로 알린다", async () => {
    for (const failure of ["null", "scope"]) {
      vi.mocked(getAccountNamespace).mockReturnValue(scope);
      vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockResolvedValueOnce({ id_map: {}, rejected: [], restored: 1 });
      vi.mocked(confirmSceneWrite).mockImplementation(action => ({ value: action(), settled: Promise.resolve(true), confirmed: Promise.resolve().then(() => {
        if (failure === "scope") vi.mocked(getAccountNamespace).mockReturnValue("acct:other@example.test");
        return true;
      }) }));
      const workspace = vi.fn();
      await expect(openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: () => failure === "null" ? null : scene(), restoreWorkspace: workspace })).rejects.toThrow("기록은 복원했지만");
      expect(workspace).not.toHaveBeenCalled();
    }
  });

  it("탭이 이미 있으면 저장 확정 실패는 경고를 싣고 성공 흐름을 계속한다", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockResolvedValueOnce({ id_map: {}, rejected: [], restored: 1 });
    vi.mocked(confirmSceneWrite).mockImplementation(action => ({ value: action(), settled: Promise.resolve(false), confirmed: Promise.resolve(false) }));
    const opened = scene();
    const importer = vi.fn(() => opened);
    const result = await openSceneKeep({ id: "keep", scope, canWrite: () => true, importSnapshot: importer });
    expect(result.scene).toBe(opened);
    expect(result.saveWarning).toBe("탭은 열었지만 이 PC 에 아직 저장하지 못했습니다.");
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("목록의 구서버 404와 상세의 찾을 수 없는 항목을 구분한다", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError(404, "Not Found", "Not Found"));
    await expect(sceneKeepApi.list(scope)).rejects.toThrow("업데이트");
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError(404, "보관본을 찾을 수 없습니다"));
    await expect(sceneKeepApi.detail(scope, "gone")).rejects.toThrow("찾을 수 없습니다");
  });
});

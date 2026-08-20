// 에셋 버전 갱신 공용 실행기 — SceneBoard·SpotlightPrompt 복붙 통합의 동작 계약 고정.
import { describe, expect, it, vi } from "vitest";
import {
  assetProjectsFromRefs,
  runAssetVersionRefresh,
} from "../src/lib/assetVersionRefresh";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("assetProjectsFromRefs", () => {
  it("asset: 참조의 프로젝트만 뽑고 나머지는 무시한다", () => {
    const refs = [
      { file_path: "asset:PROJ_A|scenes/cut01.png" },
      { file_path: "asset:PROJ_B|x.png" },
      { file_path: "/media/aa/bb.png" }, // 일반 미디어 — 제외
      { file_path: null },
      {},
    ];
    expect([...assetProjectsFromRefs(refs)].sort()).toEqual(["PROJ_A", "PROJ_B"]);
  });

  it("only 목록이 있으면 그 프로젝트만(실시간 신호의 '변경된 것만' 필터)", () => {
    const refs = [
      { file_path: "asset:PROJ_A|a.png" },
      { file_path: "asset:PROJ_B|b.png" },
    ];
    expect([...assetProjectsFromRefs(refs, ["PROJ_B"])]).toEqual(["PROJ_B"]);
    // 빈 only 는 전체(변경 목록이 비면 전 프로젝트 갱신 — 기존 두 구현의 공통 규칙).
    expect([...assetProjectsFromRefs(refs, [])].sort()).toEqual(["PROJ_A", "PROJ_B"]);
  });
});

describe("runAssetVersionRefresh", () => {
  it("프로젝트별로 조회하고 결과를 버전표에 반영한다", async () => {
    const ingest = vi.fn();
    const fetchTree = vi.fn().mockResolvedValue({ children: [{ name: "x" }] });
    const inFlight = new Set<string>();
    runAssetVersionRefresh(["A", "B"], inFlight, true, { fetchTree, ingest });
    await flush();
    expect(fetchTree).toHaveBeenCalledWith("A", true);
    expect(fetchTree).toHaveBeenCalledWith("B", true);
    expect(ingest).toHaveBeenCalledWith("A", [{ name: "x" }]);
    expect(inFlight.size).toBe(0); // 완료 후 해제
  });

  it("in-flight 중인 프로젝트는 중복 조회하지 않는다", async () => {
    const ingest = vi.fn();
    let resolveFirst!: (v: { children: unknown[] }) => void;
    const fetchTree = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => (resolveFirst = resolve)));
    const inFlight = new Set<string>();
    runAssetVersionRefresh(["A"], inFlight, false, { fetchTree, ingest });
    runAssetVersionRefresh(["A"], inFlight, false, { fetchTree, ingest }); // 진행 중 재요청
    expect(fetchTree).toHaveBeenCalledTimes(1);
    resolveFirst({ children: [] });
    await flush();
    expect(inFlight.size).toBe(0);
  });

  it("조회 실패는 삼키고 in-flight 를 해제해 다음 신호에 재시도 가능하게 한다", async () => {
    const ingest = vi.fn();
    const fetchTree = vi.fn().mockRejectedValue(new Error("network"));
    const inFlight = new Set<string>();
    runAssetVersionRefresh(["A"], inFlight, true, { fetchTree, ingest });
    await flush();
    expect(ingest).not.toHaveBeenCalled();
    expect(inFlight.size).toBe(0); // 실패해도 해제 — 재시도 가능
  });
});

// 옛 저장 칸에서 옮길 때의 진단 기록(2026-10-07).
//
// "캔버스 연결이 안 붙는다"는 신고의 원인을 저장 칸이 가득 찬 것으로 봤지만, 그 PC 의 저장량은 받지 못했다.
// 배포 뒤 그 PC 에서 확인할 수 있게, 처음 옮기는 순간의 상태를 한 번 적어 둔다. 이 시험이 지키는 것:
//  · 실제로 옮긴 그때만 적는다(다시 켜도·다른 창이 먼저 옮겼어도 덮지 않는다).
//  · 진단이 실패해도 옮기는 일은 한다.
//  · 화면은 '지금'과 '옮길 때'를 따로 보여 주고, 기록이 없으면 없다고 말한다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasArchiveSection } from "../src/components/settings/CanvasArchiveSection";
import { describeSceneMigration, exportSceneArchiveText } from "../src/lib/sceneArchive";
import { bootSceneStore, diagnoseLegacyStorage } from "../src/lib/sceneBoot";
import {
  initSceneStore,
  readSceneMigrationInfo,
  type LegacyDiagnosis,
  type LegacyMark,
  type SceneMigrationInfo,
} from "../src/lib/sceneStore";
import type { Scene } from "../src/lib/scenes";

const BUCKET = "local::_none"; // 로그인 없는 로컬 계정
const mk = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 1 });
const legacy = () => ({ [BUCKET]: [mk("s1"), mk("s2")], "acct:b@x.com::_none": [mk("b1")] });
const keepMark = () => true;
const committed: LegacyMark = { state: "committed", generation: "g1" };
const full: LegacyDiagnosis = { legacyChars: 4_960_000, storageChars: 4_990_000, probe: "quota" };

beforeEach(() => {
  localStorage.clear();
});

describe("처음 옮길 때의 기록", () => {
  it("옮긴 그 순간의 수치를 적는다 — 다시 켜도 바뀌지 않고, 진단을 다시 재지도 않는다", async () => {
    const diagnose = vi.fn(() => full);
    expect((await initSceneStore(legacy, null, keepMark, diagnose)).kind).toBe("ready");
    const info = await readSceneMigrationInfo();
    expect(info).toEqual({ ...full, sceneCount: 3, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });

    const later = vi.fn((): LegacyDiagnosis => ({ legacyChars: 1, storageChars: 1, probe: "ok" }));
    await initSceneStore(legacy, committed, keepMark, later); // 다시 켠다
    await initSceneStore(legacy, null, keepMark, later); // 표식을 못 읽은 창(다른 창이 이미 옮겨 둔 저장소)
    expect(await readSceneMigrationInfo()).toEqual(info);
    expect(later).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledTimes(1);
  });

  it("진단이 던져도 옮기는 일은 한다 — 기록에는 '확인 못 함'으로 남는다", async () => {
    const result = await initSceneStore(legacy, null, keepMark, () => {
      throw new Error("저장소 접근 차단");
    });
    expect(result).toMatchObject({ kind: "ready", migrated: true });
    expect(await readSceneMigrationInfo()).toMatchObject({
      legacyChars: null,
      storageChars: null,
      probe: "unknown",
      sceneCount: 3,
    });
  });

  // 이관을 끝낸 뒤 저장소가 사라져 빈 상태로 여는 것은 '옮긴 것'이 아니다 — 그때의 수치를 옮길 때의 기록으로 적으면
  // 원인 판단을 그르친다.
  it("옮기지 않은 열기(저장소가 사라져 빈 상태로 열 때)에는 적지 않는다", async () => {
    const diagnose = vi.fn(() => full);
    await initSceneStore(legacy, committed, keepMark, diagnose);
    expect(await readSceneMigrationInfo()).toBeNull();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("전체 내보내기 파일에 함께 실린다 — 파일만 받아도 그 PC 의 상태를 볼 수 있다", async () => {
    await initSceneStore(legacy, null, keepMark, () => full);
    const file = JSON.parse(await exportSceneArchiveText()) as { migration: SceneMigrationInfo };
    expect(file.migration).toMatchObject({ ...full, sceneCount: 3 });
  });
});

describe("옛 저장 칸 진단", () => {
  const probeKeys = () => Object.keys(localStorage).filter((key) => key.startsWith("ch.scenes.probe."));
  afterEach(() => vi.restoreAllMocks());

  it("씬 자료와 전체의 글자 수를 재고, 시험 쓰기가 되면 ok — 임시 키는 남기지 않는다", () => {
    localStorage.setItem("ch.scenes", "x".repeat(500));
    localStorage.setItem("other", "y".repeat(100));
    expect(diagnoseLegacyStorage()).toEqual({
      legacyChars: 500,
      storageChars: "ch.scenes".length + 500 + "other".length + 100,
      probe: "ok",
    });
    expect(probeKeys()).toEqual([]);
  });

  // 옮기는 내용(씬 수)과 글자 수가 **같은 읽기**에서 나와야 한다. 진단이 옛 저장소를 다시 읽으면, 그사이 옛 판
  // 창이 고친 내용의 길이가 적혀 '옮긴 씬 수'와 다른 시점의 값이 된다(Codex 코드 리뷰).
  it("글자 수는 넘겨받은 원문의 것을 쓴다 — 옛 저장소를 다시 읽지 않는다", async () => {
    localStorage.setItem("ch.scenes", "x".repeat(500)); // 그사이 옛 창이 바꿔 놓은 내용
    expect(diagnoseLegacyStorage(123).legacyChars).toBe(123);

    const raw = JSON.stringify({ [BUCKET]: [mk("s1"), mk("s2")] });
    localStorage.setItem("ch.scenes", raw);
    expect((await bootSceneStore()).kind).toBe("ready");
    expect(await readSceneMigrationInfo()).toMatchObject({ legacyChars: raw.length, sceneCount: 2 });
  });

  it("할당량 초과로 못 쓰면 quota, 다른 이유면 unknown — 던지지 않는다", () => {
    const real = Storage.prototype.setItem;
    const failWith = (error: unknown) =>
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
        if (key.startsWith("ch.scenes.probe.")) throw error;
        real.call(this, key, value);
      });
    failWith(new DOMException("가득 참", "QuotaExceededError"));
    expect(diagnoseLegacyStorage().probe).toBe("quota");
    vi.restoreAllMocks();
    failWith(new DOMException("막힘", "SecurityError"));
    expect(diagnoseLegacyStorage().probe).toBe("unknown");
    expect(probeKeys()).toEqual([]);
  });
});

describe("화면에 보이는 한 줄", () => {
  it("기록이 없으면 없다고 말한다 — 지금 잰 값으로 과거를 채우지 않는다", () => {
    expect(describeSceneMigration(null)).toBe("옮긴 기록 없음");
  });

  it("가득 찼던 기록과 시험 쓰기가 된 기록을 다르게 쓴다 — '됨'을 '여유 있었음'으로 쓰지 않는다", () => {
    const at = "2026-10-07T12:30:00.000Z";
    const fullLine = describeSceneMigration({ ...full, at, sceneCount: 104 });
    expect(fullLine).toMatch(/^옮길 때\(2026-10-0\d \d\d:\d\d\): 캔버스 104개 · 캔버스 자료 496만 글자 · 옛 저장 칸 전체 499만 글자/);
    expect(fullLine).toContain("시험 쓰기 실패(가득 차 있었음)");
    const okLine = describeSceneMigration({ legacyChars: 800, storageChars: null, probe: "ok", at, sceneCount: 1 });
    expect(okLine).toContain("캔버스 자료 800글자 · 옛 저장 칸 전체 확인 못 함 · 시험 쓰기 됨");
    expect(okLine).not.toContain("여유");
  });

  describe("설정 창", () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const facts = async () => {
      await act(async () => root.render(<CanvasArchiveSection />));
      await act(async () => {
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return host.querySelector('[data-testid="canvas-storage-facts"]')?.textContent ?? "";
    };

    it("'지금'과 '옮길 때'를 따로 보여 준다", async () => {
      await initSceneStore(legacy, null, keepMark, () => full);
      const line = await facts();
      expect(line).toContain("지금 캔버스 2개"); // 이 계정의 것만
      expect(line).toContain("옮길 때(");
      expect(line).toContain("캔버스 3개"); // 옮길 때는 모든 계정
      expect(line).toContain("시험 쓰기 실패(가득 차 있었음)");
    });

    it("옮긴 기록이 없는 설치에서는 없다고 보여 준다", async () => {
      await initSceneStore(legacy, committed, keepMark, () => full); // 옮기지 않은 열기
      expect(await facts()).toBe("지금 캔버스 0개 · 옮긴 기록 없음");
    });
  });
});

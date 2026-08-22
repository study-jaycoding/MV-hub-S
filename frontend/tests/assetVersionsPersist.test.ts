// 어셋 버전표 영속화 계약 — 저장 '단위'만 프로젝트별로 쪼갠 변경의 회귀 방지.
//  ★썸네일 갱신 정책(어떤 조건에 버전이 바뀌는가)은 이 테스트의 대상이 아니다(불변).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

const LEGACY_KEY = "mvhub.assetVersions.v1";
const KEY_PREFIX = "mvhub.assetVersions.v2.";

interface MockStorage extends Storage {
  writes: string[];
}

// node 환경엔 localStorage 가 없다. 어떤 키에 썼는지 기록해 '이번 프로젝트만 쓰기'를 검증한다.
function storageMock(): MockStorage {
  const store: Record<string, string> = {};
  const writes: string[] = [];
  return {
    writes,
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      writes.push(k);
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as MockStorage;
}

function installStorage(): MockStorage {
  const mock = storageMock();
  (globalThis as { localStorage?: Storage }).localStorage = mock;
  return mock;
}

// 모듈 로드 시점에 저장분을 읽으므로, 시드 후 새로 import 한다.
async function freshModule() {
  vi.resetModules();
  return await import("../src/lib/assetVersions");
}

const file = (path: string, version: string): AssetNode => ({
  name: path.split("/").pop() || path,
  type: "image",
  path,
  version,
});

describe("assetVersions 영속화(프로젝트별 키)", () => {
  beforeEach(() => {
    installStorage();
  });

  it("구버전 합본 키를 그대로 읽어 들이고(하위호환) 프로젝트별 키로 1회 이관한다", async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ "A|a.png": "v1", "A|sub/b.png": "v2", "B|c.png": "v3", bad: "x" }),
    );
    const m = await freshModule();

    // 이관 전 값이 그대로 살아 있다(사용자 버전표 유실 없음).
    expect(m.getAssetVersion("A", "a.png")).toBe("v1");
    expect(m.getAssetVersion("A", "sub/b.png")).toBe("v2");
    expect(m.getAssetVersion("B", "c.png")).toBe("v3");

    // 프로젝트별 키로 옮겨졌고 옛 합본 키는 제거됐다.
    expect(JSON.parse(localStorage.getItem(`${KEY_PREFIX}A`) || "null")).toEqual({
      "a.png": "v1",
      "sub/b.png": "v2",
    });
    expect(JSON.parse(localStorage.getItem(`${KEY_PREFIX}B`) || "null")).toEqual({ "c.png": "v3" });
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("프로젝트별 키로 저장된 표를 다시 읽어 온다(새 구조 왕복)", async () => {
    const first = await freshModule();
    first.ingestAssetTreeVersions("My Proj.2", [file("a.png", "v1")]); // 인코딩 필요한 이름도 왕복
    expect(localStorage.getItem(`${KEY_PREFIX}${encodeURIComponent("My Proj.2")}`)).toBeTruthy();

    const second = await freshModule(); // 새로고침 상당
    expect(second.getAssetVersion("My Proj.2", "a.png")).toBe("v1");
  });

  it("한 프로젝트 갱신은 그 프로젝트 키만 쓴다(다른 프로젝트는 손대지 않음)", async () => {
    const seed = await freshModule();
    seed.ingestAssetTreeVersions("A", [file("a.png", "v1")]);
    seed.ingestAssetTreeVersions("B", [file("b.png", "v1")]);
    const bBefore = localStorage.getItem(`${KEY_PREFIX}B`);

    const mock = localStorage as MockStorage;
    mock.writes.length = 0;
    seed.ingestAssetTreeVersions("A", [file("a.png", "v2")]); // A 만 변경
    expect(mock.writes).toEqual([`${KEY_PREFIX}A`]);
    expect(localStorage.getItem(`${KEY_PREFIX}B`)).toBe(bBefore);

    // 변경이 없으면 아무것도 쓰지 않는다(기존 규칙 유지).
    mock.writes.length = 0;
    seed.ingestAssetTreeVersions("A", [file("a.png", "v2")]);
    expect(mock.writes).toEqual([]);
  });

  it("트리에서 사라진 파일은 그 프로젝트 버킷에서만 제거된다", async () => {
    const m = await freshModule();
    m.ingestAssetTreeVersions("A", [file("a.png", "v1"), file("b.png", "v1")]);
    m.ingestAssetTreeVersions("B", [file("c.png", "v1")]);

    m.ingestAssetTreeVersions("A", [file("a.png", "v1")]); // b.png 삭제됨
    expect(m.getAssetVersion("A", "b.png")).toBeUndefined();
    expect(m.getAssetVersion("B", "c.png")).toBe("v1");
    expect(JSON.parse(localStorage.getItem(`${KEY_PREFIX}A`) || "null")).toEqual({ "a.png": "v1" });
  });
});

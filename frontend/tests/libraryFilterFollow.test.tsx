// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Store } from "../src/lib/storage";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import {
  FILTER_AUTO_TAGS_KEY,
  FILTERS_FORMAT_KEY,
  FILTERS_KEY,
  GENERATION_SCOPE_KEY,
} from "../src/lib/useLibraryPersistence";

function fakeStore(data: Record<string, string>): Store {
  return {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => (key in data ? (JSON.parse(data[key]) as T) : null),
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => {
      const value = key in data ? JSON.parse(data[key]) : [];
      return new Set(Array.isArray(value) ? value : []);
    },
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
}

type LibraryState = ReturnType<typeof useLibraryFilters>;
let host: HTMLDivElement;
let root: Root;
let latest: LibraryState;

function mount(store: Store) {
  function Probe() {
    latest = useLibraryFilters(store);
    return null;
  }
  act(() => root.render(<Probe />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Resolve 라이브러리 따라가기", () => {
  it("보기 필터만 비우고 생성 목적지·생성 태그·무장 폴더·수동 선택 키를 보존한다", () => {
    const data: Record<string, string> = {
      [FILTERS_KEY]: JSON.stringify({
        tab: "team",
        project_id: "view-old",
        folder_path: "old-folder",
        search: "needle",
        share_dir: "mine",
        [FILTERS_FORMAT_KEY]: "2",
      }),
      [GENERATION_SCOPE_KEY]: JSON.stringify({ project_id: "create", folder_path: "dest" }),
      [FILTER_AUTO_TAGS_KEY]: JSON.stringify(["visible"]),
      typeFilter: "video",
      colorFilter: JSON.stringify(["r"]),
      tagFilter: JSON.stringify(["tag"]),
      armedAutoTags: JSON.stringify(["visible", "gen-only"]),
      armedFolder: JSON.stringify({ projectId: "create", path: "dest" }),
      sharedOnly: "1",
      commentOnly: "1",
      finalOnly: "1",
      grayOn: "1",
    };
    mount(fakeStore(data));
    const revision = latest.manualRevision;
    const resetKey = latest.selectionResetKey;

    act(() => latest.followLocation({ project_id: "resolved", folder_path: "shots" }));

    expect(latest.filters).toEqual({ tab: "team", project_id: "resolved", folder_path: "shots" });
    expect(latest.typeFilter).toBe("all");
    expect([...latest.colorFilter]).toEqual([]);
    expect([...latest.tagFilter]).toEqual([]);
    expect([...latest.filterAutoTags]).toEqual([]);
    expect(latest.sharedOnly).toBe(false);
    expect(latest.commentOnly).toBe(false);
    expect(latest.finalOnly).toBe(false);
    expect(latest.grayOn).toBe(false);
    expect(latest.generationScope).toEqual({ project_id: "create", folder_path: "dest" });
    expect([...latest.armedAutoTags].sort()).toEqual(["gen-only", "visible"]);
    expect(latest.armedFolder).toEqual({ projectId: "create", path: "dest" });
    expect(latest.manualRevision).toBe(revision);
    expect(latest.selectionResetKey).toBe(resetKey);
    expect(latest.genQuery.auto_tags).toEqual([]);
  });

  it("검색 변경은 자동 위치를 생성 목적지로 채택하지 않고, 같은 폴더 수동 클릭은 채택한다", () => {
    const data: Record<string, string> = {
      [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }),
      [GENERATION_SCOPE_KEY]: JSON.stringify({ project_id: "create", folder_path: "dest" }),
    };
    mount(fakeStore(data));
    act(() => latest.followLocation({ project_id: "resolved", folder_path: "shots" }));

    act(() => latest.patch({ search: "clip" }));
    expect(latest.generationScope).toEqual({ project_id: "create", folder_path: "dest" });
    expect(latest.manualRevision).toBe(1);

    act(() => latest.patch({ project_id: "resolved", folder_path: "shots" }));
    expect(latest.generationScope).toEqual({ project_id: "resolved", folder_path: "shots" });
    expect(latest.manualRevision).toBe(2);
  });

  it("자동태그 토글은 보기 기준이며 다른 생성 태그를 보존한다", () => {
    const data: Record<string, string> = {
      [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }),
      armedAutoTags: JSON.stringify(["both", "gen-only"]),
      [FILTER_AUTO_TAGS_KEY]: JSON.stringify(["both"]),
    };
    mount(fakeStore(data));

    act(() => latest.toggleAutoTag("gen-only"));
    expect([...latest.filterAutoTags].sort()).toEqual(["both", "gen-only"]);
    expect([...latest.armedAutoTags].sort()).toEqual(["both", "gen-only"]);

    act(() => latest.toggleAutoTag("both"));
    expect([...latest.filterAutoTags]).toEqual(["gen-only"]);
    expect([...latest.armedAutoTags]).toEqual(["gen-only"]);
    expect(latest.genQuery.auto_tags).toEqual(["gen-only"]);

    act(() => latest.setArmedAutoTags((tags) => new Set([...tags, "legacy-setter"])));
    expect(latest.filterAutoTags.has("legacy-setter")).toBe(true);
    expect(latest.armedAutoTags.has("legacy-setter")).toBe(true);
  });

  it("새 저장 키가 없을 때만 옛 보기 위치·무장 태그에서 복원하고 다시 로드한다", () => {
    const data: Record<string, string> = {
      [FILTERS_KEY]: JSON.stringify({
        tab: "my",
        project_id: "legacy-project",
        folder_path: "legacy-folder",
        [FILTERS_FORMAT_KEY]: "2",
      }),
      armedAutoTags: JSON.stringify(["legacy-tag"]),
    };
    const store = fakeStore(data);
    mount(store);
    expect(latest.generationScope).toEqual({
      project_id: "legacy-project",
      folder_path: "legacy-folder",
    });
    expect([...latest.filterAutoTags]).toEqual(["legacy-tag"]);

    act(() => latest.patch({ project_id: "new-project", folder_path: "new-folder" }));
    act(() => latest.toggleAutoTag("new-tag"));
    act(() => root.unmount());
    root = createRoot(host);
    mount(store);

    expect(latest.generationScope).toEqual({ project_id: "new-project", folder_path: "new-folder" });
    expect([...latest.filterAutoTags].sort()).toEqual(["legacy-tag", "new-tag"]);
  });

  it("빈 새 저장값은 유효하며, 동일 객체 setter와 자동 따라가기는 revision을 올리지 않는다", () => {
    const data: Record<string, string> = {
      [FILTERS_KEY]: JSON.stringify({
        tab: "my",
        project_id: "legacy-project",
        folder_path: "legacy-folder",
        [FILTERS_FORMAT_KEY]: "2",
      }),
      [GENERATION_SCOPE_KEY]: JSON.stringify({}),
      [FILTER_AUTO_TAGS_KEY]: JSON.stringify([]),
      armedAutoTags: JSON.stringify(["legacy-tag"]),
    };
    mount(fakeStore(data));
    expect(latest.generationScope).toEqual({});
    expect([...latest.filterAutoTags]).toEqual([]);

    act(() => latest.setFilters((current) => current));
    expect(latest.manualRevision).toBe(0);
    act(() => latest.setTypeFilter("video"));
    expect(latest.manualRevision).toBe(1);
    act(() => latest.setTypeFilter("video"));
    expect(latest.manualRevision).toBe(2);
    const key = latest.selectionResetKey;
    act(() => latest.followLocation({ project_id: "auto" }));
    expect(latest.manualRevision).toBe(2);
    expect(latest.selectionResetKey).toBe(key);
  });
});

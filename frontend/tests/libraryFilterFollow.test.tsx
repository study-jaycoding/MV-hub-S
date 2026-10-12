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
    const followed = latest.followRevision;

    act(() => latest.followLocation({ project_id: "resolved", folder_path: "shots" }));

    // 따라간 횟수가 오른다 — 상단바가 검색칸을 다시 올려, 치던 검색어의 예약(0.3초 뒤)이 찾아간 자리에 걸리지 않게 한다(10회차)
    expect(latest.followRevision).toBe(followed + 1);
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

  // 28회차 ⑤-2(Jay 결정 '나') → 29회차(Jay "검색과 같게"): 보기 필터를 바꾸면 선택을 비우지 않는다 — 결과에 남은 카드는 고른 채로(사라진 카드는
  //  App 의 규칙 42 효과가 뺀다). 보는 자리(탭·프로젝트·폴더·휴지통)가 바뀌면 전처럼 비운다.
  it("보기 필터(검색어·종류·색·태그·공유·검수·코멘트·최종·회색·자동태그·W 침)는 선택 초기화 키를 올리지 않고 수동 횟수만 올린다", () => {
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }) }));
    const key = latest.selectionResetKey;
    const steps: Array<[string, () => void]> = [
      ["search", () => latest.patch({ search: "cat" })],
      ["search-clear", () => latest.patch({ search: undefined })], // 검색어를 지우는 것도 검색어 변경이다
      ["workspace-chip", () => latest.patch({ workspace_ids: ["w1"] })],
      ["workspace-chip-toggle", () => latest.setFilters((current) => ({ ...current, workspace_ids: ["w1", "w2"] }))], // App 의 toggleWorkspaceChip 이 쓰는 길
      ["creator", () => latest.patch({ creator_uid: "u1", share_dir: "received" })],
      ["type", () => latest.setTypeFilter("video")],
      ["type-same", () => latest.setTypeFilter("video")],
      ["color", () => latest.setColorFilter(new Set(["r"]))],
      ["tag", () => latest.setTagFilter(new Set(["t"]))],
      ["shared", () => latest.setSharedOnly(true)],
      ["review", () => latest.setReviewFilter("held")],
      ["comment", () => latest.setCommentOnly(true)],
      ["final", () => latest.setFinalOnly(true)],
      ["gray", () => latest.setGrayOn(true)],
      ["auto-tag", () => latest.toggleAutoTag("ep")],
      ["auto-tag-setter", () => latest.setArmedAutoTags((tags) => new Set([...tags, "x"]))],
    ];
    let revision = latest.manualRevision;
    for (const [name, step] of steps) {
      act(step);
      expect([name, latest.selectionResetKey]).toEqual([name, key]);
      expect([name, latest.manualRevision]).toEqual([name, revision + 1]); // 늦은 따라가기 응답은 여전히 버려야 한다
      revision = latest.manualRevision;
    }
  });

  it("보는 자리가 바뀌면 선택 초기화 키가 오른다 — 폴더·프로젝트·휴지통 patch, 탭을 바꾸는 setFilters, 검색어와 폴더가 같이 온 patch", () => {
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }) }));
    const keys = [latest.selectionResetKey];
    const bump = (step: () => void) => {
      act(step);
      expect(keys).not.toContain(latest.selectionResetKey);
      keys.push(latest.selectionResetKey);
    };
    bump(() => latest.patch({ search: "dog", folder_path: "ep01" }));
    bump(() => latest.patch({ project_id: "p2" }));
    bump(() => latest.patch({ deleted_only: true }));
    bump(() => latest.patch({ include_deleted: true, deleted_only: undefined }));
    bump(() => latest.setFilters((current) => ({ ...current, tab: "team" })));
  });
});

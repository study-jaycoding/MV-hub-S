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

function mount(store: Store, workspace?: Parameters<typeof useLibraryFilters>[1]) {
  function Probe() {
    latest = useLibraryFilters(store, workspace);
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

  // 2026-10-13 ①②: 공유 탭의 마지막 자리 기억(adopt 없음)은 보는 자리만 되살린다 — 생성 위치·무장 폴더는 그대로, 선택은 비우고 수동 횟수는 올린다
  it("restoreLocation(기억 되살림) 은 보는 자리만 되살린다 — 생성 위치·무장 폴더 보존, 선택 비움·수동 횟수 +1, 같은 자리면 아무 일도 없다", () => {
    mount(fakeStore({
      [FILTERS_KEY]: JSON.stringify({ tab: "team", project_id: "p1", folder_path: "e001", [FILTERS_FORMAT_KEY]: "2" }),
      [GENERATION_SCOPE_KEY]: JSON.stringify({ project_id: "create", folder_path: "dest" }),
      armedFolder: JSON.stringify({ projectId: "create", path: "dest" }),
    }));
    const key = latest.selectionResetKey;
    const revision = latest.manualRevision;
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035/C0010" }));
    expect(latest.filters).toMatchObject({ tab: "team", project_id: "p1", folder_path: "e035/C0010" });
    expect(latest.generationScope).toEqual({ project_id: "create", folder_path: "dest" });
    expect(latest.armedFolder).toEqual({ projectId: "create", path: "dest" });
    expect(latest.selectionResetKey).not.toBe(key);
    expect(latest.manualRevision).toBe(revision + 1);
    const key2 = latest.selectionResetKey;
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035/C0010" })); // 같은 자리
    expect([latest.selectionResetKey, latest.manualRevision]).toEqual([key2, revision + 1]);
    act(() => latest.restoreLocation({ project_id: undefined, folder_path: undefined })); // 프로젝트 맨 위(명시적)
    expect([latest.filters.project_id, latest.filters.folder_path]).toEqual([undefined, undefined]);
    expect(latest.generationScope).toEqual({ project_id: "create", folder_path: "dest" });
    // 휴지통 보기도 자리다 — 실리면 켜고, 없으면 끈다(기록에서 일반 목록으로 돌아온다)
    act(() => latest.restoreLocation({ project_id: "p1", deleted_only: true }));
    expect([latest.filters.project_id, latest.filters.deleted_only]).toEqual(["p1", true]);
    const key3 = latest.selectionResetKey;
    act(() => latest.restoreLocation({ project_id: "p1" }));
    expect([latest.filters.deleted_only, latest.filters.include_deleted, latest.selectionResetKey === key3]).toEqual([undefined, undefined, false]);
    // 되살린 자리 표식 — App 의 '낡은 프로젝트' 효과가 건너뛴다. 눌러 고르면(patch 의 생성 위치 채택) 내린다
    expect(latest.restoredLocationRef.current).toBe(true);
    act(() => latest.patch({ project_id: "p1" }));
    expect(latest.restoredLocationRef.current).toBe(false);
  });

  // 2026-10-13 오후(Jay "화면은 e035 인데 표시는 C0110"): 브라우저 뒤로·앞으로 가기(adopt)는 그 자리를 눌러 들어간 것과 같다 — 생성 위치·무장 폴더도
  //  그 자리로. 자리가 실제로 바뀔 때만이고, 휴지통 기록은 건드리지 않는다.
  it("restoreLocation(뒤로·앞으로 가기) 은 자리가 바뀌면 생성 위치·무장 폴더도 그 자리로 — 같은 자리·휴지통은 그대로, 표식은 켠 채", () => {
    const store = fakeStore({
      [FILTERS_KEY]: JSON.stringify({ tab: "team", project_id: "p1", folder_path: "e035/C0110", [FILTERS_FORMAT_KEY]: "2" }),
      [GENERATION_SCOPE_KEY]: JSON.stringify({ project_id: "p1", folder_path: "e035/C0110" }),
      armedFolder: JSON.stringify({ projectId: "p1", path: "e035/C0110" }),
    });
    mount(store);
    const revision = latest.manualRevision;
    // 뒤로 — e035 로: 보는 자리·생성 위치·무장이 함께
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035" }, true));
    expect([latest.filters.folder_path, latest.generationScope, latest.armedFolder])
      .toEqual(["e035", { project_id: "p1", folder_path: "e035" }, { projectId: "p1", path: "e035" }]);
    expect([latest.manualRevision, latest.restoredLocationRef.current]).toEqual([revision + 1, true]); // 표식은 켠 채('낡은 프로젝트' 효과가 건너뛴다)
    // 프로젝트만 고른 자리 — 무장 없음(눌러 고를 때와 같다)
    act(() => latest.restoreLocation({ project_id: "p1" }, true));
    expect([latest.generationScope, latest.armedFolder]).toEqual([{ project_id: "p1" }, null]);
    // 같은 자리의 기록(겹·탭의 사본) — 생성 위치가 달라도 맞추지 않는다: 기억으로 되살린 자리에서 미리보기를 닫는 것만으로 바뀌면 안 된다
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e001" })); // 기억 되살림(보기만)
    expect([latest.filters.folder_path, latest.generationScope]).toEqual(["e001", { project_id: "p1" }]);
    const armedBefore = latest.armedFolder;
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e001" }, true));
    expect([latest.generationScope, latest.armedFolder === armedBefore]).toEqual([{ project_id: "p1" }, true]);
    // 휴지통 기록 — 보는 자리만(생성 목적지가 아니다. 폴더 값이 남아 있어도 무장하지 않는다)
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035", deleted_only: true }, true));
    expect([latest.filters.deleted_only, latest.generationScope, latest.armedFolder]).toEqual([true, { project_id: "p1" }, null]);
    // 다시 일반 목록의 폴더로 — 같은 무장 값이면 객체를 갈지 않는다(저장을 다시 하지 않는다)
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035" }, true));
    const armed = latest.armedFolder;
    act(() => latest.restoreLocation({ project_id: "p1" }));          // 보기만 맨 위로
    act(() => latest.restoreLocation({ project_id: "p1", folder_path: "e035" }, true)); // 다시 그 폴더로(생성 위치는 계속 e035 였다)
    expect([latest.armedFolder === armed, latest.armedFolder]).toEqual([true, { projectId: "p1", path: "e035" }]);
  });

  it("teamScopeKey·teamAutoReady — 지금 탭과 무관하게 공유 탭에 들어가면 갖게 될 공간 범위와 '확정된 자동 공간인가'를 센다", () => {
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }) }), { scope: "team", id: "ws-1", name: "팀" } as never);
    expect(latest.teamScopeKey).toBe(JSON.stringify([JSON.stringify(["team", "ws-1"]), "auto"]));
    expect(latest.teamAutoReady).toBe(true);
    expect(latest.workspaceScopeKey).toBe(""); // 공유 탭이 아니면 비어 있다 — 그래서 따로 둔다
    act(() => latest.workspaceFollow?.onChange("all")); // 공유 탭이 아니라 workspaceFollow 가 없다 — 아래에서 공유 탭으로 다시 띄워 본다
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "team", [FILTERS_FORMAT_KEY]: "2" }) }), { scope: "team", id: "ws-1", name: "팀" } as never);
    act(() => latest.workspaceFollow!.onChange("all")); // 전체 보기 — 확정된 자동 공간이 아니다
    expect([latest.teamAutoReady, latest.teamScopeKey]).toEqual([false, JSON.stringify([JSON.stringify(["team", "ws-1"]), "all"])]);
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }) }), { scope: "team", id: "", name: "" } as never);
    expect(latest.teamAutoReady).toBe(false); // 공간 미확정
    mount(fakeStore({ [FILTERS_KEY]: JSON.stringify({ tab: "my", [FILTERS_FORMAT_KEY]: "2" }) }));
    expect(latest.teamAutoReady).toBe(false); // 공간 문맥 없음
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

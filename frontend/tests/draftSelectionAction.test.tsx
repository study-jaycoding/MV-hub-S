// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardSelectionActionBar, LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import { GenerationCard } from "../src/components/GenerationCard";
import type { Generation } from "../src/types";

vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));

it("Draft 버튼은 Draft 생성물 하나를 골랐을 때만 선택 수 뒤에 보이고, 완료된 내 Draft 에만 동작한다", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const finish = vi.fn();
  const noop = () => {};
  const draft = { id: "draft", model: "seedance_2_5", status: "done", is_mine: true,
    job_id: "job", params: { draft: true }, deleted: false } as Generation;
  const render = (selected: Generation[], busy = false, done = false) => act(() => root.render(
    <BoardSelectionActionBar selected={selected} projects={[]} onShare={noop} onDownload={noop}
      onCompare={noop} onAssign={noop} onDelete={noop} onFinishDraft={finish} draftBusy={busy} draftDone={done} />,
  ));
  try {
    render([draft]);
    const button = () => host.querySelector<HTMLButtonElement>(".sb-draft")!;
    expect(host.querySelector(".sb-count")?.nextElementSibling).toBe(button());
    expect(button().disabled).toBe(false);
    act(() => button().click());
    expect(finish).toHaveBeenCalledExactlyOnceWith(draft);
    // Draft 가 아닌 하나·두 개 이상 선택에는 단추가 없다(Jay 10-22)
    for (const selected of [[{ ...draft, params: { resolution: "480p" } }], [{ ...draft, model: "nano_banana_flash" }], [draft, draft]]) {
      render(selected);
      expect(host.querySelector(".sb-draft")).toBeNull();
      expect(host.querySelector(".sb-count")).not.toBeNull();
    }
    // 남의 Draft 는 보이되 눌리지 않는다
    render([{ ...draft, is_mine: false }]);
    expect(button().disabled).toBe(true);
    render([draft], true);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    render([draft], false, true);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(button().title).toContain("이미 1080p");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

// Jay 10-22: 워크스페이스에서도 Draft 생성물을 하나 고르면 선택바에서 Draft 생성을 할 수 있어야 한다 — 캔버스 선택바와 같은 규칙.
it("라이브러리(워크스페이스) 선택바에도 같은 Draft 단추 — Draft 하나일 때만, 완료된 내 Draft 에만 동작", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const finish = vi.fn();
  const noop = () => {};
  const draft = { id: "draft", model: "seedance_2_5", status: "done", is_mine: true,
    job_id: "job", params: { draft: true }, deleted: false } as Generation;
  const render = (selected: Generation[], busy = false, done = false) => act(() => root.render(
    <LibrarySelectionActionBar selectedCount={selected.length} selectedGenerations={selected} projects={[]} onShare={noop}
      onDownload={noop} onResolveTransfer={noop} onResolveRetry={null} resolveRetryProjectName="" resolveTransferBusy={false}
      resolveTransferPendingCount={0} onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop}
      onFinishDraft={finish} draftBusy={busy} draftDone={done} />,
  ));
  try {
    render([draft]);
    const button = () => host.querySelector<HTMLButtonElement>(".sb-draft")!;
    expect(host.querySelector(".sb-count")?.nextElementSibling).toBe(button());
    act(() => button().click());
    expect(finish).toHaveBeenCalledExactlyOnceWith(draft);
    for (const selected of [[{ ...draft, params: { resolution: "480p" } }], [draft, { ...draft, id: "other" }]]) {
      render(selected);
      expect(host.querySelector(".sb-draft")).toBeNull();
    }
    render([{ ...draft, is_mine: false }]);
    expect(button().disabled).toBe(true);
    render([draft], false, true);
    expect(button().disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

// Jay 10-22: 캔버스 카드처럼 워크스페이스·'생성 결과' 창의 격자 카드에도 Draft 생성물 표시.
it("격자 카드에 Draft 생성물 표시 — Draft 만, 남의 카드는 작성자 배지 아래, 목록 보기에는 없다", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const noop = () => {};
  const base = {
    id: "g1", prompt: "test", shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-10-22",
    assets: [{ id: "a", generation_id: "g1", type: "video", file_path: "/media/a.mp4", thumbnail_path: null }],
    references: [], tags: [], auto_tags: [], deleted: false, model: "seedance_2_5", params: { draft: true }, job_id: "job",
  } as unknown as Generation;
  const render = (gen: Generation, layout: "grid" | "list" = "grid") => act(() => root.render(
    <GenerationCard gen={gen} tab="my" layout={layout} onSetSource={noop} onSetTags={noop} onOpenComments={noop}
      onRequestEdit={noop} onEditDone={noop} onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop}
      onUnfinalize={noop} onImport={noop} onRestore={noop} onInfo={noop} onPreview={noop} onToggleSelect={noop} />,
  ));
  const badge = () => host.querySelector<HTMLElement>(".card-thumb .linb-draft");
  try {
    render(base);
    expect(badge()?.textContent).toBe("Draft");
    expect(badge()?.classList.contains("below-creator")).toBe(false);
    render({ ...base, is_mine: false, creator_name: "리버" } as Generation);
    expect(badge()?.classList.contains("below-creator")).toBe(true); // 작성자 배지(오른쪽 위)와 겹치지 않게
    render({ ...base, params: { draft: true, draft_job_id: "done-job" } } as Generation); // 1080p 로 완성된 결과는 Draft 가 아니다
    expect(badge()).toBeNull();
    render({ ...base, model: "nano_banana_flash" } as Generation);
    expect(badge()).toBeNull();
    render(base, "list");
    expect(badge()).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

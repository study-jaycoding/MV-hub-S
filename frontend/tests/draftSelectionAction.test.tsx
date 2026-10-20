// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardSelectionActionBar } from "../src/components/app/SelectionActionBar";
import type { Generation } from "../src/types";

it("Draft 버튼은 선택 수 뒤에 오며 실제 완료된 내 Draft 한 개에만 동작한다", () => {
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
    for (const selected of [[{ ...draft, params: { resolution: "480p" } }], [draft, draft], [{ ...draft, is_mine: false }]]) {
      render(selected);
      expect(button().disabled).toBe(true);
    }
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

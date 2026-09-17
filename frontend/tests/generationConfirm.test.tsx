// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationConfirmOverlay } from "../src/components/generation/GenerationConfirmOverlay";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { GradeStepModal } from "../src/components/GradeStepModal";
import { computeGradeStep } from "../src/lib/gradeStep";
import { setLang } from "../src/lib/i18n";
import type { Generation } from "../src/types";

const noop = () => {};
const g = { id: "test", prompt: "fixture", shared: true, is_held: true, is_final: false, is_mine: true,
  status: "done", assets: [], references: [], tags: [], auto_tags: [] } as unknown as Generation;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLang("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.unstubAllGlobals(); });

it.each([
  ["share", false, false, "Share this result?"],
  ["share", true, false, "Remove sharing?"],
  ["final", true, false, "Mark as final (gold)?"],
  ["final", true, true, "Remove final status?"],
] as const)("legacy %s confirmation translates (shared=%s, final=%s)", (mode, shared, isFinal, question) => {
  act(() => root.render(<GenerationConfirmOverlay mode={mode} shared={shared} isFinal={isFinal} onYes={noop} onNo={noop}/>));
  expect(host.querySelector(".cs-final-q")?.textContent).toBe(question);
});

it("an open confirmation updates language and only submits once", () => {
  const yes = vi.fn();
  act(() => root.render(<GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={yes} onNo={noop}/>));
  expect(host.textContent).toContain("Remove sharing?");
  act(() => setLang("ko")); expect(host.textContent).toContain("공유 해제 할까요?");
  act(() => setLang("en")); expect(host.textContent).toContain("Remove sharing?");
  const button = host.querySelector<HTMLButtonElement>(".cs-final-yes")!;
  act(() => { button.click(); button.click(); }); expect(yes).toHaveBeenCalledTimes(1);
});

it.each(["no", "outside", "escape"])("legacy confirmation cancels via %s without mutation", (method) => {
  const no = vi.fn(), yes = vi.fn();
  act(() => root.render(<GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={yes} onNo={no}/>));
  act(() => {
    if (method === "no") host.querySelector<HTMLButtonElement>(".cs-final-no")!.click();
    else if (method === "outside") document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(no).toHaveBeenCalledTimes(1); expect(yes).not.toHaveBeenCalled();
});

it("history/canvas uses the translated confirmation and preserves its generation callback", () => {
  const yes = vi.fn(), no = vi.fn();
  act(() => root.render(<HistoryBoardNode generation={g} x={0} y={0} width={180} height={180} isRoot={false}
    isSelected={false} onLine={false} offLine={false} fill disabled={false} typeFilter="all" sharedOnly={false}
    commentOnly={false} finalOnly={false} sConfirm={{id:g.id,kind:"share"}} onSClick={noop} onSDouble={noop}
    onSConfirmYes={yes} onSConfirmNo={no} onPreview={noop} onInfo={noop} onRegenerate={noop}/>));
  expect(host.querySelector(".cs-final-q")?.textContent).toBe("Remove sharing?");
  act(() => host.querySelector<HTMLButtonElement>(".cs-final-yes")!.click());
  expect(yes).toHaveBeenCalledExactlyOnceWith(g); expect(no).not.toHaveBeenCalled();
});

it("bulk grade confirmation translates placeholders and reacts to language changes", () => {
  act(() => root.render(<GradeStepModal pending={computeGradeStep([g],"down",()=>true)} busy={false} onConfirm={noop} onCancel={noop}/>));
  expect(host.querySelector(".gradestep-title")?.textContent).toBe("Lower grade");
  expect(host.querySelector(".gradestep-body")?.textContent).toContain("Final→Shared, Shared/On hold→Unshared");
  expect(host.textContent).not.toMatch(/[가-힣]/);
  act(() => setLang("ko")); expect(host.textContent).toContain("단계 내리기");
  expect(host.textContent).toContain("최종→공유, 공유·보류→일반");
});

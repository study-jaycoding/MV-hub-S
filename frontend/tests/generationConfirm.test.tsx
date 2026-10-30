// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationReviewOverlay } from "../src/components/generation/GenerationReviewOverlay";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { GradeStepModal } from "../src/components/GradeStepModal";
import { computeGradeStep } from "../src/lib/gradeStep";
import { setLang } from "../src/lib/i18n";
import type { ReviewAction } from "../src/lib/generationReview";
import type { Generation } from "../src/types";

const noop = () => {};
const g = { id: "test", prompt: "fixture", shared: true, is_held: true, is_final: false, is_mine: true,
  status: "done", assets: [], references: [], tags: [], auto_tags: [] } as unknown as Generation;
const allowed = { unshared: true, shared: true, held: false, final: true };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLang("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.unstubAllGlobals(); });

const pick = (action: ReviewAction) => act(() => host.querySelector<HTMLButtonElement>(`.review-${action}`)!.click());

it.each([
  ["shared", "unshared", "Remove sharing?"],
  ["shared", "final", "Mark as final (gold)?"],
  ["final", "shared", "Return to shared?"],
] as const)("bulk %s menu asks a translated question after picking %s", (state, action, question) => {
  act(() => root.render(<GenerationReviewOverlay state={state} count={3} allowed={allowed} onAction={noop} onCancel={noop}/>));
  pick(action);
  expect(host.querySelector(".cs-final-q")?.textContent).toBe(question);
});

it("an open confirmation updates language and only submits once", () => {
  const yes = vi.fn();
  act(() => root.render(<GenerationReviewOverlay state="shared" count={3} allowed={allowed} onAction={yes} onCancel={noop}/>));
  pick("unshared");
  expect(host.textContent).toContain("Remove sharing?");
  act(() => setLang("ko")); expect(host.textContent).toContain("공유 해제 할까요?");
  act(() => setLang("en")); expect(host.textContent).toContain("Remove sharing?");
  const button = host.querySelector<HTMLButtonElement>(".cs-final-yes")!;
  act(() => { button.click(); button.click(); }); expect(yes).toHaveBeenCalledTimes(1);
});

it.each(["no", "outside", "escape"])("confirmation cancels via %s without mutation", (method) => {
  const no = vi.fn(), yes = vi.fn();
  act(() => root.render(<GenerationReviewOverlay state="shared" count={3} allowed={allowed} onAction={yes} onCancel={no}/>));
  pick("unshared");
  act(() => {
    if (method === "no") host.querySelector<HTMLButtonElement>(".cs-final-no")!.click();
    else if (method === "outside") document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(no).toHaveBeenCalledTimes(1); expect(yes).not.toHaveBeenCalled();
});

it("history/canvas uses the same picker and hands back the generation with the picked action", () => {
  const yes = vi.fn(), no = vi.fn();
  act(() => root.render(<HistoryBoardNode generation={g} x={0} y={0} width={180} height={180} isRoot={false}
    isSelected={false} onLine={false} offLine={false} fill disabled={false} typeFilter="all" sharedOnly={false}
    commentOnly={false} finalOnly={false} sConfirm={{id:g.id}} onSClick={noop}
    onSConfirmYes={yes} onSConfirmNo={no} onPreview={noop} onInfo={noop} onRegenerate={noop}/>));
  expect([...document.querySelectorAll(".s-pick-item")].map((button) => button.textContent)).toEqual(["Final", "Unshare"]);
  expect(host.querySelector(".linb-node")!.classList.contains("s-picking")).toBe(true);
  act(() => document.querySelector<HTMLButtonElement>(".s-pick .review-unshared")!.click());
  expect(yes).toHaveBeenCalledExactlyOnceWith(g, "unshared"); expect(no).not.toHaveBeenCalled();
});

it("bulk grade confirmation translates placeholders and reacts to language changes", () => {
  act(() => root.render(<GradeStepModal pending={computeGradeStep([g],"down",()=>true)} busy={false} onConfirm={noop} onCancel={noop}/>));
  expect(host.querySelector(".gradestep-title")?.textContent).toBe("Lower grade");
  expect(host.querySelector(".gradestep-body")?.textContent).toContain("Final→Shared, Shared/On hold→Unshared");
  expect(host.textContent).not.toMatch(/[가-힣]/);
  act(() => setLang("ko")); expect(host.textContent).toContain("단계 내리기");
  expect(host.textContent).toContain("최종→공유, 공유·보류→일반");
});

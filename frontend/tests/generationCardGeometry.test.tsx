// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationCard } from "../src/components/GenerationCard";
import type { Generation } from "../src/types";

vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => () => "Test model" }));
const noop = () => {};
const css = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}.css`, import.meta.url), "utf8");
const generationsCss = css("generations");
const resolveCss = css("resolve-library");
const allCss = css("base") + generationsCss + resolveCss + css("history");
const props = (layout: "grid" | "list" = "grid"): ComponentProps<typeof GenerationCard> => ({
  gen: { id: "gold", prompt: "test", shared: true, is_final: true, is_mine: true, status: "done",
    created_at: "2026-09-17", assets: [], references: [], tags: [], auto_tags: [], deleted: false } as unknown as Generation,
  tab: "team", layout, selected: true, resolveHighlighted: true,
  onSetSource: noop, onSetTags: noop, onOpenComments: noop, onRequestEdit: noop, onEditDone: noop,
  onRegenerate: noop, onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop,
  onReview: noop, onImport: noop, onRestore: noop, onInfo: noop, onPreview: noop,
});
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(["grid", "list"] as const)("%s: gold star is centered, and all content shares one rounded clip", (layout) => {
  act(() => root.render(<><style>{allCss}</style><div className="gen-cell"><GenerationCard {...props(layout)} /></div></>));
  const button = host.querySelector<HTMLButtonElement>(".card-sf.final")!;
  const icon = button.querySelector<SVGElement>(".card-final-star")!;
  const buttonStyle = getComputedStyle(button);
  expect(buttonStyle.display).toBe("inline-flex");
  expect(buttonStyle.alignItems).toBe("center"); expect(buttonStyle.justifyContent).toBe("center");
  expect(buttonStyle.padding).toBe("0px"); expect(buttonStyle.position).toBe("relative");
  expect(getComputedStyle(icon).display).toBe("block");
  expect(getComputedStyle(icon).width).toBe("1em"); expect(getComputedStyle(icon).height).toBe("1em");
  // 도형 경계가 viewBox 양끝에 맞아 글꼴 baseline/여백에 영향을 받지 않는다.
  const points = icon.querySelector("polygon")!.getAttribute("points")!.split(" ").map((point) => point.split(",").map(Number));
  expect([Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))]).toEqual([2, 0, 98, 91]);
  expect(icon.getAttribute("viewBox")).toBe("2 0 96 91");
  act(() => button.click());
  expect(getComputedStyle(host.querySelector(".card-clip > .sconfirm")!).borderRadius).toBe("0");
  expect(getComputedStyle(host.querySelector(".card")!).borderRadius).toBe("14px");
  expect(getComputedStyle(host.querySelector(".card")!).overflow).toBe("visible");
  expect(host.querySelector(".card")!.children).toHaveLength(1);
  const clip = getComputedStyle(host.querySelector(".card-clip")!);
  expect(clip.clipPath).toBe("inset(2px round 11px)");
  expect(["", "0", "0px"]).toContain(clip.borderRadius);
  expect(host.querySelector(".card.selected.resolve-highlighted")).not.toBeNull();
});

it("selection reveals one frame surface without a second stroke, while focus/Resolve glows remain", () => {
  expect(generationsCss).not.toContain(".card.selected::after");
  expect(generationsCss).toContain("clip-path: inset(2px round 11px)");
  expect(generationsCss).toContain("0 0 0 2px #fff, 0 0 0 4px var(--accent)");
  expect(resolveCss).toContain("inset 0 0 0 2px #ff304f, 0 0 0 2px #ff304f, 0 0 18px 5px rgba(255, 48, 79, 0.72)");
});

it.each(["grid", "list"] as const)("%s: selection keeps frame padding and content layout unchanged", (layout) => {
  // jsdom은 var()가 든 border 축약값을 longhand 폭으로 풀지 못한다. 색만 치환하고 폭은 실제 CSS로 검사한다.
  const layoutCss = allCss.replaceAll("var(--border)", "rgba(255, 255, 255, 0.08)");
  const render = (selected: boolean) => act(() => root.render(<><style>{layoutCss}</style>
    <div className="gen-cell focused"><GenerationCard {...props(layout)} selected={selected} /></div></>));
  const contentInsets = (style: CSSStyleDeclaration) => ["Top", "Right", "Bottom", "Left"].map((side) =>
    parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) +
    (parseFloat(style.getPropertyValue(`padding-${side.toLowerCase()}`)) || 0));
  render(false);
  const original = getComputedStyle(host.querySelector(".card")!);
  expect(getComputedStyle(host.querySelector(".card-clip")!).clipPath).toBe("inset(0 round 13px)");
  const originalInsets = contentInsets(original);
  expect(originalInsets).toEqual([1, 1, 1, 1]);
  render(true);
  const selected = getComputedStyle(host.querySelector(".card")!);
  expect(selected.borderWidth).toBe("0px");
  expect(selected.padding).toBe("1px");
  expect(contentInsets(selected)).toEqual(originalInsets);
  expect(selected.boxSizing).toBe("border-box");
  expect(selected.borderRadius).toBe(original.borderRadius);
  render(false);
  expect(contentInsets(getComputedStyle(host.querySelector(".card")!))).toEqual(originalInsets);
});

it("review menu fills the card with three equal rows and no size cap", () => {
  act(() => root.render(<><style>{allCss}</style><GenerationCard {...props()} /></>));
  act(() => host.querySelector<HTMLButtonElement>(".card-sf")!.click());
  expect(getComputedStyle(host.querySelector(".review-option")!).minHeight).toBe("30px");
  expect(getComputedStyle(host.querySelector(".review-option-name")!).fontSize).toBe("12px");
  expect(getComputedStyle(host.querySelector(".review-option-icon")!).width).toBe("21px");
  expect(host.querySelector(".review-option-detail")).toBeNull();
  expect(getComputedStyle(host.querySelector(".review-option-label")!).whiteSpace).toBe("nowrap");
  expect(getComputedStyle(host.querySelector(".review-panel")!).width).toBe("100%");
  expect(getComputedStyle(host.querySelector(".review-panel")!).height).toBe("100%");
  const optionsStyle = getComputedStyle(host.querySelector(".review-options")!);
  expect(optionsStyle.display).toBe("grid");
  expect(optionsStyle.gridTemplateRows).toBe("repeat(3, minmax(30px, 1fr))");
  expect(optionsStyle.flexGrow).toBe("1");
  expect(generationsCss).toContain("container-type: inline-size");
  // 긴 리스트에서 폭만으로 글자를 키우면 3행이 카드 높이를 넘어간다. 짧은 변을 사용한다.
  expect(getComputedStyle(host.querySelector(".review-confirm")!).containerType).toBe("size");
  expect(generationsCss).toContain("font-size: max(12px, 6cqmin)");
  expect(generationsCss).toContain("width: max(21px, 10cqmin)");
  expect(generationsCss).toContain("gap: max(4px, 1.5cqmin)");
  expect(generationsCss).not.toContain("width: min(360px");
  expect(generationsCss).not.toContain("height: clamp(30px, 12cqw, 54px)");
});

it("confirmation uses the full panel width with equal Yes/No buttons, without the menu's full height", () => {
  act(() => root.render(<><style>{allCss}</style><GenerationCard {...props()} /></>));
  act(() => host.querySelector<HTMLButtonElement>(".card-sf")!.click());
  act(() => host.querySelector<HTMLButtonElement>(".review-unshared")!.click());
  expect(host.querySelector(".review-menu")).toBeNull();
  expect(getComputedStyle(host.querySelector(".review-panel")!).width).toBe("100%");
  const actionsStyle = getComputedStyle(host.querySelector(".cs-final-actions")!);
  expect(actionsStyle.width).toBe("100%");
  expect(actionsStyle.display).toBe("flex");
  for (const button of host.querySelectorAll(".cs-final-actions button")) {
    const style = getComputedStyle(button);
    expect(style.flexGrow).toBe("1");
    expect(style.flexBasis).toBe("0%");
    expect(style.height).toBe("28px");
  }
});

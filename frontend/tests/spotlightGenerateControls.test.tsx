// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpotlightGenerateControls } from "../src/components/spotlight/SpotlightGenerateControls";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = (count: number, cost: number | null, costLoading = false) => act(() => root.render(
  <SpotlightGenerateControls count={count} maxCount={4} setCount={() => {}} busy={false} cost={cost} costLoading={costLoading}
    onSubmit={() => {}}><span /></SpotlightGenerateControls>));

describe("Generate 장수 — 크레딧 배지 모서리 빨간 숫자(Jay 2026-10-28 시안 B)", () => {
  it("keeps the label plain and shows the count on the credit badge only for two or more", () => {
    show(1, 28);
    const gen = () => host.querySelector(".sl-gen")!;
    expect(gen().textContent).toBe("Generate ✦28");
    expect(host.querySelector(".sl-count-dot")).toBeNull();
    show(2, 28);
    expect(host.querySelector(".sl-cost")!.textContent).toBe("56");
    expect(host.querySelector(".sl-cost-wrap .sl-count-dot")!.textContent).toBe("2");
    expect(gen().textContent!.startsWith("Generate ✦")).toBe(true); // "Generate 2" 가 아니다
  });
  it("still shows the count while the price is loading or unknown", () => {
    show(3, null, true);
    expect(host.querySelector(".sl-count-dot")!.textContent).toBe("3");
    show(3, null);
    expect(host.querySelector(".sl-cost")).toBeNull();
    expect(host.querySelector(".sl-count-dot")!.textContent).toBe("3");
  });
});

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightDurationChip } from "../src/components/spotlight/SpotlightDurationChip";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const show = (props: Partial<React.ComponentProps<typeof SpotlightDurationChip>>) => act(() => root.render(
  <SpotlightDurationChip value={4} min={4} max={30} open={false} onToggle={() => {}} onChange={() => {}} {...props} />));
const slide = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const marks = () => [...host.querySelectorAll<HTMLSpanElement>(".sl-dur-marks span")].map((s) => [s.textContent, s.style.left]);

describe("길이 칩 — 칩엔 값만, 누르면 위에 눈금 슬라이더 창", () => {
  it("shows only the value until opened, then a 1-second slider with marks at their real positions", () => {
    const onToggle = vi.fn();
    const onChange = vi.fn();
    show({ onToggle, onChange });
    expect(host.querySelector("button")!.textContent).toBe("4s");
    expect(host.querySelector(".sl-dur-pop")).toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    show({ onToggle, onChange, open: true });
    const input = host.querySelector<HTMLInputElement>(".sl-dur-pop input")!;
    expect([input.min, input.max, input.value]).toEqual(["4", "30", "4"]);
    expect(marks()).toEqual([["4", "0%"], ["10", "23.08%"], ["15", "42.31%"], ["20", "61.54%"], ["30", "100%"]]);
    slide(input, "12");
    expect(onChange).toHaveBeenCalledWith(12);
  });
  it("moves only between a model's fixed lengths", () => {
    const onChange = vi.fn();
    show({ value: 10, min: 5, max: 15, stops: [5, 10, 15], open: true, onChange });
    const input = host.querySelector<HTMLInputElement>(".sl-dur-pop input")!;
    expect([input.min, input.max, input.value]).toEqual(["0", "2", "1"]);
    expect(marks()).toEqual([["5", "0%"], ["10", "50%"], ["15", "100%"]]);
    slide(input, "2");
    expect(onChange).toHaveBeenCalledWith(15);
  });
  it("cannot be opened while the value is ignored or locked", () => {
    show({ ignored: true, open: true });
    const chip = host.querySelector("button")!;
    expect(chip.disabled).toBe(true);
    expect(chip.classList.contains("sl-opt-ignored")).toBe(true);
    expect(host.querySelector(".sl-dur-pop")).toBeNull();
    show({ disabled: true, open: true });
    expect(host.querySelector(".sl-dur-pop")).toBeNull();
  });
});

// @vitest-environment jsdom
// 고급(Set) 창(Jay 2026-10-28) — 칩 이름 Set, 창 안은 한글 없이 영어로만(값은 CLI 값 그대로).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("shows English names and raw CLI values in the advanced panel, Korean only as hover text", () => {
  const setOpt = vi.fn();
  act(() => root.render(
    <SpotlightOptionsBar type="video" setType={() => {}} model="seedance_2_5" setModel={() => {}} onPickModel={() => {}}
      modelName="Seedance 2.5" typeModels={[]} constraints={{}} optionValues={{ bitrate_mode: "high" }} setOptionValues={() => {}}
      setOpt={setOpt} open="advanced" setOpen={() => {}}
      tunable={[
        { name: "mode", type: "string", default: "t2v", enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
        { name: "bitrate_mode", type: "string", default: "standard", enum: ["standard", "high"] },
      ] as never} />));
  const pop = host.querySelector(".sl-adv-pop")!;
  expect(pop.querySelector(".sl-dd-title")!.textContent).toBe("Advanced Options");
  expect([...pop.querySelectorAll(".sl-adv-label")].map((l) => l.textContent)).toEqual(["Mode", "Bitrate"]);
  const values = [...pop.querySelectorAll<HTMLButtonElement>(".sl-adv-opt")];
  expect(values.map((b) => b.textContent)).toEqual(["t2v", "omni_reference", "video_edit", "video_extension", "standard", "high"]);
  const high = values.find((b) => b.textContent === "high")!;
  expect(high.classList.contains("sel")).toBe(true);
  expect(high.title).toBe(""); // 한글 설명도 띄우지 않는다
  expect(/[가-힣]/.test(pop.textContent ?? "")).toBe(false); // 창 안은 영어로만
  expect([...host.querySelectorAll("button")].find((b) => b.title.startsWith("고급 옵션"))!.textContent).toBe("Set›");
  act(() => values.find((b) => b.textContent === "video_edit")!.click());
  expect(setOpt).toHaveBeenCalledWith("mode", "video_edit");
});

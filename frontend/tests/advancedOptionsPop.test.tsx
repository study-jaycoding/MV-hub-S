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
  const setOpt = vi.fn(); // 고른 뒤 창을 닫는 길 — Set 창 값은 이걸 쓰지 않는다
  let values: Record<string, unknown> = { bitrate_mode: "high" };
  const setOptionValues = vi.fn((next: unknown) => { values = typeof next === "function" ? next(values) : next as Record<string, unknown>; });
  act(() => root.render(
    <SpotlightOptionsBar type="video" setType={() => {}} model="seedance_2_5" setModel={() => {}} onPickModel={() => {}}
      modelName="Seedance 2.5" typeModels={[]} constraints={{}} optionValues={{ bitrate_mode: "high" }} setOptionValues={setOptionValues as never}
      setOpt={setOpt} open="advanced" setOpen={() => {}}
      tunable={[
        { name: "mode", type: "string", default: "t2v", enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
        { name: "bitrate_mode", type: "string", default: "standard", enum: ["standard", "high"] },
      ] as never} />));
  const pop = host.querySelector(".sl-adv-pop")!;
  expect(pop.querySelector(".sl-dd-title")!.textContent).toBe("Advanced Options");
  const labels = [...pop.querySelectorAll<HTMLElement>(".sl-adv-label")];
  expect(labels.map((l) => l.querySelector(".sl-adv-name")!.textContent)).toEqual(["Mode", "Bitrate"]);
  // 이름에 마우스를 올리면 앱 모양 설명 상자 — 이름·설명 + 값마다 한 줄(브라우저 기본 말풍선은 쓰지 않는다)
  const help = labels[0].querySelector<HTMLElement>('.sl-adv-help[role="tooltip"]')!;
  expect(labels[0].title).toBe("");
  expect(help.querySelector("b")!.textContent).toBe("모드");
  expect(help.querySelector("p")!.textContent).toBe("어떤 방식으로 만들지 고릅니다.");
  expect([...help.querySelectorAll("dt")].map((d) => `${d.textContent}: ${d.nextElementSibling!.textContent}`)).toEqual([
    "t2v: 글만으로 만들기", "omni_reference: 넣은 이미지·영상·오디오를 참고해 만들기", "video_edit: 넣은 영상 1개를 고치기",
    "video_extension: 넣은 영상 앞·뒤로 이어 붙이기"]);
  expect(labels[1].querySelector(".sl-adv-help")!.textContent).toContain("더 선명하게(파일이 큼)");
  const buttons = [...pop.querySelectorAll<HTMLButtonElement>(".sl-adv-opt")];
  expect(buttons.map((b) => b.textContent)).toEqual(["t2v", "omni_reference", "video_edit", "video_extension", "standard", "high"]);
  const high = buttons.find((b) => b.textContent === "high")!;
  expect(high.classList.contains("sel")).toBe(true);
  expect(high.title).toBe(""); // 한글 설명도 띄우지 않는다
  const shown = pop.cloneNode(true) as HTMLElement;
  shown.querySelectorAll(".sl-adv-help").forEach((h) => h.remove()); // 마우스를 올릴 때만 뜨는 한국어 설명은 빼고
  expect(/[가-힣]/.test(shown.textContent ?? "")).toBe(false); // 창 안은 영어로만
  expect([...host.querySelectorAll("button")].find((b) => b.title.startsWith("고급 옵션"))!.textContent).toBe("Set›");
  act(() => buttons.find((b) => b.textContent === "video_edit")!.click());
  expect(values).toEqual({ bitrate_mode: "high", mode: "video_edit" });
  expect(setOpt).not.toHaveBeenCalled(); // 값을 눌러도 Set 창은 열린 채(Esc·바깥 누름으로만 닫힘)
  // 이름에 키보드 초점이 가고, 이름이 자기 설명 상자를 가리킨다(Codex E-4 — 마우스만이던 것)
  expect(labels.every((l) => l.tabIndex === 0)).toBe(true);
  expect(document.getElementById(labels[0].getAttribute("aria-describedby")!)).toBe(help);
});

it("길이 선택지에 숫자가 아닌 값(auto)이 있으면 막대 대신 값 목록 — 고른 값을 원문 그대로(Codex E-2)", () => {
  const setOpt = vi.fn();
  act(() => root.render(
    <SpotlightOptionsBar type="video" setType={() => {}} model="seedance_2_5" setModel={() => {}} onPickModel={() => {}}
      modelName="Seedance 2.5" typeModels={[]} constraints={{}} optionValues={{ duration: "5" }} setOptionValues={vi.fn() as never}
      setOpt={setOpt} open="duration" setOpen={() => {}}
      tunable={[{ name: "duration", type: "string", default: "5", enum: ["auto", "5", "10"] }] as never} />));
  expect(host.querySelector(".sl-dur-track")).toBeNull();
  const items = [...host.querySelectorAll<HTMLButtonElement>(".sl-dropdown .sl-dd-item")];
  expect(items.map((b) => b.textContent)).toEqual(["auto", "5", "10"]);
  act(() => items[0].click());
  expect(setOpt).toHaveBeenCalledWith("duration", "auto");
});

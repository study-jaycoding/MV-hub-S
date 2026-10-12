// @vitest-environment jsdom
// 프롬프트 옵션의 정수 칸(고급 옵션의 seed 등) — 정확히 담을 수 없는 큰 정수는 받지 않는다(조작 규칙 49 — 22회차, Codex 코드 리뷰).
// `Number("9007199254740993")` 은 …992 다. 받으면 친 것과 다른 값이 제출된다.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";
import type { ModelParam } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("고급 옵션의 정수 칸 — 2^53 을 넘는 정수는 들어가지 않고(다른 수로 바뀌어 저장되지 않는다), 그 아래는 그대로 받는다", () => {
  let values: Record<string, string | number | boolean> = {};
  function Bar() {
    const [optionValues, setOptionValues] = useState<Record<string, string | number | boolean>>({ seed: 7 });
    values = optionValues;
    return (
      <SpotlightOptionsBar type="image" setType={() => {}} model="fixture_model" setModel={() => {}} onPickModel={() => {}} modelName="Fixture"
        typeModels={[]} tunable={[{ name: "seed", type: "integer" } as ModelParam]} constraints={{}} optionValues={optionValues}
        setOptionValues={setOptionValues} setOpt={() => {}} open="advanced" setOpen={() => {}} />
    );
  }
  act(() => root.render(<Bar />));
  const input = () => host.querySelector<HTMLInputElement>("input.sl-adv-num")!;
  const type = (text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input().value).toBe("7");
  type("9007199254740993"); // 붙여 넣었다
  expect([values.seed, input().value]).toEqual([7, "7"]); // 전엔 9007199254740992 가 들어갔다
  type("9007199254740991"); // 정확히 담기는 가장 큰 정수
  expect(values.seed).toBe(9007199254740991);
  type(""); // 비우는 것은 종전대로
  expect(values.seed).toBe("");
});

// 최종(골드) 광택의 CSS 계약 — 가만히 열어 둔 탭이 CPU 를 계속 쓰지 않게 한다.
// 종전의 `background-position` 무한 애니메이션은 골드 카드 한 장만 있어도 브라우저가 매 프레임 다시 그리게 했다
// (격리 실측: 골드 0장 1% · 1장 24~38% · 모션 끄기 0.3% of one core). CPU 자체는 여기서 못 잰다 — 원인이 된 CSS 모양만 막는다.
// 계약만 본다(이름·시간·정확한 문법은 묶지 않는다): ①골드 요소의 애니메이션은 끝없이 돌지 않고 기본 상태에는 없다
// ②그 키프레임은 합성 가능한 속성(transform·opacity)만 움직인다 ③모션 끄기에서 멈춘다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const generations = read("generations.css");
const all = generations + "\n" + read("history.css");
const GOLD = [".card-sf.final", ".card-colorbar.final", ".linb-colorbar.final"];

/** `selector { body }` 블록들(@media 안의 규칙 포함) — 선택자에 골드 요소가 든 것만. */
const goldRules = [...all.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }))
  .filter((r) => GOLD.some((g) => r.selector.includes(g)));
const animated = goldRules.filter((r) => /animation(-name)?\s*:/.test(r.body) && !/animation\s*:\s*none/.test(r.body));

describe("골드 광택 CSS", () => {
  it("골드 요소는 끝없이 돌지 않고, 기본 상태에는 애니메이션이 없다", () => {
    expect(animated.length).toBeGreaterThan(0); // 빛 자체가 사라진 것도 회귀다
    for (const rule of animated) {
      expect(rule.body).not.toMatch(/infinite/);
      for (const part of rule.selector.split(",")) expect(part).toMatch(/:hover|:focus-visible|:focus-within/);
    }
    // 세 자리 모두 빛이 연결돼 있다: ★ · 카드 하단 띠 · 히스토리 노드 띠
    for (const gold of GOLD) expect(animated.some((r) => r.selector.includes(gold))).toBe(true);
  });

  it("골드 애니메이션의 키프레임은 합성 가능한 속성만 움직인다", () => {
    const names = new Set(animated.flatMap((r) => [...r.body.matchAll(/animation(?:-name)?\s*:\s*([A-Za-z_][\w-]*)/g)].map((m) => m[1])));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      const frames = all.match(new RegExp(`@keyframes\\s+${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*)\\s*\\}`));
      expect(frames, `@keyframes ${name}`).not.toBeNull();
      const properties = new Set([...frames![1].matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]));
      for (const property of properties) expect(["transform", "opacity"]).toContain(property);
    }
  });

  it("골드 요소에 will-change 를 상시로 걸지 않는다", () => {
    for (const rule of goldRules) expect(rule.body).not.toMatch(/will-change/);
  });

  it("모션 끄기(앱 설정·OS 설정)는 세 자리의 빛을 모두 멈춘다", () => {
    const app = goldRules.filter((r) => r.selector.includes(".reduce-motion")).map((r) => ({ ...r, stops: /animation\s*:\s*none/.test(r.body) }));
    for (const gold of GOLD) expect(app.some((r) => r.stops && r.selector.includes(gold))).toBe(true);
    const media = [...generations.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((m) => m[1]).join("\n");
    for (const gold of GOLD) expect(media).toMatch(new RegExp(`${gold.replace(/\./g, "\\.")}[^{}]*\\{[^{}]*animation\\s*:\\s*none`));
  });
});

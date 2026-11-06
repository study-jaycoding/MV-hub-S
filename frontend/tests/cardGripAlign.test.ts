// 카드 재사용 단추(⠿)는 S·T·C 줄 바로 밑에 S 와 같은 크기로(Jay 2026-11-06 1안). jsdom 은 CSS 를 겹쳐 계산하지 않아
// 규칙의 숫자를 읽어 자리를 계산한다 — 실제 화면 좌표는 격리 크롬 실측(Ctrl 카드 ⠿ 왼쪽 = S 왼쪽, 위 간격 = 옆 간격)이 맡는다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const gen = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
const assets = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
const px = (block: string, prop: string) => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(block);
  if (!m) throw new Error(`${prop} 없음: ${block.slice(0, 120)}`);
  return Number(m[1]);
};
const block = (css: string, selector: RegExp) => {
  const m = selector.exec(css);
  if (!m) throw new Error(`규칙 없음: ${selector}`);
  return m[1];
};

describe("카드 재사용 단추 정렬", () => {
  it("보통 카드 — ⠿ 의 top 은 S 줄 top + S 크기 + 간격, 크기·왼쪽은 S 와 같다", () => {
    const tl = block(gen, /\n\.card-tl \{([^}]*)\}/);
    const btn = block(gen, /\n\.card-sf, \.card-cm \{([^}]*)\}/);
    const grip = block(gen, /\n\.card-drag-grip \{([^}]*)\}/);
    expect(px(grip, "top")).toBe(px(tl, "top") + px(btn, "height") + px(tl, "gap"));
    expect(px(grip, "left")).toBe(px(tl, "left"));
    expect(px(grip, "width")).toBe(px(btn, "width"));
  });

  it("좁은 카드(@container 130px 이하) — ⠿ 도 줄어든 S 와 같은 크기·같은 간격", () => {
    const narrow = gen.slice(gen.indexOf("@container (max-width: 130px)"));
    const body = narrow.slice(0, narrow.indexOf("\n}") + 2);
    const tl = block(gen, /\n\.card-tl \{([^}]*)\}/);
    const gap = px(block(body, /\.card-tl \{([^}]*)\}/), "gap");
    const btn = block(body, /\.card-sf, \.card-cm \{([^}]*)\}/);
    const grip = block(body, /\.card-drag-grip \{([^}]*)\}/);
    expect(px(grip, "width")).toBe(px(btn, "width"));
    expect(px(grip, "height")).toBe(px(btn, "height"));
    expect(px(grip, "top")).toBe(px(tl, "top") + px(btn, "height") + gap);
  });

  it("Ctrl 카드 — 단추 하나하나가 아니라 S·T·C 묶음과 ⠿ 에 같은 배율", () => {
    expect(assets).toMatch(/\.mp-card-layer :is\(\.card-tl, \.card-drag-grip\) \{ zoom: 1\.3; \}/);
    const buttons = block(assets, /\.mp-card-layer :is\(\.card-sf, \.card-cm, \.card-drag-grip\) \{([^}]*)\}/);
    expect(buttons).not.toMatch(/zoom/);
  });
});

// 워크스페이스 그리드 날짜 줄 아래 12px(Jay 2026-10-30) — 가상 격자는 줄 사이 간격이 카드 줄 아래쪽에만 있어 카드가 날짜 밑줄에 붙었다.
// virtua 는 바깥 여백(margin)을 줄 높이로 재지 않으므로 날짜 줄 안쪽 여백으로 자리를 내고, 밑줄은 그 위에(::after) 그린다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const body = (selector: string) => {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  expect(m, selector).not.toBeNull();
  return m![1];
};

it("가상 격자 카드 보기의 날짜 줄은 아래 12px 을 안쪽 여백으로 낸다(바깥 여백 아님) · 밑줄은 그 위", () => {
  const head = body(".gen-grid-virtual:not(.as-list) .gen-date-header");
  expect(head).toMatch(/border-bottom: 0/);
  expect(head).toMatch(/padding-bottom: 19px/); // 6 + 밑줄 1 + 12
  expect(head).not.toMatch(/margin/);
  const line = body(".gen-grid-virtual:not(.as-list) .gen-date-header::after");
  expect(line).toMatch(/bottom: 12px/);
  expect(line).toMatch(/border-bottom: 1px solid var\(--border\)/);
  expect(body(".gen-vrow-grid")).toMatch(/gap: 12px; padding-bottom: 12px/); // 카드 줄 사이 간격과 같은 값
  // 다른 화면(리스트·Assets·Resolve 목록)이 쓰는 기본 날짜 줄은 그대로
  expect(body(".gen-date-header")).toMatch(/padding: 16px 2px 6px; margin-top: 2px;\s*border-bottom: 1px solid var\(--border\)/);
});

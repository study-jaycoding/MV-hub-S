// 연결점 고리(.scene-port)는 늘 연결선 끝점(.scene-dot) 가운데에 선다 — Jay 2026-10-29 "원 안의 점은 정렬이 항상 맞춰져야 한다".
//  점 = SceneBoard 가 카드 좌표 + PORT_GAP 으로 그린다. 고리 = 카드 안 absolute 라 기준이 '카드 테두리 안쪽'이다.
//  그래서 고리 자리는 PORT_GAP·고리 반지름·카드 테두리 두께(--bw)로 계산하고, 카드 테두리는 늘 --bw 로만 정한다.
//  전엔 테두리를 2px 로 못박아 테두리 없는 카드(결과 든 생성·Comfy)에서 2px 어긋났다. 실제 그림 자리는 jsdom 이 못 재므로
//  (헤드리스 크롬 실측은 docs/status/캔버스_연결선_점_2026-10-29.md) 여기서는 그 약속이 깨지지 않는지 CSS 원문으로 본다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const cssFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith(".css") ? [p] : [];
  });
type Rule = { file: string; selectors: string[]; decls: [string, string][] };
const rules: Rule[] = cssFiles(SRC).flatMap((file) =>
  [...readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    file,
    selectors: m[1].split(",").map((s) => s.trim()),
    decls: m[2].split(";").flatMap((d) => {
      const i = d.indexOf(":");
      return i < 0 ? [] : [[d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string]];
    }),
  })),
);
const subjectOf = (selector: string) => selector.split(/\s+|>|\+|~/).filter(Boolean).pop() || "";
const CARD = /\.scene-card(?:-(?:ref|gen|text|set|model|list|view|render|comfy|input|output|head))?(?![\w-])/;
const isCard = (selector: string) => !selector.includes("::") && CARD.test(subjectOf(selector));
const isPort = (selector: string) => !selector.includes("::") && /\.scene-port(?![\w-])/.test(subjectOf(selector));

it("카드 테두리 두께는 늘 --bw 로 정한다 — 숫자로 바로 쓰면 고리 자리와 어긋난다", () => {
  const BORDER = /^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style))?$/;
  const bad = rules.flatMap((r) =>
    r.selectors.some(isCard)
      ? r.decls.filter(([p, v]) => BORDER.test(p) && !v.includes("var(--bw)")).map(([p, v]) => `${r.selectors.join(", ")} { ${p}: ${v} }`)
      : [],
  );
  expect(bad).toEqual([]);
});

it("노드 틀 통일(Jay 2026-10-29, 10-30 2px) — 모든 노드 2px · 평소 자기 색 35% · 고르면 같은 2px 불투명(바깥 링 없음) · 방금 생성도 불투명", () => {
  const one = (selector: string) => rules.find((r) => r.selectors.length === 1 && r.selectors[0] === selector)?.decls ?? [];
  const own = "var(--pc, var(--accent))";
  expect(one(".scene-card")).toEqual(expect.arrayContaining([
    ["--bw", "2px"],
    ["border", "var(--bw) solid transparent"], // 안 B(Jay 2026-10-30): 평소 테두리는 안 보인다 — 올림 65% · 고름 불투명
  ]));
  expect(one(".scene-card:hover")).toContainEqual(["border-color", `color-mix(in srgb, ${own} 65%, transparent)`]);
  // 서버에 없는 레퍼런스·리스트(빨강)도 같은 규칙 — 평소 빨강을 칠하는 규칙이 없고, 올림 65% · 고름 불투명만(Jay 2026-10-30)
  const offPlain = rules.filter((r) => r.selectors.some((s) => /off-server$/.test(s) && !s.includes(".sel")) && r.decls.some(([p]) => p === "border-color"));
  expect(offPlain.map((r) => r.selectors.join(", "))).toEqual([]);
  expect(rules.find((r) => r.selectors.includes(".scene-card-ref.off-server:hover"))?.decls).toContainEqual(["border-color", "color-mix(in srgb, #ff6b6b 65%, transparent)"]);
  expect(one(".scene-card.sel.off-server")).toContainEqual(["border-color", "#ff6b6b"]);
  // 빈 원(선택 안 한 카드의 연결 없는 칸)은 입력이 하나라도 이어진 쪽에서만 — 출력 쪽·연결 없는 입력 쪽은 숨긴다
  const idle = rules.find((r) => r.decls.some(([p, v]) => p === "--ring" && v === "10px"))!;
  expect(idle.selectors.length).toBeGreaterThan(0);
  for (const s of idle.selectors) {
    expect(s, s).toContain('[data-linked~="in"]');
    expect(subjectOf(s), s).toMatch(/^\.scene-port\.in\.lane-/);
  }
  expect(one(".scene-card.sel")).toContainEqual(["border-color", own]);
  expect(one(".scene-card.sel").some(([p]) => p === "box-shadow")).toBe(false); // 바깥 링을 되살리지 않는다
  expect(one(".scene-card.glow")).toContainEqual(["border-color", own]);
  expect(one(".scene-textfloat").find(([p]) => p === "box-shadow")?.[1]).toMatch(/^0 0 0 2px var\(--pc, var\(--accent\)\)/); // 텍스트 큰 편집 창도 자기 색·노드 틀 두께
  expect(one(".scene-card.has-node .linb-node:not(.final)").find(([p]) => p === "border")?.[1]).toMatch(/^2px solid /); // 결과 노드 틀도 같은 두께
  // 그룹 틀(Jay 2026-10-30): 평소 선·빛 없음(2px 자리만 투명) · 고르면 밝힌 선 2px + 빛(바깥 링 0 0 0 Npx 없음) · 머리줄 아래 줄 없음 · 개수 배지 그룹 색
  expect(one(".scene-group")).toContainEqual(["border", "2px solid transparent"]);
  expect(one(".scene-group").some(([p]) => p === "box-shadow")).toBe(false);
  expect(one(".scene-group.selected")).toContainEqual(["border-color", "var(--g-lit)"]);
  expect(one(".scene-group.selected").find(([p]) => p === "box-shadow")?.[1]).not.toMatch(/0 0 0 \d/);
  expect([...one(".scene-group-hd"), ...one(".scene-group.selected .scene-group-hd")].filter(([p]) => p.startsWith("border-bottom"))).toEqual([]);
  expect(one(".scene-group-count")).toContainEqual(["background", "var(--gc, var(--accent))"]);
  // 노드 안 강조(이름표·끌어 놓기·고른 줄·배지·체크·Comfy 단추 올림)도 자기 색 — 라임(--accent)으로 박지 않는다(Jay 2026-10-30)
  for (const sel of [".scene-card-hd", ".scene-card-hd.setbar", ".scene-setnode-folder.drag-over .scene-setnode-pill.ph", ".scene-listrow.selrow", ".scene-listrow-badge", ".scene-listrow-check", ".scene-comfynode-act:hover"]) {
    expect(one(sel).some(([, v]) => v.includes("var(--pc")), sel).toBe(true);
    expect(one(sel).filter(([, v]) => /--accent(?!-ink)/.test(v.replaceAll("var(--pc, var(--accent))", ""))), sel).toEqual([]);
  }
  // 종류별 규칙은 고유색(--pc)만 정하고 틀 색을 따로 칠하지 않는다(빨강 = 서버에 없음·텍스트 편집 중 숨김만 예외)
  const KINDS = /\.scene-card-(ref|gen|text|set|model|list|view|render|comfy|input|output)(?![\w-])/;
  const painted = rules.flatMap((r) =>
    r.selectors.some((s) => isCard(s) && KINDS.test(subjectOf(s)) && !/off-server|data-text-editing/.test(s))
      ? r.decls.filter(([p]) => p === "border-color").map(([p, v]) => `${r.selectors.join(", ")} { ${p}: ${v} }`)
      : [],
  );
  expect(painted).toEqual([]);
});

it("고리 자리 = 점 간격(PORT_GAP) + 고리 반지름 + 카드 테두리 — 다른 규칙이 고리를 옆으로 옮기지 않는다", () => {
  const gap = readFileSync(join(SRC, "components/scene/SceneBoard.tsx"), "utf8").match(/const PORT_GAP = (\d+);/)?.[1];
  const base = rules.find((r) => r.selectors.length === 1 && r.selectors[0] === ".scene-port")!;
  expect(base.decls).toContainEqual(["--port-gap", `${gap}px`]);
  expect(base.decls).toContainEqual(["width", "var(--ring)"]);
  expect(base.decls).toContainEqual(["height", "var(--ring)"]);
  const at = "calc(0px - var(--port-gap) - var(--ring) / 2 - var(--bw, 0px))";
  expect(rules.find((r) => r.selectors[0] === ".scene-port.out")?.decls).toContainEqual(["right", at]);
  expect(rules.find((r) => r.selectors[0] === ".scene-port.in")?.decls).toContainEqual(["left", at]);
  // 그 밖의 고리 규칙은 가로 자리·크기를 직접 건드리지 않는다(세로는 칸별 top, 커지는 건 가운데 기준 scale 만).
  //  크기는 --ring 으로만 바꾼다 — 자리 계산이 같은 값을 읽어 가운데가 그대로다(선택 안 한 카드의 작은 빈 원).
  const MOVES = /^(left|right|inset|margin.*|translate|width|height|position|--port-gap|--bw)$/;
  const bad = rules.flatMap((r) =>
    r.selectors.some(isPort) && r !== base && !(r.selectors[0] === ".scene-port.out" || r.selectors[0] === ".scene-port.in")
      ? r.decls
          .filter(([p, v]) => MOVES.test(p) || (p === "transform" && !/^translateY\(-50%\)( scale\([\d.]+\))?$/.test(v)))
          .map(([p, v]) => `${r.selectors.join(", ")} { ${p}: ${v} }`)
      : [],
  );
  expect(bad).toEqual([]);
});

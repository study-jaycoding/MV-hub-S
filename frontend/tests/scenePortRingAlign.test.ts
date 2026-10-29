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
  const base = rules.find((r) => r.selectors.includes(".scene-card"));
  expect(base?.decls).toContainEqual(["--bw", "0px"]); // 테두리 없는 카드(Comfy 등)의 기본값
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
  // 그 밖의 고리 규칙은 가로 자리·크기를 건드리지 않는다(세로는 칸별 top, 커지는 건 가운데 기준 scale 만).
  const MOVES = /^(left|right|inset|margin.*|translate|width|height|position|--ring|--port-gap|--bw)$/;
  const bad = rules.flatMap((r) =>
    r.selectors.some(isPort) && r !== base && !(r.selectors[0] === ".scene-port.out" || r.selectors[0] === ".scene-port.in")
      ? r.decls
          .filter(([p, v]) => MOVES.test(p) || (p === "transform" && !/^translateY\(-50%\)( scale\([\d.]+\))?$/.test(v)))
          .map(([p, v]) => `${r.selectors.join(", ")} { ${p}: ${v} }`)
      : [],
  );
  expect(bad).toEqual([]);
});

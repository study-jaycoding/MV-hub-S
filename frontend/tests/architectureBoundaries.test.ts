import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { boundaryCompatibility } from "../eslint.config.js";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const lint = new ESLint({ cwd, overrideConfig: { rules: { "import/no-cycle": "off" } } });
async function errors(file: string, code: string) {
  const results = await lint.lintText(code, { filePath: `src/${file}` });
  return results.flatMap(result => result.messages.filter(message => message.severity === 2));
}

it.each([
  ['components/BoundaryProbe.tsx', 'import { runSubmission } from "../features/generation/submit";'],
  ['components/BoundaryProbe.tsx', 'import type { X } from "../features/library/readModel";'],
  ['components/BoundaryProbe.tsx', 'type X = import("../features/library/readModel").GenerationReadTicket;'],
  ['components/BoundaryProbe.tsx', 'export { runSubmission } from "../features/generation/submit";'],
  ['components/BoundaryProbe.tsx', 'export * from "../features/canvas/session";'],
  ['components/BoundaryProbe.tsx', 'const load = () => import("../features/generation/submit");'],
  ['components/BoundaryProbe.tsx', 'const load = (name: string) => import(name);'],
  ['components/BoundaryProbe.tsx', 'const load = require("/src/features/generation/submit.ts");'],
  ['features/canvas/probe.ts', 'import { captureSubmissionScope } from "../../app/operationContext";'],
  ['features/canvas/probe.ts', 'import type { Props } from "../../components/scene/SceneBoard";'],
  ['features/canvas/probe.ts', 'import { x } from "../library/readModel";'],
  ['shared/contracts/probe.ts', 'import type { X } from "../../features/library/api";'],
  ['shared/contracts/probe.ts', 'import { x } from "../../types";'],
  ['shared/contracts/probe.ts', 'export const read = () => localStorage.getItem("x");'],
  ['features/library/readModel.ts', 'import { useState } from "react";'],
  ['features/library/changes.ts', 'import type { Dispatch } from "react";'],
  ['features/library/changes.ts', 'import { jsonFetch } from "../../lib/http";'],
  ['features/library/changes.ts', 'import { loadJSON } from "../../lib/storage";'],
  ['features/library/changes.ts', 'globalThis.fetch("/api");'],
  ['features/library/changes.ts', 'globalThis["localStorage"].getItem("x");'],
  ['features/library/changes.ts', 'window.fetch("/api");'],
])("금지 import/실행 의존성을 error로 막는다: %s %s", async (file, code) => {
  expect((await errors(file, code)).length).toBeGreaterThan(0);
});

it.each([
  ['components/BoundaryProbe.tsx', 'import { runSubmission } from "../features/generation/api";'],
  ['components/BoundaryProbe.tsx', 'import type { GenerationReadTicket } from "../features/library/api";'],
  ['features/generation/probe.ts', 'import { runSubmission } from "./submit";'],
  ['shared/contracts/probe.ts', 'import type { Generation } from "../../types";'],
  ['shared/contracts/probe.ts', 'export type { Generation } from "../../types";'],
  ['features/library/readModel.ts', 'import { isStructurallyEqual } from "../../lib/stateReconciliation";'],
  ['features/library/changes.ts', 'import type { GenerationReadScope } from "./readModel";'],
  ['lib/useSceneHistory.ts', 'import { relinkCards } from "../features/canvas/assetRefs";'],
])("공개 포트·내부 의존성·정확 예외는 통과한다: %s", async (file, code) => {
  expect(await errors(file, code)).toEqual([]);
});

it("compatibility 예외는 한 내부 history 엔진만 허용한다", async () => {
  expect(boundaryCompatibility).toEqual([{ from: "lib/useSceneHistory", to: "features/canvas/assetRefs", reason: "canvas history internal engine; avoid public React-port cycle" }]);
  expect((await errors("lib/anotherHistory.ts", 'import { relinkCards } from "../features/canvas/assetRefs";')).length).toBeGreaterThan(0);
});

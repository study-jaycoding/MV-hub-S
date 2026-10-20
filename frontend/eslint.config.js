import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("./src/", import.meta.url));
const relativeSource = value => path.relative(sourceRoot, value).replaceAll("\\", "/").replace(/\.(tsx?|jsx?)$/, "");
// Canvas history is an existing internal engine. Importing the public React port here would form
// api → useCanvasSession → useSceneHistory → api. This one adapter reads the pure relink calculation.
export const boundaryCompatibility = Object.freeze([
  Object.freeze({ from: "lib/useSceneHistory", to: "features/canvas/assetRefs", reason: "canvas history internal engine; avoid public React-port cycle" }),
]);
const pureLibrary = new Set(["features/library/readModel", "features/library/changes"]);
const environmentImports = /^(react(?:-dom)?(?:\/|$)|node:)|(?:^|\/)(?:http|storage|[^/]*Store|[^/]*Api|api)(?:$|\.)/;

function importViolation(filename, specifier, typeOnly) {
  const from = relativeSource(filename);
  const target = specifier.startsWith(".") ? relativeSource(path.resolve(path.dirname(filename), specifier))
    : specifier.startsWith("/src/") ? specifier.slice(5).replace(/\.(tsx?|jsx?)$/, "") : specifier;
  const feature = value => /^features\/([^/]+)\//.exec(value)?.[1];
  const owner = feature(from), destination = feature(target);
  if (destination && owner !== destination && target !== `features/${destination}/api`
    && !boundaryCompatibility.some(item => item.from === from && item.to === target)) return "Feature 내부 대신 features/<name>/api 공개 포트를 사용하세요.";
  if (owner && (/^(?:app|components)\//.test(target) || target === "App" || target === "api" || /^react-dom(?:\/|$)/.test(target))) return "Feature에서 App·UI 조립 계층을 역참조하지 마세요.";
  if (from.startsWith("shared/contracts/")) {
    if (!typeOnly || !(target === "types" || target.startsWith("shared/contracts/"))) return "shared/contracts는 공통 자료형의 type-only 의존성만 허용합니다.";
  }
  if (pureLibrary.has(from) && (environmentImports.test(specifier) || /^(?:app|components)\//.test(target))) return "Library 순수 모델에서 React·통신·저장소·UI에 의존하지 마세요.";
  return null;
}

export const featureBoundaryRule = {
  meta: { type: "problem", schema: [], messages: { boundary: "{{reason}}" } },
  create(context) {
    const check = (node, value, typeOnly = false) => {
      if (typeof value !== "string") return;
      const reason = importViolation(context.filename, value, typeOnly);
      if (reason) context.report({ node, messageId: "boundary", data: { reason } });
    };
    return {
      ImportDeclaration(node) { check(node, node.source.value, node.importKind === "type" || (node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === "type"))); },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value, node.exportKind === "type" || (node.specifiers.length > 0 && node.specifiers.every(item => item.exportKind === "type"))); },
      ExportAllDeclaration(node) { check(node, node.source.value, node.exportKind === "type"); },
      TSImportType(node) { check(node, node.source.value, true); },
      ImportExpression(node) {
        if (typeof node.source.value === "string") check(node, node.source.value);
        else context.report({ node, messageId: "boundary", data: { reason: "동적 import는 경계를 검사할 수 있는 고정 경로를 사용하세요." } });
      },
      CallExpression(node) { if (node.callee.type === "Identifier" && node.callee.name === "require") check(node, node.arguments[0]?.value); },
    };
  },
};

const pureDomainFiles = [
  "src/lib/commentTree.ts",
  "src/lib/editTimeline.ts",
  "src/lib/editResolveExport.ts",
  "src/lib/comfyRunState.ts",
  "src/lib/generationDisplay.ts",
  "src/lib/gradeStep.ts",
  "src/lib/folderTreeModel.ts",
  "src/lib/recipeScene.ts",
  "src/lib/sceneComfyInputs.ts",
  "src/lib/sceneComfySeeds.ts",
  "src/lib/sceneDerive.ts",
  "src/lib/sceneEdges.ts",
  "src/lib/sceneLayout.ts",
  "src/lib/sceneMedia.ts",
  "src/lib/seedancePrompt.ts",
  "src/lib/setUtils.ts",
  "src/lib/spotlightSubmit.ts",
  "src/components/assets/treeUtils.ts",
  "src/features/**/domain/**/*.{ts,tsx}",
];

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    // 기존 주석 정리는 별도 코드 품질 단계에서 한다. 이 명령은 구조 경계만 본다.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
      "react-hooks": reactHooksPlugin,
      mvhub: { rules: { boundaries: featureBoundaryRule } },
    },
    settings: {
      "import/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"],
      },
    },
    rules: {
      // P1은 warning-first다. 현재 순환을 보이게 하되 빌드와 테스트는 막지 않는다.
      "import/no-cycle": ["warn", { ignoreExternal: true }],
      // P1–P3 전환 feature의 공개 포트·역방향 의존성만 error. 과거 warning-first 규칙은 유지한다.
      "mvhub/boundaries": "error",
    },
  },
  {
    files: pureDomainFiles,
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          paths: [
            {
              name: "react",
              message: "순수 도메인 코드는 React에 의존하지 않아야 합니다.",
            },
            {
              name: "react-dom",
              message: "순수 도메인 코드는 React DOM에 의존하지 않아야 합니다.",
            },
          ],
          patterns: [
            {
              group: [
                "../api",
                "../../api",
                "**/api",
                "**/*Api",
                "**/http",
                "**/storage",
                "**/*Store",
                "**/components/**",
              ],
              message: "순수 도메인에서 API·저장소·UI를 분리하세요.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "warn",
        {
          name: "fetch",
          message: "순수 도메인에서는 fetch 대신 입력값을 받으세요.",
        },
        {
          name: "localStorage",
          message: "순수 도메인에서는 localStorage 대신 입력값을 받으세요.",
        },
        {
          name: "window",
          message: "순수 도메인에서는 브라우저 전역에 접근하지 마세요.",
        },
        {
          name: "document",
          message: "순수 도메인에서는 DOM에 접근하지 마세요.",
        },
      ],
    },
  },
  {
    files: ["src/features/library/readModel.ts", "src/features/library/changes.ts", "src/shared/contracts/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", "fetch", "window", "document", "localStorage", "sessionStorage", "indexedDB", "WebSocket", "BroadcastChannel", "navigator"],
      "no-restricted-properties": ["error", ...["fetch", "window", "document", "localStorage", "sessionStorage", "indexedDB", "WebSocket", "BroadcastChannel", "navigator"].map(property => ({ object: "globalThis", property }))],
    },
  },
];

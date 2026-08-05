import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const pureDomainFiles = [
  "src/lib/commentTree.ts",
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
  "src/components/manage/dashboardModel.ts",
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
];

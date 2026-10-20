import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
it("전환한 외부 writer는 저장 함수나 범용 patch를 호출하지 않는다", () => {
  for (const path of ["lib/useCanvasGenerationLinks.ts", "lib/mcpCanvasTasks.ts", "lib/sceneAssetRelink.ts",
    "lib/sceneBackup.ts", "components/mcp/McpConnection.tsx"]) {
    expect(source(path), path).not.toMatch(/\b(updateScene|updateScenesWith|saveScenes|mergeScenesFromBackup|importScene)\s*\(/);
    expect(source(path), path).not.toContain("Partial<Scene>");
  }
});
it("타임라인 UI는 문서 callback/Undo 정책을 지정하지 않고 명령만 보낸다", () => {
  expect(source("components/timeline/EditTab.tsx")).not.toMatch(/\bapplyEdit\s*\(|undo:\s*false/);
  expect(source("features/timeline/session.ts")).toContain('command.type !== "recordDurations"');
});
it("비동기 Comfy/복구 writer는 카드 설정자나 Undo 옵션을 받지 않는다", () => {
  for (const path of ["lib/useSceneComfyExecution.ts", "lib/sceneComfyLibrary.ts", "lib/useSceneCardRecovery.ts"]) {
    expect(source(path), path).not.toMatch(/\bsetCards\s*\(|undo:\s*false|persistDerived|persistUser/);
    expect(source(path), path).toContain("commitDocument");
  }
});
it("Canvas 화면과 입력 hook은 세션의 저장·Undo 엔진을 직접 사용하지 않는다", () => {
  for (const path of ["components/scene/SceneBoard.tsx", "lib/useSceneCardMove.ts", "lib/useSceneGroupMove.ts",
    "lib/useSceneCardResize.ts", "lib/useSceneClipboardDrop.ts"]) {
    expect(source(path), path).not.toMatch(/\b(useSceneHistory|useSceneInputCommit|persistUser|persistDerived|deferUser|applyCards|beginGesture|endGesture)\s*\(/);
    expect(source(path), path).not.toMatch(/undo:\s*false/);
  }
  expect(source("features/canvas/session.ts")).not.toContain("commitBoardSnapshot");
});

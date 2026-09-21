// Seedance 렌더 시험 공통 장치. 제품 상태 훅/편집기/옵션 바는 대체하지 않는다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import type { SpotlightPrompt, SpotlightPromptHandle } from "../src/components/SpotlightPrompt";
import type { Generation, ModelParam, WorkspaceContext } from "../src/types";
import type { SpotlightCreateBody } from "../src/lib/spotlightSubmit";
import type { CanvasGenerationLink } from "../src/lib/canvasGenerationRecovery";

// 이 장치를 쓰는 시험 파일은 프롬프트 도크(또는 App 전체)를 통째로 마운트한다 — 파일의 첫 시험은 단독 0.8~1.8초인데, 전체 실행(파일 병렬·jsdom 기동
// 경합)에서는 기본 5초를 넘는다. 2026-09-20 에 두 시험에만 20초를 줬지만 09-21 에 같은 장치를 쓰는 다른 두 파일에서 또 났다(시험 파일이 늘 때마다 자리를
// 옮겨 가며 재발). 그래서 개별 시험이 아니라 **이 장치를 들여오는 파일 전체**에 20초를 준다 — 전역 제한은 그대로라 다른 시험의 무한 대기는 5초에 드러난다.
vi.setConfig({ testTimeout: 20_000 });

export function installPromptStyles(): HTMLStyleElement {
  // Vitest의 기본 CSS 비활성화 플러그인은 .css?raw도 빈 문자열로 바꾼다.
  // Vite 변환을 거치지 않고 제품 파일 자체를 읽는다(시험 실행 중에만 읽음).
  const css = readFileSync(new NodeURL("../src/styles/prompt-dock.css", import.meta.url), "utf8");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  try {
    expect(style.sheet, "제품 CSS가 jsdom 스타일시트로 등록되어야 한다").not.toBeNull();
    const rules = Array.from(style.sheet!.cssRules).filter((rule) => rule.type === 1) as CSSStyleRule[];
    const ignored = rules.find((rule) => rule.selectorText === ".sl-opt-ignored");
    expect(ignored?.style.getPropertyValue("opacity"), "제품의 흐림 규칙이 실제로 파싱되어야 한다").toBe("0.45");
    const hidden = rules.find((rule) => rule.selectorText === ".sl-dockbar.sl-hidden .sl-dock > *:not(.sl-status-row)");
    expect(hidden?.style.getPropertyValue("display"), "제품의 숨김 규칙이 실제로 파싱되어야 한다").toBe("none");
    return style;
  } catch (error) {
    style.remove();
    throw error;
  }
}

export const SEEDANCE_PARAMS: ModelParam[] = [
  { name: "mode", type: "string", required: false, default: "t2v", enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
  { name: "extension_mode", type: "string|null", required: false, default: null, enum: ["backward", "forward"] },
  { name: "duration", type: "integer", required: false, default: 5 },
  { name: "aspect_ratio", type: "string", required: false, default: "16:9", enum: ["16:9", "9:16", "1:1"] },
  { name: "resolution", type: "string", required: false, default: "720p", enum: ["480p", "720p", "1080p"] },
];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
}

export function click(element: Element) {
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

export function required<T extends Element = HTMLElement>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`화면 요소가 없습니다: ${selector}`);
  return element;
}

export function button(parent: ParentNode, text: string): HTMLButtonElement {
  const found = [...parent.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`화면 버튼이 없습니다: ${text}`);
  return found;
}

export function installPromptBoundaryMocks() {
  // 호출 목록에 없는 네트워크는 성공으로 삼키지 않는다. 실제 서버에 접속할 수도 없다.
  const fetch = vi.fn(() => Promise.reject(new Error("렌더 시험의 예상 밖 네트워크 호출")));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = {
    models: vi.fn().mockResolvedValue([
      { job_set_type: "nano_banana_flash", display_name: "Nano Banana 2", type: "image" },
      { job_set_type: "seedance_2_5", display_name: "Seedance 2.5", type: "video" },
      { job_set_type: "seedance_2_0", display_name: "Seedance 2.0", type: "video" },
    ]),
    modelParams: vi.fn().mockImplementation((model: string) => Promise.resolve({
      params: model === "seedance_2_5" ? SEEDANCE_PARAMS : [], constraints: {},
    })),
    estimateCost: vi.fn().mockResolvedValue({ credits: 1 }),
    agentStatus: vi.fn().mockResolvedValue({ connected: true }),
    getGeneration: vi.fn().mockResolvedValue({
      id: "reference-fixture", source_name: "시험 이미지", tags: [],
      assets: [{ type: "image", file_path: "/fixtures/reference.png", thumbnail_path: "/fixtures/reference.png" }],
    }),
    thumbOrRaw: vi.fn((path: string) => path),
    prepareCreate: vi.fn<(body: SpotlightCreateBody, workspace: WorkspaceContext, link?: CanvasGenerationLink) => () => Promise<Generation>>()
      .mockImplementation(() => { throw new Error("이 시험에서 허용하지 않은 생성 제출"); }),
    resolveCanvasGenerationLinks: vi.fn().mockResolvedValue({ links: [] }),
    getGenerationsBatch: vi.fn().mockResolvedValue({ items: {} }),
  };
  vi.doMock("../src/api", () => ({ api }));
  const policy = { key: "fixture", workspaceId: "", status: "ready", allowed: new Set<string>(), groupName: null, revision: 1, fetchedAt: 0 };
  vi.doMock("../src/lib/modelPolicy", () => ({
    useModelPolicy: () => policy,
    currentModelPolicy: () => policy,
    configureModelPolicy: vi.fn(),
    modelBlockMessage: () => null,
  }));
  // 서버 콘솔/계정 팝업만 생략한다. 프롬프트 자체의 계정·에이전트 훅은 실제 코드다.
  vi.doMock("../src/components/spotlight/ServerConsolePanel", () => ({ ServerConsolePanel: () => null }));
  return { api, fetch };
}

export function createRenderRoot() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, dispose: () => { act(() => root.unmount()); container.remove(); } };
}

export type PromptProps = ComponentProps<typeof SpotlightPrompt>;

export async function mountPrompt(overrides: Partial<PromptProps> = {}) {
  const { SpotlightPrompt: Component } = await import("../src/components/SpotlightPrompt");
  const view = createRenderRoot();
  const ref = createRef<SpotlightPromptHandle>();
  let props: PromptProps = {
    workspace: { scope: "personal", id: null, name: null },
    armedAutoTags: [], expanded: true, inCompose: true,
    onCreated: vi.fn(), onToggleExpand: vi.fn(), ...overrides,
  };
  const render = async (changes: Partial<PromptProps> = {}) => {
    props = { ...props, ...changes };
    act(() => view.root.render(<Component {...props} ref={ref} />));
    await settle();
  };
  try { await render(); } catch (error) { view.dispose(); throw error; }
  return { ...view, ref, render };
}

export function expectShownMode(container: ParentNode, mode: string) {
  if (!container.querySelector(".sl-adv-pop")) {
    click(required(container, 'button[title="고급 옵션 (모드·비트레이트·장르 등)"]'));
  }
  const modeButton = button(required(container, ".sl-adv-pop"), mode);
  expect(modeButton.classList.contains("sel")).toBe(true);
  for (const other of ["t2v", "omni_reference", "video_edit", "video_extension"].filter((item) => item !== mode)) {
    expect(button(required(container, ".sl-adv-pop"), other).classList.contains("sel")).toBe(false);
  }
}

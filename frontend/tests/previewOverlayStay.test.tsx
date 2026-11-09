// @vitest-environment jsdom
// 크게 보기 Ctrl 카드 — S·T·C·정보(Jay 2026-11-09 신고, 기록 docs/status/크게보기_키단추_2026-11-09.md).
//  ① 워크스페이스·공유 탭: 뒤 격자에 같은 생성물 카드가 붙어 있어 S 선택 창이 바로 닫혔다(캔버스는 격자 카드가 없어 됐다)
//  ② 정보(생성물·어셋)·어셋 C 는 크게 보기를 닫고 열었다 → 크게 보기를 둔 채 그 위 겹에
//  ③ 어셋 T: 격자 칸과 크게 보기 칸에 태그 입력이 같이 열려 서로 초점을 뺏고 둘 다 닫혔다
// 겹의 실제 화면 순서는 jsdom 이 계산하지 않아 CSS 규칙의 z-index 를 직접 본다 — 눈 확인은 5173.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetMeta, AssetNode, Generation, PreviewTarget } from "../src/types";

const fixture = vi.hoisted(() => ({
  tree: [] as unknown[], gen: null as unknown, noop: () => {},
}));
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const known: Record<string, unknown> = {
    assetFileUrl: (_project: string, path: string) => `/files/${path}`, assetThumbUrl: (_project: string, path: string) => `/thumbs/${path}`,
    getGeneration: async () => fixture.gen,
  };
  return { api: new Proxy(known, { get: (target, name: string) => target[name] ?? pending }) };
});
vi.mock("../src/lib/generationViews", () => ({ recordGenerationView: vi.fn(), TEAM_SCOPE: "@team" }));
vi.mock("../src/components/assets/useAssetProjectData", () => ({
  useAssetProjectData: () => ({
    error: "", loading: false, meta: {}, metaReady: true, project: "P", projects: ["P"], projectIds: {}, linkedProjects: new Set<string>(), missingProjects: [], tree: fixture.tree,
    refreshProjectData: fixture.noop, reloadMeta: async () => true, reloadProjects: fixture.noop, reloadTree: fixture.noop, setMeta: fixture.noop, setProject: fixture.noop,
  }),
}));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

import { AssetsView } from "../src/components/AssetsView";
import { GenerationCard } from "../src/components/GenerationCard";
import { InfoPopup } from "../src/components/InfoPopup";
import { MediaPreview } from "../src/components/MediaPreview";
import { assetFileUrl } from "../src/lib/assetUrls";

const GEN = { id: "g1", prompt: "운동장", shared: false, is_final: false, is_mine: true, status: "done", created_at: "2026-11-05",
  assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/media/g1.png", thumbnail_path: null }],
  references: [], tags: [], auto_tags: [], deleted: false, project_id: "p1", project_name: "P", folder_path: "e001/c0010",
  comment_count: 0, has_unread: false } as unknown as Generation;
const GEN_TARGET: PreviewTarget = { url: "/media/g1.png", type: "image", name: "운동장", genId: "g1" };
// 어셋 화면은 칸을 lib/assetUrls 의 원본 주소와 맞춰 본다 — 크게 보기 대상도 같은 주소
const asset = (name: string): PreviewTarget => ({ url: assetFileUrl("P", name), type: "image", name, assetPath: name });
const node: AssetNode = { name: "a.png", path: "a.png", type: "image" } as AssetNode;
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };

// 앱이 크게 보기에 넘기는 카드 동작(AppOverlays previewCardActions)
const actions = () => ({
  canFinalize: () => false, onReview: vi.fn(), onPublish: vi.fn(), onUnpublish: vi.fn(), onFinalize: vi.fn(), onUnfinalize: vi.fn(),
  onSetTags: vi.fn(), onSetAutoTags: vi.fn(), autoTagOptions: [], onRegenerate: vi.fn(), onImport: vi.fn(), onInfo: vi.fn(),
  onOpenComments: vi.fn(), onOpenFolder: vi.fn(), myCreatorUid: "me",
});

let host: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let restore: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  fixture.tree = [];
  fixture.gen = GEN;
  // 원본이 그려진 사각형 — jsdom 은 크기를 재지 않는다
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) } as DOMRect);
  const proto = HTMLImageElement.prototype;
  const nw = Object.getOwnPropertyDescriptor(proto, "naturalWidth");
  const nh = Object.getOwnPropertyDescriptor(proto, "naturalHeight");
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(proto, "naturalHeight", { configurable: true, get: () => 600 });
  restore = [() => {
    if (nw) Object.defineProperty(proto, "naturalWidth", nw);
    if (nh) Object.defineProperty(proto, "naturalHeight", nh);
  }];
  onClose = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  restore.forEach((undo) => undo());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const render = async (ui: ReactNode) => { act(() => root.render(<>{ui}</>)); await settle(); };
const ctrlDown = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true })); });
const key = (k: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const layer = () => host.querySelector<HTMLElement>(".mp-card-layer");
const count = () => host.querySelector(".preview-count")?.textContent?.trim();
const tlButton = (label: "S" | "T" | "C") => [...layer()!.querySelectorAll<HTMLButtonElement>(".card-tl button")].find((b) => b.textContent === label)!;
/** 실제 누름처럼 — 누름(카드 단추를 붙여 둔다) 뒤 클릭 */
const tap = async (el: Element) => {
  act(() => { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  act(() => { (el as HTMLElement).click(); });
  await settle();
};

describe("생성물 Ctrl 카드", () => {
  // 워크스페이스·공유 탭 격자의 카드 — 격자는 고르지 않은 카드에도 selectedCount=1 을 준다(ThumbnailGrid)
  const gridCard = (
    <GenerationCard gen={GEN} tab="my" layout="grid" selectedCount={1} onSetSource={vi.fn()} onSetTags={vi.fn()} onOpenComments={vi.fn()}
      onRequestEdit={vi.fn()} onEditDone={vi.fn()} onRegenerate={vi.fn()} onPublish={vi.fn()} onUnpublish={vi.fn()} onFinalize={vi.fn()}
      onUnfinalize={vi.fn()} onImport={vi.fn()} onRestore={vi.fn()} onInfo={vi.fn()} onPreview={vi.fn()} />
  );

  it("S — 뒤 격자에 같은 생성물 카드가 있어도 S 선택 창이 하나 뜨고 남는다(전엔 격자 카드가 바로 닫았다)", async () => {
    await render(<>{gridCard}<MediaPreview target={GEN_TARGET} onClose={onClose} cardActions={actions()} /></>);
    ctrlDown();
    await settle();
    await tap(tlButton("S"));
    expect(document.body.querySelectorAll(".s-pick")).toHaveLength(1);
    // 격자 카드의 S 는 제 창을 따로 연다 — 크게 보기 카드의 창과 섞이지 않는다
    act(() => { [...host.querySelectorAll<HTMLButtonElement>(".card-sf")].find((b) => !b.closest(".mp-card-layer"))!.click(); });
    await settle();
    expect(document.body.querySelectorAll(".s-pick")).toHaveLength(1);
  });

  it("T 입력창의 Esc 는 입력창만 닫는다 — 크게 보기는 남고 다음 Esc 에 닫힌다(11-09 Jay)", async () => {
    await render(<MediaPreview target={GEN_TARGET} onClose={onClose} cardActions={actions()} />);
    ctrlDown();
    await settle();
    await tap(tlButton("T"));
    const input = layer()!.querySelector<HTMLInputElement>(".card-status input")!;
    expect(input).not.toBeNull();
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(layer()?.querySelector(".card-status input") ?? null).toBeNull();
    expect(onClose).not.toHaveBeenCalled(); // 전엔 크게 보기가 잡는 단계에서 먼저 닫혔다
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ⓘ — 크게 보기는 닫지 않고 정보를 바로 연다", async () => {
    const acts = actions();
    await render(<MediaPreview target={GEN_TARGET} onClose={onClose} cardActions={acts} />);
    ctrlDown();
    await settle();
    await tap(layer()!.querySelector(".ov-info")!);
    expect(acts.onInfo).toHaveBeenCalledTimes(1);
    expect(acts.onInfo.mock.calls[0][0]).toMatchObject({ kind: "generation", gen: { id: "g1" } });
    expect(onClose).not.toHaveBeenCalled(); // 전엔 크게 보기를 닫은 뒤에 열었다
  });
});

describe("크게 보기 위의 정보 창", () => {
  const ITEMS: PreviewTarget = { ...asset("a.png"), items: [asset("a.png"), asset("b.png")], index: 0 };
  const info = (onInfoClose: () => void) => (
    <InfoPopup target={{ kind: "file", project: "P", node, meta, x: 100, y: 100 }} onClose={onInfoClose} onPreview={vi.fn()} />
  );

  it("크게 보기가 떠 있을 때 연 정보 창은 위 겹 — Esc 는 정보 창부터, 떠 있는 동안 ←/→ 는 크게 보기 장을 넘기지 않는다", async () => {
    const onInfoClose = vi.fn();
    await render(<MediaPreview target={ITEMS} onClose={onClose} />);
    await render(<><MediaPreview target={ITEMS} onClose={onClose} />{info(onInfoClose)}</>);
    expect(host.querySelector(".info-popup")?.classList.contains("over-preview")).toBe(true);
    expect(host.querySelector(".info-catcher")?.classList.contains("over-preview")).toBe(true);
    key("ArrowRight");
    expect(count()).toBe("1/2");
    key("Escape");
    expect(onInfoClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await render(<MediaPreview target={ITEMS} onClose={onClose} />); // 정보 창이 닫혔다
    key("ArrowRight");
    expect(count()).toBe("2/2"); // 다시 크게 보기의 키
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("크게 보기 없이 연 정보 창은 종전 겹 그대로", async () => {
    await render(info(vi.fn()));
    expect(host.querySelector(".info-popup")?.classList.contains("over-preview")).toBe(false);
  });

  it("위 겹 규칙은 크게 보기 막(.preview-backdrop)보다 높고, 내 계정 패널·우클릭 메뉴 막보다는 낮다", () => {
    const css = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8")
      + readFileSync(new NodeURL("../src/styles/app-shell.css", import.meta.url), "utf8");
    const z = (selector: string) => {
      const rule = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`));
      return Number(rule?.[1].match(/z-index: (\d+)/)?.[1]);
    };
    const backdrop = z(".preview-backdrop");
    expect(backdrop).toBeGreaterThan(0);
    for (const selector of [".info-catcher.over-preview", ".info-popup.over-preview", ".cmt-panel.over-preview"]) {
      expect(z(selector)).toBeGreaterThan(backdrop);
      expect(z(selector)).toBeLessThan(z(".manage-float"));
      expect(z(selector)).toBeLessThan(z(".preview-menu-catcher"));
    }
  });
});

describe("어셋 Ctrl 카드(실제 어셋 화면이 칸을 등록)", () => {
  const ITEMS: PreviewTarget = { ...asset("a.png"), items: [asset("a.png"), asset("b.png")], index: 0 };
  const view = (onInfo = vi.fn()) => <AssetsView onInfo={onInfo} onPreview={vi.fn()} />;
  beforeEach(() => {
    fixture.tree = ["a.png", "b.png"].map((name) => ({ name, path: name, type: "image" }));
  });
  const gridInputs = () => [...host.querySelectorAll(".asset-cell .card-status input")].filter((input) => !input.closest(".mp-card-layer"));

  it("T — 크게 보기 칸에만 태그 입력이 열리고 남는다(격자 칸에는 안 열림) · 떠 있는 동안 ←/→ 는 장을 넘기지 않는다", async () => {
    await render(<>{view()}<MediaPreview target={ITEMS} onClose={onClose} /></>);
    ctrlDown();
    await settle();
    expect(layer()?.querySelector(".asset-cell")).not.toBeNull();
    await tap(tlButton("T"));
    expect(layer()!.querySelector(".card-status input")).not.toBeNull();
    expect(gridInputs()).toHaveLength(0); // 전엔 격자 칸에도 열려 서로 초점을 뺏고 둘 다 닫혔다
    await settle();
    expect(layer()!.querySelector(".card-status input")).not.toBeNull();
    key("ArrowRight"); // 입력칸 밖에서 눌러도 — 입력창이 위 겹이라 크게 보기 키는 쉰다
    await settle();
    expect(count()).toBe("1/2");
    expect(layer()!.querySelector(".card-status input")).not.toBeNull();
  });

  it("T 입력창의 Esc 는 입력창만 닫는다 — 크게 보기는 남는다(11-09 Jay)", async () => {
    await render(<>{view()}<MediaPreview target={ITEMS} onClose={onClose} /></>);
    ctrlDown();
    await settle();
    await tap(tlButton("T"));
    const input = layer()!.querySelector<HTMLInputElement>(".card-status input")!;
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect(layer()?.querySelector(".card-status input") ?? null).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    key("ArrowRight"); // 입력창을 닫으면 다시 크게 보기의 키
    await settle();
    expect(count()).toBe("2/2");
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("C — 크게 보기를 닫지 않고 코멘트 창을 그 위 겹에 띄운다", async () => {
    await render(<>{view()}<MediaPreview target={ITEMS} onClose={onClose} /></>);
    ctrlDown();
    await settle();
    await tap(tlButton("C"));
    const panel = host.querySelector(".cmt-panel");
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains("over-preview")).toBe(true);
    expect(onClose).not.toHaveBeenCalled(); // 전엔 크게 보기를 닫은 뒤에 열었다
    expect(host.querySelector(".media-preview")).not.toBeNull();
  });

  it("c 키 — Ctrl 카드 C 와 같은 작은 코멘트 창을 크게 보기 위 겹에 띄운다(어셋 그림 §4 — 전엔 아무 일도 없었다)", async () => {
    await render(<>{view()}<MediaPreview target={ITEMS} onClose={onClose} /></>);
    await settle();
    expect(host.querySelector(".cmt-panel")).toBeNull();
    key("c");
    await settle();
    const panel = host.querySelector(".cmt-panel");
    expect(panel?.classList.contains("over-preview")).toBe(true);
    // 어느 파일의 코멘트인지 = 왼쪽 썸네일 칸(마우스를 올리면 파일 이름, 11-09 시안 C-2) — 머리줄 글자는 뺐다
    expect(panel?.querySelector(".cmt-media")?.getAttribute("title")).toBe("a.png");
    expect(panel?.querySelector(".cmt-file")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ⓘ — 크게 보기를 닫지 않고 그 파일의 정보를 연다", async () => {
    const onInfo = vi.fn();
    await render(<>{view(onInfo)}<MediaPreview target={ITEMS} onClose={onClose} /></>);
    ctrlDown();
    await settle();
    await tap(layer()!.querySelector(".ov-info")!);
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onInfo.mock.calls[0][0]).toMatchObject({ kind: "file", project: "P", node: { path: "a.png" } });
    expect(onClose).not.toHaveBeenCalled();
  });
});

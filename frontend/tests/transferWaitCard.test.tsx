// @vitest-environment jsdom
// 파일이 서버로 올라오기 전 받는 사람 카드 — '원본 없음' 대신 전송 대기. 올라오면 목록이 새 주소를 받아 저절로 보인다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { estimateCost: vi.fn(), thumbOrRaw: (path: string) => path } }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (model: string | null) => model || "—", modelMediaType: () => "image" }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));

import { GenerationCard } from "../src/components/GenerationCard";
import { setLang } from "../src/lib/i18n";
import type { Generation } from "../src/types";

const noop = () => {};
let root: Root;
let host: HTMLDivElement;

function generation(file_path: string, patch: Partial<Generation> = {}): Generation {
  return {
    id: "g1", worker_id: "w", worker_name: null, prompt: "p", display_prompt: null, model: "comfy", params: {}, color: null,
    status: "done", execution_phase: null, error: null, created_at: "2026-11-02 00:00:00",
    assets: [{ id: "a1", type: "image", file_path, thumbnail_path: null, source_url: null, cached: true }],
    references: [], tags: [], auto_tags: [], shared: true, parent_gen_id: null, is_source: false, source_name: null, comment: null,
    comment_count: 0, has_unread: false, local_only: false, creator_uid: "other", creator_name: "다른 사람", is_mine: false,
    workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: "p1", deleted: false, ...patch,
  } as Generation;
}

function card(gen: Generation, tab: "my" | "team" = "team") {
  const props: ComponentProps<typeof GenerationCard> = {
    gen, tab, onSetSource: noop, onSetTags: noop, onOpenComments: noop, onRequestEdit: noop, onEditDone: noop, onRegenerate: noop, onPublish: noop,
    onUnpublish: noop, onFinalize: noop, onUnfinalize: noop, onImport: noop, onRestore: noop, onInfo: noop, onPreview: noop,
  };
  return <GenerationCard {...props} />;
}

function failImage() {
  const image = host.querySelector("img.thumb, .thumb-wrap img, img")!;
  act(() => { image.dispatchEvent(new Event("error")); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  setLang("ko");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("전송 대기 카드", () => {
  it("공유 탭의 로컬 주소 그림을 못 읽으면 전송 대기다", () => {
    act(() => root.render(card(generation("/media/comfy/a.png"))));
    failImage();
    expect(host.textContent).toContain("전송 대기");
    expect(host.textContent).not.toContain("원본 없음");
    expect(host.querySelector(".thumb-waiting")).not.toBeNull();
  });

  it.each([
    ["내 작업 탭", "/media/comfy/a.png", "my"],
    ["원격 주소", "https://cdn.example/a.png", "team"],
    ["서버 보관 위치", "asset-sync:" + "a".repeat(32), "team"],
  ] as const)("%s 는 지금처럼 원본 없음이다", (_name, path, tab) => {
    act(() => root.render(card(generation(path), tab)));
    failImage();
    expect(host.textContent).toContain("원본 없음");
    expect(host.textContent).not.toContain("전송 대기");
  });

  it("원격 원본이 있는 카드는 전송 대기가 아니다", () => {
    const gen = generation("/media/comfy/a.png");
    gen.assets[0].source_url = "https://cdn.example/a.png";
    act(() => root.render(card(gen)));
    failImage();
    expect(host.textContent).toContain("원본 없음");
    expect(host.textContent).not.toContain("전송 대기");
  });

  it("주소가 바뀌면 표시가 풀려 새 주소를 다시 읽는다", () => {
    act(() => root.render(card(generation("/media/comfy/a.png"))));
    failImage();
    act(() => root.render(card(generation("asset-sync:" + "b".repeat(32)))));
    expect(host.querySelector(".thumb-broken")).toBeNull(); // 대기도 원본 없음도 아니다 — 새 주소를 읽는 중이다
    expect(host.querySelector("img")?.getAttribute("src")).toContain("/api/asset-sync/files/" + "b".repeat(32));
  });

  it("카드별 타이머를 두지 않는다", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    act(() => root.render(card(generation("/media/comfy/a.png"))));
    failImage();
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });
});

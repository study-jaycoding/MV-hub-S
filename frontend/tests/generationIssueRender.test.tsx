// @vitest-environment jsdom
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationCard } from "../src/components/GenerationCard";
import { InfoPopup } from "../src/components/InfoPopup";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { GenerationCard as CanvasGenerationCard } from "../src/components/scene/cards/GenerationCard";
import { SceneVariantPopup } from "../src/components/scene/SceneVariantPopup";
import { generationIssueFor, generationStatusLabelFor } from "../src/lib/generationDisplay";
import { setLang } from "../src/lib/i18n";
import { useGenerationCardActions } from "../src/lib/useGenerationCardActions";
import { api } from "../src/api";
import type { Generation } from "../src/types";

vi.mock("../src/api", () => ({
  api: {
    estimateCost: vi.fn().mockResolvedValue({ credits: 1 }),
    generationMetrics: vi.fn().mockResolvedValue(null),
    thumbOrRaw: (path: string) => path,
    prepareRegenerate: vi.fn(),
    confirmGenerationNotSubmitted: vi.fn(),
  },
}));
vi.mock("../src/lib/modelCatalog", () => ({
  useModelDisplayName: () => (model: string | null) => model || "—",
}));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));

const GROUP_LIMIT = "CLI 실패: Error: You've reached your monthly workspace group credit limit. " +
  "Ask your workspace admin to increase the group limit or wait until it resets. " +
  "— cmd: generate create seedance_2_5 --prompt <프롬프트 29071자> --mode omni_reference";
const RECOVERY_ERROR = "HF 확인 필요 — 외부 제출 여부가 불명확하여 자동 재생성을 차단했습니다\n" +
  "제출 진단: " + GROUP_LIMIT;
const noop = () => {};
let root: Root;
let container: HTMLDivElement;

function generation(patch: Partial<Generation> = {}): Generation {
  return {
    id: "issue-fixture", worker_id: "test-worker", worker_name: null, prompt: "Synthetic test prompt",
    display_prompt: null, model: "seedance_2_5", params: {}, color: null,
    status: "running", execution_phase: "recovery_required", error: RECOVERY_ERROR,
    created_at: "2026-09-16 00:00:00", assets: [], references: [], tags: [], auto_tags: [],
    shared: false, parent_gen_id: null, is_source: false, source_name: null, comment: null,
    comment_count: 0, has_unread: false, local_only: false, creator_uid: null, creator_name: null,
    is_mine: true, workspace_scope: "personal", workspace_id: null, workspace_name: null,
    project_id: null, deleted: false, ...patch,
  };
}

function libraryProps(gen: Generation): ComponentProps<typeof GenerationCard> {
  return {
    gen, tab: "my", onSetSource: noop, onSetTags: noop, onOpenComments: noop,
    onRequestEdit: noop, onEditDone: noop, onRegenerate: noop, onPublish: noop, onUnpublish: noop,
    onFinalize: noop, onUnfinalize: noop, onImport: noop, onRestore: noop,
    onInfo: noop, onPreview: noop,
  };
}

function historyProps(gen: Generation): ComponentProps<typeof HistoryBoardNode> {
  return {
    generation: gen, x: 0, y: 0, width: 180, height: 180, isRoot: false, isSelected: false,
    onLine: false, offLine: false, fill: true, disabled: false, typeFilter: "all",
    sharedOnly: false, commentOnly: false, finalOnly: false, sConfirm: null,
    onSClick: noop, onSDouble: noop, onSConfirmYes: noop, onSConfirmNo: noop,
    onPreview: noop, onInfo: noop, onRegenerate: noop,
  };
}

function canvasProps(gen: Generation): ComponentProps<typeof CanvasGenerationCard> {
  return {
    card: { id: "canvas-card", kind: "generation", genId: gen.id, x: 0, y: 0 },
    sel: false, g: gen, showNode: false, waiting: false, genMissing: false, width: 180, height: 180,
    fill: true, selectedOnly: false, laneDelta: () => 0, getNodePreview: () => noop,
    hist: {
      disabledIds: new Set(), typeFilter: "all", sharedOnly: false, commentOnly: false,
      finalOnly: false, sConfirm: null, onSClick: noop, onSDouble: noop, onSConfirmYes: noop,
      onSConfirmNo: noop,
    },
    actions: {
      setCardMenu: noop, setCardBatch: noop, orchestrateGenerate: async () => {},
      showGenerateBar: false, onOutPortDown: noop, onResizeDown: noop,
    },
    tagEdit: {
      active: false, hasAutoTags: false, autoTagOptions: [], applyCardTags: noop,
      applyCardAutoTags: noop, close: noop,
    },
  };
}

function variantProps(gen: Generation): ComponentProps<typeof SceneVariantPopup> {
  return {
    cardId: "result-card", sceneId: "scene",
    cards: [{ id: "result-card", kind: "generation", genId: gen.id, x: 0, y: 0 }],
    genData: { [gen.id]: gen }, disabledIds: new Set(), projects: [], autoTagOptions: [],
    ui: {
      popupSel: new Set(), setPopupSel: noop, popupAnchorRef: { current: null }, popupMarq: null,
      gripDragging: false, setGripDragging: noop, tagEditGid: null, setTagEditGid: noop,
      tagEditorPos: null, varGridRef: createRef<HTMLDivElement>(), varpopWrapRef: createRef<HTMLDivElement>(),
      onVarGridMouseDown: noop,
    },
    gen: {
      sConfirm: null, onNodeSClick: noop, onNodeSDouble: noop, onNodeSConfirmYes: noop,
      onNodeSConfirmNo: noop, tagsEnabled: false, hasAutoTags: false,
      applyCardTags: noop, applyCardAutoTags: noop,
    },
    actions: { setCardMenu: noop, setCardVariant: noop, pruneVariants: noop, latestCard: () => undefined },
  };
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = container.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  setLang("ko");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLang("ko");
  vi.unstubAllGlobals();
});

describe.each(["ko", "en"] as const)("생성 오류 실제 UI — %s", (lang) => {
  it.each(["grid", "list"] as const)("작업 공간·공유 카드 %s에서 실패·보류 원인을 동일하게 표시한다", async (layout) => {
    setLang(lang);
    for (const tab of ["my", "team"] as const) {
      for (const patch of [
        {},
        { status: "failed" as const, execution_phase: "failed" as const, error: GROUP_LIMIT },
      ]) {
        const g = generation(patch);
        const issue = generationIssueFor(g.status, g.error, g.execution_phase)!;
        expect(issue).not.toBeNull();
        await render(<GenerationCard {...libraryProps(g)} layout={layout} tab={tab} />);
        const tile = required(".thumb-placeholder");
        expect(tile.textContent).toBe(issue.title);
        expect(tile.title).toContain(issue.action);
        expect(tile.textContent).not.toContain("HF 확인");
      }
    }
  });

  it("썸네일이 있는 실패 카드의 상태 배지도 원인을 표시한다", async () => {
    setLang(lang);
    const g = generation({ status: "failed", execution_phase: "failed", assets: [{
      id: "asset", generation_id: "issue-fixture", type: "image", file_path: "/fixture.png",
      thumbnail_path: "/fixture.png", source_url: null, cached: false,
    }] });
    await render(<GenerationCard {...libraryProps(g)} />);
    expect(required(".status-pill").textContent).toBe(generationIssueFor(g.status, g.error, g.execution_phase)?.title);
  });

  it("생성 정보는 원인·해결방법·접힌 전체 원문과 기존 복구 확인을 함께 표시한다", async () => {
    setLang(lang);
    const g = generation();
    const issue = generationIssueFor(g.status, g.error, g.execution_phase)!;
    const requeue = vi.fn().mockResolvedValue(false);
    await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }}
      onClose={noop} onPreview={noop} onRecoveryRequeue={requeue} />);
    const panel = required(".info-recovery");
    expect(panel.textContent).toContain(issue.title);
    expect(panel.textContent).toContain(issue.detail);
    expect(panel.textContent).toContain(issue.action);
    const original = required<HTMLDetailsElement>(".info-error-details");
    expect(original.open).toBe(false);
    expect(original.textContent).toContain(RECOVERY_ERROR);
    const button = required<HTMLButtonElement>(".info-recovery-btn");
    expect(button.textContent).toBe(lang === "ko" ? "미제출 확인 후 다시 실행" : "Confirm not submitted, then run again");
    expect(requeue).not.toHaveBeenCalled();
    expect(api.prepareRegenerate).not.toHaveBeenCalled();
  });

  it("캔버스·결과 묶음·히스토리도 동일 원인과 해결 안내를 표시한다", async () => {
    setLang(lang);
    for (const patch of [{}, { status: "failed" as const, execution_phase: "failed" as const }]) {
      const g = generation(patch);
      const issue = generationIssueFor(g.status, g.error, g.execution_phase)!;
      await render(<CanvasGenerationCard {...canvasProps(g)} />);
      expect(required(".scene-card-genbody").textContent).toBe(issue.title);
      expect(required(".scene-card-genbody").title).toContain(issue.action);
      await render(<SceneVariantPopup {...variantProps(g)} />);
      const result = required(".scene-varpop-item .thumb-placeholder, .scene-varpop-ph");
      expect(result.textContent).toBe(issue.title);
      expect(result.title).toContain(issue.action);
      await render(<HistoryBoardNode {...historyProps(g)} />);
      expect(required(".linb-ph").textContent).toBe(issue.title);
      expect(required(".linb-ph").title).toContain(issue.action);
    }
  });
});

it("실패와 recovery_required가 겹쳐도 같은 원인을 두 번 표시하지 않는다", async () => {
  const g = generation({ status: "failed" });
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(container.querySelectorAll(".info-recovery")).toHaveLength(1);
  expect(container.querySelector(".info-error")).toBeNull();
});

it("잔액 부족은 그룹 한도와 다른 카드·정보 제목을 표시한다", async () => {
  const g = generation({ status: "failed", execution_phase: "failed", error: "CLI 실패: Error: Insufficient credits" });
  await render(<GenerationCard {...libraryProps(g)} />);
  expect(required(".thumb-placeholder").textContent).toBe("크레딧 부족");
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(required(".info-error-label").textContent).toContain("크레딧 부족");
  expect(required<HTMLDetailsElement>(".info-error-details").open).toBe(false);
  expect(required(".info-error-details").textContent).toContain(g.error);
});

it("이유가 불명확한 기존 보류도 중립 제출 확인 안내와 원문을 보존한다", async () => {
  const g = generation({ error: "HF 확인 필요 — 외부 제출 여부 불명확" });
  await render(<GenerationCard {...libraryProps(g)} />);
  expect(required(".thumb-placeholder").textContent).toBe("제출 확인 필요");
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(required(".info-recovery-label").textContent).toContain("제출 확인 필요");
  expect(required(".info-error-details").textContent).toContain(g.error);
});

it.each(["ko", "en"] as const)("%s 미분류 실패도 원인을 지어내지 않고 접힌 원문을 제공한다", async (lang) => {
  setLang(lang);
  const g = generation({ status: "failed", execution_phase: "failed", error: "Unexpected external condition" });
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(required(".info-error-label").textContent).toContain(lang === "ko" ? "실패 사유" : "Failure reason");
  expect(required<HTMLDetailsElement>(".info-error-details").open).toBe(false);
  expect(required(".info-error-details").textContent).toContain(g.error);
});

it("정상 완료·취소·재시도 중 카드는 예전 크레딧 오류로 덮어쓰지 않는다", async () => {
  for (const patch of [
    { status: "done" as const, execution_phase: "done" as const },
    { status: "failed" as const, execution_phase: "canceled" as const },
    { status: "pending" as const, execution_phase: "pending" as const },
    { status: "running" as const, execution_phase: "tracking" as const },
    { status: "nsfw" as const, execution_phase: "failed" as const },
  ]) {
    const g = generation(patch);
    expect(generationIssueFor(g.status, g.error, g.execution_phase)).toBeNull();
    await render(<GenerationCard {...libraryProps(g)} />);
    expect(required(".thumb-placeholder").textContent).toBe(generationStatusLabelFor(g.status, g.error, g.execution_phase));
    expect(required(".thumb-placeholder").textContent).not.toContain("크레딧");
  }
});

it("메모된 히스토리 카드와 정보창도 언어 변경 즉시 원인 안내를 갱신한다", async () => {
  const g = generation();
  await render(<><HistoryBoardNode {...historyProps(g)} />
    <InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} /></>);
  expect(required(".linb-ph").textContent).toContain("크레딧");
  act(() => setLang("en"));
  const issue = generationIssueFor(g.status, g.error, g.execution_phase)!;
  expect(required(".linb-ph").textContent).toBe(issue.title);
  expect(required(".info-recovery-label").textContent).toContain(issue.title);
  expect(required(".info-error-details > summary").textContent).toBe("Original error");
});

it("원인을 표시해도 recovery_required 재생성은 차단하고 추가 제출하지 않는다", async () => {
  const flash = vi.fn();
  let actions: ReturnType<typeof useGenerationCardActions>;
  function Host() {
    actions = useGenerationCardActions({
      armedAutoTags: new Set(), bumpBoard: noop, flash,
      canFinalize: () => true,
      navTab: noop, reload: async () => {}, workspace: { scope: "personal", id: null, name: null },
    });
    return null;
  }
  await render(<Host />);
  const g = generation();
  expect(await actions!.onRegenerate(g)).toBeNull();
  expect(flash).toHaveBeenCalledWith(expect.stringContaining(generationIssueFor(g.status, g.error, g.execution_phase)!.title));
  expect(api.prepareRegenerate).not.toHaveBeenCalled();
  expect(api.confirmGenerationNotSubmitted).not.toHaveBeenCalled();
});

it.each(["ko", "en"] as const)("%s 재실행 동의에는 원인과 과금 주의를 보존하고 취소하면 요청하지 않는다", async (lang) => {
  setLang(lang);
  let actions: ReturnType<typeof useGenerationCardActions>;
  function Host() {
    actions = useGenerationCardActions({
      armedAutoTags: new Set(), bumpBoard: noop, flash: noop,
      canFinalize: () => true,
      navTab: noop, reload: async () => {}, workspace: { scope: "personal", id: null, name: null },
    });
    return null;
  }
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await render(<Host />);
    const g = generation();
    const issue = generationIssueFor(g.status, g.error, g.execution_phase)!;
    expect(await actions!.onRecoveryRequeue(g)).toBe(false);
    const message = confirm.mock.calls[0][0];
    expect(message).toContain(issue.title);
    expect(message).toContain(issue.action);
    expect(message).toContain(lang === "ko" ? "크레딧이 사용될 수 있습니다" : "may use credits");
    expect(api.confirmGenerationNotSubmitted).not.toHaveBeenCalled();
    expect(api.prepareRegenerate).not.toHaveBeenCalled();
  } finally {
    confirm.mockRestore();
  }
});

it("자동 조사 no_match 뒤에도 원인 해결과 수동 제출 확인 안내는 유지한다", async () => {
  const g = generation({ recovery_probe_status: "no_match" });
  const requeue = vi.fn();
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }}
    onClose={noop} onPreview={noop} onRecoveryRequeue={requeue} />);
  const panel = required(".info-recovery");
  expect(panel.textContent).toContain(generationIssueFor(g.status, g.error, g.execution_phase)!.action);
  expect(panel.textContent).toContain("자동 재실행 안 함 · 제출 확인 필요");
  expect(required(".info-recovery-btn").textContent).toBe("다시 실행");
  expect(requeue).not.toHaveBeenCalled();
});

it("취소된 생성물은 예전 오류를 실패 사유로 다시 보여주지 않는다", async () => {
  const g = generation({ status: "failed", execution_phase: "canceled" });
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(container.querySelector(".info-error")).toBeNull();
  expect(container.querySelector(".info-recovery")).toBeNull();
});

it("완료 응답에 옛 복구 단계가 남아도 재실행 확인 패널을 표시하지 않는다", async () => {
  const g = generation({ status: "done" });
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(container.querySelector(".info-error")).toBeNull();
  expect(container.querySelector(".info-recovery")).toBeNull();
});

it("보류 배지는 히스토리·캔버스·변형 팝업에서 빨강 S로 표시한다", async () => {
  const g = generation({ shared: true, is_held: true, status: "done", execution_phase: "done", error: null });
  await render(<HistoryBoardNode {...historyProps(g)} />);
  expect(required(".linb-sf.held").textContent).toBe("S");
  await render(<CanvasGenerationCard {...canvasProps(g)} showNode />);
  expect(required(".linb-sf.held").textContent).toBe("S");
  await render(<SceneVariantPopup {...variantProps(g)} />);
  expect(required(".card-sf.held").textContent).toBe("S");
});

it.each(["nsfw", "failed"] as const)("%s 종료의 phase가 done이어도 원래 사유를 숨기지 않는다", async (status) => {
  const g = generation({ status, execution_phase: "done", error: "Provider rejected the content" });
  await render(<InfoPopup target={{ kind: "generation", gen: g, x: 0, y: 0 }} onClose={noop} onPreview={noop} />);
  expect(required(".info-error").textContent).toContain(g.error);
  expect(container.querySelector(".info-recovery")).toBeNull();
});

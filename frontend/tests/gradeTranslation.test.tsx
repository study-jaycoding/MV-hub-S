// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { GradeStepModal } from "../src/components/GradeStepModal";
import { LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import { computeGradeStep, describeGradeStep, type GradeMode } from "../src/lib/gradeStep";
import { setLang, t } from "../src/lib/i18n";
import { MIRROR_PENDING_NOTICE, withMirrorPendingNotice } from "../src/lib/shareMirrorPending";
import { useGenerationCardActions } from "../src/lib/useGenerationCardActions";
import { useGradeStep } from "../src/lib/useGradeStep";
import { useGenerationShareActions } from "../src/lib/useGenerationShareActions";
import type { Generation } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  publishToShared: vi.fn(), publishFolderToShared: vi.fn(), unpublish: vi.fn(), finalize: vi.fn(), unfinalize: vi.fn(), unhold: vi.fn(),
  setReviewState: vi.fn(),
} }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: vi.fn() }));

const noop = () => {};
const gen = (patch: Partial<Generation> = {}): Generation => ({
  id: "translation-fixture", shared: true, is_held: false, is_final: false, is_mine: true,
  status: "done", assets: [], references: [], tags: [], auto_tags: [], ...patch,
} as unknown as Generation);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLang("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.unstubAllGlobals(); });

it.each([
  ["up", gen({ is_held: true }), "Raise grade"],
  ["down", gen({ is_final: true }), "Lower grade"],
  ["single", gen({ shared: false }), "Share to team"],
  ["single", gen(), "Remove sharing"],
  ["double", gen(), "Raise grade"],
  ["double", gen({ is_final: true }), "Remove final status"],
] satisfies [GradeMode, Generation, string][])("%s translates its confirmation without changing grade operations", (mode, generation, title) => {
  const result = computeGradeStep([generation], mode, () => true);
  const description = describeGradeStep(result, t);
  expect(description.title).toBe(title);
  expect(description.body).toContain("1");
  expect(description.body).not.toMatch(/[가-힣]|\{count\}/);
  // Callers that do not opt into translation retain the original Korean contract.
  expect(describeGradeStep(result).body).toContain("선택한 1개");
});

it("translates kept counts and empty results after translating the template", () => {
  const result = computeGradeStep([gen(), gen({ id: "kept", is_final: true })], "up", () => true);
  expect(describeGradeStep(result, t).body).toContain("1 unchanged or not permitted");
  expect(describeGradeStep(result).body).toContain(" (1개는 유지·권한없음)");
  const empty = describeGradeStep(computeGradeStep([], "up", () => true), t);
  expect(empty).toEqual({ title: "No eligible items", body: "None of the selected cards can be changed right now." });
});

it("an open bulk modal updates both body and button labels when language changes", () => {
  const pending = computeGradeStep([gen({ is_held: true })], "down", () => true);
  act(() => root.render(<GradeStepModal pending={pending} busy={false} onConfirm={noop} onCancel={noop} />));
  expect(host.querySelector(".gradestep-title")?.textContent).toBe("Lower grade");
  expect(host.querySelector(".gradestep-body")?.textContent).toContain("Final→Shared, Shared/On hold→Unshared");
  expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Cancel", "Confirm"]);
  act(() => setLang("ko"));
  expect(host.querySelector(".gradestep-title")?.textContent).toBe("단계 내리기");
  expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["취소", "확인"]);
  act(() => setLang("en"));
  act(() => root.render(<GradeStepModal pending={pending} busy onConfirm={noop} onCancel={noop} />));
  expect(host.querySelector(".gradestep-btn.confirm")?.textContent).toBe("Applying…");
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

it("arrow tooltips translate and retain the requested held transitions", () => {
  act(() => root.render(<LibrarySelectionActionBar selectedCount={1} selectedGenerations={[gen()]} projects={[]}
    onShare={noop} onGradeStep={noop} onDownload={noop} onResolveTransfer={noop} onResolveRetry={null}
    resolveRetryProjectName="" resolveTransferBusy={false} resolveTransferPendingCount={0}
    onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop} />));
  const titles = () => [...host.querySelectorAll<HTMLButtonElement>(".sb-grade button")].map((button) => button.title);
  expect(titles()).toEqual([
    "Lower grade (Final→Shared, Shared/On hold→Unshared)",
    "Raise grade (Unshared/On hold→Shared, Shared→Final)",
  ]);
  act(() => setLang("ko"));
  expect(titles()[0]).toBe("단계 내리기 (최종→공유, 공유·보류→일반)");
});

it("single-card questions share the existing translation dictionary", () => {
  expect(["공유 하시겠습니까?", "공유 해제 할까요?", "최종(골드)으로 지정할까요?", "최종 지정을 해제할까요?"].map(t))
    .toEqual(["Share this result?", "Remove sharing?", "Mark as final (gold)?", "Remove final status?"]);
});

it("mirror notices translate only for opted-in callers", () => {
  expect(withMirrorPendingNotice("Done.", { mirror_pending: true }, t)).toBe("Done. Some local updates will sync automatically shortly.");
  expect(withMirrorPendingNotice("Done.", { mirror_pending: true })).toBe(`Done. ${MIRROR_PENDING_NOTICE}`);
  expect(withMirrorPendingNotice("Done.", { mirror_pending: false }, t)).toBe("Done.");
});

it("bulk results translate counts, partial failures and mirror pending at completion", async () => {
  let actions!: ReturnType<typeof useGradeStep>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGradeStep({ canFinalize: () => true, flash, reload }); return null; }
  act(() => root.render(<Harness />));
  vi.mocked(api.unpublish).mockResolvedValueOnce(gen({ mirror_pending: true })).mockRejectedValueOnce(new Error("denied"));
  act(() => actions.requestGradeStep([gen(), gen({ id: "failed" })], "down"));
  await act(async () => actions.confirm());
  expect(flash).toHaveBeenLastCalledWith("1 applied · 1 failed/skipped Some local updates will sync automatically shortly.");
  expect(api.unpublish).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledTimes(1);
  act(() => actions.requestGradeStep([gen({ shared: false, is_mine: false })], "single"));
  expect(flash).toHaveBeenLastCalledWith("No eligible items to change.");
});

// Codex 조작 점검(2026-10-14) — 처리 뒤 같은 선택으로 또 누르면, 화면이 아직 든 옛 상태가 아니라 **서버의 답**으로 방향을 잡는다(목록을
//  다시 받는 중이거나 받지 못했을 때 — 그 생성물의 객체가 그대로다). 목록이 새로 오면(객체가 바뀐다) 목록을 믿는다. 잠그고 기다리지
//  않는다: 다시 받기는 실패해도 조용히 끝나고, 뒤따르는 조회가 늦으면 끝나지 않는다.
it("the next grade step after a run uses the server's answer until the list brings a new object", async () => {
  let actions!: ReturnType<typeof useGradeStep>;
  const flash = vi.fn(), reload = vi.fn(() => new Promise<void>(() => {})); // 다시 받기가 끝나지 않는다
  function Harness() { actions = useGradeStep({ canFinalize: () => true, flash, reload }); return null; }
  act(() => root.render(<Harness />));
  const stale = gen({ id: "a", is_final: true }); // 화면이 든 것 — 처리 뒤에도 같은 객체다(목록이 아직 안 왔다)
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "a", is_final: false, is_held: true })); // 최종 전에 보류였다 → 보류로
  act(() => actions.requestGradeStep([stale], "down"));
  await act(async () => { void actions.confirm(); for (let turn = 0; turn < 8; turn++) await Promise.resolve(); });
  expect([actions.pending, actions.busy, reload.mock.calls.length]).toEqual([null, false, 1]); // 확인 창은 닫혔고, 잠그지 않는다
  act(() => actions.requestGradeStep([stale], "up")); // 옛 상태(최종)로 보면 올릴 것이 없다 — 서버의 답(보류)으로 보면 보류 해제다
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unhold"]);
  act(() => actions.cancel());
  act(() => actions.requestGradeStep([stale], "double")); // 옛 상태면 또 '최종 해제'
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["finalize"]);
  act(() => actions.cancel());
  act(() => actions.requestGradeStep([{ ...stale }], "down")); // 목록이 새로 왔다(객체가 다르다) — 목록을 믿는다
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unfinalize"]);
  act(() => actions.cancel());
  act(() => actions.requestGradeStep([stale], "up")); // 서버의 답은 그때 버렸다 — 옛 객체가 다시 와도 쓰지 않는다
  expect(flash).toHaveBeenLastCalledWith("No eligible items to change.");
});

// Jay 2026-10-14 — 최종을 해제하면 원래의 보류로: 여러 장을 한 번에 풀 때도(S 더블클릭 · ↓) 보류로 돌아간 수를 알린다. 올리는 쪽(최종 지정 ·
//  보류 해제)의 응답은 세지 않는다.
it("bulk un-final says how many went back on hold", async () => {
  let actions!: ReturnType<typeof useGradeStep>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGradeStep({ canFinalize: () => true, flash, reload }); return null; }
  act(() => root.render(<Harness />));
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "was-held", is_held: true })).mockResolvedValueOnce(gen({ id: "was-shared" }));
  act(() => actions.requestGradeStep([gen({ id: "was-held", is_final: true }), gen({ id: "was-shared", is_final: true })], "double"));
  await act(async () => actions.confirm());
  expect(vi.mocked(api.unfinalize).mock.calls.map(([id]) => id)).toEqual(["was-held", "was-shared"]);
  expect(flash).toHaveBeenLastCalledWith("2 applied · 1 back on hold");
  setLang("ko");
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "was-held", is_held: true }));
  act(() => actions.requestGradeStep([gen({ id: "was-held", is_final: true })], "down"));
  await act(async () => actions.confirm());
  expect(flash).toHaveBeenLastCalledWith("1개 적용 · 원래의 보류로 1개");
  // 올리는 쪽: 보류 해제(↑)의 응답이 보류로 와도(그럴 일은 없지만) 세지 않는다 — 해제의 것만 센다
  vi.mocked(api.unhold).mockResolvedValueOnce(gen({ id: "h", is_held: true }));
  act(() => actions.requestGradeStep([gen({ id: "h", is_held: true })], "up"));
  await act(async () => actions.confirm());
  expect(flash).toHaveBeenLastCalledWith("1개 적용");
});

it.each([
  ["onUnpublish", "unpublish", "Removed team sharing.", "Could not remove sharing:"],
  ["onFinalize", "finalize", "Marked as final (gold).", "Could not mark as final:"],
  ["onUnfinalize", "unfinalize", "Removed final status.", "Could not remove final status:"],
] as const)("%s translates success/failure UI but preserves original error details", async (handler, apiMethod, success, failure) => {
  let actions!: ReturnType<typeof useGenerationCardActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGenerationCardActions({ armedAutoTags: new Set(),
    bumpBoard: noop, canFinalize: () => true, flash, navTab: noop, reload,
    workspace: { scope: "personal", id: null, name: null } }); return null; }
  act(() => root.render(<Harness />));
  vi.mocked(api[apiMethod]).mockResolvedValueOnce(gen({ mirror_pending: true })).mockRejectedValueOnce(new Error("서버 원문"));
  await act(async () => actions[handler](gen()));
  expect(flash).toHaveBeenLastCalledWith(`${success} Some local updates will sync automatically shortly.`);
  await act(async () => actions[handler](gen()));
  expect(flash).toHaveBeenLastCalledWith(`${failure} Error: 서버 원문`);
  expect(api[apiMethod]).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledTimes(1);
});

it("normal sharing translates success, failure and empty selections without changing eligibility", async () => {
  let actions!: ReturnType<typeof useGenerationShareActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined), bumpBoard = vi.fn();
  function Harness() { actions = useGenerationShareActions({ flash, reload, bumpBoard }); return null; }
  act(() => root.render(<Harness />));
  vi.mocked(api.publishToShared).mockResolvedValueOnce({ ok: true, published: 0, blocked: 0, mirror_pending: true, message: "서버 원문" })
    .mockRejectedValueOnce(new Error("403: 서버 거절"));
  await act(async () => actions.onPublish(gen({ shared: false })));
  expect(flash).toHaveBeenLastCalledWith("1 shared with the team. 서버 원문 Some local updates will sync automatically shortly.");
  expect(api.publishToShared).toHaveBeenLastCalledWith(["translation-fixture"]);
  await act(async () => actions.onPublish(gen({ shared: false })));
  expect(flash).toHaveBeenLastCalledWith("Could not share: 서버 거절");
  // 공유는 됐는데 뒤의 다시 읽기가 실패 — 까닭만 보인다("TypeError:" 앞머리는 뗀다, 28회차 errorDetail 통일)
  vi.mocked(api.publishToShared).mockResolvedValueOnce({ ok: true, published: 1, blocked: 0, mirror_pending: false, message: "" });
  reload.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await act(async () => actions.onPublish(gen({ shared: false })));
  expect(flash).toHaveBeenLastCalledWith("Could not share: Failed to fetch");
  await act(async () => actions.boardShare([gen(), gen({ is_mine: false, shared: false })]));
  expect(flash).toHaveBeenLastCalledWith("No eligible items to share (your completed, unshared results only).");
  expect(api.publishToShared).toHaveBeenCalledTimes(3);
});

it("folder sharing translates UI while preserving folder names and raw server details", async () => {
  let actions!: ReturnType<typeof useGenerationShareActions>;
  const flash = vi.fn(), reload = vi.fn().mockResolvedValue(undefined);
  function Harness() { actions = useGenerationShareActions({ flash, reload, bumpBoard: noop }); return null; }
  act(() => root.render(<Harness />));
  const name = "테스트 $& {count}";
  const remote = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  vi.mocked(api.publishFolderToShared).mockResolvedValueOnce({ ok: true, total: 4, accepted: 2, published: 0,
    attempted: 3, blocked: 1, unprocessed: 1, error: "원문 $& {count}", message: "서버 응답", mirror_pending: true,
    remote,
  }).mockResolvedValueOnce({ ok: true, total: 0, accepted: 0, published: 0, attempted: 0, blocked: 0, unprocessed: 0,
    error: null, message: null, mirror_pending: false, remote });
  await act(async () => actions.folderShare("project", "e001/c0010", name));
  expect(api.publishFolderToShared).toHaveBeenLastCalledWith("project", "e001/c0010");
  expect(flash).toHaveBeenLastCalledWith(`Shared 2 items from '${name}' with the team. 서버 응답 Stopped: 원문 $& {count} (1 remaining — run again to resume sharing) Some local updates will sync automatically shortly.`);
  await act(async () => actions.folderShare("project", "e001/c0010", name));
  expect(flash).toHaveBeenLastCalledWith(`No eligible items to share in '${name}' (your completed, unshared results only).`);
});

it.each([
  "최종(골드)", "팀 공유됨", "최종(골드) — 더블클릭=최종 해제 (공유 잠금)",
  "팀 공유됨 · 클릭=공유 해제 · 더블클릭=최종 지정(Supervisor)",
  "팀 공유 (클릭) · 최종 지정은 공유 후 더블클릭", "클릭=공유 해제 · 더블클릭=최종 지정 (Supervisor)",
  "더블클릭=최종 지정(Supervisor)", "최종(골드) · 더블클릭=최종 해제",
  "팀 공유됨 · 클릭=공유 해제 · 더블클릭=최종 지정", "팀 공유 (클릭) · 공유 후 더블클릭=최종 지정",
  "최종(골드) — 더블클릭=최종 해제", "팀 공유됨 · 클릭=해제 · 더블클릭=최종",
  "팀 공유 (클릭) · 최종은 공유 후 더블클릭", "더블클릭=최종 지정 (Supervisor)",
])("translates the existing S tooltip: %s", (tooltip) => {
  expect(t(tooltip)).not.toMatch(/[가-힣]/);
});

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

// Codex 조작 점검(2026-10-14) — 처리 뒤 같은 선택으로 또 누르면, 화면이 아직 든 옛 상태가 아니라 **서버의 답**으로 방향을 잡는다. 그
//  기억은 시간으로만 끝난다(10초) — 목록과 견줘 '따라왔나'를 판단하지 않는다(객체가 같은지 · 그때의 등급과 같은지 — 둘 다 구멍이 났다).
//  잠그고 기다리지도 않는다: 다시 받기는 실패해도 조용히 끝나고, 뒤따르는 조회가 늦으면 끝나지 않는다.
it("the next grade step after a run uses the server's answer for a few seconds", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
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
  // 색만 바뀐 새 객체(등급은 옛 값 그대로)에서도 같다 — 객체가 같은지로 보지 않는다
  act(() => actions.requestGradeStep([{ ...stale, color: "red" } as Generation], "up"));
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unhold"]);
  act(() => actions.cancel());
  clock.mockReturnValue(1_000_000 + 9_999); // 기억하는 동안
  act(() => actions.requestGradeStep([stale], "up"));
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unhold"]);
  act(() => actions.cancel());
  clock.mockReturnValue(1_000_000 + 10_000); // 10초가 지났다 — 화면에 보이는 상태(최종)대로 계산한다
  act(() => actions.requestGradeStep([stale], "up"));
  expect(flash).toHaveBeenLastCalledWith("No eligible items to change.");
  clock.mockRestore();
});

// 기억한 상태로 낸 요청이 거절되면 그 기억이 틀린 것이다(그사이 남이 바꿨다) — 기록을 지우고 목록으로 돌아간다. 두면 같은 거절이
//  되풀이된다(Codex 4차). 확인 창이 떠 있는 동안 목록이 따라와도, 이어진 조작의 답은 그대로 기억한다(같은 4차).
it("a rejected request drops the remembered answer, and a late list does not disturb the next one", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  let actions!: ReturnType<typeof useGradeStep>;
  const flash = vi.fn(), reload = vi.fn(() => new Promise<void>(() => {}));
  function Harness() { actions = useGradeStep({ canFinalize: () => true, flash, reload }); return null; }
  act(() => root.render(<Harness />));
  const run = async () => { await act(async () => { void actions.confirm(); for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }); };
  const shown = gen({ id: "a", is_final: true }); // 화면이 든 것(최종)
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "a", is_final: false, is_held: true }));
  act(() => actions.requestGradeStep([shown], "down"));
  await run(); // 기억: 보류
  act(() => actions.requestGradeStep([shown], "up")); // 기억으로 — 보류 해제
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unhold"]);
  vi.mocked(api.unhold).mockRejectedValueOnce(new Error("409: 최종 지정을 먼저 해제")); // 그사이 남이 다시 최종으로 올렸다
  await run();
  act(() => actions.requestGradeStep([shown], "down")); // 기억을 지웠다 — 화면(최종)대로: 최종 해제(기억이 남았다면 '보류'라 공유 해제였다)
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unfinalize"]);

  // 확인 창이 떠 있는 동안 목록이 따라온다: 해제(→ 보류) → ↑ 의 확인 창 → [목록이 '보류'로 온다] → 확인(→ 공유) → 다음 ↑ 는 최종 지정
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "a", is_final: false, is_held: true }));
  await run();
  act(() => actions.requestGradeStep([shown], "up"));
  vi.mocked(api.unhold).mockResolvedValueOnce(gen({ id: "a", is_final: false, is_held: false }));
  await run();
  const caughtUp = { ...shown, is_final: false, is_held: true }; // 목록은 한 걸음 늦게 '보류'를 들고 왔다
  act(() => actions.requestGradeStep([caughtUp], "up"));
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["finalize"]); // 방금의 답(공유)으로 — 목록(보류)대로면 또 보류 해제였다
  clock.mockRestore();
});

// 이어서 누르는 조작(Codex 3차) — 공유 해제 → 발행 → 다시 ↑: 발행의 결과도 적어야 마지막이 '최종 지정'이 된다(안 적으면 '공유 아님'
//  기록이 남아 또 발행한다). 묶음 발행이 일부만 됐으면 어느 것인지 모른다 — 그 기록을 지우고 목록을 본다.
it("consecutive runs keep the record current — unpublish, publish, then the next step is finalize", async () => {
  let actions!: ReturnType<typeof useGradeStep>;
  const flash = vi.fn(), reload = vi.fn(() => new Promise<void>(() => {})); // 목록은 끝내 안 온다
  function Harness() { actions = useGradeStep({ canFinalize: () => true, flash, reload }); return null; }
  act(() => root.render(<Harness />));
  const run = async () => { await act(async () => { void actions.confirm(); for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }); };
  const a = gen({ id: "a" }), b = gen({ id: "b" }); // 화면이 든 것: 둘 다 내 것 · 공유(끝까지 이 값 그대로다)
  vi.mocked(api.unpublish).mockImplementation(async (id: string) => gen({ id, shared: false }));
  act(() => actions.requestGradeStep([a, b], "down"));
  await run();
  act(() => actions.requestGradeStep([a, b], "up")); // 서버의 답(공유 아님)으로 — 다시 발행이다
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["publish", "publish"]);
  vi.mocked(api.publishToShared).mockResolvedValueOnce({ ok: true, published: 2, blocked: 0, mirror_pending: false, message: "" });
  await run();
  act(() => actions.requestGradeStep([a, b], "up")); // 발행도 적었다 — 이제 최종 지정이다(안 적으면 또 발행)
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["finalize", "finalize"]);
  act(() => actions.cancel());

  act(() => actions.requestGradeStep([a, b], "down")); // 다시 공유 해제
  await run();
  act(() => actions.requestGradeStep([a, b], "up"));
  vi.mocked(api.publishToShared).mockResolvedValueOnce({ ok: true, published: 1, blocked: 1, mirror_pending: false, message: "" }); // 하나만 됐다
  await run();
  act(() => actions.requestGradeStep([a, b], "single")); // 어느 것이 됐는지 모른다 — 기록을 지우고 목록(둘 다 공유)을 본다: 공유 해제
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["unpublish", "unpublish"]);
  act(() => actions.cancel());

  // 일부만 된 발행을 '전부 공유됨'으로 적지도 않는다 — 화면이 '공유 아님'인 둘: 하나만 됐으면 다음 ↑ 도 둘 다 발행 대상이다
  const c = gen({ id: "c", shared: false }), d = gen({ id: "d", shared: false });
  act(() => actions.requestGradeStep([c, d], "up"));
  vi.mocked(api.publishToShared).mockResolvedValueOnce({ ok: true, published: 1, blocked: 1, mirror_pending: false, message: "" });
  await run();
  act(() => actions.requestGradeStep([c, d], "up"));
  expect(actions.pending?.ops.map((op) => op.action)).toEqual(["publish", "publish"]);
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
  // 다른 생성물로 본다 — 방금 푼 것과 같은 id 를 '아직 최종'으로 다시 넘기면 옛 목록으로 보고 서버의 답(보류)을 쓴다(아래 시험)
  vi.mocked(api.unfinalize).mockResolvedValueOnce(gen({ id: "another", is_held: true }));
  act(() => actions.requestGradeStep([gen({ id: "another", is_final: true })], "down"));
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

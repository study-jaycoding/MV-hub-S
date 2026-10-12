// @vitest-environment jsdom
// 두 창이 같은 저장소(localStorage)의 표를 쓸 때(조작 규칙 48 — 21회차, Codex 전수 검토).
// 표를 통째로 들고 있다가 통째로 저장하면, 다른 창이 그사이 바꾼 항목이 이 창의 낡은 사본에 지워진다 — 저장 직전에 최신을 다시 읽어
// **이 창이 바꾼 것만** 반영한다. 여기서 '다른 창'은 저장소를 직접 고치는 것으로 흉내 낸다(이 창의 메모리 사본은 그대로 낡아 있다).
// Resolve Assets 의 색·비활성은 tests/resolveProjectBrowser 에 있다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAccountNamespace } from "../src/lib/accountScope";
import { DISABLED_EVENT } from "../src/lib/deactivated";
import { mergeOwnChanges, mergeOwnSetChanges } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetModules(); // 메모리 사본을 가진 모듈(teamSeen·stateGlow)을 시험마다 새로 읽는다
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const stored = <T,>(key: string) => JSON.parse(localStorage.getItem(key) ?? "null") as T;
/** 다른 창이 저장소를 고쳤다 — 이 창에는 storage 이벤트가 아직 오지 않았다(알림이 오기 전의 틈). */
const otherWindowWrites = (key: string, change: (value: never) => unknown) => {
  localStorage.setItem(key, JSON.stringify(change((stored<unknown>(key) ?? {}) as never)));
};

it("이 창이 바꾼 항목만 최신 표에 반영한다 — 안 건드린 항목은 저장소의 것을 두고, 이 창이 지운 것은 지운다", () => {
  const before = { a: 1, b: 2, c: 3 };
  // a 는 다른 창이 바꿈(이 창은 안 건드림) · b 는 이 창이 바꿈 · c 는 이 창이 지움(저장소에는 아직 있다 — 지워져야 한다) · d 는 다른 창이 더함
  expect(mergeOwnChanges({ a: 9, b: 2, c: 3, d: 4 }, before, { a: 1, b: 7 })).toEqual({ a: 9, b: 7, d: 4 });
  expect([...mergeOwnSetChanges(new Set(["x", "other"]), new Set(["x", "y"]), new Set(["y", "z"]))].sort()).toEqual(["other", "z"]); // x 는 이 창이 뺌 · z 는 더함 · y 는 다른 창이 뺌
});

it("계보 판의 수동 배치 — 다른 창이 그사이 옮긴 노드의 자리를 이 창의 저장이 지우지 않는다", async () => {
  const { useHistoryManualPositions } = await import("../src/components/history/useHistoryManualPositions");
  let move!: (id: string, x: number) => void;
  function Probe() {
    const { setManualPos } = useHistoryManualPositions(null);
    move = (id, x) => setManualPos((prev) => ({ ...prev, [id]: { x, y: 0 } }));
    return null;
  }
  localStorage.setItem(STORAGE_KEYS.historyPos, JSON.stringify({ old: { x: 1, y: 1 } }));
  act(() => root.render(<Probe />));
  otherWindowWrites(STORAGE_KEYS.historyPos, (value: Record<string, unknown>) => ({ ...value, X: { x: 50, y: 50 } }));
  act(() => move("Y", 70));
  expect(stored(STORAGE_KEYS.historyPos)).toEqual({ old: { x: 1, y: 1 }, X: { x: 50, y: 50 }, Y: { x: 70, y: 0 } }); // 전엔 X 가 없었다
  otherWindowWrites(STORAGE_KEYS.historyPos, (value: Record<string, unknown>) => { const { old: _old, ...rest } = value; return rest; });
  act(() => move("Y", 80)); // 다른 창이 지운 것을 이 창이 되살리지도 않는다
  expect(stored(STORAGE_KEYS.historyPos)).toEqual({ X: { x: 50, y: 50 }, Y: { x: 80, y: 0 } });
  // '이 창이 바꾼 것'은 **마지막 저장 뒤에** 바꾼 것이다 — 이미 저장한 Y 를 다른 창이 다시 옮겼으면, 이 창이 다른 노드를 옮길 때 그 Y 를 덮지 않는다
  otherWindowWrites(STORAGE_KEYS.historyPos, (value: Record<string, unknown>) => ({ ...value, Y: { x: 999, y: 9 } }));
  act(() => move("Z", 5));
  expect(stored(STORAGE_KEYS.historyPos)).toEqual({ X: { x: 50, y: 50 }, Y: { x: 999, y: 9 }, Z: { x: 5, y: 0 } });
});

it("프롬프트 기록 — 다른 창이 그사이 제출한 프롬프트의 기록을 이 창의 제출이 지우지 않는다", async () => {
  const { appendHistory, loadHistory } = await import("../src/lib/promptEditor");
  const entry = (text: string) => ({ parts: [{ t: "text" as const, v: text }], text });
  const memory = loadHistory(); // 이 창이 뜰 때 읽은 기록(비어 있다)
  const key = Object.keys(localStorage).length; // 기록의 저장 열쇠는 추측하지 않는다 — 한 번 써서 찾는다
  const first = appendHistory(entry("이 창의 첫 프롬프트"), memory);
  const histKey = Object.keys(localStorage).find((name) => localStorage.getItem(name)!.includes("이 창의 첫 프롬프트"))!;
  expect([key, first.map((item) => item.text)]).toEqual([0, ["이 창의 첫 프롬프트"]]);
  otherWindowWrites(histKey, (value: unknown[]) => [...value, entry("다른 창의 프롬프트")]);
  const next = appendHistory(entry("이 창의 둘째 프롬프트"), first); // 이 창의 메모리(first)에는 다른 창의 것이 없다
  expect(next.map((item) => item.text)).toEqual(["이 창의 첫 프롬프트", "다른 창의 프롬프트", "이 창의 둘째 프롬프트"]);
  expect(stored<{ text: string }[]>(histKey).map((item) => item.text)).toEqual(next.map((item) => item.text));
  expect(appendHistory(entry("다른 창의 프롬프트"), next).map((item) => item.text)) // 같은 글은 한 번만 — 맨 뒤로 온다
    .toEqual(["이 창의 첫 프롬프트", "이 창의 둘째 프롬프트", "다른 창의 프롬프트"]);
  localStorage.clear(); // 저장소를 못 읽으면(비었으면) 이 창의 기록에 더한다
  expect(appendHistory(entry("새 글"), next).map((item) => item.text)).toHaveLength(4);
});

it("새로 들어온 카드의 확인 — 다른 창에서 확인한 카드가 이 창의 확인으로 다시 '새것'이 되지 않는다", async () => {
  const seen = await import("../src/lib/teamSeen");
  const card = (id: string) => ({ id, job_id: null, shared_at: "2099-01-01 00:00:00" });
  seen.ensureTeamBase();
  expect([seen.isFreshGen(card("X")), seen.isFreshGen(card("Y"))]).toEqual([true, true]);
  const ns = getAccountNamespace();
  otherWindowWrites(STORAGE_KEYS.teamSeen, (map: Record<string, { seen: Record<string, unknown> }>) => ({
    ...map, [ns]: { ...map[ns], seen: { ...map[ns].seen, X: { at: "2099-01-01 00:00:00" } } },
  }));
  seen.ackTeamFresh(card("Y")); // 이 창의 메모리 사본에는 X 의 확인이 없다
  const seenKeys = () => Object.keys(stored<Record<string, { seen: Record<string, unknown> }>>(STORAGE_KEYS.teamSeen)[ns].seen).sort();
  expect(seenKeys()).toEqual(["X", "Y"]); // 전엔 Y 뿐
  expect(seen.isFreshGen(card("X"))).toBe(false);
  // '모두 확인'(여러 장을 한 번에)도 같다
  otherWindowWrites(STORAGE_KEYS.teamSeen, (map: Record<string, { seen: Record<string, unknown> }>) => ({
    ...map, [ns]: { ...map[ns], seen: { ...map[ns].seen, W: { at: "2099-01-01 00:00:00" } } },
  }));
  expect(seen.ackTeamFreshKeys([{ ackKey: "V", sharedAt: "2099-01-01 00:00:00" }])).toBe(1);
  expect(seenKeys()).toEqual(["V", "W", "X", "Y"]);

  // 다른 창의 확인은 알림(storage 이벤트)이 오면 이 창에도 보인다 — 화면도 다시 그린다
  const redraw = vi.fn();
  seen.subscribeTeamSeen(redraw);
  otherWindowWrites(STORAGE_KEYS.teamSeen, (map: Record<string, { seen: Record<string, unknown> }>) => ({
    ...map, [ns]: { ...map[ns], seen: { ...map[ns].seen, Z: { at: "2099-01-01 00:00:00" } } },
  }));
  expect(seen.isFreshGen(card("Z"))).toBe(true); // 알림 전 — 이 창은 아직 모른다
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.teamSeen }));
  expect([seen.isFreshGen(card("Z")), redraw.mock.calls.length]).toEqual([false, 1]);
});

// Codex 코드 리뷰: 같은 카드라도 다른 창이 **더 새 공유 시점**(재공유 뒤)을 확인해 두었으면, 이 창이 든 옛 카드의 확인으로 그 시각을 낮추지 않는다.
it("새로 들어온 카드의 확인 — 다른 창이 재공유 뒤의 것을 확인했으면 이 창의 옛 카드 클릭이 그 확인을 되돌리지 않는다", async () => {
  const seen = await import("../src/lib/teamSeen");
  seen.ensureTeamBase();
  const ns = getAccountNamespace();
  const older = { id: "X", job_id: null, shared_at: "2099-01-01 00:00:00" };
  const reshared = { id: "X", job_id: null, shared_at: "2099-02-01 00:00:00" };
  expect(seen.isFreshGen(older)).toBe(true); // 이 창은 재공유 전의 카드를 들고 있다
  otherWindowWrites(STORAGE_KEYS.teamSeen, (map: Record<string, { seen: Record<string, unknown> }>) => ({
    ...map, [ns]: { ...map[ns], seen: { X: { at: reshared.shared_at } } },
  }));
  const redraw = vi.fn();
  seen.subscribeTeamSeen(redraw);
  seen.ackTeamFresh(older);
  expect(stored<Record<string, { seen: Record<string, { at: string }> }>>(STORAGE_KEYS.teamSeen)[ns].seen.X.at).toBe(reshared.shared_at); // 전엔 옛 시각으로 낮아졌다
  expect([seen.isFreshGen(reshared), redraw.mock.calls.length]).toEqual([false, 1]); // 이 창의 화면도 맞춘다
});

it("상태가 바뀐 카드의 빛 — 다른 창에서 확인해 끈 빛이 이 창의 확인으로 되살아나지 않는다", async () => {
  const glow = await import("../src/lib/stateGlow");
  const ns = getAccountNamespace();
  const shared = (id: string) => ({ id, job_id: null, shared: true, is_final: false, is_held: false });
  const mark = { state: "shared", at: Date.now() };
  localStorage.setItem(STORAGE_KEYS.stateGlow, JSON.stringify({ [ns]: { X: mark, Y: mark } }));
  expect([glow.stateGlowOf(shared("X") as never), glow.stateGlowOf(shared("Y") as never)]).toEqual(["shared", "shared"]); // 이 창이 읽어 둔다
  otherWindowWrites(STORAGE_KEYS.stateGlow, (all: Record<string, Record<string, unknown>>) => ({ ...all, [ns]: { Y: all[ns].Y } })); // 다른 창이 X 를 골라 껐다
  glow.ackStateGlow([shared("Y") as never]);
  expect(stored<Record<string, unknown>>(STORAGE_KEYS.stateGlow)[ns]).toEqual({}); // 전엔 { X } — 끈 빛이 되살아났다

  const redraw = vi.fn();
  glow.subscribeStateGlow(redraw);
  otherWindowWrites(STORAGE_KEYS.stateGlow, (all: Record<string, unknown>) => ({ ...all, [ns]: { X: mark } }));
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.stateGlow }));
  expect([glow.stateGlowOf(shared("X") as never), redraw.mock.calls.length]).toEqual(["shared", 1]);
});

it.each([STORAGE_KEYS.historyDisabled, STORAGE_KEYS.assetsDisabled, STORAGE_KEYS.disabledFolders])(
  "비활성(d) — 다른 창이 바꾼 것(%s)도 이 창에 알린다(전엔 새로 고칠 때까지 회색 표시가 그대로였다)", (key) => {
    const heard = vi.fn();
    window.addEventListener(DISABLED_EVENT, heard);
    try {
      window.dispatchEvent(new StorageEvent("storage", { key }));
      expect(heard).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new StorageEvent("storage", { key: "ch.something.else" }));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(DISABLED_EVENT, heard);
    }
  },
);

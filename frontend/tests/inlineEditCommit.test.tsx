// @vitest-environment jsdom
// 그 자리에서 고치는 입력칸의 확정·취소(조작 규칙 43).
// 2026-10-12(조작 점검 16회차, Codex 전수 검토): Enter·초점 이탈·Esc 와 '대상이 바뀌는 순간'에 초안이 엉뚱한 곳에 저장되거나,
//  치던 값이 다른 값으로 바뀌어 저장되는 곳들.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCell } from "../src/components/assets/AssetCell";
import { ProjectPlanningFields } from "../src/components/manage/ProjectPlanningDialog";
import type { Planning } from "../src/components/manage/types";
import { ComfyNumberInput } from "../src/components/scene/cards/ComfyCard";
import { SceneBar } from "../src/components/scene/SceneBar";
import { TagEditor } from "../src/components/TagEditor";
import { errorDetail, HttpError } from "../src/lib/http";
import { validateProjectPlanning } from "../src/lib/projectPlanning";
import type { Scene } from "../src/lib/scenes";
import type { AssetMeta, AssetNode, WorkspaceContext } from "../src/types";

vi.mock("../src/lib/workspaceOptionsCache", () => ({ cachedWorkspaceOptions: () => [], fetchWorkspaceOptions: async () => [] }));
vi.mock("../src/api", () => ({ api: {
  assetFileUrl: (project: string, path: string) => `/files/${project}/${path}`, assetThumbUrl: (project: string, path: string) => `/thumbs/${project}/${path}`,
} }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

/** React 가 다루는 입력칸에 글을 넣는다(값을 직접 쓰면 React 가 모른다). */
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (target: EventTarget, name: string) => act(() => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
});
const blur = (input: HTMLElement) => act(() => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });

// ── 씬 탭 메뉴의 이름칸 ──
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const scene = (id: string, name: string) => ({ id, name, cards: [], edges: [], created_at: 0 }) as Scene;
function sceneBar() {
  const onRename = vi.fn();
  act(() => root.render(<SceneBar scenes={[scene("A", "alpha"), scene("B", "bravo")]} activeId="A" workspaceContext={personal}
    onSelect={vi.fn()} onAdd={vi.fn()} onRename={onRename} onDelete={vi.fn()} onReorder={vi.fn()} onAssignWorkspace={vi.fn()} />));
  const tabs = () => [...host.querySelectorAll<HTMLElement>(".scene-tab")];
  const openMenu = (index: number) => act(() => {
    tabs()[index].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  const nameInput = () => host.querySelector<HTMLInputElement>(".scene-ws-menu-name");
  return { onRename, openMenu, nameInput };
}

it("씬 탭 메뉴 — 메뉴가 뜬 채 다른 탭의 메뉴를 열면 이름칸은 그 탭의 이름이다(앞 탭의 이름을 그 탭에 저장하지 않는다)", () => {
  const bar = sceneBar();
  bar.openMenu(0);
  expect(bar.nameInput()!.value).toBe("alpha");
  // 키보드(Shift+F10)로 다른 탭의 메뉴를 열었다 — 바깥을 '누른' 것이 아니라 메뉴는 떠 있는 채로 대상만 바뀐다
  bar.openMenu(1);
  expect(bar.nameInput()!.value).toBe("bravo"); // 전엔 alpha 가 남았다
  key(bar.nameInput()!, "Enter");
  expect(bar.onRename).not.toHaveBeenCalled(); // 전엔 B 가 'alpha' 로 저장됐다
  expect(bar.nameInput()).toBeNull();
});

it("씬 탭 메뉴 — 초점 이탈로 한 번 저장한 뒤의 Esc·같은 이름·옛 이름은 '방금 저장한 이름'을 기준으로 한다", () => {
  const bar = sceneBar();
  bar.openMenu(0);
  const input = () => bar.nameInput()!;
  input().focus();
  type(input(), "beta");
  blur(input()); // Tab 으로 메뉴 안의 단추로 — 저장된다
  expect(bar.onRename.mock.calls).toEqual([["A", "beta"]]);
  blur(input()); // 같은 이름으로 또 벗어나도 다시 보내지 않는다
  expect(bar.onRename).toHaveBeenCalledTimes(1);
  type(input(), "  ");
  blur(input()); // 빈 이름은 받지 않는다 — 방금 저장한 이름으로 돌아간다
  expect(input().value).toBe("beta"); // 전엔 메뉴를 열 때의 alpha 로 돌아갔다
  expect(bar.onRename).toHaveBeenCalledTimes(1);
  type(input(), "gamma");
  key(input(), "Escape"); // 고치던 것을 버린다 — 방금 저장한 이름으로 돌아간다
  expect(input().value).toBe("beta"); // 전엔 메뉴를 열 때의 alpha 로 돌아갔다
  type(input(), "alpha"); // 옛 이름으로 되돌린다 — 저장된 이름(beta)과 다르니 보낸다
  key(input(), "Enter");
  expect(bar.onRename.mock.calls).toEqual([["A", "beta"], ["A", "alpha"]]); // 전엔 '열 때의 이름과 같다'며 안 보냈다
});

// ── 태그 편집기: 칩은 편집기의 사본이다 ──
const chipTexts = () => [...host.querySelectorAll(".te-chip")].map((chip) => chip.firstChild!.textContent);
const tagInput = () => host.querySelector<HTMLInputElement>(".cs-tag-input")!;

it("태그 편집기 — 부모가 서버 값으로 되돌렸다고 알리면 칩도 되돌린다(실패한 태그를 다음 Enter 가 다시 저장하지 않는다). 치던 글은 그대로다", () => {
  const onChange = vi.fn();
  const show = (tags: string[], signal: number) => act(() => root.render(<TagEditor tags={tags} onChange={onChange} resetSignal={signal} />));
  show(["a"], 0);
  type(tagInput(), "hero");
  key(tagInput(), "Enter");
  expect(onChange).toHaveBeenLastCalledWith(["a", "hero"]);
  expect(chipTexts()).toEqual(["a", "hero"]);
  // 부모 값만 달라지고 알림이 없으면 사본을 둔다 — 늦게 오는 부모 값(캔버스)이 방금 넣은 칩을 걷지 않게
  show(["a"], 0);
  expect(chipTexts()).toEqual(["a", "hero"]);
  // 저장에 실패해 부모가 서버 값으로 되돌렸다
  type(tagInput(), "wor");
  show(["a"], 1);
  expect(chipTexts()).toEqual(["a"]); // 전엔 hero 칩이 남았다("되돌렸습니다" 뒤에도)
  expect(tagInput().value).toBe("wor");
  type(tagInput(), "world");
  key(tagInput(), "Enter");
  expect(onChange).toHaveBeenLastCalledWith(["a", "world"]); // 전엔 실패한 hero 까지 다시 저장했다
});

it("Assets 타일 — 메타를 되돌렸다는 알림을 열려 있는 태그 편집기까지 넘긴다", () => {
  const node: AssetNode = { name: "a.png", path: "a.png", type: "image" };
  const meta = (tags: string[]): AssetMeta => ({ is_source: false, source_name: null, tags, comment: null, color: null, comment_count: 0, has_unread: false });
  const noop = () => {};
  const show = (tags: string[], signal: number) => act(() => root.render(
    <AssetCell project="P" node={node} idx={0} layout="grid" scale={1} fit="contain" selected focused meta={meta(tags)} editingTag tagResetSignal={signal}
      onS={noop} onT={noop} onC={noop} onTagsReplace={noop} onBulkTagAdd={noop} onBulkTagRemove={noop} onTagCancel={noop} onInfo={noop} onExportDrag={noop} />));
  show([], 0);
  type(tagInput(), "hero");
  key(tagInput(), "Enter");
  expect(chipTexts()).toEqual(["hero"]);
  show([], 1); // 저장 실패 → 메타를 서버 값으로 되돌림(useAssetMetaActions.restoreEpoch)
  expect(chipTexts()).toEqual([]);
});

// ── 숫자 칸: 치는 중인 글을 다른 수로 바꾸지 않는다 ──
it("Comfy 숫자 칸 — 지워도 0 이 저장되지 않고 '-' 부터 칠 수 있다. 수가 아닌 채로 벗어나면 앞 값으로 돌아간다", () => {
  const onChange = vi.fn();
  const onBlur = vi.fn();
  function Field() {
    const [value, setValue] = useState<number | null>(20);
    return <ComfyNumberInput value={value} onChange={(next) => { onChange(next); setValue(next); }} onBlur={onBlur} />;
  }
  act(() => root.render(<Field />));
  const input = () => host.querySelector<HTMLInputElement>("input")!;
  expect(input().value).toBe("20");
  type(input(), ""); // 전체 선택 → Backspace. '-' 만 친 순간도 브라우저는 빈 글로 알려 준다
  expect(onChange).not.toHaveBeenCalled(); // 전엔 0 이 저장됐다
  expect(input().value).toBe(""); // 칸은 빈 채로 — 이어서 칠 수 있다(전엔 0 이 되써졌다)
  type(input(), "-5");
  expect(onChange).toHaveBeenLastCalledWith(-5);
  type(input(), "");
  blur(input()); // 수가 아닌 채로 벗어났다
  expect(input().value).toBe("-5");
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onBlur).toHaveBeenCalledTimes(1); // 미뤄 둔 저장을 확정하는 것은 그대로다
});

// 22회차(조작 규칙 49, Codex 전수 검토): 2^53 을 넘는 정수는 `Number()` 가 다른 수로 바꾼다 — 친 것과 다른 seed 가 저장돼 그 값으로 실행됐다.
it("Comfy 숫자 칸 — 정확히 담을 수 없는 큰 정수는 받지 않고 알린다(다른 수로 바꿔 저장하지 않는다)", () => {
  const onChange = vi.fn();
  const flashes: string[] = [];
  const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  try {
    function Field() {
      const [value, setValue] = useState<number | null>(7);
      return <ComfyNumberInput value={value} onChange={(next) => { onChange(next); setValue(next); }} onBlur={() => {}} />;
    }
    act(() => root.render(<Field />));
    const input = () => host.querySelector<HTMLInputElement>("input")!;
    type(input(), "9007199254740993"); // 붙여 넣었다 — Number() 로는 …992 가 된다
    expect(onChange).not.toHaveBeenCalled(); // 전엔 9007199254740992 가 저장됐다
    expect(input().value).toBe("9007199254740993"); // 치는 동안은 친 글 그대로
    blur(input());
    expect([input().value, flashes]).toEqual(["7", ["이 칸은 9007199254740991 까지의 정수만 정확히 다룹니다 — 값을 바꾸지 않았습니다."]]);
    type(input(), "9007199254740991"); // 정확히 담기는 가장 큰 정수는 받는다
    expect(onChange).toHaveBeenLastCalledWith(9007199254740991);
    type(input(), "0.30000000000000004"); // 소수는 원래 근사다 — 종전대로 받는다
    expect(onChange).toHaveBeenLastCalledWith(0.30000000000000004);
    blur(input());
    expect(flashes).toHaveLength(1);
  } finally {
    window.removeEventListener("ch:flash", onFlash);
  }
});
it("프로젝트 설정의 자동 보관 일수 — 지우거나 0 을 쳐도 30 으로 바뀌지 않는다(지우고 7 을 치면 307 이 됐다). 범위는 저장할 때 본다", () => {
  const onFormChange = vi.fn();
  function Fields() {
    const [form, setForm] = useState<Planning>({ archive_after_days: 30 } as Planning);
    return <ProjectPlanningFields form={form} budgetInput="" onBudgetInputChange={() => {}} onFormChange={(next) => { onFormChange(next); setForm(next); }} />;
  }
  act(() => root.render(<Fields />));
  const days = () => host.querySelector<HTMLInputElement>('[aria-label="자동 작업 보관 기준 일수"]')!;
  type(days(), "");
  expect(onFormChange.mock.calls.at(-1)![0].archive_after_days).toBeNull(); // 전엔 30
  expect(days().value).toBe("");
  type(days(), "7");
  expect(onFormChange.mock.calls.at(-1)![0].archive_after_days).toBe(7);
  type(days(), "0");
  expect(onFormChange.mock.calls.at(-1)![0].archive_after_days).toBe(0); // 전엔 30 으로 바뀌어 저장됐다
  expect(validateProjectPlanning({ archive_after_days: 0 } as Planning, "").error).toContain("1~3650");
  expect(validateProjectPlanning({ archive_after_days: null } as Planning, "").planning!.archive_after_days).toBe(30); // 비우면 기본값(자리 글자 30)
  // 예산 칸도 받을 수 없는 입력은 받지 않는다(지워서 다른 수로 만들지 않는다)
  const onBudget = vi.fn();
  act(() => root.render(<ProjectPlanningFields form={{} as Planning} budgetInput="5000" onBudgetInputChange={onBudget} onFormChange={() => {}} />));
  const budget = host.querySelector<HTMLInputElement>('[aria-label="예산 크레딧"]')!;
  type(budget, "1.5");
  type(budget, "-100");
  expect(onBudget).not.toHaveBeenCalled(); // 전엔 15·100 이 들어갔다
  type(budget, "6,000");
  expect(onBudget).toHaveBeenLastCalledWith("6000");
});

it("안내에 붙이는 실패 까닭은 서버가 준 글만이다 — 클래스 이름·상태코드 앞머리를 뗀다", () => {
  const failed = new HttpError(500, "500: 저장 실패", "저장 실패"); // 실제 요청 실패와 같은 모양(lib/http `jsonFetch`)
  expect(errorDetail(failed)).toBe("저장 실패");
  // 앱의 다른 안내들은 이렇게 앞머리를 뗀다 — 전엔 "HttpError: 500: 저장 실패" 가 그대로 남았다
  expect(String(failed).replace(/^Error:\s*/, "")).toBe("500: 저장 실패");
  expect(failed.name).toBe("HttpError");
  expect(errorDetail(new Error("502: 서버에 닿지 않습니다"))).toBe("서버에 닿지 않습니다");
  expect(errorDetail(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  expect(errorDetail("그냥 글")).toBe("그냥 글");
});

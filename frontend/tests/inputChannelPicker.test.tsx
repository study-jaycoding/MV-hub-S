// @vitest-environment jsdom
// INPUT 출력 목록(Jay 2026-10-29) — 종류별 무리·검색 거르기·이어진 칸에 맞는 것만 · 출력 고르기 전에 생성 카드에 미리 잇기.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputCard } from "../src/components/scene/cards/InputCard";
import { InputChannelPicker, type InputPickItem } from "../src/components/scene/cards/InputChannelPicker";
import { OutputCard } from "../src/components/scene/cards/OutputCard";
import { applyCanvasEdit } from "../src/features/canvas/edits";
import { canConnect, inputPickLanes, outputPickGroup, resolvePortEdges } from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge } from "../src/lib/scenes";

const n = (id: string, kind: SceneCard["kind"], extra: Partial<SceneCard> = {}): SceneCard => ({ id, kind, x: 0, y: 0, ...extra });
const byId = (cards: SceneCard[]) => new Map(cards.map((c) => [c.id, c] as const));

describe("outputPickGroup / inputPickLanes", () => {
  const cards = [
    n("M", "model"), n("R", "reference", { refs: [] }), n("T", "text", { text: "글" }), n("L", "list"),
    n("Om", "output", { text: "m_img" }), n("Or", "output", { text: "ref_img" }), n("Ot", "output"), n("Ol", "output"), n("Oe", "output", { text: "aaaa" }),
    n("Oi", "output"), n("Ifree", "input"), n("G", "generation"), n("G2", "generation"),
    n("Im", "input", { channel: "Om" }), n("Ip", "input"), n("Iq", "input"),
  ];
  const edges: SceneEdge[] = [
    { id: "1", from: "M", to: "Om" }, { id: "2", from: "R", to: "Or" }, { id: "3", from: "T", to: "Ot" },
    { id: "4", from: "R", to: "L" }, { id: "5", from: "L", to: "Ol" }, { id: "6", from: "Ifree", to: "Oi" },
    { id: "7", from: "Im", to: "G" }, { id: "8", from: "Ip", to: "G2", role: "model" }, { id: "9", from: "Iq", to: "G2" },
  ];
  const map = byId(cards);
  it("무리 = 받는 것이 생성 카드로 들어갈 칸 — 모델·레퍼런스(레퍼런스 리스트 포함)·텍스트·없음(못 푸는 INPUT 도)", () => {
    expect(["Om", "Or", "Ot", "Ol", "Oe", "Oi"].map((id) => outputPickGroup(id, map, edges))).toEqual(["model", "ref", "text", "ref", "none", "none"]);
  });
  it("이어진 칸 — 풀린 INPUT 은 소스 종류로, 못 푸는 INPUT 은 놓은 칸(role)이 있을 때만", () => {
    expect([...inputPickLanes("Im", map, edges)]).toEqual(["model"]);
    expect([...inputPickLanes("Ip", map, edges)]).toEqual(["model"]);
    expect([...inputPickLanes("Iq", map, edges)]).toEqual([]); // 칸을 모름 → 거르지 않음
    expect([...inputPickLanes("Ifree", map, edges)]).toEqual([]); // 생성 카드에 안 이음
  });
});

describe("출력 고르기 전에 미리 잇기", () => {
  const cards = [n("I", "input"), n("G", "generation", { refs: [] }), n("L", "list"), n("M", "model"), n("O", "output", { text: "m" })];
  const map = byId(cards);
  it("못 푸는 INPUT 은 생성 카드에만 이을 수 있다(풀린 INPUT 규칙은 그대로)", () => {
    expect(canConnect(map.get("I")!, map.get("G")!, map, [])).toBe(true);
    expect(canConnect(map.get("I")!, map.get("L")!, map, [])).toBe(false);
    expect(canConnect(map.get("I")!, map.get("G")!)).toBe(false); // 컨텍스트 없으면 불가(그대로)
  });
  it("놓은 칸을 그 선에만 기억하고, 출력을 고르기 전엔 수집에서 빠진다", () => {
    const edit = applyCanvasEdit({ cards, edges: [], groups: [] }, { type: "connectCards", pairs: [["I", "G"]], role: "model" }, {});
    const edge = edit!.snapshot.edges[0];
    expect(edge).toMatchObject({ from: "I", to: "G", role: "model" });
    expect(resolvePortEdges(map, edit!.snapshot.edges)).toEqual([]); // 아무것도 전하지 않음
    // 출력을 고르면(모델 OUTPUT) 실제 소스로 풀린다
    const chosen = cards.map((c) => (c.id === "I" ? { ...c, channel: "O" } : c));
    const links = [...edit!.snapshot.edges, { id: "mo", from: "M", to: "O" }];
    expect(resolvePortEdges(byId(chosen), links).find((e) => e.to === "G")).toMatchObject({ from: "M", role: "model" });
  });
  it("풀린 INPUT 에는 칸을 붙이지 않는다(소스 종류로 정해짐)", () => {
    const resolved = cards.map((c) => (c.id === "I" ? { ...c, channel: "O" } : c));
    const edit = applyCanvasEdit({ cards: resolved, edges: [{ id: "mo", from: "M", to: "O" }], groups: [] },
      { type: "connectCards", pairs: [["I", "G"]], role: "text" }, {});
    expect(edit!.snapshot.edges.find((e) => e.from === "I")?.role).toBeUndefined();
  });
});

describe("InputChannelPicker", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  const items: InputPickItem[] = [
    { id: "a", name: "aaaa", group: "none" },
    { id: "m", name: "m_img", group: "model" },
    { id: "m2", name: "(이름 없음)", group: "model" },
    { id: "r", name: "ref_img", group: "ref" },
    { id: "r2", name: "(이름 없음)", group: "ref" },
    { id: "t", name: "(이름 없음)", group: "text" },
  ];
  const mount = (props: Partial<Parameters<typeof InputChannelPicker>[0]> = {}) => {
    const onPick = vi.fn();
    act(() => root.render(<InputChannelPicker items={items} value="" lanes={new Set()} onPick={onPick} {...props} />));
    return onPick;
  };
  const open = () => act(() => { host.querySelector<HTMLButtonElement>(".scene-portpick-btn")!.click(); });
  const input = () => host.querySelector<HTMLInputElement>(".scene-portpick-search input")!;
  const type = (text: string) => act(() => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  const pills = () => [...host.querySelectorAll(".scene-portpick-pill")].map((p) => p.textContent);
  const rows = () => [...host.querySelectorAll(".scene-portpick-op")].map((r) => r.textContent);

  it("열면 검색칸에 초점, 무리는 모델·레퍼런스·텍스트·입력 없음 순서", () => {
    mount(); open();
    expect(document.activeElement).toBe(input());
    expect(pills()).toEqual(["모델", "레퍼런스", "텍스트", "입력 없음"]);
    expect(rows()).toEqual(["m_img", "(이름 없음)", "ref_img", "(이름 없음)", "(이름 없음)", "aaaa"]);
  });
  it("치면 이름(대소문자 무시)이 맞는 것만 · 빈 무리는 숨김 · 맞는 글자 표시 · 개수", () => {
    mount(); open(); type("IMG");
    expect(pills()).toEqual(["모델", "레퍼런스"]);
    expect(rows()).toEqual(["m_img", "ref_img"]);
    expect([...host.querySelectorAll(".scene-portpick-op mark")].map((m) => m.textContent)).toEqual(["img", "img"]);
    expect(host.querySelector(".scene-portpick-foot")!.textContent).toBe("2개 · 숨김 4개 · Enter = m_img 고르기");
  });
  it("무리 이름을 치면 그 무리가 다 나오고, 맞는 것이 없으면 안내", () => {
    mount(); open(); type("텍스트");
    expect(pills()).toEqual(["텍스트"]);
    expect(rows()).toEqual(["(이름 없음)"]);
    type("zzz");
    expect(host.querySelector(".scene-portpick-empty")!.textContent).toBe('"zzz" 에 맞는 출력이 없습니다');
  });
  it("↑↓·Enter 로 고르고, Esc 는 친 글 → 닫기 순", () => {
    const onPick = mount(); open();
    key("ArrowDown"); key("ArrowDown"); key("Enter");
    expect(onPick).toHaveBeenLastCalledWith("r"); // m_img → (이름 없음) → ref_img
    open(); type("ref"); key("Escape");
    expect(input().value).toBe("");
    key("Escape");
    expect(host.querySelector(".scene-portpick-pop")).toBeNull();
  });
  it("OUTPUT·INPUT 색 = 내보내는 것의 무리 — 레퍼런스 리스트도 레퍼런스와 같은 파랑, 텍스트 리스트는 보라(Jay 10-29)", () => {
    const cards = [
      n("R", "reference", { refs: [] }), n("L", "list"), n("T", "text", { text: "a" }), n("TL", "list"),
      n("Or", "output", { text: "ref_card" }), n("Ol", "output", { text: "ref_img" }), n("Ot", "output", { text: "prompts" }), n("Oe", "output"),
      n("Il", "input", { channel: "Ol" }), n("It", "input", { channel: "Ot" }), n("Ie", "input", { channel: "Oe" }),
    ];
    const edges: SceneEdge[] = [
      { id: "1", from: "R", to: "Or" }, { id: "2", from: "R", to: "L" }, { id: "3", from: "L", to: "Ol" },
      { id: "4", from: "T", to: "TL" }, { id: "5", from: "TL", to: "Ot" },
    ];
    const map = byId(cards);
    const tone = (el: Element | null) => [...el!.querySelector(".scene-portnode")!.classList].find((c) => c.startsWith("oc-"));
    const draw = (card: SceneCard) => {
      act(() => root.render(<div className="scene-card">{card.kind === "output"
        ? <OutputCard card={card} sel={false} edges={edges} cardsById={map} setNodeText={() => {}} flushPending={() => {}} />
        : <InputCard card={card} sel={false} cards={cards} cardsById={map} edges={edges} setNodeChannel={() => {}} onOutPortDown={() => {}} />}</div>));
      return tone(host.querySelector(".scene-card"));
    };
    expect(["Or", "Ol", "Ot", "Oe", "Il", "It", "Ie"].map((id) => draw(map.get(id)!))).toEqual(
      ["oc-ref", "oc-ref", "oc-text", "oc-none", "oc-ref", "oc-text", "oc-none"]);
  });
  it("펼친 동안만 감싼 카드에 data-pop-open — 연결 끝 점 층 위로 올리는 표시(Jay 10-29: 끝 점이 목록 위로 비침)", () => {
    const onPick = vi.fn();
    act(() => root.render(<div className="scene-card"><InputChannelPicker items={items} value="" lanes={new Set()} onPick={onPick} /></div>));
    const cardEl = host.querySelector(".scene-card")!;
    expect(cardEl.hasAttribute("data-pop-open")).toBe(false);
    open();
    expect(cardEl.hasAttribute("data-pop-open")).toBe(true);
    key("Escape");
    expect(cardEl.hasAttribute("data-pop-open")).toBe(false);
  });
  it("이어진 칸이 모델이면 모델 무리만, 숨긴 수 안내 · 채널이 있으면 '선택 해제'", () => {
    const onPick = mount({ lanes: new Set(["model"] as const), value: "m" }); open();
    expect(pills()).toEqual(["모델"]);
    expect(host.querySelector(".scene-portpick-foot")!.textContent).toBe("모델 칸에 이어져 있어 모델만 · 다른 4개 숨김");
    expect(host.querySelector(".scene-portpick-op.on")!.textContent).toBe("m_img"); // 지금 고른 것에서 시작
    act(() => { host.querySelector<HTMLButtonElement>(".scene-portpick-unset")!.click(); });
    expect(onPick).toHaveBeenLastCalledWith("");
  });
});

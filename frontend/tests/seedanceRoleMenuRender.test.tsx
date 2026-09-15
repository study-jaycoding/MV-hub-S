// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, expectShownMode, installPromptBoundaryMocks, installPromptStyles, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

// 실물: SpotlightPrompt/트레이/포털 메뉴, 선택·토큰 DOM, 모델/트레이 훅, 제품 CSS.
// 가짜: 기존 하네스의 API/정책/콘솔. 드래그에서만 jsdom에 없는 요소 좌표를 제공한다.
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let style: HTMLStyleElement;
beforeEach(() => {
  vi.resetModules(); localStorage.clear();
  boundary = installPromptBoundaryMocks(); style = installPromptStyles();
});
afterEach(() => {
  view?.dispose(); view = undefined; style?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
});

function binding(prompt = "본문", mode = "omni_reference", key = "scene:roles"): NonNullable<PromptProps["trayBinding"]> {
  return { key, prompt, modelKey: `${key}:${mode}`,
    model: { model: "seedance_2_5", type: "video", params: { mode } },
    refs: [
      { type: "image", file_path: "/fixtures/a.png", name: "A", thumb: "/fixtures/a.png" },
      { type: "image", file_path: "/fixtures/b.png", name: "B", thumb: "/fixtures/b.png" },
      { type: "video", file_path: "/fixtures/v.mp4", name: "V" },
      { type: "audio", file_path: "/fixtures/a.wav", name: "Audio" },
    ],
  };
}
function editor() { return required<HTMLElement>(view!.container, '[contenteditable="true"]'); }
function items() { return [...view!.container.querySelectorAll<HTMLElement>(".sl-reftray-item")]; }
function context(index: number) {
  act(() => {
    items()[index].dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true }));
    items()[index].dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
  });
}
async function choose(index: number, label: string) {
  context(index); click(button(required(document.body, ".sl-ref-role-menu"), label)); await settle();
}
function caret(node: Node, offset: number) {
  act(() => {
    // 실제 사용자의 에디터 클릭으로 캔버스 포커스 가드를 통과한다.
    editor().dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    editor().focus();
    window.getSelection()!.setBaseAndExtent(node, offset, node, offset);
    document.dispatchEvent(new Event("selectionchange"));
    editor().dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  expect(document.activeElement).toBe(editor());
}
async function promptText() { return (await import("../src/lib/promptEditor")).serialize(editor()).text; }
function badge(index: number) { return required(items()[index], ".sl-reftray-role"); }

describe("Seedance 2.5 트레이 우클릭 역할 편집", () => {
  it("이미지에만 3줄 메뉴를 표시하고 omni에서 활성화한다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    for (const index of [2, 3]) { context(index); expect(document.querySelector(".sl-ref-role-menu")).toBeNull(); }
    context(0);
    const menu = required(document.body, ".sl-ref-role-menu");
    expect([...menu.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["첫 프레임", "끝 프레임", "옴니 레퍼런스"]);
    expect([...menu.querySelectorAll("button")].every((b) => !b.disabled)).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector(".sl-ref-role-menu")).toBeNull();
    await view.render({ trayBinding: binding("본문", "video_edit") });
    context(0);
    const first = button(required(document.body, ".sl-ref-role-menu"), "첫 프레임");
    expect(first.disabled).toBe(true);
    expect(getComputedStyle(first).opacity).toBe("0.45");
    click(first); expect(await promptText()).toBe("본문");
    await view.render({ trayBinding: { ...binding(), modelKey: "other", model: { model: "seedance_2_0", type: "video", params: { mode: "std" } } } });
    context(0); expect(document.querySelector(".sl-ref-role-menu")).toBeNull();
  });

  it("기존 토큰을 모두 바꾸고 이전 첫 담당을 모두 옴니로 풀며 한 번의 Undo로 함께 복구한다", async () => {
    const original = "@simage1 <<<simage_1>>> @image2 <<<image_2>>> @vedio_1";
    view = await mountPrompt({ trayBinding: binding(original) });
    caret(editor().firstChild!, 0);
    act(() => { editor().blur(); }); await settle();
    await choose(1, "첫 프레임");
    expect(await promptText()).toBe("@image1 @image1 @simage2 @simage2 @video1");
    expect(badge(0).classList.contains("omni")).toBe(true);
    expect(badge(1).classList.contains("start")).toBe(true);
    act(() => { editor().dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(await promptText()).toBe("@simage1 @simage1 @image2 @image2 @video1");
    expect(badge(0).classList.contains("start")).toBe(true);
    expect(badge(1).classList.contains("omni")).toBe(true);
  });

  it("끝 담당도 하나이며 같은 이미지의 첫/끝/옴니 중복 상태를 만들지 않는다", async () => {
    view = await mountPrompt({ trayBinding: binding("@eimage1 @eimage_1 @simage2 @simage_2") });
    await choose(1, "끝 프레임");
    expect(await promptText()).toBe("@image1 @image1 @eimage2 @eimage2");
    expect(badge(1).classList.contains("end")).toBe(true);
    await choose(1, "옴니 레퍼런스");
    expect(await promptText()).toBe("@image1 @image1 @image2 @image2");
    const { seedanceTokenRoles, validateSeedanceTokenRoles } = await import("../src/lib/seedancePrompt");
    expect(seedanceTokenRoles(await promptText()).image.get(2)).toEqual(new Set(["image"]));
    expect(validateSeedanceTokenRoles(binding().refs, seedanceTokenRoles(await promptText()))).toBeNull();
  });

  it("문장 중간 @작성중을 삭제하지 않고 커서에 삽입하며 우클릭이 포커스를 빼앗지 않는다", async () => {
    view = await mountPrompt({ trayBinding: binding("앞 @작성중 뒤") });
    caret(editor().firstChild!, "앞 @작성중".length);
    context(0);
    expect(document.activeElement).toBe(editor());
    click(button(required(document.body, ".sl-ref-role-menu"), "첫 프레임")); await settle();
    expect(await promptText()).toBe("앞 @작성중 @simage1  뒤");
    expect(document.activeElement).toBe(editor());
  });

  it("blur의 토큰 정규화로 텍스트 노드가 바뀌어도 저장한 커서 위치를 복원한다", async () => {
    view = await mountPrompt({ trayBinding: binding() });
    const old = document.createTextNode("<<<image_2>>> 앞 @작성중 뒤");
    act(() => { editor().replaceChildren(old); editor().dispatchEvent(new Event("input", { bubbles: true })); });
    caret(old, "<<<image_2>>> 앞 @작성중".length);
    act(() => { editor().blur(); }); await settle();
    expect(editor().contains(old)).toBe(false); // 실제 blur 훅이 DOM을 교체했음을 확인
    await choose(0, "끝 프레임");
    expect(await promptText()).toBe("@image2 앞 @작성중 @eimage1  뒤");
    expect(document.activeElement).toBe(editor());
  });

  it("유효한 커서 기록이 없거나 카드가 바뀌면 문장 끝에 삽입한다", async () => {
    view = await mountPrompt({ trayBinding: binding("첫 본문") });
    window.getSelection()?.removeAllRanges();
    await choose(0, "첫 프레임");
    expect(await promptText()).toBe("첫 본문 @simage1");
    caret(editor().firstChild!, 1);
    context(1);
    await view.render({ trayBinding: binding("새 카드 본문", "omni_reference", "scene:new") });
    expect(document.querySelector(".sl-ref-role-menu")).toBeNull();
    await choose(1, "끝 프레임");
    expect(await promptText()).toBe("새 카드 본문 @eimage2");
  });

  it("텍스트 변형·알약을 모두 교체하면서 인라인 칩 노드와 줄바꿈을 보존한다", async () => {
    view = await mountPrompt({ trayBinding: binding("@image1\n아래") });
    caret(editor().firstChild!, 0);
    act(() => { editor().blur(); }); await settle();
    const { buildChipEl } = await import("../src/lib/promptEditor");
    const chip = buildChipEl({ type: "image", file_path: "/fixtures/inline.png", thumb: "", role: "@Image", name: "인라인" });
    act(() => {
      editor().append(chip, document.createTextNode(" <<<image_1>>> @eimage_1 @simage_1 @video1"));
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const br = required(editor(), "br");
    await choose(0, "첫 프레임");
    expect(await promptText()).toBe("@simage1\n아래 @simage1 @simage1 @simage1 @video1");
    expect(required(editor(), ".inline-ref")).toBe(chip);
    expect(required(editor(), "br")).toBe(br);
    act(() => { required(chip, ".inline-ref-remove").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await settle(); expect(editor().querySelector(".inline-ref")).toBeNull();
  });

  it("같은 파일 두 장은 UID로 구분하며, 메뉴가 열린 뒤 순서가 바뀌어도 그 대상을 찾는다", async () => {
    const saved = binding("@image1 @image2");
    saved.refs[1] = { ...saved.refs[0], name: "두 번째 복사" };
    view = await mountPrompt({ trayBinding: saved });
    context(1);
    // 실제 왼쪽 드래그 핸들러로 두 번째 UID를 앞으로 옮긴 뒤 열린 메뉴 실행.
    dragSecondToFirst(); await settle();
    click(button(required(document.body, ".sl-ref-role-menu"), "첫 프레임")); await settle();
    expect(required(items()[0], ".sl-reftray-name").textContent).toBe("두 번째 복사");
    expect(await promptText()).toBe("@simage1 @image2");
    expect(badge(0).classList.contains("start")).toBe(true);
    expect(badge(1).classList.contains("omni")).toBe(true);
  });

  it("왼쪽 드래그 뒤 역할은 위치를 따르고 더블클릭 미리보기도 유지된다", async () => {
    const onPreview = vi.fn(); const onRefs = vi.fn();
    view = await mountPrompt({ trayBinding: binding("@simage1 @image2"), onPreview, onTrayBindingRefsChange: onRefs });
    caret(editor().firstChild!, 0);
    act(() => { editor().blur(); }); await settle();
    expect(required<HTMLImageElement>(items()[0], "img").draggable).toBe(false);
    dragSecondToFirst(); await settle();
    expect(onRefs).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ name: "B" })]));
    expect(required(items()[0], ".sl-reftray-name").textContent).toBe("B");
    expect(await promptText()).toBe("@simage1 @image2");
    expect(badge(0).classList.contains("start")).toBe(true);
    expect(required<HTMLImageElement>(editor(), ".sl-tok-start img").getAttribute("src")).toContain("b.png");
    act(() => { items()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ type: "image", name: "B" }));
  });

  it("대상이 삭제되거나 실행 전에 모드가 바뀌면 열린 메뉴로 편집하지 않는다", async () => {
    view = await mountPrompt({ trayBinding: binding("본문") });
    context(0);
    click(required(items()[0], ".sl-reftray-x")); await settle();
    expect(document.querySelector(".sl-ref-role-menu")).toBeNull();
    expect(await promptText()).toBe("본문");
    context(0);
    expectShownMode(view.container, "omni_reference");
    click(button(required(view.container, ".sl-adv-pop"), "video_extension")); await settle();
    const menu = required(document.body, ".sl-ref-role-menu");
    expect(button(menu, "첫 프레임").disabled).toBe(true);
    click(button(menu, "첫 프레임")); expect(await promptText()).toBe("본문");
  });

  it("역할 Undo가 인라인 첨부·공백·줄바꿈을 복원하고 일반 입력 뒤에는 가로채지 않는다", async () => {
    view = await mountPrompt({ trayBinding: binding("@simage1\n@image2") });
    const { buildChipEl, serialize } = await import("../src/lib/promptEditor");
    act(() => {
      editor().append(buildChipEl({ type: "image", file_path: "/fixtures/i.png", thumb: "", role: "@Image", name: "인라인" }), document.createTextNode("끝"));
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = serialize(editor());
    await choose(1, "첫 프레임");
    act(() => { editor().dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(serialize(editor())).toEqual(before);
    await choose(1, "첫 프레임");
    act(() => {
      editor().append(document.createTextNode("일반 입력"));
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { editor().dispatchEvent(undo); });
    expect(undo.defaultPrevented).toBe(false); // jsdom은 네이티브 Undo 자체를 수행하지 않는다.
    expect(await promptText()).toContain("일반 입력");
  });
});

function dragSecondToFirst() {
  for (const [index, item] of items().entries()) {
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue({ x: index * 100, y: 0, left: index * 100,
      right: index * 100 + 80, top: 0, bottom: 60, width: 80, height: 60, toJSON: () => ({}) });
  }
  act(() => {
    items()[1].dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 140, clientY: 30, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 30 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 5, clientY: 30 }));
  });
}

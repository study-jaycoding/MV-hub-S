// @vitest-environment jsdom
// ElevenLabs v4 오디오 태그 — A [+ Tag] 단추·태그 창 · B `[` 목록 · 넣을 때 띄어쓰기(힉스필드 웹 규칙).
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioTagTrigger, insertAudioTag } from "../src/lib/promptEditor";
import { AUDIO_TAG_GROUPS, audioTagMatches, audioTagModel } from "../src/lib/spotlightPromptConfig";
import { AudioTagList, SpotlightPromptRow } from "../src/components/spotlight/SpotlightPromptRow";
import { isKeyHandled } from "../src/lib/keyHandled";
import { button, installPromptBoundaryMocks, mountPrompt, required, settle } from "./seedanceRenderHarness";

// 편집칸에 글을 두고 커서를 (조각 i, 위치 o) 에 놓는다 — 조각은 글(string) 또는 줄바꿈("<br>").
function editorWith(parts: string[], at: [number, number] | "end") {
  const ed = document.createElement("div");
  ed.contentEditable = "true";
  for (const part of parts) ed.append(part === "<br>" ? document.createElement("br") : document.createTextNode(part));
  document.body.append(ed);
  ed.focus();
  const range = document.createRange();
  if (at === "end") { range.selectNodeContents(ed); range.collapse(false); }
  else { range.setStart(ed.childNodes[at[0]], at[1]); range.collapse(true); }
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return ed;
}
const textOf = (ed: HTMLElement) => [...ed.childNodes].map((n) => (n.nodeName === "BR" ? "\n" : n.textContent)).join("");
const caretAt = (ed: HTMLElement) => {
  const r = window.getSelection()!.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(ed);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length + [...ed.querySelectorAll("br")].filter((br) => pre.intersectsNode(br)).length;
};

afterEach(() => { document.body.innerHTML = ""; });

describe("태그 표·모델", () => {
  it("웹 v4 와 같은 5묶음 40개 · v4 와 v3(text2speech_v2·elevenlabs)에서만", () => {
    expect(AUDIO_TAG_GROUPS.map(([g, t]) => [g, t.length])).toEqual([
      ["Emotion", 7], ["Vocalizations", 12], ["Delivery", 6], ["Character", 3], ["Sound effects", 12]]);
    expect([
      audioTagModel("elevenlabs_v4"), audioTagModel("text2speech_v2", "elevenlabs"),
      audioTagModel("elevenlabs_v4_turbo"), audioTagModel("text2speech_v2", "minimax"), audioTagModel("text2speech_v2", "seed_speech"),
      audioTagModel("text2speech_v2"), audioTagModel("seed_audio"), audioTagModel("nano_banana_flash"),
    ]).toEqual([true, true, false, false, false, false, false, false]);
  });

  it("`[` 목록: 빈 검색어 = 전부 · 걸러짐 · 똑같은 게 없으면 검색어 그대로 Custom 을 끝에", () => {
    expect(audioTagMatches("")).toHaveLength(40);
    expect(audioTagMatches("wh")).toEqual([{ group: "Delivery", tag: "whispering" }, { group: "Custom", tag: "wh" }]);
    expect(audioTagMatches("SIGHING")).toEqual([{ group: "Vocalizations", tag: "sighing" }]);
    expect(audioTagMatches(" clears th")).toEqual([{ group: "Vocalizations", tag: "clears throat" }, { group: "Custom", tag: "clears th" }]);
    expect(audioTagMatches("robot")).toEqual([{ group: "Custom", tag: "robot" }]);
  });
});

describe("bracket-list — `[` 검색어 규칙(웹과 같다)", () => {
  it.each<[string, string[], [number, number] | "end", string | null]>([
    ["열린 [ 뒤", ["Hi [wh"], "end", "wh"],
    ["[ 바로 뒤", ["Hi ["], "end", ""],
    ["공백도 검색어", ["[clears th"], "end", "clears th"],
    ["닫힌 태그 뒤", ["[sighing] ok"], "end", null],
    ["닫힌 태그 안", ["[sigh] ok"], [0, 3], null],
    ["[ 없음", ["Hello"], "end", null],
    ["줄 시작(앞 조각에 [ 가 있어도 다른 줄)", ["a [", "<br>", "b"], "end", null],
    ["커서가 [ 앞", ["[wh"], [0, 0], null],
  ])("%s", (_name, parts, at, query) => {
    expect(audioTagTrigger(editorWith(parts, at))?.query ?? null).toBe(query);
  });
});

describe("spacing — 넣을 때 띄어쓰기·커서", () => {
  it.each<[string, string[], [number, number] | "end", string, number]>([
    ["단어 뒤 → 앞에 공백, 뒤에 공백", ["Hello"], "end", "Hello [sighing] ", 16],
    ["공백 뒤 → 앞 공백 없음", ["Hello "], "end", "Hello [sighing] ", 16],
    ["빈 칸", [], "end", "[sighing] ", 10],
    ["뒤가 이미 공백 → 더하지 않고 그 공백 뒤로", ["Hello world"], [0, 5], "Hello [sighing] world", 16],
    ["줄바꿈 앞 → 뒤 공백 없음", ["Hello", "<br>", "next"], [0, 5], "Hello [sighing]\nnext", 15],
    ["줄 처음", ["Hello", "<br>", "next"], [2, 0], "Hello\n[sighing] next", 16],
    ["`[검색어` 자리를 바꾼다", ["Hi [wh"], "end", "Hi [sighing] ", 13],
    ["단어 사이", ["abc"], [0, 1], "a [sighing] bc", 12],
  ])("%s", (_name, parts, at, text, caret) => {
    const ed = editorWith(parts, at);
    insertAudioTag(ed, "sighing");
    expect(textOf(ed)).toBe(text);
    expect(caretAt(ed)).toBe(caret);
  });

  it("커서가 칸 밖이면 끝에 넣는다", () => {
    const ed = editorWith(["Hello"], [0, 0]);
    window.getSelection()!.removeAllRanges();
    insertAudioTag(ed, "pause");
    expect(textOf(ed)).toBe("Hello [pause] ");
  });
});

describe("tag-button — [+ Tag] 단추·태그 창", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); });
  const noop = () => {};
  const row = (onAudioTag: ((tag: string) => void) | null) => (
    <div>
      <SpotlightPromptRow expanded={false} tagFilter={null} editorRef={createRef()} onToggleExpand={noop} onClearTagFilter={noop}
        onInput={noop} onCaretMove={noop} onKeyDown={noop} onPaste={noop} onCompositionStart={noop} onCompositionEnd={noop}
        onDragOver={noop} onDrop={noop} onDragLeave={noop} onCopyPrompt={noop} onClearPrompt={noop} onAudioTag={onAudioTag} />
      <button className="outside">밖</button>
    </div>
  );

  it("태그 모델이 아니면 단추가 없다", () => {
    act(() => root.render(row(null)));
    expect(host.querySelector(".sl-atag-btn")).toBeNull();
    expect(host.querySelector(".sl-prompt-row")!.classList.contains("atags")).toBe(false);
  });

  it("누르면 5묶음 40개 · 태그를 눌러도 열린 채 · 누르는 동안 초점을 빼앗지 않는다 · Esc 는 쓴 것으로", () => {
    const picked: string[] = [];
    act(() => root.render(row((tag) => picked.push(tag))));
    const btn = host.querySelector<HTMLButtonElement>(".sl-atag-btn")!;
    expect(btn.textContent).toBe("+ Tag");
    expect(host.querySelector(".sl-prompt-row")!.classList.contains("atags")).toBe(true);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => btn.click());
    const pop = host.querySelector(".sl-atag-pop")!;
    expect([...pop.querySelectorAll(".sl-dd-title")].map((el) => el.textContent)).toEqual(AUDIO_TAG_GROUPS.map(([g]) => g));
    const pills = [...pop.querySelectorAll<HTMLButtonElement>(".sl-atag-pill")];
    expect(pills).toHaveLength(40);
    const pillDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    pills[3].dispatchEvent(pillDown);
    expect(pillDown.defaultPrevented).toBe(true);
    act(() => { pills[3].click(); pills[10].click(); });
    expect(picked).toEqual(["menacing", "sighing"]);
    expect(host.querySelector(".sl-atag-pop")).not.toBeNull();
    // 글 칸을 눌러도(커서 옮기기) 열린 채
    act(() => { host.querySelector(".sl-prompt")!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(host.querySelector(".sl-atag-pop")).not.toBeNull();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(esc); });
    expect(isKeyHandled(esc)).toBe(true);
    expect(host.querySelector(".sl-atag-pop")).toBeNull();
  });

  it("바깥을 누르면 닫히고, 모델이 바뀌면 닫힌다", () => {
    act(() => root.render(row(noop)));
    act(() => host.querySelector<HTMLButtonElement>(".sl-atag-btn")!.click());
    act(() => { host.querySelector(".outside")!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(host.querySelector(".sl-atag-pop")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".sl-atag-btn")!.click());
    act(() => root.render(row(null)));
    act(() => root.render(row(noop)));
    expect(host.querySelector(".sl-atag-pop")).toBeNull();
  });

  it("`[` 목록: 묶음 머리·켠 줄·누르면 고름(초점 유지)", () => {
    const chose: string[] = [];
    act(() => root.render(<AudioTagList items={audioTagMatches("wh")} activeIndex={1} onHoverIndex={noop} onSelect={(t) => chose.push(t)} />));
    expect([...host.querySelectorAll(".sl-mention-sub")].map((el) => el.textContent)).toEqual(["Delivery", "Custom"]);
    const items = [...host.querySelectorAll(".sl-mention-item")];
    expect(items.map((el) => el.textContent)).toEqual(["[whispering]", "[wh]"]);
    expect(items[1].classList.contains("on")).toBe(true);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => { items[0].dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);
    expect(chose).toEqual(["whispering"]);
  });
});

describe("bracket-list — 프롬프트에서(ElevenLabs v4)", () => {
  let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    const { api } = installPromptBoundaryMocks();
    api.models.mockResolvedValue([{ job_set_type: "elevenlabs_v4", display_name: "Eleven v4", type: "audio" }]);
    const voice = [{ name: "voice_id", type: "string", default: null }, { name: "voice_type", type: "string", default: null, enum: ["preset"] }];
    api.modelParams.mockImplementation((model: string) => Promise.resolve({
      params: model === "text2speech_v2" ? [{ name: "variant", type: "string", default: null, enum: ["elevenlabs", "minimax", "seed_speech"] }, ...voice] : voice,
      constraints: {},
    }));
    (api as Record<string, unknown>).voices = vi.fn().mockResolvedValue([]);
  });
  afterEach(() => { view?.dispose(); view = undefined; vi.unstubAllGlobals(); });

  // 실제처럼 입력칸을 눌러 초점을 얻고, 글 조각의 끝에 커서를 두고 input 을 보낸다
  const type = (editor: HTMLElement, change: () => void) => act(() => {
    editor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    editor.focus();
    change();
    const node = editor.lastChild!;
    const range = document.createRange();
    range.setStart(node, node.textContent!.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const key = (editor: HTMLElement, k: string) => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    act(() => { editor.dispatchEvent(event); });
    return event;
  };

  it("`[` 를 치면 목록 · Enter 로 `[검색어` 를 바꾼다 · Esc 는 목록만 닫고(쓴 키) 같은 `[` 에서 다시 열지 않는다 · [+ Tag] 단추", async () => {
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    const keys = await import("../src/lib/keyHandled");
    setHubFeatures(["audio-models-v1"]);
    view = await mountPrompt({ expanded: false });
    act(() => button(view!.container, "Audio").click());
    await settle();
    // 첫 오디오 모델(Seed Audio)이 자동으로 골라진다 — 모델 칩에서 v4 로 바꾼다
    act(() => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("모델 선택"))!.click());
    await settle();
    act(() => [...view!.container.querySelectorAll<HTMLElement>(".sl-dd-item")].find((b) => b.textContent?.includes("Eleven v4"))!.click());
    await settle();
    expect(view.container.querySelector(".sl-atag-btn")).not.toBeNull();
    const editor = required(view.container, '[contenteditable="true"]');

    type(editor, () => { editor.textContent = "Hi [wh"; });
    await settle();
    const list = required(view.container, ".sl-atag-list");
    expect([...list.querySelectorAll(".sl-mention-item")].map((el) => el.textContent)).toEqual(["[whispering]", "[wh]"]);
    key(editor, "ArrowDown");
    await settle();
    expect(list.querySelectorAll(".sl-mention-item")[1].classList.contains("on")).toBe(true);
    key(editor, "ArrowUp");
    await settle();
    const enter = key(editor, "Enter");
    await settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("Hi [whispering] ");
    expect(view.container.querySelector(".sl-atag-list")).toBeNull();

    type(editor, () => { editor.append(document.createTextNode("x [")); });
    await settle();
    expect(view.container.querySelector(".sl-atag-list")).not.toBeNull();
    const esc = key(editor, "Escape");
    await settle();
    expect(keys.isKeyHandled(esc)).toBe(true);
    expect(view.container.querySelector(".sl-atag-list")).toBeNull();
    expect(editor.textContent).toBe("Hi [whispering] x [");
    type(editor, () => { (editor.lastChild as Text).appendData("a"); }); // 같은 `[` 뒤에 더 친다
    await settle();
    expect(view.container.querySelector(".sl-atag-list")).toBeNull();

    // A: 단추로 연 창의 태그는 지금 커서 자리에 — 창은 열린 채
    act(() => required<HTMLButtonElement>(view!.container, ".sl-atag-btn").click());
    await settle();
    act(() => [...view!.container.querySelectorAll<HTMLButtonElement>(".sl-atag-pill")].find((b) => b.textContent === "[sighing]")!.click());
    await settle();
    expect(editor.textContent).toBe("Hi [whispering] x [a [sighing] ");
    expect(view.container.querySelector(".sl-atag-pop")).not.toBeNull();
  });

  it("ElevenLabs v3 에서도 단추·`[` 목록 · 같은 모델의 MiniMax 로 바꾸면 사라지고 열린 목록도 닫힌다", async () => {
    const { setHubFeatures } = await import("../src/lib/hubFeatures");
    setHubFeatures(["audio-models-v1"]);
    view = await mountPrompt({ expanded: false });
    act(() => button(view!.container, "Audio").click());
    await settle();
    const pick = async (from: string, to: string) => {
      act(() => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(from))!.click());
      await settle();
      act(() => [...view!.container.querySelectorAll<HTMLElement>(".sl-dd-item")].find((b) => b.textContent?.includes(to))!.click());
      await settle();
    };
    await pick("모델 선택", "ElevenLabs v3");
    expect(view.container.querySelector(".sl-atag-btn")).not.toBeNull();
    const editor = required(view.container, '[contenteditable="true"]');
    type(editor, () => { editor.textContent = "Hi [la"; });
    await settle();
    expect([...required(view.container, ".sl-atag-list").querySelectorAll(".sl-mention-item")].map((el) => el.textContent))
      .toEqual(["[playful]", "[laughing]", "[applause]", "[la]"]); // 'la' 를 담은 태그(묶음 순서) + 검색어 그대로

    await pick("ElevenLabs v3", "MiniMax Speech 2.8 HD");
    expect(view.container.querySelector(".sl-atag-btn")).toBeNull();
    expect(view.container.querySelector(".sl-atag-list")).toBeNull();
  });
});

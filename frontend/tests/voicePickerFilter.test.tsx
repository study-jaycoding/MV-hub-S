// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";
import { recommendedVoiceIds } from "../src/lib/spotlightPromptConfig";
import { setHubFeatures } from "../src/lib/hubFeatures";
import voiceCatalog from "../src/lib/voiceCatalog.json";

const voices = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { voices } }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));

const GRADY = "e2a2d2e6-9ed2-59cd-82af-feaa27f8a678"; // 표: male
const EMILY = "6b3e3642-f7b7-4cb8-9688-51e233c4b92f"; // 표: female · 웹 Qwen 목록
const catalog: Record<string, string[]> = voiceCatalog;

let root: Root;
let host: HTMLDivElement;
let options: Record<string, string | number | boolean>;
let played: string[];
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setHubFeatures(["audio-models-v1"]);
  voices.mockResolvedValue({ items: [
    { id: GRADY, name: "Grady", voice_type: "preset" },
    { id: EMILY, name: "Emily", voice_type: "preset" },
    { id: "not-in-table", name: "Newbie", voice_type: "preset" },
  ], cursor: null });
  played = [];
  play = vi.fn(function (this: HTMLMediaElement) { played.push(this.src); return Promise.resolve(); });
  pause = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setHubFeatures([]); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Panel({ model, initial = { voice_id: "kept", voice_type: "preset" } }: { model: string; initial?: Record<string, string | number | boolean> }) {
  const [values, setValues] = useState(initial);
  const [open, setOpen] = useState<string | null>("voice");
  options = values;
  return <SpotlightOptionsBar type="audio" setType={vi.fn()} model={model} setModel={vi.fn()} onPickModel={vi.fn()} modelName={model}
    typeModels={[]} tunable={[]} constraints={{}} optionValues={values} setOptionValues={setValues}
    setOpt={vi.fn()} open={open} setOpen={setOpen} />;
}
const rows = () => [...host.querySelectorAll(".sl-voice-pop .sl-dd-item")].map((b) => b.textContent);
const click = (label: string) => act(() => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click());
const pick = (group: string, label: string) =>
  act(() => [...host.querySelectorAll(`[aria-label="${group}"] button`)].find((b) => b.textContent === label)!.click());
const pressed = (group: string) => host.querySelector(`[aria-label="${group}"] button[aria-pressed="true"]`)?.textContent;
const playButton = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="${name} 미리듣기"]`);

describe("Voice 창", () => {
  it("voice-label: 빈 칩·창 머리·해제 단추가 Voice, 고른 목소리는 이름", async () => {
    await act(async () => root.render(<Panel model="seed_audio" initial={{}} />));
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label="Voice"]')!;
    expect(chip.textContent).toContain("Voice");
    expect(chip.title).toBe("Voice");
    expect(host.querySelector(".sl-voice-pop .sl-dd-title")?.textContent).toBe("Voice 3개");
    expect(host.textContent).not.toContain("목소리 선택");
    click("Grady");
    expect(options).toEqual({ voice_id: GRADY, voice_type: "preset" });
    expect(chip.textContent).toContain("Grady");
    click("Voice 해제");
    expect(options).toEqual({});
  });

  it("gender-filter: 표의 성별로 거르고, 검색·Qwen 추천과 함께 동작하며 선택은 그대로", async () => {
    await act(async () => root.render(<Panel model="qwen_audio_tts" />));
    expect(rows()).toEqual(["Emily추천", "Grady", "Newbie"]);
    pick("성별", "남성");
    expect(rows()).toEqual(["Grady"]);
    expect(pressed("성별")).toBe("남성");
    expect(pressed("나이")).toBe("전체");
    pick("성별", "여성");
    expect(rows()).toEqual(["Emily추천"]);
    const input = host.querySelector<HTMLInputElement>(".sl-voice-search")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "gr");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toEqual([]);
    expect(host.querySelector(".sl-dd-empty")?.textContent).toBe("맞는 목소리가 없습니다.");
    pick("성별", "전체");
    expect(rows()).toEqual(["Grady"]);
    expect(options.voice_id).toBe("kept"); // 거르기는 저장된 선택을 건드리지 않는다
  });

  it("age-filter: 표의 나이로 거르고, 성별과 함께 동작하며 표에 없는 목소리는 '전체'에서만", async () => {
    await act(async () => root.render(<Panel model="elevenlabs_v4" />));
    pick("나이", "청년");
    expect(rows()).toEqual(["Emily"]); // 표: young
    expect(pressed("나이")).toBe("청년");
    pick("나이", "중년");
    expect(rows()).toEqual(["Grady"]); // 표: middle_aged
    pick("성별", "여성");
    expect(rows()).toEqual([]); // 중년 + 여성 = 이 목록엔 없음
    pick("나이", "노년");
    pick("성별", "전체");
    expect(rows()).toEqual([]);
    pick("나이", "전체");
    expect(rows()).toEqual(["Grady", "Emily", "Newbie"]);
    expect(options.voice_id).toBe("kept");
  });

  it("preview: ▶ 는 한 번에 하나만 재생하고, 다시 누르기·다른 ▶·창 닫기에서 멈추며 선택을 바꾸지 않는다", async () => {
    await act(async () => root.render(<Panel model="elevenlabs_v4" />));
    act(() => playButton("Grady")!.click());
    expect(played).toEqual([catalog[GRADY][1]]);
    expect(playButton("Grady")!.getAttribute("aria-label")).toBe("Grady 미리듣기 멈춤");
    act(() => playButton("Emily")!.click());
    expect(pause).toHaveBeenCalledTimes(1); // Grady 를 멈추고
    expect(played).toEqual([catalog[GRADY][1], catalog[EMILY][1]]);
    expect(playButton("Grady")!.getAttribute("aria-label")).toBe("Grady 미리듣기");
    act(() => playButton("Emily")!.click()); // 같은 ▶ 다시 = 멈춤
    expect(pause).toHaveBeenCalledTimes(2);
    expect(played).toHaveLength(2);
    expect(playButton("Emily")!.getAttribute("aria-label")).toBe("Emily 미리듣기");
    act(() => playButton("Grady")!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Voice"]')!.click()); // 칩을 눌러 창을 닫는다
    expect(host.querySelector(".sl-voice-pop")).toBeNull();
    expect(pause).toHaveBeenCalledTimes(3);
    expect(options.voice_id).toBe("kept");
  });

  it("preview: 표에 없거나 재생에 실패한 줄은 '미리듣기 없음', 이미 멈춘 소리의 늦은 실패는 무시하고 고르기는 된다", async () => {
    let rejectGrady!: (error: Error) => void;
    play.mockImplementationOnce(() => new Promise((_, reject) => { rejectGrady = reject; }));
    await act(async () => root.render(<Panel model="elevenlabs_v4" />));
    expect(host.querySelector('[aria-label="Newbie 미리듣기 없음"]')?.getAttribute("title")).toBe("미리듣기 없음");
    act(() => playButton("Grady")!.click());
    act(() => playButton("Emily")!.click()); // Grady 를 멈춘 뒤
    await act(async () => rejectGrady(new DOMException("interrupted", "AbortError") as unknown as Error));
    expect(playButton("Grady")).not.toBeNull(); // 멈춤이 끊은 play 실패로 '없음'이 되지 않는다
    act(() => playButton("Emily")!.click()); // Emily 멈춤
    play.mockImplementationOnce(() => Promise.reject(new Error("load failed")));
    await act(async () => playButton("Emily")!.click());
    expect(playButton("Emily")).toBeNull();
    expect(host.querySelector('[aria-label="Emily 미리듣기 없음"]')).not.toBeNull();
    click("Emily");
    expect(options).toEqual({ voice_id: EMILY, voice_type: "preset" });
  });

  it("catalog: 114개 · 성별 male/female · 나이 청년 46·중년 60·노년 8 · 주소는 힉스필드 CDN · Qwen 추천 목소리도 표 안에", () => {
    const entries = Object.entries(catalog);
    expect(entries).toHaveLength(114);
    for (const [id, [gender, url, age]] of entries) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(["male", "female"]).toContain(gender);
      expect(["young", "middle_aged", "old"]).toContain(age);
      expect(url).toMatch(/^https:\/\/(d1xarpci4ikg0w\.cloudfront\.net|cdn\.higgsfield\.ai)\/\S+\.(mp3|wav)$/);
    }
    const count = (age: string) => entries.filter(([, value]) => value[2] === age).length;
    expect([count("young"), count("middle_aged"), count("old")]).toEqual([46, 60, 8]);
    const qwen = [...recommendedVoiceIds("qwen_audio_tts")!];
    expect(qwen).toHaveLength(47);
    expect(qwen.filter((id) => !catalog[id])).toEqual([]);
  });
});

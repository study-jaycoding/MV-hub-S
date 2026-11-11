// @vitest-environment jsdom
// 별도 창은 마지막으로 닫은 자리·크기에서 다시 뜬다(Jay 2026-11-11, docs/status/별도창_마지막자리_2026-11-11.md) — 창이 닫힐 때(pagehide) 스스로 적고,
//  메인 창이 다음에 열 때 그 값으로 연다. 이 PC 는 모니터가 3대라 옆 모니터의 음수 좌표도 그대로 써야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn(() => Promise.resolve({})) }));

import { closeEmbedWindow, EMBED_MODES, openEmbedWindow, rememberEmbedWindowRect } from "../src/lib/popupWindows";

type Mode = (typeof EMBED_MODES)[keyof typeof EMBED_MODES];

function fakePopup() {
  const w = Object.assign(new EventTarget(), {
    closed: false, focus: vi.fn(), moveTo: vi.fn(), close: vi.fn(() => { w.closed = true; }), document: { title: "" },
  });
  return w;
}
type FakePopup = ReturnType<typeof fakePopup>;
const open = vi.spyOn(window, "open");

// 메인 창이 열고(window.open 의 세 번째 값을 돌려준다) 바로 닫는다 — 다음 열기가 '떠 있는 창 앞으로'로 빠지지 않게
function featuresOnOpen(mode: Mode): string {
  openEmbedWindow(mode);
  closeEmbedWindow(mode);
  return String(open.mock.calls.at(-1)?.[2]);
}

// 이 창의 자리·바깥 크기(크롬·엣지의 window.open width/height 가 바깥 크기 — 2026-11-11 실측)
function place(left: number, top: number, width: number, height: number) {
  for (const [key, value] of Object.entries({ screenX: left, screenY: top, outerWidth: width, outerHeight: height })) {
    Object.defineProperty(window, key, { value, configurable: true });
  }
}

// 메인 창이 있는 모니터 — 이 PC 의 가운데 주 모니터
function onScreen(left: number, top: number, width: number, height: number) {
  for (const [key, value] of Object.entries({ availLeft: left, availTop: top, availWidth: width, availHeight: height })) {
    Object.defineProperty(window.screen, key, { value, configurable: true });
  }
}

// 이 시험 창이 그 이름의 별도 창으로 켜졌을 때 단 pagehide 듣기를 돌려준다(없으면 null) — 듣기가 시험 사이에 쌓이지 않게 직접 부른다
function bootAs(name: string): (() => void) | null {
  const add = vi.spyOn(window, "addEventListener");
  window.name = name;
  try {
    rememberEmbedWindowRect();
  } finally {
    window.name = "";
  }
  const found = add.mock.calls.find(([type]) => type === "pagehide");
  add.mockRestore();
  return found ? () => (found[1] as () => void)() : null;
}

beforeEach(() => {
  localStorage.clear();
  open.mockImplementation((() => fakePopup()) as never);
});
afterEach(() => open.mockReset());

describe("별도 창 마지막 자리", () => {
  it("적은 자리가 없으면 지금처럼 정해 둔 자리로 연다", () => {
    expect(featuresOnOpen(EMBED_MODES.agent)).toBe("popup=yes,width=540,height=880,left=1320,top=60");
    expect(featuresOnOpen(EMBED_MODES.assets)).toBe("popup=yes,width=1180,height=780,left=140,top=80");
  });

  it("닫을 때 적은 자리·바깥 크기로 다시 연다 — 옆 모니터의 음수 좌표도, 창마다 따로", () => {
    const closeAgent = bootAs("contenthub-agent");
    const closeAssets = bootAs("contenthub-assets");
    place(-1200, 400, 604, 721); // 왼쪽 세로 모니터
    closeAgent?.();
    place(2800, 300, 900, 700); // 오른쪽 모니터
    closeAssets?.();

    expect(featuresOnOpen(EMBED_MODES.agent)).toBe("popup=yes,width=604,height=721,left=-1200,top=400");
    expect(featuresOnOpen(EMBED_MODES.assets)).toBe("popup=yes,width=900,height=700,left=2800,top=300");
    expect(featuresOnOpen(EMBED_MODES.manage)).toBe("popup=yes,width=1180,height=820,left=120,top=60"); // 안 적은 창은 그대로
  });

  it("최소화된 채 닫힌 값(-32000)은 적지 않고 지난 값을 남긴다 · 깨진 저장 값은 무시한다", () => {
    const closeAgent = bootAs("contenthub-agent");
    place(1500, 120, 604, 721);
    closeAgent?.();
    place(-32000, -32000, 160, 28);
    closeAgent?.();
    expect(featuresOnOpen(EMBED_MODES.agent)).toBe("popup=yes,width=604,height=721,left=1500,top=120");

    localStorage.setItem("mvhub.popupRect", "{깨짐");
    expect(featuresOnOpen(EMBED_MODES.agent)).toBe("popup=yes,width=540,height=880,left=1320,top=60");
    localStorage.setItem("mvhub.popupRect", JSON.stringify({ agent: { left: "1", top: 2, width: 600, height: 700 } }));
    expect(featuresOnOpen(EMBED_MODES.agent)).toBe("popup=yes,width=540,height=880,left=1320,top=60");
  });

  it("메인 창은 아무것도 적지 않는다", () => {
    expect(bootAs("")).toBeNull();
  });

  it("옆 모니터 자리면 열기 전에 '여러 화면' 허락을 묻고, 허락되면 끌려온 창을 그 자리로 옮긴다 · 같은 모니터면 묻지 않는다 · 막으면 그대로", async () => {
    onScreen(0, 0, 2560, 1440);
    const closeAgent = bootAs("contenthub-agent");
    const closeAssets = bootAs("contenthub-assets");
    place(2800, 400, 620, 760); // 오른쪽 모니터
    closeAgent?.();
    place(1500, 120, 900, 700); // 같은 모니터
    closeAssets?.();
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const getScreenDetails = vi.fn(() => Promise.resolve({}));
    Object.assign(window, { getScreenDetails });
    try {
      openEmbedWindow(EMBED_MODES.agent);
      const agent = open.mock.results.at(-1)?.value as FakePopup;
      expect(getScreenDetails.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder.at(-1)!); // 누른 흔적이 남았을 때 묻는다
      await flush();
      expect(agent.moveTo).toHaveBeenCalledWith(2800, 400);
      closeEmbedWindow(EMBED_MODES.agent);

      openEmbedWindow(EMBED_MODES.assets);
      expect(getScreenDetails).toHaveBeenCalledTimes(1);
      closeEmbedWindow(EMBED_MODES.assets);

      getScreenDetails.mockImplementationOnce(() => Promise.reject(new Error("NotAllowedError")));
      openEmbedWindow(EMBED_MODES.agent);
      const blocked = open.mock.results.at(-1)?.value as FakePopup;
      await flush();
      expect(blocked.moveTo).not.toHaveBeenCalled();
      closeEmbedWindow(EMBED_MODES.agent);
    } finally {
      delete (window as Window & { getScreenDetails?: unknown }).getScreenDetails;
    }
  });
});

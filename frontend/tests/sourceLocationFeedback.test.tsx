// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCell } from "../src/components/assets/AssetCell";
import { InfoPopup } from "../src/components/InfoPopup";
import { api } from "../src/api";
import { flashMsg } from "../src/lib/flash";
import { HttpError } from "../src/lib/http";
import { getLang, setLang } from "../src/lib/i18n";
import type { AssetMeta, AssetNode } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  assetFileUrl: () => "/fixture.png", assetThumbUrl: () => "/fixture-thumb.png",
  revealAsset: vi.fn(),
} }));
vi.mock("../src/lib/flash", () => ({ flashMsg: vi.fn() }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
const noop = () => {};
const node: AssetNode = { name: "fixture.png", path: "folder/fixture.png", type: "image" };
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };
let root: Root, host: HTMLDivElement, previousLang: ReturnType<typeof getLang>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("alert", vi.fn());
  previousLang = getLang();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); setLang(previousLang); });
  host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals();
});
function renderRoute(route: string) {
  if (route === "info") {
    act(() => root.render(<InfoPopup target={{ kind: "file", project: "fixture", node, meta, x: 0, y: 0 }} onClose={noop} onPreview={noop} />));
    return host.querySelector<HTMLButtonElement>(".info-path-btn")!;
  }
  act(() => root.render(<AssetCell project="fixture" node={node} idx={0} layout={route as "grid" | "list"} scale={1} fit="contain" selected={false} focused={false} meta={meta} editingTag={false}
    onS={noop} onT={noop} onC={noop} onTagsReplace={noop} onBulkTagAdd={noop} onBulkTagRemove={noop} onTagCancel={noop} onInfo={noop} onExportDrag={noop} />));
  return route === "list" ? host.querySelector<HTMLButtonElement>(".cd-path")!
    : [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "📂")!;
}
// 12회차(조작 규칙 39 — '뗀 것을 놓치면 남는 상태'): 타일에 마우스를 올리면 재생하고 mouseleave 에 멈춘다. 올린 채 창을 떠나면
//  mouseleave 가 오지 않아, 소리가 있는 오디오가 다른 창에서도 계속 났다. (이 파일의 AssetCell 틀을 빌려 쓴다.)
it("Assets 타일의 호버 재생 — 올린 채 창을 떠나거나 탭이 숨으면 멈추고, 벗어난 뒤에는 창의 blur 를 듣지 않는다", () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  try {
    act(() => root.render(<AssetCell project="fixture" node={{ name: "voice.mp3", path: "folder/voice.mp3", type: "audio" }} idx={0} layout="grid" scale={1} fit="contain" selected={false} focused={false} meta={meta} editingTag={false}
      onS={noop} onT={noop} onC={noop} onTagsReplace={noop} onBulkTagAdd={noop} onBulkTagRemove={noop} onTagCancel={noop} onInfo={noop} onExportDrag={noop} />));
    const tile = host.querySelector<HTMLElement>(".asset-media")!;
    const audio = host.querySelector("audio")!;
    const over = () => act(() => { tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    const out = () => act(() => { tile.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); });
    over();
    expect(play).toHaveBeenCalledTimes(1);
    audio.currentTime = 3;
    act(() => { window.dispatchEvent(new Event("blur")); }); // 올린 채 다른 창으로
    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); }); // 보이는 채의 통지는 아니다
    expect(pause).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); }); // 탭이 숨었다
    expect(pause).toHaveBeenCalledTimes(2);
    out(); // 벗어나면 멈추고(전부터) 리스너를 뗀다
    expect(pause).toHaveBeenCalledTimes(3);
    act(() => { window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(pause).toHaveBeenCalledTimes(3);
    // 다시 올린 채 셀이 사라져도(스크롤) 리스너를 남기지 않는다 — 벗어남 없이 들어온 것으로 두 번 와도 한 번만 건다
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const blurs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => call[0] === "blur").length;
    over();
    over();
    act(() => root.unmount());
    expect([blurs(added), blurs(removed)]).toEqual([1, 1]);
    added.mockRestore(); removed.mockRestore();
    root = createRoot(host);
  } finally {
    play.mockRestore(); pause.mockRestore(); hidden.mockRestore();
  }
});

const failures = [
  [new HttpError(404, "raw", "private/file"), "원본 파일이나 프로젝트를 찾을 수 없습니다.", "The source file or project could not be found."],
  [new HttpError(403, "raw", "private/auth"), "원본 위치를 열 권한이 없습니다.", "You do not have permission to open the source location."],
  [new HttpError(500, "raw", "private/explorer"), "파일 탐색기를 열지 못했습니다.", "Could not open the file browser."],
  [new Error("private/internal"), "원본 위치를 열지 못했습니다. 연결 상태와 파일 위치를 확인해 주세요.", "Could not open the source location. Check the connection and file location."],
] as const;
for (const route of ["grid", "list", "info"]) {
  for (const lang of ["ko", "en"] as const) {
    it.each(failures)(route + " " + lang + " 원본 열기 실패를 비차단 안내로 통일 (%#)", async (error, ko, en) => {
      act(() => setLang(lang));
      vi.mocked(api.revealAsset).mockRejectedValue(error);
      const button = renderRoute(route);
      await act(async () => button.click());
      expect(api.revealAsset).toHaveBeenCalledExactlyOnceWith("fixture", "folder/fixture.png");
      expect(flashMsg).toHaveBeenCalledExactlyOnceWith(lang === "ko" ? ko : en);
      expect(alert).not.toHaveBeenCalled();
      expect(button.title).toBe(lang === "ko" ? "원본 위치 열기 (탐색기)" : "Open source location (file browser)");
    });
    it(route + " " + lang + " 원본 열기 성공은 동일 API 1회·오류 없음", async () => {
      act(() => setLang(lang));
      vi.mocked(api.revealAsset).mockResolvedValue({ ok: true });
      const button = renderRoute(route);
      await act(async () => button.click());
      expect(api.revealAsset).toHaveBeenCalledExactlyOnceWith("fixture", "folder/fixture.png");
      expect(flashMsg).not.toHaveBeenCalled();
      expect(alert).not.toHaveBeenCalled();
    });
  }
}

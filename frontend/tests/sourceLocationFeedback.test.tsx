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

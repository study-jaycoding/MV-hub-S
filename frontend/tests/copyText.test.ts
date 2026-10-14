// @vitest-environment jsdom
// 글자 복사 단추들(캔버스 글·목록·Comfy 결과·오류, 정보 창 프롬프트, 글 보기 창, 프롬프트 복사)이 같이 쓴다 — 59회차(Codex):
//  클립보드가 없거나 쓰기가 막혀도 조용해, 사용자는 예전 클립보드를 붙였다.
import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "../src/lib/flash";

afterEach(() => { vi.unstubAllGlobals(); });

it("글자 복사 — 담으면 참이고 조용하다, 클립보드가 없거나 막히면 알리고 거짓", async () => {
  const seen: string[] = [];
  const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
  window.addEventListener("ch:flash", listen);
  try {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("a")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("a");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    expect(await copyText("a")).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await copyText("a")).toBe(false);
    expect(seen).toEqual(["클립보드에 복사하지 못했습니다 — 브라우저가 막았습니다.", "클립보드에 복사하지 못했습니다 — 브라우저가 막았습니다."]);
  } finally {
    window.removeEventListener("ch:flash", listen);
  }
});

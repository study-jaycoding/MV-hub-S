// @vitest-environment jsdom
// 2026-09-21 격리 브라우저 실측에서 나온 '조용히 아무 일도 안 일어나는' 두 건.
// ① 여러 장을 고르고 태그를 입력했는데, 기준(포커스) 카드가 이미 가진 태그면 나머지 선택 카드에 안 붙었다(쓰기 0건).
// ② 공유 중인 카드가 섞인 휴지통 보내기가 "N개 실패"로만 끝났다 — 서버는 409 로 "먼저 공유 해제"를 알려 주는데 화면에는 없었다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TagEditor } from "../src/components/TagEditor";
import { runGenerationTrash, trashResultText } from "../src/lib/bulkGenerationActions";
import { HttpError } from "../src/lib/http";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function typeTag(text: string) {
  const input = host.querySelector<HTMLInputElement>("input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setValue.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
}

it("다중 선택: 기준 카드가 이미 가진 태그도 나머지 선택 카드에 넘긴다", () => {
  const onChange = vi.fn(), onBulkAdd = vi.fn();
  act(() => root.render(<TagEditor tags={["hero"]} onChange={onChange} onBulkAdd={onBulkAdd} selectedCount={12} />));
  typeTag("hero");
  expect(onChange).not.toHaveBeenCalled(); // 이 카드는 바뀔 것이 없다
  expect(onBulkAdd).toHaveBeenCalledExactlyOnceWith(["hero"]);
});

it("다중 선택: 새 태그와 가진 태그를 섞어 입력하면 이 카드엔 새 것만, 나머지엔 입력 전체", () => {
  const onChange = vi.fn(), onBulkAdd = vi.fn();
  act(() => root.render(<TagEditor tags={["hero"]} onChange={onChange} onBulkAdd={onBulkAdd} selectedCount={3} />));
  typeTag("hero, night");
  expect(onChange).toHaveBeenCalledExactlyOnceWith(["hero", "night"]);
  expect(onBulkAdd).toHaveBeenCalledExactlyOnceWith(["hero", "night"]);
});

it("한 장만 고른 경우에는 일괄 경로를 부르지 않는다", () => {
  const onBulkAdd = vi.fn();
  act(() => root.render(<TagEditor tags={["hero"]} onChange={vi.fn()} onBulkAdd={onBulkAdd} />));
  typeTag("hero");
  expect(onBulkAdd).not.toHaveBeenCalled();
});

it("휴지통 보내기: 공유 중(409)은 '건너뜀'으로 따로 세고 성공한 id 만 돌려준다", async () => {
  const result = await runGenerationTrash(["ok", "shared", "broken"], async (id) => {
    if (id === "shared") throw new HttpError(409, "공유 중인 항목은 삭제할 수 없습니다.");
    if (id === "broken") throw new HttpError(500, "server");
  });
  expect(result).toEqual({ done: ["ok"], shared: 1, failed: 1 });
  expect(trashResultText(3, 1, 1)).toBe("1개 휴지통 이동 · 1개는 공유 중이라 건너뜀(먼저 공유 해제) · 1개 실패");
  expect(trashResultText(12, 5, 0)).toBe("7개 휴지통 이동 · 5개는 공유 중이라 건너뜀(먼저 공유 해제)");
  expect(trashResultText(4, 0, 0)).toBe("4개를 휴지통으로 보냈습니다.");
  expect(trashResultText(1, 1, 0)).toBe("1개는 공유 중이라 건너뜀(먼저 공유 해제)"); // 한 장뿐이면 '0개 휴지통 이동'을 붙이지 않는다
});

it("휴지통 보내기: 프록시의 팀 공유물 거절(403)은 '공유 중'이 아니라 일반 실패로 남는다", async () => {
  const result = await runGenerationTrash(["team"], async () => { throw new HttpError(403, "팀 공유물은 삭제할 수 없습니다."); });
  expect(result).toEqual({ done: [], shared: 0, failed: 1 });
  expect(trashResultText(1, result.shared, result.failed)).toBe("1개 실패");
});

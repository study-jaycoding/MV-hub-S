// @vitest-environment jsdom
// 이름에 들어가면 안 되는 글자(조작 규칙 53 — 26회차, Codex 전수 검토): 태그·전역 태그·Assets 등록 이름은 만들기가 JSON 으로 가 받아들여지는데, 삭제·해제는
//  이름을 주소 한 칸에 넣어(`/tags/{tag}`) `/` 가 든 이름을 서버 라우트가 받지 못했다 — 지울 수 없는 항목이 남았다. Assets 등록 이름의 `|` 는 레퍼런스
//  표기 `asset:이름|경로` 의 구분자와 충돌해 그 폴더의 그림을 레퍼런스로 못 썼다. 만들 때 안내와 함께 거절한다(이미 만들어진 이름은 5-3).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TagEditor } from "../src/components/TagEditor";
import { MountManager } from "../src/components/assets/MountManager";
import { useGenerationAutoTagActions } from "../src/lib/useGenerationAutoTagActions";

const mocks = vi.hoisted(() => ({ assetMounts: vi.fn(), addAssetMount: vi.fn(), createAutoTag: vi.fn(), deleteAutoTag: vi.fn() }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/workspaceOptionsCache", () => ({ cachedWorkspaceOptions: () => [], fetchWorkspaceOptions: async () => [] }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.assetMounts.mockResolvedValue({ mounts: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const type = (input: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const enter = (target: HTMLElement) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });

it("태그 편집기: / 가 든 태그는 만들지 않고 이유를 보인다 — 다른 태그는 그대로", () => {
  const onChange = vi.fn();
  act(() => root.render(<TagEditor tags={[]} onChange={onChange} />));
  const input = host.querySelector<HTMLInputElement>(".cs-tag-input")!;
  type(input, "look/dev, hero");
  enter(input);
  expect(onChange).not.toHaveBeenCalled(); // 전엔 ["look/dev", "hero"] 가 저장돼 look/dev 를 지울 수 없었다
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("/ 는 쓸 수 없습니다");
  type(input, ".."); // 점만의 이름은 브라우저가 삭제 주소를 정리해 다른 곳으로 보낸다(Codex 코드 리뷰)
  enter(input);
  expect(onChange).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain(". 이나 .. 일 수 없습니다");
  type(input, "hero");
  enter(input);
  expect(onChange).toHaveBeenCalledWith(["hero"], []);
});

it("Assets 등록: 표시 이름에 / \\ | 가 들면 등록하지 않고 이유를 보인다", async () => {
  await act(async () => root.render(<MountManager onClose={() => {}} onChanged={() => {}} workspaceId="team-b" />));
  const path = host.querySelector<HTMLInputElement>(".mount-input:not(.mount-name)")!;
  const name = host.querySelector<HTMLInputElement>(".mount-input.mount-name")!;
  type(path, "C:/refs");
  for (const bad of ["A|B", "refs/dev", "a\\b", "."]) {
    type(name, bad);
    await act(async () => { enter(name); });
    expect(mocks.addAssetMount).not.toHaveBeenCalled(); // 전엔 등록돼 `asset:A|B|x.png` 가 A 와 B|x.png 로 갈려 읽혔다
    expect(host.textContent).toMatch(/쓸 수 없습니다|일 수 없습니다/);
  }
  type(name, "refs");
  await act(async () => { enter(name); });
  expect(mocks.addAssetMount).toHaveBeenCalledExactlyOnceWith("refs", "C:/refs");
});

it("전역 태그: / 가 든 이름은 만들지 않고 알린다", async () => {
  const input = { askPrompt: vi.fn().mockResolvedValue("look/dev"), flash: vi.fn(), reload: vi.fn(async () => {}),
    setArmedAutoTags: vi.fn(), setWorkspaceChips: vi.fn(), workspaceContext: { scope: "team" as const, id: "a", name: "R&D" } };
  await useGenerationAutoTagActions(input).addAutoTag();
  expect(mocks.createAutoTag).not.toHaveBeenCalled();
  expect(input.flash).toHaveBeenCalledWith(expect.stringContaining("/ 는 쓸 수 없습니다"));
  input.askPrompt.mockResolvedValue(".");
  await useGenerationAutoTagActions(input).addAutoTag();
  expect(mocks.createAutoTag).not.toHaveBeenCalled();
  input.askPrompt.mockResolvedValue("look");
  await useGenerationAutoTagActions(input).addAutoTag();
  expect(mocks.createAutoTag).toHaveBeenCalledExactlyOnceWith("look");
});

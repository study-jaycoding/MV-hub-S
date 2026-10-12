// @vitest-environment jsdom
// 내 계정의 비밀번호 변경(조작 규칙 53 — 26회차, Codex 전수 검토): 변경 요청만 앞뒤 공백을 지워 보냈다 — 로그인 창은 친 그대로 보내고 서버는 그대로 비교하므로,
//  "변경되었습니다"는 뜨는데 친 비밀번호로는 들어갈 수 없었다. 친 그대로 보낸다(길이 검사도 친 그대로).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setMyPassword: vi.fn() }));
vi.mock("../src/api", () => ({ api: { setMyPassword: mocks.setMyPassword } }));
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: () => Promise.resolve({}) }));

import { ManageAccount } from "../src/components/ManageAccount";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.setMyPassword.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const type = (input: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("새 비밀번호는 친 그대로 보낸다 — 앞뒤 공백을 지우지 않는다(로그인 창과 같게)", async () => {
  act(() => root.render(<ManageAccount provider={null} account={{ name: "나", email: "me@example.com" } as never} onClose={() => {}} onProviderUpdated={() => {}} />));
  const fields = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  type(fields[0], "current-fixture");
  type(fields[1], "  next-fixture ");
  await act(async () => { fields[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(mocks.setMyPassword).toHaveBeenCalledExactlyOnceWith("current-fixture", "  next-fixture "); // 전엔 "next-fixture"
  expect(host.textContent).toContain("비밀번호가 변경되었습니다.");
});

it("길이 검사도 친 그대로다 — 공백을 지운 뒤 6자 미만이라고 거절하지 않는다", async () => {
  act(() => root.render(<ManageAccount provider={null} account={{ name: "나", email: "me@example.com" } as never} onClose={() => {}} onProviderUpdated={() => {}} />));
  const fields = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  type(fields[0], "current-fixture");
  type(fields[1], "  abcd"); // 6자(공백 둘 포함) — 서버도 친 그대로 6자 이상이면 받는다
  const button = fields[1].parentElement!.querySelector<HTMLButtonElement>("button")!; // 새 비밀번호 칸 옆의 [변경](이름 칸에도 같은 글자의 단추가 있다)
  expect(button.disabled).toBe(false); // 단추의 기준도 같다(Codex 코드 리뷰 — 전엔 단추만 잠겨 Enter 와 달랐다)
  await act(async () => { button.click(); });
  expect(mocks.setMyPassword).toHaveBeenCalledExactlyOnceWith("current-fixture", "  abcd");
});

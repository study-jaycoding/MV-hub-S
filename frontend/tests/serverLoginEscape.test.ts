// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, isUpstreamUnreachable } from "../src/lib/http";
import { ServerLoginScreen } from "../src/components/ServerLoginScreen";
import { api } from "../src/api";

vi.mock("../src/lib/keyGate", () => ({ useKeyOwner: () => {} }));
vi.mock("../src/api", () => ({ api: {
  sharedServerLogin: vi.fn().mockResolvedValue({ ok: true }),
  sharedServerRegister: vi.fn().mockResolvedValue({ auto_logged_in: true }),
  sharedServerProbe: vi.fn().mockResolvedValue({ ok: true }),
} }));

describe("로그인 화면 전송 주소 표시", () => {
  let host: HTMLDivElement, root: Root;
  const identity = "http://127.0.0.1:18091";
  const history = "http://127.0.0.1:18090";
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it.each([undefined, null, "https://127.0.0.1:18091"])("현재 주소만 표시용 값으로 보인다: %s", async (displayUrl) => {
    await act(async () => root.render(createElement(ServerLoginScreen, {
      url: identity, displayUrl, urlHistory: [history], onConnected: vi.fn(),
    })));
    const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("서버 주소 변경"))!;
    act(() => toggle.click());
    expect(host.textContent).toContain(`현재 주소: ${displayUrl ?? identity}`);
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(identity);
    const option = host.querySelectorAll("option")[1];
    expect(option.value).toBe(history);
    expect(option.textContent).toBe(history);
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(api.sharedServerLogin).toHaveBeenLastCalledWith(identity, "", "");
    act(() => {
      const select = host.querySelector("select")!;
      select.value = history;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(api.sharedServerLogin).toHaveBeenLastCalledWith(history, "", "");
  });

  it("주소 패널을 열지 않아도 인증서 오류를 표시한다", async () => {
    await act(async () => root.render(createElement(ServerLoginScreen, {
      url: identity, displayUrl: identity, transportError: "공유 서버 인증서 확인 실패",
      onConnected: vi.fn(),
    })));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("공유 서버 인증서 확인 실패");
  });
});

// 로그인 화면의 '서버 주소 변경' 패널은 자격증명 오류가 아니라 '서버에 못 닿음'일 때만
// 자동으로 펼쳐진다. 비밀번호를 틀렸는데 주소를 의심하게 만들면 안 된다.
describe("공유 서버 도달 실패 판정", () => {
  it("로컬 허브가 올린 502(공유 서버 연결 실패)는 도달 실패", () => {
    expect(isUpstreamUnreachable(new HttpError(502, "502: 공유 서버 연결 실패"))).toBe(true);
    expect(isUpstreamUnreachable(new HttpError(504, "504: timeout"))).toBe(true);
  });

  it("자격증명·권한 오류는 주소 문제가 아니다", () => {
    expect(isUpstreamUnreachable(new HttpError(400, "400: 공유 서버 로그인 실패"))).toBe(false);
    expect(isUpstreamUnreachable(new HttpError(401, "401: 만료"))).toBe(false);
    expect(isUpstreamUnreachable(new HttpError(403, "403: 이 PC 전용"))).toBe(false);
  });

  it("HTTP 응답조차 못 받은 경우(fetch 실패)도 도달 실패로 본다", () => {
    expect(isUpstreamUnreachable(new TypeError("Failed to fetch"))).toBe(true);
  });
});

// @vitest-environment jsdom
// MV Agent 머리줄 단추(Jay 11-10 시안 자리 1·I 번개 — docs/status/MVAgent_머리줄아이콘_2026-11-10.md) — 아이콘 캡슐 안 검색칸 바로 뒤(편집 앞)
//  번개 칸 · 평소 선·칸 열림 투톤(옆 칸들과 같은 규칙). 허브가 agent_chat_v1 을 알릴 때만 보인다(docs/status/AskAgent_옆칸_설계_2026-11-09.md 4·10절).
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 머리줄 틀은 응답 없이도 그려진다(topBarIconButtons 와 같은 가짜)
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({}, { get: () => pending }) };
});

import { TopBar } from "../src/components/TopBar";
import { AGENT_CHAT_FEATURE, setHubFeatures } from "../src/lib/hubFeatures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setHubFeatures([]);
});

function bar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return (
    <TopBar filters={{ tab: "my" } as never} onTab={noop} onSearch={noop} onWorkspaceSwitched={noop}
      workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
      onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop}
      {...props} />
  );
}
const agent = () => host.querySelector<HTMLButtonElement>(".topbar .top-ic-group > .agent-btn");

describe("MV Agent 머리줄 번개 칸", () => {
  it("허브가 agent_chat_v1 을 알리지 않으면 없다", () => {
    act(() => root.render(bar({ onToggleAgent: noop })));
    expect(agent()).toBeNull();
  });

  it("기능이 켜져 있으면 캡슐 안 검색칸 바로 뒤(편집 앞) 아이콘 칸 — 선·투톤 두 그림, 누르면 열고 켜진 채 다시 누르면 닫는다", () => {
    setHubFeatures([AGENT_CHAT_FEATURE]);
    const onToggleAgent = vi.fn();
    act(() => root.render(bar({ onToggleAgent, onOpenEdit: noop })));
    const button = agent()!;
    expect(button.previousElementSibling).toBe(host.querySelector(".topbar .top-ic-group > .topbar-search"));
    expect(button.nextElementSibling!.getAttribute("aria-label")).toBe("편집");
    expect([button.getAttribute("aria-label"), button.textContent]).toEqual(["MV Agent", ""]);
    expect([button.querySelectorAll(".top-ic-line").length, button.querySelectorAll(".top-ic-lit").length]).toEqual([1, 1]);
    expect(host.querySelector(".agent-pill")).toBeNull(); // 옛 글자 알약은 없다
    expect([button.getAttribute("aria-pressed"), button.classList.contains("lit")]).toEqual(["false", false]);
    act(() => button.click());
    expect(onToggleAgent).toHaveBeenCalledTimes(1);
    act(() => root.render(bar({ onToggleAgent, onOpenEdit: noop, agentOpen: true })));
    expect([agent()!.getAttribute("aria-pressed"), agent()!.classList.contains("lit")]).toEqual(["true", true]);
    act(() => agent()!.click());
    expect(onToggleAgent).toHaveBeenCalledTimes(2);
  });

  it("연결이 없으면(onToggleAgent 없음) 기능이 켜져 있어도 없다", () => {
    setHubFeatures([AGENT_CHAT_FEATURE]);
    act(() => root.render(bar()));
    expect(agent()).toBeNull();
  });

  it("라임 바탕은 어디서나 검은 글자 · 칸 기본 폭 520(끝선을 끌면 --agent-w)", () => {
    const css = readFileSync(new NodeURL("../src/styles/agent-chat.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/agent-pill/);
    const lime = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background: var\(--accent\)/.test(m[2]));
    expect(lime.length).toBeGreaterThan(3);
    for (const [, selector, body] of lime) expect([selector.trim(), body.includes("color: var(--accent-ink)")]).toEqual([selector.trim(), true]);
    expect(css).toMatch(/\.agent-panel \{[^}]*width: var\(--agent-w, 520px\)/);
    expect(css).toMatch(/\.app\.agent-open \{ padding-right: var\(--agent-w, 520px\); \}/); // 앱 본문도 같은 폭만큼 좁아진다
  });
});

// @vitest-environment jsdom
// Ask Agent 알약(시안 _shots/ask-agent-pill-v2.png) — 검색 묶음 바로 왼쪽 · 아이콘 없음 · 평소 회색 · 칸이 열린 동안 라임 + 검은 글자.
//  허브가 agent_chat_v1 을 알릴 때만 보인다(docs/status/AskAgent_옆칸_설계_2026-11-09.md 4·10절).
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
const pill = () => host.querySelector<HTMLButtonElement>(".topbar .agent-pill");

describe("Ask Agent 알약", () => {
  it("허브가 agent_chat_v1 을 알리지 않으면 없다", () => {
    act(() => root.render(bar({ onToggleAgent: noop })));
    expect(pill()).toBeNull();
  });

  it("기능이 켜져 있으면 검색 묶음 바로 왼쪽에 글자만 있는 알약 — 누르면 칸을 열고 닫는다(aria-pressed)", () => {
    setHubFeatures([AGENT_CHAT_FEATURE]);
    const onToggleAgent = vi.fn();
    act(() => root.render(bar({ onToggleAgent })));
    const button = pill()!;
    expect(button.textContent).toBe("Ask Agent");
    expect(button.querySelector("svg")).toBeNull();
    expect(button.nextElementSibling).toBe(host.querySelector(".topbar .top-ic-group"));
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => button.click());
    expect(onToggleAgent).toHaveBeenCalledTimes(1);
    act(() => root.render(bar({ onToggleAgent, agentOpen: true })));
    expect(pill()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("연결이 없으면(onToggleAgent 없음) 기능이 켜져 있어도 없다", () => {
    setHubFeatures([AGENT_CHAT_FEATURE]);
    act(() => root.render(bar()));
    expect(pill()).toBeNull();
  });

  it("평소 회색(옆 단추와 같은 바탕·테두리) · 켜지면 라임 바탕 + 검은 글자 — 라임 바탕은 어디서나 검은 글자", () => {
    const css = readFileSync(new NodeURL("../src/styles/agent-chat.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.topbar \.agent-pill \{[^}]*background: rgba\(255, 255, 255, 0\.04\); border: 1px solid var\(--border\);[^}]*color: var\(--muted\)/);
    expect(css).toMatch(/\.agent-pill\[aria-pressed="true"\] \{[^}]*background: var\(--accent\);[^}]*color: var\(--accent-ink\)/);
    const lime = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background: var\(--accent\)/.test(m[2]));
    expect(lime.length).toBeGreaterThan(3);
    for (const [, selector, body] of lime) expect([selector.trim(), body.includes("color: var(--accent-ink)")]).toEqual([selector.trim(), true]);
    expect(css).toMatch(/\.agent-panel \{[^}]*width: 520px/);
  });
});

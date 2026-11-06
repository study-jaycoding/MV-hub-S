// @vitest-environment jsdom
// 계정 메뉴 크레딧 두 칸(Jay 2026-11-06 시안) — 위 Credits(워크스페이스 잔액 + 점), 아래 Limit · User group(팀 공간만).
// 값의 계산(내 몫·충전량)은 서버 my-quota 그대로다 — 여기서는 어느 칸에 무엇이 그려지는지만 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/components/AccountMenu";
import type { MyCreditQuota } from "../src/lib/myCreditQuota";
import type { WorkspaceContext } from "../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const noop = () => {};
const TEAM: WorkspaceContext = { scope: "team", id: "ws1", name: "Team" };
const WORKSPACES = [
  { id: "ws1", name: "Team", plan_type: "team", credits: 40934.34, is_selected: true, user_role: "member" },
  { id: "me", name: null, plan_type: "free", credits: 12.5, is_selected: false, user_role: "owner" },
];

function quota(over: Partial<MyCreditQuota>): MyCreditQuota {
  return {
    workspace_id: "ws1", source: "unassigned", group_id: null, group_name: null, quota: null,
    used_real: 0, used_estimated: 0, estimated_count: 0, unknown_count: 0, used: 0, remaining: null,
    limit_period: null, period_start: null, period_end: null, revision: 1, enforcement: "advisory", pool_total: null,
    ...over,
  };
}

function serve(myQuota: MyCreditQuota | null) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/my-quota") ? myQuota
      : url.endsWith("/api/workspaces") ? WORKSPACES
      : url.endsWith("/api/account/hf") ? { reported: true, credits: 40934.34, workspaces: WORKSPACES } // 공유 서버 로그인 = 에이전트 보고값
      : undefined;
    if (body === undefined || body === null) return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

const ACCOUNT = { email: "member-a@example.com", name: "팀원 A", status: "approved", creator_uid: "u1", created_at: "2026-11-01", approved_at: "2026-11-01" };

async function open(context: WorkspaceContext, signedIn = false) {
  await act(async () => root.render(
    <AccountMenu provider={null} onProviderUpdated={noop} onWorkspaceSwitched={noop} onWorkspaceContextChange={noop}
      workspaceContext={context} account={signedIn ? ACCOUNT : undefined} />,
  ));
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  for (let i = 0; i < 4; i++) await act(async () => {}); // 목록·내 몫 조회
  const pop = document.querySelector<HTMLElement>(".acct-pop")!;
  const credits = pop.querySelector<HTMLElement>(".acct-credits");
  const limit = pop.querySelector<HTMLElement>(".acct-limit");
  const rows = limit ? [...limit.querySelectorAll<HTMLElement>(".acct-limit-row")] : [];
  return {
    credits,
    creditsText: credits?.querySelector(".acct-credits-top")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    limit,
    limitText: rows[0]?.querySelector(".acct-limit-val")?.textContent?.trim() ?? "",
    groupText: rows[1]?.querySelector(".acct-limit-val")?.textContent?.trim() ?? "",
    limitTitle: rows[0]?.getAttribute("title") ?? "",
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("한도 있는 그룹: Credits = 워크스페이스 잔액 + 점, Limit = 남은 몫 / 내 한도, User group = 그룹 이름", async () => {
  serve(quota({ source: "auto", group_id: "g4", group_name: "Line 4", quota: 7000, used: 539.5, remaining: 6460.5, limit_period: "month" }));
  const m = await open(TEAM);
  expect(m.creditsText).toContain("Credits");
  expect(m.creditsText).toContain("40,934.34 left");
  expect(m.credits!.querySelector(".acct-dots")).not.toBeNull(); // 점은 위 칸 — 남은 몫 ÷ 내 한도
  expect(m.limit!.querySelector(".acct-dots")).toBeNull();
  expect(m.limitText).toBe("6,460.5 / 7,000");
  expect(m.groupText).toBe("Line 4");
  expect(m.limit!.querySelector(".acct-limit-sep svg")).toBeNull(); // User group 앞 아이콘 없음(Jay 11-06 손질)
  expect(m.limitTitle).toContain("월 한도 7,000");
  expect(m.limitTitle).toContain("사용 539.5");
});

it("한도 없는 그룹: Limit = ∞ · 그룹 이름, 점은 잔액 ÷ 이번 달 충전으로 위 칸", async () => {
  serve(quota({ source: "unlimited", group_id: "gp", group_name: "Pipeline TD", pool_total: 20000 }));
  const m = await open(TEAM);
  expect(m.creditsText).toContain("40,934.34 left");
  expect(m.credits!.querySelector(".acct-dots")).not.toBeNull();
  expect(m.limitText).toBe("∞");
  expect(m.groupText).toBe("Pipeline TD");
});

it("그룹에 안 든 사람: Limit = —, User group = None", async () => {
  serve(quota({ source: "unassigned", pool_total: 20000 }));
  const m = await open(TEAM);
  expect(m.limitText).toBe("—");
  expect(m.groupText).toBe("None");
  expect(m.limitTitle).toContain("그룹에 들지 않았습니다");
});

it("내 몫을 못 읽으면 Limit·그룹은 — 로 두고 잔액은 그대로 보인다", async () => {
  serve(null);
  const m = await open(TEAM);
  expect(m.creditsText).toContain("40,934.34 left");
  expect(m.limitText).toBe("—");
  expect(m.groupText).toBe("—");
  expect(m.limitTitle).toBe("확인 불가");
});

it("공유 서버 로그인(에이전트 보고값)에서도 두 칸이 그대로이고 '에이전트 보고값 기준' 안내 줄은 없다", async () => {
  serve(quota({ source: "unlimited", group_id: "gp", group_name: "Pipeline TD", pool_total: 60000 }));
  const m = await open(TEAM, true);
  expect(m.creditsText).toContain("40,934.34 left");
  expect(m.limitText).toBe("∞");
  expect(m.groupText).toBe("Pipeline TD");
  expect(document.querySelector(".acct-pop")!.textContent).not.toContain("에이전트 보고값");
});

it("팀 공간이 아니면 Credits 칸만 — Limit·User group 칸이 없다", async () => {
  serve(null);
  const m = await open({ scope: "personal", id: null, name: null });
  expect(m.limit).toBeNull();
});

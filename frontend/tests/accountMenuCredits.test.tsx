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

function serve(myQuota: MyCreditQuota | null, workspaces = WORKSPACES) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/my-quota") ? myQuota
      : url.endsWith("/api/workspaces") ? workspaces
      : url.endsWith("/api/account/hf") ? { reported: true, credits: 40934.34, workspaces } // 공유 서버 로그인 = 에이전트 보고값
      : undefined;
    if (body === undefined || body === null) return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

const ACCOUNT = { email: "member-a@example.com", name: "팀원 A", status: "approved", creator_uid: "u1", created_at: "2026-11-01", approved_at: "2026-11-01" };

async function open(context: WorkspaceContext, signedIn = false, localHub = false) {
  await act(async () => root.render(
    <AccountMenu provider={null} onProviderUpdated={noop} onWorkspaceSwitched={noop} onWorkspaceContextChange={noop}
      workspaceContext={context} account={signedIn ? ACCOUNT : undefined} localHub={localHub} />,
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
    groupText: limit?.querySelector(".acct-limit-sep .acct-limit-val")?.textContent?.trim() ?? "",
    limitTitle: rows[0]?.getAttribute("title") ?? "",
    usage: limit?.querySelector<HTMLButtonElement>(".acct-usage-num") ?? null,
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
  vi.restoreAllMocks();
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

it("잔액 확인 전달 안내는 매니징 실패 경고와 분리하고 옛 서버·내용 불일치를 구별한다", async () => {
  serve(null);
  const fetch=globalThis.fetch;
  vi.stubGlobal("fetch", (input:RequestInfo|URL,init?:RequestInit) => String(input).endsWith("/api/sync-status")
    ? Promise.resolve(new Response(JSON.stringify({pending:0,failed:0,account_report_pending:0,account_report_failed:0,
      balance_pending:8,balance_failed:8,balance_unsupported:2,balance_conflict:3,balance_last_error_code:"hub_not_signed_in"}),{status:200}))
    : fetch(input,init));
  await open(TEAM,false,true);
  const pop=document.querySelector(".acct-pop")!;
  expect(pop.textContent).not.toContain("매니징 동기화");
  expect(pop.textContent).toContain("잔액 확인 3건 서버 전달 대기");
  expect(pop.textContent).toContain("잔액 확인 2건 서버 업데이트 뒤 전달");
  expect(pop.textContent).toContain("잔액 확인 3건 전달 내용을 확인해 주세요");
  const notice=[...pop.querySelectorAll<HTMLElement>(".acct-sync-warn")].find((n)=>n.textContent==="잔액 확인 3건 서버 전달 대기")!;
  expect(notice.title).toBe("공유 서버에 로그인하면 다시 전달합니다.");
  expect(pop.innerHTML).not.toContain("hub_not_signed_in");
});

it("공유 서버 Credits 숫자에 공통 잔액의 KST 확인 시각을 붙이고 Usage 단추는 유지한다", async () => {
  const at = Date.parse("2026-11-17T08:41:00Z");
  vi.spyOn(Date,"now").mockReturnValue(at+180000);
  serve(quota({ source: "unlimited", basis: "api", pool_total: 60000 }),
    WORKSPACES.map((w) => ({ ...w, balance_meta: { basis: "observed", credits_c: 12345, observed_at_ms: at, time_quality: "reported" } })));
  const m = await open(TEAM,true);
  expect(m.credits!.querySelector<HTMLElement>(".acct-credits-left")!.title).toBe("11/17 17:41 확인 (3분 전)");
  expect(m.creditsText).toContain("123.45 left");
  expect(m.usage).not.toBeNull();
});

it.each(["account","workspace"])("이전 %s의 늦은 잔액 응답을 버린다", async (change) => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish=resolve; });
  let calls=0;
  const response = (credits: number) => new Response(JSON.stringify({reported:true,workspaces:[
    {...WORKSPACES[0],id:change==="workspace"?"ws2":"ws1",credits},
  ]}),{status:200,headers:{"Content-Type":"application/json"}});
  vi.stubGlobal("fetch", (input: RequestInfo|URL) => String(input).endsWith("/api/account/hf")
    ? ++calls===1 ? pending : Promise.resolve(response(222))
    : Promise.reject(new Error("offline")));
  const render = (next: boolean) => root.render(<AccountMenu provider={null} account={next&&change==="account"?{...ACCOUNT,email:"other@example.test"}:ACCOUNT}
    onProviderUpdated={noop} onWorkspaceSwitched={noop} onWorkspaceContextChange={noop}
    workspaceContext={next&&change==="workspace"?{...TEAM,id:"ws2"}:TEAM} />);
  await act(async () => render(false));
  await act(async () => render(true));
  await act(async () => { finish(response(111)); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  expect(document.querySelector(".acct-credits-left")!.textContent).toContain("222 left");
  expect(document.querySelector(".acct-credits-left")!.textContent).not.toContain("111");
});

it("팀 공간이 아니면 Credits 칸만 — Limit·User group 칸이 없다", async () => {
  serve(null);
  const m = await open({ scope: "personal", id: null, name: null });
  expect(m.limit).toBeNull();
});


it.each(["unassigned", "unlimited"] as const)("새 서버 %s 계정도 Usage 숫자로 내 사용량 창에 들어간다(값이 없으면 —)", async source => {
  serve(quota({ source, usage_supported: true }));
  const m = await open(TEAM);
  expect(m.usage).not.toBeNull();
  expect(m.usage!.textContent).toBe("—›");
  expect(m.usage!.getAttribute("aria-label")).toBe("Usage — · 내 사용량 창 열기");
  expect(m.limit?.textContent).not.toContain("내 사용량 보기"); // 옛 단추는 없앴다(Jay 2026-11-17)
});

it("basis 없는 구서버는 Usage 줄과 API 출처를 숨긴다", async () => {
  serve(quota({ source: "auto", quota: 100, remaining: 90 }));
  const m = await open(TEAM);
  expect(m.usage).toBeNull();
  expect(m.limit?.textContent).not.toContain("Usage");
  expect(m.limit?.textContent).not.toContain("힉스필드 기준");
});

it("API 기준·전액 환불 안내는 작은 글씨가 아니라 Usage 숫자의 풀이 글로 간다", async () => {
  serve(quota({ source: "auto", basis: "api", quota: 100, remaining: 90, used: 10, failed_count: 3, failed_refunded_count: 1, collected_at_ms: 100 }));
  const m = await open(TEAM);
  expect(m.usage!.textContent).toBe("10›");
  expect(m.limit?.textContent).not.toContain("힉스필드 기준");
  expect(m.limit?.textContent).not.toContain("전액 환불");
  expect(m.usage!.title).toContain("힉스필드 기준");
  expect(m.usage!.title).toContain("오류 보고 후 전액 환불 1건");
  expect(m.usage!.title).not.toContain("전액 환불 3건");
});

it("미상 건수만 있을 때 금액에 견적 기호를 붙이지 않고 미확인 안내는 풀이 글로", async () => {
  serve(quota({ source: "auto", basis: "api", quota: 100, remaining: 90, used: 10, unknown_count: 3 }));
  const m = await open(TEAM);
  expect(m.limitText).toBe("90 / 100");
  expect(m.usage!.textContent).toBe("10›");
  expect(m.limit?.textContent).not.toContain("사용량 미확인 3건");
  expect(m.usage!.title).toContain("사용량 미확인 3건");
});

it("집계 전 견적이 있으면 Usage 숫자 앞에 ≈, 누르면 메뉴가 닫히고 내 사용량 창이 열린다", async () => {
  serve(quota({ source: "auto", basis: "api", quota: 100, remaining: 88, used: 12, estimated_count: 2, used_estimated: 2 }));
  const m = await open(TEAM);
  expect(m.usage!.textContent).toBe("≈ 12›");
  // 단추 이름에 숫자와 용도가 함께 — 옆 'Usage' 글자와 무관하게 무엇을 여는지 알 수 있다
  expect(m.usage!.getAttribute("aria-label")).toBe("Usage ≈ 12 · 내 사용량 창 열기");
  expect(m.usage!.title.split("\n")[0]).toBe("내 사용량 창 열기");
  await act(async () => { m.usage!.click(); });
  expect(document.querySelector(".acct-pop")).toBeNull();
  expect(document.querySelector('[role="dialog"].my-usage-window')).not.toBeNull();
});

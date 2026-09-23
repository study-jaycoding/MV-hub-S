import { describe, expect, it } from "vitest";
import {
  addDays,
  cycleLabel,
  draftFromSettings,
  draftMemberCount,
  draftToBody,
  formatDecimal,
  formatThousands,
  limitTotal,
  mergeTopupsFromServer,
  newGroupId,
  niceCeil,
  stripDecimal,
  overrideBody,
  periodSuffix,
  periodUsageLabel,
  projectDepletion,
  remainingTone,
  stripThousands,
  topupSteps,
  topupsOnlyBody,
  usagePercent,
  validateDraft,
  validateTopup,
  type BalancePoint,
  type CreditPlanSettings,
} from "../src/lib/creditPlan";

const day = (n: number) => addDays("2026-09-01", n);

describe("remainingTone — 남은 양 기준 경고색", () => {
  it("∞ 는 none, 0 이하는 bad, 한도의 20% 이하는 warn, 그 외 ok", () => {
    expect(remainingTone(500, null)).toBe("none");
    expect(remainingTone(0, 1000)).toBe("bad");
    expect(remainingTone(-30, 1000)).toBe("bad");
    expect(remainingTone(200, 1000)).toBe("warn");
    expect(remainingTone(201, 1000)).toBe("ok");
  });
  it("이번 달 사용률은 한도 없으면 null", () => {
    expect(usagePercent(300, 1000)).toBe(30);
    expect(usagePercent(300, null)).toBeNull();
    expect(usagePercent(300, 0)).toBeNull();
    expect(limitTotal([{ monthly_limit: 1000 }, { monthly_limit: null }, { monthly_limit: 500 }])).toBe(1500);
    // 매일·매주 한도는 월 충전과 비교할 수 없어 합에서 뺀다
    expect(limitTotal([{ monthly_limit: 1000, limit_period: "month" }, { monthly_limit: 300, limit_period: "day" }, { monthly_limit: 700, limit_period: "week" }])).toBe(1000);
    expect([periodSuffix("day"), periodSuffix("week"), periodSuffix("month"), periodSuffix(undefined)]).toEqual(["/일", "/주", "/월", "/월"]);
    expect([periodUsageLabel("day"), periodUsageLabel("week"), periodUsageLabel(undefined)]).toEqual(["오늘", "이번 주", "이번 달"]);
  });
});

describe("잔액 추이 — 충전 계단과 예상 소진", () => {
  const falling: BalancePoint[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ day: day(i), credits: 7000 - i * 500 }));
  it("관측 사이의 증가만 충전으로 본다", () => {
    const history = [...falling, { day: day(7), credits: 24000 }, { day: day(8), credits: 23000 }];
    expect(topupSteps(history)).toEqual([{ day: day(7), amount: 20000 }]);
    expect(topupSteps(falling)).toEqual([]);
  });
  it("최근 7일 소진 속도로 바닥나는 날을 예상하고, 충전은 소진에서 뺀다", () => {
    const projection = projectDepletion(falling, 7, day(7));
    expect(projection).not.toBeNull();
    expect(projection!.perDay).toBe(500);
    expect(projection!.daysLeft).toBe(8); // 4000 / 500
    expect(projection!.depleteDay).toBe(day(14));
    const withTopup = [...falling, { day: day(7), credits: 24000 }, { day: day(8), credits: 23500 }];
    const after = projectDepletion(withTopup, 7, day(8))!;
    // 창 = 마지막 날 기준 7일(day1~day8). 증가 20,000 은 빼고 감소만 합산(500×6) / 7일.
    expect(after.perDay).toBeCloseTo(3000 / 7);
  });
  it("관측 3점 미만·소진 없음·1년 초과·끊긴 보고는 예상하지 않는다", () => {
    const today = day(7);
    expect(projectDepletion(falling.slice(0, 2), 7, today)).toBeNull();
    expect(projectDepletion([0, 1, 2, 3].map((i) => ({ day: day(i), credits: 7000 })), 7, today)).toBeNull();
    expect(projectDepletion([0, 1, 2, 3].map((i) => ({ day: day(i), credits: 100000 - i })), 7, today)).toBeNull();
    // 관측 공백: 최근 7일 안에 점이 2개뿐이면 null
    expect(projectDepletion([{ day: day(0), credits: 9000 }, { day: day(20), credits: 8000 }, { day: day(21), credits: 7000 }], 7, day(21))).toBeNull();
    // 마지막 관측이 오늘보다 7일 넘게 오래됐으면(보고 끊김) 옛 속도로 예측하지 않는다(코덱스 P2)
    expect(projectDepletion(falling, 7, day(40))).toBeNull();
    expect(projectDepletion(falling, 7, day(13))).not.toBeNull();
  });
  it("세로축 최대값은 값보다 살짝 큰 깔끔한 수", () => {
    expect(niceCeil(28058)).toBe(30000);
    expect(niceCeil(7865)).toBe(8500);
    expect(niceCeil(0)).toBe(1000);
  });
});

describe("설정 초안 — 검사와 저장 본문", () => {
  const settings: CreditPlanSettings = {
    workspace_id: "ws1",
    month: "2026-09",
    plan: { monthly_topup: 20000, note: null, revision: 3, updated_at: null },
    groups: [
      { id: "g1", name: "Artist", monthly_limit: 1000, member_count: 2, used_month: 200, unknown_month: 1, remaining: 800, unknown_since_base: 1, estimated: true },
      { id: "g2", name: "TD", monthly_limit: null, member_count: 0, used_month: 0, unknown_month: 0, remaining: null, unknown_since_base: 0, estimated: false },
    ],
    members: [
      { email: "a@x", name: "제이", workspace_role: "member", is_available: true, group_id: "g1" },
      { email: "c@x", name: "c", workspace_role: null, is_available: false, group_id: null },
    ],
    topups: [{ id: "t1", day: "2026-09-03", credits: 3000, note: "긴급" }],
  };
  it("서버 설정 → 초안 → 본문이 왕복한다(∞ 는 null, 보정은 비우면 없음, 월 충전은 표시만)", () => {
    const draft = draftFromSettings(settings);
    expect(draft.groups[1].unlimited).toBe(true);
    expect(draft.monthlyTopup).toBe(20000);
    expect(validateDraft(draft)).toBeNull();
    const body = draftToBody(draft);
    expect(body.revision).toBe(3);
    expect("monthly_topup" in body).toBe(false);
    expect(body.topup_day).toBe(1); // 서버가 안 주면 1일
    expect(body.topups).toEqual([{ id: "t1", day: "2026-09-03", credits: 3000, note: "긴급" }]);
    expect(body.groups).toEqual([
      { id: "g1", name: "Artist", monthly_limit: 1000, limit_period: "month", allowed_models: [] },
      { id: "g2", name: "TD", monthly_limit: null, limit_period: "month", allowed_models: [] },
    ]);
    expect(body.members).toEqual([{ email: "a@x", group_id: "g1" }, { email: "c@x", group_id: null }]);
  });
  it("사용 모델: 서버값(모르는 id 포함)이 초안을 거쳐 본문에 명시적으로 실린다 · 구서버(필드 없음)는 빈 목록=제한 없음", () => {
    const withAllowed: CreditPlanSettings = {
      ...settings,
      groups: [
        { ...settings.groups[0], allowed_models: ["seedance_2_5", "future_model_9"] },
        settings.groups[1],
      ],
    };
    const draft = draftFromSettings(withAllowed);
    expect(draft.groups[0].allowedModels).toEqual(["seedance_2_5", "future_model_9"]);
    expect(draft.groups[1].allowedModels).toEqual([]);
    const body = draftToBody(draft);
    expect(body.groups?.[0].allowed_models).toEqual(["seedance_2_5", "future_model_9"]);
    expect(body.groups?.[1].allowed_models).toEqual([]); // 명시 [] = 제한 없음(키 생략은 '유지'라 설정 창은 항상 보낸다)
  });
  it("검사: 빈 이름·겹치는 이름·한도 없음·정수 아님·긴급 충전 오류를 잡는다", () => {
    const draft = draftFromSettings(settings);
    expect(validateDraft({ ...draft, topups: [{ id: "t2", day: "", creditsInput: "100", note: "" }] })).toContain("날짜");
    expect(validateDraft({ ...draft, topups: [{ id: "t2", day: "2026-09-10", creditsInput: "", note: "" }] })).toContain("크레딧");
    expect(validateDraft({ ...draft, topups: [{ id: "t2", day: "2026-09-10", creditsInput: "0", note: "" }] })).toContain("크레딧");
    expect(validateDraft({ ...draft, groups: [{ ...draft.groups[0], name: " " }] })).toContain("그룹 이름");
    expect(validateDraft({ ...draft, groups: [draft.groups[0], { ...draft.groups[1], name: "Artist" }] })).toContain("겹칩니다");
    expect(validateDraft({ ...draft, groups: [{ ...draft.groups[0], limitInput: "" }] })).toContain("한도");
  });
  it("삭제된 그룹을 가리키는 배정은 해제(null)로 보낸다", () => {
    const draft = draftFromSettings(settings);
    const body = draftToBody({ ...draft, groups: [draft.groups[1]] });
    expect(body.members).toEqual([{ email: "a@x", group_id: null }, { email: "c@x", group_id: null }]);
  });
  it("새 그룹은 클라이언트 id 를 그대로 보내 같은 저장에 멤버 배정을 싣는다", () => {
    const draft = draftFromSettings(settings);
    const id = newGroupId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const withNew = {
      ...draft,
      groups: [...draft.groups, { id, isNew: true, name: "New", limitInput: "300", limitPeriod: "week" as const, unlimited: false, remaining: null, usedMonth: 0, memberCount: 0, allowedModels: [], color: "#22c55e" }],
      members: draft.members.map((member) => (member.email === "c@x" ? { ...member, group_id: id } : member)),
    };
    const body = draftToBody(withNew);
    expect(body.groups![2]).toEqual({ id, name: "New", monthly_limit: 300, limit_period: "week", allowed_models: [], color: "#22c55e" });
    expect(body.members).toContainEqual({ email: "c@x", group_id: id });
    expect(draftMemberCount(withNew, id)).toBe(1);
  });
});

describe("긴급 충전 줄 단위 저장", () => {
  it("본문엔 그룹·배정이 없고(서버가 그대로 둠), 응답을 초안에 합치면 revision·기록만 바뀐다", () => {
    const draft = draftFromSettings({
      workspace_id: "ws1", month: "2026-09", plan: { monthly_topup: 20000, note: null, revision: 3, updated_at: null },
      groups: [], members: [], topups: [{ id: "t1", day: "2026-09-03", credits: 3000, note: null }],
    });
    const edited = { ...draft, groups: [{ id: "g9", isNew: true, name: "편집중", limitInput: "1", limitPeriod: "month" as const, unlimited: false, remaining: null, usedMonth: 0, memberCount: 0, allowedModels: [], color: "#64748b" }], dirty: true };
    const body = topupsOnlyBody(edited, [{ id: "t1", day: "2026-09-03", creditsInput: "3500", note: " 추가 " }]);
    expect(body).toEqual({ revision: 3, note: null, topups: [{ id: "t1", day: "2026-09-03", credits: 3500, note: "추가" }] });
    expect("groups" in body).toBe(false);
    const merged = mergeTopupsFromServer(edited, {
      workspace_id: "ws1", month: "2026-09", plan: { monthly_topup: 25000, note: null, revision: 4, updated_at: null },
      groups: [], members: [], topups: [{ id: "t1", day: "2026-09-03", credits: 3500, note: "추가" }],
    });
    expect(merged.revision).toBe(4);
    expect(merged.monthlyTopup).toBe(25000);
    expect(merged.topups[0].creditsInput).toBe("3500");
    expect(merged.groups[0].name).toBe("편집중"); // 편집 중인 그룹 초안은 그대로
    expect(validateTopup({ id: "x", day: "2026-09-10", creditsInput: "", note: "" })).toContain("크레딧");
  });
});

describe("추정 → 힉스필드 값 맞추기 본문", () => {
  it("그룹 목록은 그대로, 대상 그룹만 remaining_override, 배정은 안 보낸다", () => {
    const body = overrideBody({
      month: "2026-09", configured: true, revision: 7,
      groups: [
        { id: "g1", name: "Artist", monthly_limit: 1000, limit_period: "day", member_count: 1, used_month: 0, unknown_month: 0, remaining: 900, unknown_since_base: 2, estimated: true },
        { id: "g2", name: "TD", monthly_limit: null, member_count: 0, used_month: 0, unknown_month: 0, remaining: null, unknown_since_base: 0, estimated: false },
      ],
    }, "g1", 3200);
    expect(body.revision).toBe(7);
    expect(body.groups).toEqual([
      { id: "g1", name: "Artist", monthly_limit: 1000, limit_period: "day", remaining_override: 3200 },
      { id: "g2", name: "TD", monthly_limit: null, limit_period: "month", remaining_override: null },
    ]);
    expect("members" in body).toBe(false);
    expect(body.groups?.every((group) => !("color" in group))).toBe(true);
  });
});

describe("충전 달 범위 문구", () => {
  it("기준일 1이면 '9월', 아니면 '9/15 ~ 10/14'", () => {
    expect(cycleLabel({ month: "2026-09", cycle_start: "2026-09-01", cycle_end: "2026-09-30" }, 1)).toBe("9월");
    expect(cycleLabel({ month: "2026-09", cycle_start: "2026-09-15", cycle_end: "2026-10-14" }, 15)).toBe("9/15 ~ 10/14");
    expect(cycleLabel({ month: "2026-09" })).toBe("9월");
  });
});

describe("숫자 입력 — 천 단위 구분", () => {
  it("보이는 값은 20,000 · 저장값은 20000", () => {
    expect(formatThousands("20000")).toBe("20,000");
    expect(formatThousands("20,0a00")).toBe("20,000");
    expect(formatThousands("")).toBe("");
    expect(stripThousands("1,234,567")).toBe("1234567");
    expect(stripThousands("abc")).toBe("");
  });
});

it("몫·정기 충전 입력은 소수점을 지우지 않는다", () => {
  // 크레딧은 소수다(−1.5 · 0.12 · 33.33). 정수만 받던 한도 입력을 그대로 쓰면 24,491.5 가 244,915 로 저장된다.
  expect(stripDecimal("24,491.5 cr")).toBe("24491.5");
  expect(stripDecimal("33.33.33")).toBe("33.3333"); // 점은 하나만 남긴다
  expect(stripDecimal("abc")).toBe("");
  expect(formatDecimal("24491.5")).toBe("24,491.5");
  expect(formatDecimal("12.")).toBe("12."); // 입력 중인 끝점은 지우지 않는다
  expect(formatDecimal(".5")).toBe("0.5");
  expect(formatDecimal("")).toBe("");
});

// 공유&리뷰 '새로 들어옴' 항목 단위 확인(ack) 모델 — 기준선·확인·차감·이관 불변식.
import { beforeEach, describe, expect, it } from "vitest";
import {
  ackTeamFresh,
  ensureTeamBase,
  getTeamBase,
  isAckedFor,
  isFreshGen,
} from "../src/lib/teamSeen";

const KEY = "ch.lib.teamSeen";

// vitest 기본 환경(node)엔 localStorage 가 없다 — 메모리 스텁(스토리지 계층은 try/catch 라 인터페이스만 맞으면 됨).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

// 모듈 캐시는 ns 가 같으면 유지되지만, 테스트는 localStorage 를 직접 갈아끼우므로
// 각 테스트에서 계정(ns)을 바꿔 캐시를 무효화한다.
let acctSeq = 0;
function freshAccount(): void {
  acctSeq += 1;
  localStorage.setItem("ch.activeAccount", `user${acctSeq}@test`);
}

describe("teamSeen (항목 단위 확인 모델)", () => {
  beforeEach(() => {
    localStorage.clear();
    freshAccount();
  });

  it("기준선이 없으면 아무것도 새것이 아니다 (도입 첫날 전체 글로우 방지)", () => {
    expect(getTeamBase()).toBeNull();
    expect(isFreshGen({ id: "g1", shared_at: "2099-01-01 00:00:00" })).toBe(false);
  });

  it("기준선 이후 공유만 새것 — 확인(클릭)하면 그 항목만 꺼진다", () => {
    ensureTeamBase();
    const base = getTeamBase()!;
    const oldGen = { id: "old", shared_at: "2000-01-01 00:00:00" };
    const newGen = { id: "new", shared_at: "2099-01-01 00:00:00", folder_path: "ep001/c0010", project_id: "p1" };
    const newGen2 = { id: "new2", shared_at: "2099-01-02 00:00:00", folder_path: "ep001/c0010", project_id: "p1" };
    expect(base.length).toBe(19); // UTC "YYYY-MM-DD HH:MM:SS"
    expect(isFreshGen(oldGen)).toBe(false);
    expect(isFreshGen(newGen)).toBe(true);
    ackTeamFresh(newGen);
    expect(isFreshGen(newGen)).toBe(false); // 확인한 것만 꺼짐
    expect(isFreshGen(newGen2)).toBe(true); // 나머지는 유지 (탭 이동과 무관)
  });

  it("확인은 '그 공유 시점'에 대한 것 — 재공유(더 새 shared_at)면 다시 새것이 된다", () => {
    ensureTeamBase();
    const g = { id: "a", shared_at: "2099-01-01 00:00:00" };
    ackTeamFresh(g);
    expect(isFreshGen(g)).toBe(false); // 확인됨
    expect(isAckedFor("a", "2099-01-01 00:00:00")).toBe(true); // 같은 시점 = 확인(>=)
    // 공유해제 → 재공유: shared_at 이 새로워짐 → 글로우·+N 모두 부활
    const reshared = { id: "a", shared_at: "2099-01-02 00:00:00" };
    expect(isFreshGen(reshared)).toBe(true);
    expect(isAckedFor("a", "2099-01-02 00:00:00")).toBe(false);
    // 다시 확인하면 새 시점으로 꺼진다
    ackTeamFresh(reshared);
    expect(isFreshGen(reshared)).toBe(false);
    expect(isAckedFor("a", "2099-01-02 00:00:00")).toBe(true);
  });

  it("구(방문시각 문자열) 형식은 기준선으로 이관된다", () => {
    const acct = `user${acctSeq}@test`;
    localStorage.setItem(KEY, JSON.stringify({ [`acct:${acct}`]: "2099-06-01 00:00:00" }));
    expect(getTeamBase()).toBe("2099-06-01 00:00:00");
    expect(isFreshGen({ id: "g", shared_at: "2099-06-02 00:00:00" })).toBe(true);
  });

  it("시점 미상(구서버 — shared_at 없음)이면 id 확인만으로 인정 — +N 영구 잠김 방지", () => {
    ensureTeamBase();
    ackTeamFresh({ id: "a", shared_at: "2099-01-01 00:00:00" });
    expect(isAckedFor("a", null)).toBe(true); // 확인한 항목 — 시점 몰라도 제외
    expect(isAckedFor("b", null)).toBe(false); // 확인 안 한 항목은 그대로 +N
  });

  it("확인은 새것이 아닌 카드에 no-op — seen 이 불필요하게 자라지 않는다", () => {
    ensureTeamBase();
    ackTeamFresh({ id: "old", shared_at: "2000-01-01 00:00:00" });
    expect(isAckedFor("old", "2000-01-01 00:00:00")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 그룹 사용 모델 정책의 **10분 주기 조회**는 보이는 창에서만 돈다.
//
// ★왜(2026-09-12, C-19): 이 인터벌은 모듈 수준이라 앱이 떠 있는 내내 돈다. 다른 폴러들은
//  전부 `document.visibilityState` 를 보는데 여기만 없었다. 안 보이는 창의 정책은 쓸 데가 없다.
//
// ★건너뛰어도 낡지 않는다: 같은 모듈이 `visibilitychange` 와 `focus` 에서 다시 조회한다
//  (30초 스로틀). 이 시험은 **그 복귀 경로까지 함께** 확인한다 — 게이트만 걸고 복귀를 안 보면
//  숨어 있던 창이 낡은 정책으로 제출을 막을 수 있다.
//
// ★시험 환경에 DOM 이 없다(jsdom 미설치). 그래서 `window`·`document` 를 직접 세워
//  **인터벌 콜백을 붙잡아** 직접 돌린다 — 10분을 기다리지 않고 그 콜백의 판단만 본다.

const fetchMock = vi.fn();
vi.mock("../src/lib/manageApi", () => ({
  manageApi: { creditPlanMyModels: (...args: unknown[]) => fetchMock(...args) },
}));
// 저장소는 원본을 살리고 정책 캐시만 비운다 — `http.ts` 등 다른 모듈도 이걸 쓴다.
vi.mock("../src/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/storage")>()),
  loadJSON: () => null,
  saveJSON: () => {},
}));

type Listener = () => void;

let intervalCallback: (() => void) | null = null;
let visibility: "visible" | "hidden" = "visible";
const documentListeners = new Map<string, Listener[]>();

function setupGlobals() {
  intervalCallback = null;
  documentListeners.clear();
  vi.stubGlobal("window", {
    setInterval: (fn: () => void) => {
      intervalCallback = fn;
      return 1;
    },
    clearInterval: () => {},
    setTimeout: () => 2,
    clearTimeout: () => {},
    addEventListener: (type: string, fn: Listener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]);
    },
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: Listener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]);
    },
  });
}

function fireVisibilityChange() {
  for (const fn of documentListeners.get("visibilitychange") ?? []) fn();
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ allowed: [] });
  visibility = "visible";
  setupGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function armPolicy() {
  const mod = await import("../src/lib/modelPolicy");
  mod.configureModelPolicy({
    context: { scope: "team", id: "ws1", name: "팀 공간" },
    email: "me@example.com",
    serverKey: "http://hub",
  });
  await Promise.resolve();
  return mod;
}

describe("모델 정책 10분 주기", () => {
  it("★숨은 창에서는 조회하지 않는다", async () => {
    await armPolicy();
    expect(intervalCallback).toBeTypeOf("function"); // 타이머가 실제로 걸렸다
    fetchMock.mockClear();

    visibility = "hidden";
    intervalCallback!();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("보이는 창에서는 그대로 조회한다", async () => {
    await armPolicy();
    fetchMock.mockClear();

    visibility = "visible";
    intervalCallback!();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("★돌아오면 다시 받아 온다 — 건너뛴 주기가 낡은 채로 남지 않는다", async () => {
    await armPolicy();
    visibility = "hidden";
    intervalCallback!();
    await Promise.resolve();
    fetchMock.mockClear();

    visibility = "visible";
    vi.setSystemTime(new Date(Date.now() + 60_000)); // 포커스 스로틀(30초) 밖
    fireVisibilityChange();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("숨은 채로 visibilitychange 가 와도 조회하지 않는다", async () => {
    await armPolicy();
    fetchMock.mockClear();

    visibility = "hidden";
    vi.setSystemTime(new Date(Date.now() + 60_000));
    fireVisibilityChange();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

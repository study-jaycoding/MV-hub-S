// @vitest-environment jsdom
// 업데이트 탭(Jay 2026-10-05 개편 · 2026-10-23 팀 배포를 서버 관리 창 [릴리스]로) — NAS 의 모든 판이 줄,
// 새 후보는 [이 PC에 먼저 설치](없을 때만 등록 → 설치, 알림 없음). 공개 표지·후보·알림 상태를 못 읽으면 이유를 보인다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import type { LatestReleaseMetadata, ReleasePackage } from "../src/lib/releaseUpdate";
import type { UpdateNotice } from "../src/lib/updateNotices";

const mocks = vi.hoisted(() => ({
  adminList: vi.fn(), adminItem: vi.fn(), register: vi.fn(),
  latest: vi.fn(), status: vi.fn(), startCandidate: vi.fn(), packages: vi.fn(),
}));
vi.mock("../src/lib/updateNotices", () => ({
  updateNoticeApi: { adminList: mocks.adminList, adminItem: mocks.adminItem, register: mocks.register },
}));
vi.mock("../src/lib/releaseUpdate", () => ({
  getLatestReleaseMetadata: mocks.latest, getReleaseUpdateStatus: mocks.status,
  startCandidateUpdate: mocks.startCandidate, listReleasePackages: mocks.packages,
}));

import { UpdateNoticesSection } from "../src/components/admin/UpdateNoticesSection";

const CAND = "2026.10.03-1420", LIVE = "2026.10.01-0906", OLD = "2026.09.30-2238";
const SHA = { cand: "c".repeat(64), live: "a".repeat(64), old: "d".repeat(64) };
const pkg = (version: string): ReleasePackage => ({ file: `MVHub-${version}.zip`, version, size: 79_000_000, modified: "" });
const OLDER = ["2026.09.28-1615", "2026.09.28-1438", "2026.09.28-1303", "2026.09.18-0838", "2026.09.17-1900"];
const notice = (version: string, sha: string, extra: Partial<UpdateNotice> = {}): UpdateNotice => ({
  id: `n-${version}`, version, file: `MVHub-${version}.zip`, released_at: "", pinned: false,
  announcement_revision: 0, announced_at: null, unread: false, sha256: sha, size: 10, ...extra,
});
const liveNotice = notice(LIVE, SHA.live, { announcement_revision: 2 });
const release = (extra: Partial<LatestReleaseMetadata> = {}): LatestReleaseMetadata => ({
  version: CAND, file: `MVHub-${CAND}.zip`, sha256: SHA.cand, size: 10, created_at: "2026-10-03T14:20:00",
  source: "candidate", candidate_error: null,
  published: { version: LIVE, sha256: SHA.live, file: `MVHub-${LIVE}.zip` },
  published_state: "ok", pending: true, ...extra,
});
const notFound = () => new HttpError(404, "404", "업데이트 항목이 없습니다");

let host: HTMLDivElement, root: Root, confirm: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.packages.mockResolvedValue([CAND, LIVE, OLD, ...OLDER].map(pkg));
  mocks.adminList.mockResolvedValue([liveNotice]);
  mocks.latest.mockResolvedValue(release());
  mocks.adminItem.mockRejectedValue(notFound());
  mocks.status.mockResolvedValue({ install_mode: "release", current_version: LIVE, state: "up_to_date" });
  mocks.register.mockImplementation(async (r: { version: string; sha256: string }) =>
    ({ ok: true, created: true, item: notice(r.version, r.sha256) }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => {
  await act(async () => { root.render(<UpdateNoticesSection />); });
  await settle();
};
const row = (version: string) => [...host.querySelectorAll(".admin-update-row")].find((r) => r.textContent?.includes(version))!;
const button = (scope: Element, label: string) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (scope: Element, label: string) => {
  await act(async () => { button(scope, label)!.click(); });
  await settle();
};

it("NAS 의 모든 판이 줄로 — 6개를 넘으면 [더 보기], 배포 중·새 후보는 꼬리표", async () => {
  await mount();
  expect(host.querySelectorAll(".admin-update-row")).toHaveLength(6);
  expect(row(LIVE).textContent).toContain("팀 배포 중");
  expect(row(CAND).textContent).toContain("새 후보 · 배포 전");
  expect(row(LIVE).textContent).toContain("알림 2회");
  await click(host, "이전 판 2개 더 보기 ▾");
  expect(host.querySelectorAll(".admin-update-row")).toHaveLength(8);
});

// 2단계(Jay 2026-10-23): 팀 배포·재공지·해제·고정 풀기는 서버 관리 창 [릴리스]로 — 웹 업데이트 탭은 [이 PC에 먼저 설치]만.
it("팀 배포 단추 없이 [이 PC에 먼저 설치]만 — 고정 알림 줄도 없다", async () => {
  mocks.adminList.mockResolvedValue([liveNotice, notice(OLD, SHA.old, { pinned: true, announcement_revision: 1 })]);
  await mount();
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels.filter((text) => text !== "이전 판 2개 더 보기 ▾")).toEqual(["이 PC에 먼저 설치"]);
  expect(host.querySelector(".admin-update-pinned")).toBeNull();
  expect(host.textContent).toContain("서버 관리 창 [릴리스]");
});

it("공지됐지만 표지 교체 전인 후보 줄은 서버 관리 창 [릴리스]에서 마저 배포하라고 알린다", async () => {
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) return notice(CAND, SHA.cand, { announcement_revision: 1 });
    throw notFound();
  });
  await mount();
  expect(row(CAND).textContent).toContain("공지됨 · 아직 배포 안 됨");
  expect(row(CAND).textContent).toContain("서버 관리 창 [릴리스]에서 마저 배포하세요");
});

it("목록 밖 후보의 단건 조회가 503 이면 '알림 상태를 확인하지 못했다'고 보인다", async () => {
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) throw new HttpError(503, "503", "서버 응답 없음");
    throw notFound();
  });
  await mount();
  expect(host.textContent).toContain("알림 상태를 확인하지 못했습니다 — 서버 응답 없음");
});

it("공개 표지를 못 읽으면 이유를 보이고 먼저 설치 단추가 없다", async () => {
  mocks.latest.mockResolvedValue(release({ published: null, published_state: "error", pending: null }));
  await mount();
  expect(host.textContent).toContain("배포 상태를 확인할 수 없습니다");
  expect(button(row(CAND), "이 PC에 먼저 설치")).toBeUndefined();
});

it("후보 파일이 깨졌으면 이유를 보이고 먼저 설치 단추가 없다", async () => {
  mocks.latest.mockResolvedValue(release({ candidate_error: "candidate.json 을 읽을 수 없습니다" }));
  await mount();
  expect(host.textContent).toContain("배포를 막았습니다");
  expect(button(row(CAND), "이 PC에 먼저 설치")).toBeUndefined();
});

it("후보가 공개본보다 옛 판이면(되돌리기가 후보만 바꾸고 멈춤) 먼저 설치 단추가 없다", async () => {
  mocks.latest.mockResolvedValue(release({ version: OLD, file: `MVHub-${OLD}.zip`, sha256: SHA.old }));
  await mount();
  expect(row(OLD).textContent).toContain("새 후보 · 배포 전");
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels.some((text) => text?.startsWith("이 PC에"))).toBe(false);
});

// 관리자 후보 선설치(Jay 2026-10-03) — 공지 전 후보를 이 PC 에만 먼저 설치. 팀 배포는 그대로.
it("새 후보는 [이 PC에 먼저 설치] — 취소하면 아무것도 안 하고, 하면 등록만(알림 없음) 뒤 설치", async () => {
  mocks.startCandidate.mockResolvedValue({ state: "starting", accepted: true });
  await mount();
  expect(button(row(LIVE), "이 PC에 먼저 설치")).toBeUndefined(); // 팀 배포 중인 판에는 없다
  confirm.mockReturnValueOnce(false);
  await click(row(CAND), "이 PC에 먼저 설치");
  expect(String(confirm.mock.calls[0][0])).toContain("팀원 PC 는 바뀌지 않습니다");
  expect(mocks.startCandidate).not.toHaveBeenCalled();
  await click(row(CAND), "이 PC에 먼저 설치");
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sha256: SHA.cand }));
  expect(mocks.startCandidate).toHaveBeenCalledWith(`n-${CAND}`, SHA.cand);
  expect(host.textContent).toContain("이 PC 에 설치하기 시작했습니다");
  expect(mocks.status).toHaveBeenLastCalledWith(true); // 작업 뒤 이 PC 상태는 새로 확인
});

it("이미 등록된 후보는 다시 등록하지 않는다(서버 시각 보존)", async () => {
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) return notice(CAND, SHA.cand);
    throw notFound();
  });
  mocks.startCandidate.mockResolvedValue({ state: "starting", accepted: true });
  await mount();
  await click(row(CAND), "이 PC에 먼저 설치");
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.startCandidate).toHaveBeenCalledWith(`n-${CAND}`, SHA.cand);
});

it("옛 서버(단건 조회 없음)면 등록하지 않고 업데이트 안내", async () => {
  mocks.adminItem.mockRejectedValue(new HttpError(404, "404", "Not Found"));
  await mount();
  await click(row(CAND), "이 PC에 먼저 설치");
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.startCandidate).not.toHaveBeenCalled();
  expect(host.textContent).toContain("공유 서버를 업데이트한 뒤");
});

it("이 PC 가 이미 그 후보면 '이 PC 설치됨'과 [이 PC에 다시 설치](손상 복구)", async () => {
  mocks.status.mockResolvedValue({ install_mode: "release", current_version: CAND, state: "check_failed", candidate: true });
  await mount();
  expect(row(CAND).textContent).toContain("이 PC 설치됨");
  expect(button(row(CAND), "이 PC에 다시 설치")).toBeDefined();
});

it.each([
  ["개발 실행본", { install_mode: "development", current_version: "" }, release()],
  ["배포 상태 확인 불가", { install_mode: "release", current_version: LIVE }, release({ pending: null })],
  ["이미 팀에 배포된 후보", { install_mode: "release", current_version: LIVE }, release({ pending: false })],
])("%s 에는 먼저 설치 단추가 없다", async (_label, status, latest) => {
  mocks.status.mockResolvedValue({ state: "up_to_date", ...status });
  mocks.latest.mockResolvedValue(latest);
  await mount();
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels.some((text) => text?.startsWith("이 PC에"))).toBe(false); // 안내 글이 아니라 단추만 본다
});

// 25회차(조작 규칙 52, Codex 전수 검토): 조회가 끝나기 전의 빈 목록을 '판이 없습니다'로 보였다 — NAS 가 느리면 몇 초 동안 틀린 말이다.
it("판 목록을 아직 못 받았으면 '판이 없습니다'가 아니라 '불러오는 중'이다", async () => {
  let finish!: (rows: ReleasePackage[]) => void;
  mocks.packages.mockReturnValue(new Promise<ReleasePackage[]>((resolve) => { finish = resolve; }));
  await mount();
  expect(host.textContent).toContain("판 목록을 불러오는 중");
  expect(host.textContent).not.toContain("릴리스 폴더에 판이 없습니다");
  await act(async () => { finish([]); });
  await settle();
  expect(host.textContent).toContain("릴리스 폴더에 판이 없습니다");
  expect(host.textContent).not.toContain("불러오는 중");
});

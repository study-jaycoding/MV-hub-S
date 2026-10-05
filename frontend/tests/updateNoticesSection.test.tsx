// @vitest-environment jsdom
// 업데이트 탭 개편(Jay 2026-10-05) — NAS 의 모든 판이 줄, [배포] 한 번 = (없을 때만 등록) → 공지 → 표지 교체.
// 후보 줄은 promote, 그 밖의 줄은 deploy-package(화면이 본 sha 로), [재공지]는 알림만, [배포 반영]은 후보 줄에서만,
// [해제]는 알림만(줄은 남음), 단계별 실패 문구, 공개 표지·후보를 못 읽으면 배포를 막는다. 후보 선설치(10-03)는 그대로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import type { LatestReleaseMetadata, ReleasePackage } from "../src/lib/releaseUpdate";
import type { UpdateNotice } from "../src/lib/updateNotices";

const mocks = vi.hoisted(() => ({
  adminList: vi.fn(), adminItem: vi.fn(), register: vi.fn(), pin: vi.fn(), announce: vi.fn(), remove: vi.fn(),
  latest: vi.fn(), promote: vi.fn(), status: vi.fn(), startCandidate: vi.fn(),
  packages: vi.fn(), manifest: vi.fn(), deploy: vi.fn(),
}));
vi.mock("../src/lib/updateNotices", () => ({
  updateNoticeApi: { adminList: mocks.adminList, adminItem: mocks.adminItem, register: mocks.register,
    pin: mocks.pin, announce: mocks.announce, remove: mocks.remove },
}));
vi.mock("../src/lib/releaseUpdate", () => ({
  getLatestReleaseMetadata: mocks.latest, promoteRelease: mocks.promote,
  getReleaseUpdateStatus: mocks.status, startCandidateUpdate: mocks.startCandidate,
  listReleasePackages: mocks.packages, getPackageManifest: mocks.manifest, deployPackage: mocks.deploy,
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
  mocks.announce.mockImplementation(async (id: string) => ({ ok: true, item: { ...liveNotice, id, announcement_revision: 1 } }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => { await act(async () => { root.render(<UpdateNoticesSection />); }); await settle(); };
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
  expect(button(row(OLD), "배포")!.className).toContain("ghost"); // 옛 판 = 되돌리기, 흐린 단추
  await click(host, "이전 판 2개 더 보기 ▾");
  expect(host.querySelectorAll(".admin-update-row")).toHaveLength(8);
  expect(host.querySelector(".admin-update-pinned")).toBeNull();
});

it("후보 줄 [배포] = 없을 때만 등록 → 공지 → promote", async () => {
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: CAND });
  await mount();
  await click(row(CAND), "배포");
  expect(mocks.adminItem).toHaveBeenCalledWith(SHA.cand);
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sha256: SHA.cand, version: CAND }));
  expect(mocks.announce).toHaveBeenCalledWith(`n-${CAND}`);
  expect(mocks.promote).toHaveBeenCalledWith(`n-${CAND}`, SHA.cand);
  expect(mocks.deploy).not.toHaveBeenCalled();
  expect(host.textContent).toContain("팀에 배포했습니다");
});

it("이미 등록된 판은 다시 등록하지 않는다(서버 시각 보존)", async () => {
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) return notice(CAND, SHA.cand);
    throw notFound();
  });
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: CAND });
  await mount();
  await click(row(CAND), "배포");
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.promote).toHaveBeenCalledWith(`n-${CAND}`, SHA.cand);
});

it("옛 판 [배포] = 지문 확인 → 공지 → deploy-package(화면이 본 sha), 확인창은 되돌리기와 후보 취소를 알린다", async () => {
  mocks.manifest.mockResolvedValue({ version: OLD, file: `MVHub-${OLD}.zip`, sha256: SHA.old, size: 10,
    created_at: "2026-09-30T22:38:00", higgsfield_cli_version: "1.1.26" });
  mocks.deploy.mockResolvedValue({ promoted: true, already: false, version: OLD, rolled_back: true });
  await mount();
  confirm.mockReturnValueOnce(false);
  await click(row(OLD), "배포");
  expect(mocks.manifest).not.toHaveBeenCalled(); // 취소하면 아무것도 안 한다
  await click(row(OLD), "배포");
  const text = String(confirm.mock.calls[1][0]);
  expect(text).toContain("옛 판으로 내려갑니다");
  expect(text).toContain(`v${CAND} 는 후보에서 내려옵니다`);
  expect(mocks.manifest).toHaveBeenCalledWith(`MVHub-${OLD}.zip`);
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sha256: SHA.old }));
  expect(mocks.announce).toHaveBeenCalledWith(`n-${OLD}`);
  expect(mocks.deploy).toHaveBeenCalledWith(`n-${OLD}`, SHA.old, SHA.live, SHA.cand);
  expect(mocks.promote).not.toHaveBeenCalled();
  expect(host.textContent).toContain("되돌렸습니다");
});

it("[재공지]는 알림만 — 배포를 다시 하지 않는다", async () => {
  await mount();
  await click(row(LIVE), "재공지");
  expect(mocks.announce).toHaveBeenCalledWith(`n-${LIVE}`);
  expect(mocks.promote).not.toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it("[해제]는 알림만 거두고 줄은 남는다 — 해제된 배포 줄은 [공지]로 다시 알린다(표지는 그대로)", async () => {
  mocks.remove.mockResolvedValue({ ok: true, removed: true });
  await mount();
  await act(async () => { mocks.adminList.mockResolvedValue([]); });
  await click(row(LIVE), "해제");
  expect(String(confirm.mock.calls[0][0])).toContain("배포된 판과 이 줄은 그대로");
  expect(mocks.remove).toHaveBeenCalledWith(`n-${LIVE}`);
  expect(row(LIVE).textContent).toContain("팀 배포 중");
  expect(button(row(LIVE), "해제")).toBeUndefined();
  mocks.manifest.mockResolvedValue({ version: LIVE, file: `MVHub-${LIVE}.zip`, sha256: SHA.live, size: 10,
    created_at: "2026-10-01T09:06:00", higgsfield_cli_version: "1.1.26" });
  await click(row(LIVE), "공지");
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sha256: SHA.live }));
  expect(mocks.announce).toHaveBeenCalledWith(`n-${LIVE}`);
  expect(mocks.promote).not.toHaveBeenCalled();
  expect(mocks.deploy).not.toHaveBeenCalled();
});

it("공지 뒤 배포가 거절되면(4xx) 단계를 밝히고, 후보 줄에 [배포 반영]이 생긴다", async () => {
  mocks.promote.mockRejectedValueOnce(new HttpError(403, "403", "릴리스 폴더에 쓰기 권한이 없습니다"));
  await mount();
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) return notice(CAND, SHA.cand, { announcement_revision: 1 });
    throw notFound();
  });
  await click(row(CAND), "배포");
  expect(host.textContent).toContain("알림은 나갔지만 팀 배포는 하지 못했습니다");
  expect(host.textContent).toContain("쓰기 권한이 없습니다");
  expect(row(CAND).textContent).toContain("공지됨 · 아직 배포 안 됨");
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: CAND });
  mocks.announce.mockClear();
  await click(row(CAND), "배포 반영");
  expect(mocks.promote).toHaveBeenLastCalledWith(`n-${CAND}`, SHA.cand);
  expect(mocks.announce).not.toHaveBeenCalled();
});

it("배포 결과를 확인할 수 없으면(500) '하지 못했다'로 단정하지 않는다", async () => {
  mocks.manifest.mockResolvedValue({ version: OLD, file: `MVHub-${OLD}.zip`, sha256: SHA.old, size: 10,
    created_at: "", higgsfield_cli_version: "1.1.26" });
  mocks.deploy.mockRejectedValue(new HttpError(500, "500", "공개 표지 결과는 확인할 수 없습니다"));
  await mount();
  await click(row(OLD), "배포");
  expect(host.textContent).toContain("팀 배포 결과를 확인할 수 없습니다");
  expect(host.textContent).not.toContain("하지 못했습니다");
});

it("공지 결과를 모르면 배포하지 않는다(자동 재시도 없음)", async () => {
  mocks.announce.mockRejectedValue(new TypeError("Failed to fetch"));
  await mount();
  await click(row(CAND), "배포");
  expect(host.textContent).toContain("공지 결과를 확인할 수 없어 배포하지 않았습니다");
  expect(mocks.announce).toHaveBeenCalledTimes(1);
  expect(mocks.promote).not.toHaveBeenCalled();
});

it("옛 서버(단건 조회 없음)면 등록하지 않고 업데이트 안내", async () => {
  mocks.adminItem.mockRejectedValue(new HttpError(404, "404", "Not Found"));
  mocks.manifest.mockResolvedValue({ version: OLD, file: `MVHub-${OLD}.zip`, sha256: SHA.old, size: 10,
    created_at: "", higgsfield_cli_version: "1.1.26" });
  await mount();
  expect(button(row(CAND), "배포")!.disabled).toBe(true); // 후보의 공지 상태를 모른다
  await click(row(OLD), "배포");
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.announce).not.toHaveBeenCalled();
  expect(host.textContent).toContain("공유 서버를 업데이트한 뒤");
});

it("목록 밖 후보의 단건 조회가 503 이면 '공지 없음'으로 보지 않고 그 줄을 막는다(알림 재발행 방지)", async () => {
  mocks.adminItem.mockImplementation(async (sha: string) => {
    if (sha === SHA.cand) throw new HttpError(503, "503", "서버 응답 없음");
    throw notFound();
  });
  await mount();
  expect(host.textContent).toContain("알림 상태를 확인하지 못해 그 줄의 단추를 막았습니다");
  expect(button(row(CAND), "배포")!.disabled).toBe(true);
  expect(button(row(LIVE), "재공지")!.disabled).toBe(false);
  expect(button(row(OLD), "배포")!.disabled).toBe(false);
});

it("후보가 공개본보다 옛 판이면(되돌리기가 후보만 바꾸고 멈춤) 먼저 설치 단추가 없다", async () => {
  mocks.latest.mockResolvedValue(release({ version: OLD, file: `MVHub-${OLD}.zip`, sha256: SHA.old }));
  await mount();
  expect(row(OLD).textContent).toContain("새 후보 · 배포 전");
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels.some((text) => text?.startsWith("이 PC에"))).toBe(false);
});

it("공개 표지를 못 읽으면 배포 단추를 막고 이유를 보인다", async () => {
  mocks.latest.mockResolvedValue(release({ published: null, published_state: "error", pending: null }));
  await mount();
  expect(host.textContent).toContain("배포 상태를 확인할 수 없습니다");
  expect(button(row(CAND), "배포")!.disabled).toBe(true);
  expect(button(row(OLD), "배포")!.disabled).toBe(true);
});

it("후보 파일이 깨졌으면 배포를 모두 막고 재공지는 둔다", async () => {
  mocks.latest.mockResolvedValue(release({ version: LIVE, file: `MVHub-${LIVE}.zip`, sha256: SHA.live, source: "latest",
    candidate_error: "candidate.json 을 읽을 수 없습니다", pending: null }));
  await mount();
  expect(host.textContent).toContain("배포를 막았습니다");
  expect(button(row(OLD), "배포")!.disabled).toBe(true);
  expect(button(row(LIVE), "재공지")!.disabled).toBe(false);
});

it("고정된 알림은 목록 위 한 줄 — NAS 에 없는 판이어도 [고정 풀기]", async () => {
  mocks.adminList.mockResolvedValue([liveNotice, notice("2026.08.01-1000", "e".repeat(64), { pinned: true })]);
  mocks.pin.mockResolvedValue({ ok: true, item: notice("2026.08.01-1000", "e".repeat(64)) });
  await mount();
  const line = host.querySelector(".admin-update-pinned")!;
  expect(line.textContent).toContain("v2026.08.01-1000");
  await click(line, "고정 풀기");
  expect(mocks.pin).toHaveBeenCalledWith("n-2026.08.01-1000", false);
});

it("성공 뒤 목록 다시 읽기가 실패해도 성공 문구는 남는다", async () => {
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: CAND });
  await mount();
  mocks.adminList.mockRejectedValue(new HttpError(503, "503", "서버 응답 없음"));
  await click(row(CAND), "배포");
  expect(host.textContent).toContain("팀에 배포했습니다");
  expect(host.textContent).toContain("알림 목록을 읽지 못했습니다");
  expect(mocks.status).toHaveBeenLastCalledWith(true); // 작업 뒤 이 PC 상태는 새로 확인
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
  expect(mocks.announce).not.toHaveBeenCalled();
  expect(mocks.promote).not.toHaveBeenCalled();
  expect(host.textContent).toContain("이 PC 에 설치하기 시작했습니다");
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

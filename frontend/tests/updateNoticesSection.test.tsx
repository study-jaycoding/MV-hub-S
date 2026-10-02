// @vitest-environment jsdom
// 업데이트 탭 B안(2026-10-02) — 처음 [공지]만 배포까지, [재공지]는 알림만, [배포 반영]은 표지만, [해제]는 확인 뒤 삭제,
// 공개 표지를 못 읽으면 배포 단추를 막는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/http";
import type { LatestReleaseMetadata } from "../src/lib/releaseUpdate";
import type { UpdateNotice } from "../src/lib/updateNotices";

const mocks = vi.hoisted(() => ({
  adminList: vi.fn(), adminItem: vi.fn(), register: vi.fn(), pin: vi.fn(), announce: vi.fn(), remove: vi.fn(),
  latest: vi.fn(), promote: vi.fn(),
}));
vi.mock("../src/lib/updateNotices", () => ({
  updateNoticeApi: { adminList: mocks.adminList, adminItem: mocks.adminItem, register: mocks.register,
    pin: mocks.pin, announce: mocks.announce, remove: mocks.remove },
}));
vi.mock("../src/lib/releaseUpdate", () => ({ getLatestReleaseMetadata: mocks.latest, promoteRelease: mocks.promote }));

import { UpdateNoticesSection } from "../src/components/admin/UpdateNoticesSection";

const notice = (extra: Partial<UpdateNotice> = {}): UpdateNotice => ({
  id: "n-cand", version: "2026.10.03-1420", file: "MVHub-2026.10.03-1420.zip", released_at: "", pinned: false,
  announcement_revision: 0, announced_at: null, unread: false, sha256: "c".repeat(64), size: 10, ...extra,
});
const live = notice({ id: "n-live", version: "2026.10.01-0906", file: "MVHub-2026.10.01-0906.zip", sha256: "a".repeat(64), announcement_revision: 2 });
const release = (extra: Partial<LatestReleaseMetadata> = {}): LatestReleaseMetadata => ({
  version: "2026.10.03-1420", file: "MVHub-2026.10.03-1420.zip", sha256: "c".repeat(64), size: 10, created_at: "",
  source: "candidate", candidate_error: null, published: { version: "2026.10.01-0906", sha256: "a".repeat(64) },
  published_state: "ok", pending: true, ...extra,
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.adminList.mockResolvedValue([notice(), live]);
  mocks.latest.mockResolvedValue(release());
  mocks.adminItem.mockRejectedValue(new HttpError(404, "404", "업데이트 항목이 없습니다"));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async () => { await act(async () => { root.render(<UpdateNoticesSection />); }); await settle(); };
const row = (version: string) => [...host.querySelectorAll(".admin-update-row")].find((r) => r.textContent?.includes(version))!;
const click = async (scope: Element, label: string) => {
  await act(async () => { [...scope.querySelectorAll("button")].find((b) => b.textContent === label)!.click(); });
  await settle();
};

it("새 후보는 노란 상자로 알리고 [목록에 등록]으로 올린다", async () => {
  mocks.adminList.mockResolvedValue([live]);
  mocks.register.mockResolvedValue({ ok: true, created: true, item: notice() });
  await mount();
  expect(host.querySelector(".admin-update-cand")?.textContent).toContain("2026.10.03-1420");
  expect(row("2026.10.01-0906").textContent).toContain("팀 배포 중");
  await click(host, "목록에 등록");
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sha256: "c".repeat(64) }));
});

it("처음 [공지]는 공지한 뒤 후보를 팀에 배포한다", async () => {
  mocks.announce.mockResolvedValue({ ok: true, item: notice({ announcement_revision: 1 }) });
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: "2026.10.03-1420" });
  await mount();
  expect(row("2026.10.03-1420").textContent).toContain("후보 · 공지 전");
  await click(row("2026.10.03-1420"), "공지");
  expect(mocks.announce).toHaveBeenCalledWith("n-cand");
  expect(mocks.promote).toHaveBeenCalledWith("n-cand", "c".repeat(64));
  expect(host.textContent).toContain("팀에 배포했습니다");
});

it("[재공지]는 알림만 — 배포를 다시 하지 않는다", async () => {
  mocks.announce.mockResolvedValue({ ok: true, item: { ...live, announcement_revision: 3 } });
  await mount();
  await click(row("2026.10.01-0906"), "재공지");
  expect(mocks.announce).toHaveBeenCalledWith("n-live");
  expect(mocks.promote).not.toHaveBeenCalled();
});

it("공지 뒤 배포가 실패하면 그렇게 알리고, 그 줄에 [배포 반영]이 생긴다", async () => {
  mocks.announce.mockResolvedValue({ ok: true, item: notice({ announcement_revision: 1 }) });
  mocks.promote.mockRejectedValueOnce(new HttpError(403, "403", "릴리스 폴더에 쓰기 권한이 없습니다"));
  await mount();
  mocks.adminList.mockResolvedValue([notice({ announcement_revision: 1 }), live]);
  await click(row("2026.10.03-1420"), "공지");
  expect(host.textContent).toContain("팀 배포는 아직입니다");
  expect(host.textContent).toContain("쓰기 권한이 없습니다");
  const waiting = row("2026.10.03-1420");
  expect(waiting.textContent).toContain("공지됨 · 아직 배포 안 됨");
  mocks.promote.mockResolvedValue({ promoted: true, already: false, version: "2026.10.03-1420" });
  mocks.announce.mockClear();
  await click(waiting, "배포 반영");
  expect(mocks.promote).toHaveBeenLastCalledWith("n-cand", "c".repeat(64));
  expect(mocks.announce).not.toHaveBeenCalled();
});

it("공개 표지를 못 읽으면 후보의 [공지]를 막고 이유를 보인다", async () => {
  mocks.latest.mockResolvedValue(release({ published: null, published_state: "error", pending: null }));
  await mount();
  expect(host.textContent).toContain("배포 상태를 확인할 수 없습니다");
  const button = [...row("2026.10.03-1420").querySelectorAll("button")].find((b) => b.textContent === "공지")!;
  expect(button.disabled).toBe(true);
});

it("목록 밖으로 밀린 후보도 단건으로 찾아 맨 위에 보인다", async () => {
  mocks.adminList.mockResolvedValue([live]);
  mocks.adminItem.mockResolvedValue(notice({ announcement_revision: 1 }));
  await mount();
  expect(mocks.adminItem).toHaveBeenCalledWith("c".repeat(64));
  expect(host.querySelector(".admin-update-cand")).toBeNull();
  expect(host.querySelector(".admin-update-row")?.textContent).toContain("2026.10.03-1420");
});

it("[해제]는 확인 뒤 지우고, 옛 서버면 업데이트 안내를 보인다", async () => {
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  vi.stubGlobal("confirm", confirm);
  mocks.remove.mockResolvedValueOnce({ ok: true, removed: true }).mockRejectedValueOnce(new HttpError(404, "404", "Not Found"));
  await mount();
  await click(row("2026.10.01-0906"), "해제");
  expect(mocks.remove).not.toHaveBeenCalled(); // 취소
  await click(row("2026.10.01-0906"), "해제");
  expect(mocks.remove).toHaveBeenCalledWith("n-live");
  expect(confirm.mock.calls[1][0]).toContain("이미 배포된 버전은 그대로");
  await click(row("2026.10.01-0906"), "해제");
  expect(host.textContent).toContain("공유 서버를 업데이트한 뒤 사용할 수 있습니다");
});

it("배포 결과를 확인할 수 없으면(500) '배포 안 됨'으로 단정하지 않는다", async () => {
  mocks.announce.mockResolvedValue({ ok: true, item: notice({ announcement_revision: 1 }) });
  mocks.promote.mockRejectedValue(new HttpError(500, "500", "공개 표지가 예상과 다른 상태입니다"));
  await mount();
  await click(row("2026.10.03-1420"), "공지");
  expect(host.textContent).toContain("팀 배포 결과를 확인할 수 없습니다");
  expect(host.textContent).not.toContain("팀 배포는 아직입니다");
});

it("후보 파일이 깨졌으면 어느 줄이든 첫 [공지]를 막는다", async () => {
  mocks.adminList.mockResolvedValue([notice({ id: "n-old", sha256: "d".repeat(64), version: "2026.09.30-2238" }), live]);
  mocks.latest.mockResolvedValue(release({ ...live, source: "latest", candidate_error: "candidate.json 을 읽을 수 없습니다",
    sha256: live.sha256!, pending: null }));
  await mount();
  expect(host.textContent).toContain("등록·공지·배포를 막았습니다");
  expect([...row("2026.09.30-2238").querySelectorAll("button")].find((b) => b.textContent === "공지")!.disabled).toBe(true);
  expect([...row("2026.10.01-0906").querySelectorAll("button")].find((b) => b.textContent === "재공지")!.disabled).toBe(false);
});

it("목록 밖 후보 조회가 404 가 아닌 오류면 등록 단추 대신 이유를 보인다", async () => {
  mocks.adminList.mockResolvedValue([live]);
  mocks.adminItem.mockRejectedValue(new HttpError(403, "403", "관리자만"));
  await mount();
  expect(host.textContent).toContain("등록됐는지 확인하지 못했습니다");
  expect(host.querySelector(".admin-update-cand")).toBeNull();
});

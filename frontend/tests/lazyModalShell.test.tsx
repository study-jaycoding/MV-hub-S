// @vitest-environment jsdom
// 지연 로딩 창의 틀(lib/useEscapeClose '지연 로딩 창의 틀' · components/app/AppOverlays) — 관리자 창·비교 창(버전·미디어).
// 2026-10-11 실측: 창의 코드가 늦게 오는 사이 다른 창을 열면, 화면에서 위에 보이는 창이 아니라 늦게 그려진 지연 로딩 창이 Esc 에 먼저
//  닫혔다(4조합 12/12) — 겹 번호를 코드가 온 뒤에야 받아서다. 이제 틀(막·빈 창·Esc 겹·모달 영역)은 연 순간에 선다.
//  시험마다 모듈을 새로 읽어(vi.resetModules) '코드가 아직 안 온' 상태에서 시작하고, 문(gates)을 열어 코드를 보낸다.
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetMeta, AssetNode, Generation, InfoTarget } from "../src/types";

const gates = { admin: Promise.resolve(), compare: Promise.resolve(), video: Promise.resolve() };

// 관리자 창의 바깥 경계 — tests/round7AdminEsc.test.tsx 와 같다.
const mocks = vi.hoisted(() => ({
  sharedServerStatus: vi.fn(), members: vi.fn(), listAccounts: vi.fn(), adminList: vi.fn(), latestRelease: vi.fn(), packages: vi.fn(),
}));
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const fixed: Record<string, unknown> = { ...mocks, assetFileUrl: () => "/fixture.png", assetThumbUrl: () => "/fixture-thumb.png", thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path };
  return { api: new Proxy(fixed, { get: (target, key: string) => target[key] ?? pending }) };
});
vi.mock("../src/lib/manageApi", () => ({ manageApi: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
vi.mock("../src/lib/useManageCaps", () => ({
  useManageCaps: () => ({ loaded: true, authOff: false, system: true, createProject: true, grantRole: true, readAll: true }),
}));
vi.mock("../src/lib/updateNotices", () => ({ updateNoticeApi: { adminList: mocks.adminList, adminItem: () => new Promise(() => {}) } }));
vi.mock("../src/lib/releaseUpdate", () => ({
  getLatestReleaseMetadata: mocks.latestRelease,
  listReleasePackages: mocks.packages,
  getReleaseUpdateStatus: () => Promise.resolve({ install_mode: "release", current_version: "", state: "up_to_date" }),
}));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
vi.mock("../src/components/admin/BackupReplicaSection", () => ({ BackupReplicaSection: () => null }));
vi.mock("../src/components/admin/AssetRegistryTab", () => ({ AssetRegistryTab: () => null }));
vi.mock("../src/lib/modelCatalog", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useModelDisplayName: () => (code?: string | null) => code ?? "",
}));

// 시험마다 모듈 묶음을 새로 읽고 창의 코드를 한 번 더 읽는다 — 전체 시험의 부하에서도 시간 초과가 나지 않게 넉넉히 준다.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Loaded = Awaited<ReturnType<typeof load>>;
let host: HTMLDivElement;
let root: Root;
let m: Loaded;
let open: Record<keyof typeof gates, () => void>;

/** 모듈을 새로 읽는다 — 세 창의 코드는 문이 열릴 때까지 오지 않는다. */
async function load() {
  vi.resetModules();
  // 가짜 모듈의 결과는 resetModules 로 지워지지 않는다 — 시험마다 다시 걸어야 새로 읽은 모듈들과 같은 묶음의 창이 온다.
  vi.doMock("../src/components/AdminWindow", async (orig) => { await gates.admin; return orig(); });
  vi.doMock("../src/components/CompareModal", async (orig) => { await gates.compare; return orig(); });
  vi.doMock("../src/components/VideoCompareModal", async (orig) => { await gates.video; return orig(); });
  open = {} as typeof open;
  for (const name of ["admin", "compare", "video"] as const) gates[name] = new Promise<void>((resolve) => { open[name] = resolve; });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const overlays = await import("../src/components/app/AppOverlays");
  const keyGate = await import("../src/lib/keyGate");
  return { act: React.act, createRoot, keyGate, ...overlays };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.sharedServerStatus.mockResolvedValue({ url: "http://server:8010", server_name: "MV", is_admin: true, elevated: false, elevated_as: null, super_admin_expires_at: null });
  mocks.members.mockResolvedValue([{ uid: "user_jay", name: "Jay", email: "jay@mv.com", global_roles: ["admin", "product_manager"] }]);
  mocks.listAccounts.mockResolvedValue([{ email: "a@mv.com", name: "A", status: "approved", hidden: false }]);
  mocks.adminList.mockResolvedValue([]);
  mocks.latestRelease.mockResolvedValue(null);
  mocks.packages.mockResolvedValue([]);
  m = await load();
  host = document.createElement("div"); document.body.append(host); root = m.createRoot(host);
});
afterEach(() => { m.act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const noop = () => {};
const el = (id: string) => document.getElementById(id) as HTMLElement;
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const active = () => document.activeElement as HTMLElement;
const render = (ui: ReactElement) => m.act(() => root.render(ui));
const focus = (id: string) => m.act(() => el(id).focus());
const key = (name: string, target: EventTarget = document.activeElement ?? document.body) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  m.act(() => { target.dispatchEvent(event); });
  return event;
};
/** 코드를 보내고 본문이 그려질 때까지 기다린다. */
async function arrive(name: keyof typeof gates, bodySelector: string) {
  open[name]();
  for (let i = 0; i < 4000 && !q(bodySelector); i++) await m.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  for (let i = 0; i < 5; i++) await m.act(async () => { await Promise.resolve(); });
  expect(q(bodySelector)).not.toBeNull();
}

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음(이전) 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
const stops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest("[inert]"));
function tab(shift = false): KeyboardEvent {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  m.act(() => { from.dispatchEvent(event); });
  if (event.defaultPrevented) return event;
  const all = stops();
  const at = all.indexOf(from);
  let next: HTMLElement | undefined;
  if (at >= 0) next = all[at + (shift ? -1 : 1)];
  else if (from === document.body) next = shift ? all[all.length - 1] : all[0];
  else if (shift) next = all.filter((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING && !item.contains(from)).pop();
  else next = all.find((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  m.act(() => { if (next) next.focus(); else from.blur(); });
  return event;
}
const walk = (count: number, shift = false) => Array.from({ length: count }, () => { tab(shift); return active(); });
const outside = (visited: HTMLElement[], region: HTMLElement) => visited.filter((at) => !region.contains(at)).map((at) => at.id || at.className || at.tagName);

const node: AssetNode = { name: "fixture.png", path: "folder/fixture.png", type: "image" };
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };
const infoTarget: InfoTarget = { kind: "file", project: "fixture", node, meta, x: 100, y: 100 };
const image = (id: string, refs: boolean | "video" = false) => ({ id, prompt: "p " + id, status: "done", created_at: "2026-10-11", model: "m", params: {},
  shared: false, is_held: false, is_final: false, is_mine: true, deleted: false, tags: [], auto_tags: [], comment_count: 0,
  references: refs ? [{ id: "ref-" + id, type: refs === "video" ? "video" : "image", role: "src", file_path: `/media/ref-${id}.png`, thumbnail_path: null, source_url: null }] : [],
  assets: [{ id: "as-" + id, type: "image", file_path: `/media/${id}.png`, thumbnail_path: `/media/${id}_t.png` }] } as unknown as Generation);
const videos = [{ url: "/media/a.png", name: "a", type: "image" as const }, { url: "/media/b.png", name: "b", type: "image" as const }];

interface View { admin?: boolean; compare?: boolean; info?: boolean; video?: boolean; refs?: boolean | "video" }
const closed = { admin: vi.fn(), compare: vi.fn(), info: vi.fn(), video: vi.fn() };
// 뒤 화면의 단추 사이에 앱의 창들을 그린다 — App 과 같은 차례(AppOverlays 뒤에 미디어 비교).
const screen = (view: View) => (
  <>
    <button id="opener">연 단추</button>
    <m.AppOverlays
      account={{ email: "jay@mv.com", creator_uid: "user_jay" } as never} adminOpen={!!view.admin} localHub
      commentGenId={null} commentLabel="" compareGens={view.compare ? [image("a", view.refs), image("b", view.refs)] : null}
      info={view.info ? infoTarget : null} myId="me" preview={null} projects={[]} syncTick={0} toast={null}
      onAdminClose={closed.admin} onCloseOverlay={noop} onCommentClose={noop} onCompareClose={closed.compare} onHistoryChanged={noop}
      onInfoClose={closed.info} onInfoOpenInBoard={noop} onInfoOpenCanvas={noop} onRecoveryRequeue={async () => true}
      onOpenInBoardFromPreview={noop} onPreview={noop}
    />
    {view.video && <m.VideoCompareOverlay videos={videos} onClose={closed.video} />}
    <button id="behind">뒤 화면의 Generate</button>
  </>
);
beforeEach(() => Object.values(closed).forEach((mock) => mock.mockReset()));

it("관리자 창: 코드가 오기 전에도 막과 빈 창이 떠 있다 — 뒤 화면의 키는 쉬고, 초점은 창에 있고, Esc 로 닫힌다", () => {
  render(screen({}));
  focus("opener");
  render(screen({ admin: true }));
  expect(q(".admin-backdrop")).not.toBeNull();
  const frame = q('.admin-window[aria-label="관리자"]')!;
  expect(frame.childElementCount).toBe(0); // 빈 틀 — 본문은 아직이다
  expect(m.keyGate.backgroundKeysBlocked()).toBe(true);
  expect(active()).toBe(frame);
  tab();
  expect(active()).toBe(frame); // 설 자리가 없는 빈 창 — 뒤 화면으로 나가지 않는다
  key("Escape");
  expect(closed.admin).toHaveBeenCalledTimes(1);
  render(screen({}));
  expect(q(".admin-window")).toBeNull();
  expect(active()).toBe(el("opener"));
});

it("관리자 창: 코드가 오기 전에 막을 눌러 닫을 수 있고, 닫았다가 다시 열어도 된다 — 코드는 그 뒤에 와도 본문이 그려진다", async () => {
  render(screen({ admin: true }));
  m.act(() => { q(".admin-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(closed.admin).toHaveBeenCalledTimes(1);
  render(screen({}));
  expect(m.keyGate.backgroundKeysBlocked()).toBe(false);
  render(screen({ admin: true }));
  expect(q(".admin-window")!.childElementCount).toBe(0);
  await arrive("admin", ".admin-window .admin-head");
  expect(document.querySelectorAll(".admin-window")).toHaveLength(1); // 빈 틀은 걷혔다
  expect(document.querySelectorAll(".admin-backdrop")).toHaveLength(1);
  key("Escape");
  expect(closed.admin).toHaveBeenCalledTimes(2); // 한 Esc 에 한 번
});

it("코드가 늦게 오는 사이 연 창(정보 창)이 위다 — 코드가 온 뒤에도 Esc 는 정보 창부터 닫고, 초점도 정보 창에 그대로다", async () => {
  render(screen({ admin: true }));
  render(screen({ admin: true, info: true })); // 관리자 창의 코드가 오기 전에 정보 창을 열었다
  const popup = q(".info-popup")!;
  expect(popup.contains(active())).toBe(true);
  await arrive("admin", ".admin-window .admin-head");
  expect(popup.contains(active())).toBe(true); // 늦게 그려진 본문이 초점을 가져가지 않는다
  expect(outside(walk(10), popup)).toEqual([]);
  key("Escape");
  expect(closed.info).toHaveBeenCalledTimes(1);
  expect(closed.admin).not.toHaveBeenCalled();
  render(screen({ admin: true }));
  expect(q(".admin-window")!.contains(active())).toBe(true); // 위 창이 닫혔다 — 초점은 아래 모달로
  key("Escape");
  expect(closed.admin).toHaveBeenCalledTimes(1);
});

it("관리자 창: 코드가 온 뒤에는 본문 안의 것부터 닫는다 — 🔑 확인 창 → 창. 글 칸의 Esc 는 칸을 벗어나기만 한다", async () => {
  render(screen({}));
  focus("opener");
  render(screen({ admin: true }));
  await arrive("admin", ".admin-window .admin-tabs");
  const win = q(".admin-window")!;
  expect(win.contains(active())).toBe(true); // 빈 틀이 걷히며 떨어진 초점을 본문의 뿌리로 다시 들였다
  expect(outside([...walk(30), ...walk(10, true)], win)).toEqual([]);
  m.act(() => q(".admin-key")!.click());
  expect(q(".admin-elev")).not.toBeNull();
  key("Escape");
  expect(q(".admin-elev")).toBeNull();
  expect(closed.admin).not.toHaveBeenCalled();
  m.act(() => [...document.querySelectorAll<HTMLButtonElement>(".admin-tab")].find((button) => button.textContent === "멤버 · 전역 역할")!.click());
  const search = q(".member-search input")!;
  m.act(() => search.focus());
  key("Escape");
  expect(closed.admin).not.toHaveBeenCalled();
  expect(active()).not.toBe(search);
  key("Escape");
  expect(closed.admin).toHaveBeenCalledTimes(1);
  render(screen({}));
  expect(active()).toBe(el("opener"));
});

it("버전 비교 창: 빈 틀 → 본문. 초점은 줄곧 창 안이고 Tab 30번·Shift+Tab 10번이 창 안에서만 돈다 · 닫으면 연 단추로 돌아간다", async () => {
  render(screen({}));
  focus("opener");
  render(screen({ compare: true }));
  expect(q(".cmp-backdrop")).not.toBeNull();
  const frame = q('.cmp-modal.cmp-window[aria-label="버전 비교"]')!;
  expect(active()).toBe(frame);
  expect(m.keyGate.backgroundKeysBlocked()).toBe(true);
  await arrive("compare", ".cmp-modal .admin-head");
  const win = q('.cmp-modal[aria-label="버전 비교"]')!;
  expect(document.querySelectorAll(".cmp-modal")).toHaveLength(1);
  expect(win.contains(active())).toBe(true);
  expect(outside([...walk(30), ...walk(10, true)], win)).toEqual([]);
  expect(m.keyGate.focusCameByTab()).toBe(true); // 창이 키의 전파를 막아도 Tab 은 적힌다
  expect(key("Escape").defaultPrevented).toBe(true); // 비교 창의 Esc 는 삼킨다 — 틀이 쥔 겹도 본문과 같은 방식이다
  expect(closed.compare).toHaveBeenCalledTimes(1);
  render(screen({}));
  expect(active()).toBe(el("opener"));
});

it("미디어 비교 창: 코드가 오기 전 Esc 로 닫히고, 온 뒤에는 라이트박스부터 닫는다. Tab 은 창 안에서만 돈다", async () => {
  render(screen({ video: true }));
  const frame = q('.cmp-modal[aria-label="미디어 비교"]')!;
  expect(frame.childElementCount).toBe(0);
  expect(active()).toBe(frame);
  key("Escape");
  expect(closed.video).toHaveBeenCalledTimes(1);
  render(screen({}));
  render(screen({ video: true }));
  await arrive("video", ".cmp-modal .admin-head");
  const win = q('.cmp-modal[aria-label="미디어 비교"]')!;
  expect(win.contains(active())).toBe(true);
  expect(outside([...walk(30), ...walk(10, true)], win)).toEqual([]);
  // 그림을 휠(가운데) 단추로 누르면 브라우저가 자동 스크롤 모드에 들어가 첫 Esc 를 가져갔다(실측 5/5) — 창 안에서는 그 기본 동작을 막는다
  const wheelPress = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true });
  m.act(() => { win.querySelector<HTMLElement>(".cmp-body img")!.dispatchEvent(wheelPress); });
  expect(wheelPress.defaultPrevented).toBe(true);
  m.act(() => win.querySelector<HTMLElement>(".fit-toggle")!.focus());
  m.act(() => win.querySelector<HTMLElement>(".cmp-body img")!.click()); // 그림을 눌러 크게 본다(라이트박스)
  expect(q(".cmp-srcbox")).not.toBeNull();
  // 라이트박스는 비교 창의 바깥 형제다 — 떠 있는 동안은 그것이 맨 위 영역이라 Tab 이 아래 비교 창으로 돌아가지 않는다
  const lightbox = q(".cmp-srcbox-inner")!;
  expect(lightbox.contains(active())).toBe(true);
  expect(outside([...walk(10), ...walk(4, true)], lightbox)).toEqual([]);
  expect(active()).toBe(q(".cmp-srcbox-x"));
  key("Escape");
  expect(q(".cmp-srcbox")).toBeNull();
  expect(active()).toBe(win.querySelector(".fit-toggle")); // 닫으면 비교 창의 연 자리로
  expect(closed.video).toHaveBeenCalledTimes(1);
  key("Escape");
  expect(closed.video).toHaveBeenCalledTimes(2);
});

it("버전 비교 창의 소스 라이트박스: 떠 있는 동안 Tab 은 라이트박스 안에서만 돈다 — 닫으면 연 소스 단추로 돌아간다", async () => {
  render(screen({ compare: true, refs: true }));
  await arrive("compare", ".cmp-modal .cmp-ref-btn");
  const source = q(".cmp-ref-btn")!;
  m.act(() => source.focus());
  m.act(() => source.click());
  const lightbox = q(".cmp-srcbox-inner")!;
  expect(lightbox.contains(active())).toBe(true);
  expect(outside([...walk(10), ...walk(4, true)], lightbox)).toEqual([]);
  key("Escape");
  expect(q(".cmp-srcbox")).toBeNull();
  expect(closed.compare).not.toHaveBeenCalled();
  expect(active()).toBe(source);
  expect(outside(walk(12), q(".cmp-modal")!)).toEqual([]); // 다시 비교 창 안에서 돈다
});

// 2026-10-11 실측: 라이트박스의 영상 조작부에 초점이 있으면 Esc 가 안 닫혔다 — 앱은 매체에서 난 Esc 를 양보하지 않는다는 것만 지킨다
//  (안쪽 조작부의 키가 페이지에 오는지는 브라우저의 일 — tests/modalFocusWindows 의 같은 묶음).
it("버전 비교 창의 소스 라이트박스(영상): 영상에서 난 Esc 는 라이트박스만 닫는다 — 비교 창은 그대로다", async () => {
  render(screen({ compare: true, refs: "video" }));
  await arrive("compare", ".cmp-modal .cmp-ref-btn");
  m.act(() => q(".cmp-ref-btn")!.click());
  const media = q(".cmp-srcbox-inner video")!;
  media.tabIndex = 0; // jsdom 에서는 조작부가 있는 매체도 초점을 못 받는다 — tabindex 로 흉내 낸다
  m.act(() => media.focus());
  expect(active()).toBe(media);
  key("Escape", media);
  expect(q(".cmp-srcbox")).toBeNull();
  expect(closed.compare).not.toHaveBeenCalled();
  expect(q('.cmp-modal[aria-label="버전 비교"]')).not.toBeNull();
});

it("두 지연 로딩 창: 먼저 연 관리자 창의 코드가 나중에 와도 나중에 연 비교 창이 위다(Esc 는 비교 창부터)", async () => {
  render(screen({ admin: true }));
  render(screen({ admin: true, compare: true }));
  await arrive("compare", ".cmp-modal .admin-head");
  await arrive("admin", ".admin-window .admin-head"); // 관리자 창의 코드가 더 늦게 왔다
  expect(q(".cmp-modal")!.contains(active())).toBe(true);
  key("Escape");
  expect(closed.compare).toHaveBeenCalledTimes(1);
  expect(closed.admin).not.toHaveBeenCalled();
});

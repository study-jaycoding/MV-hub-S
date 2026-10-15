// @vitest-environment jsdom
// 모달의 초점(lib/keyGate '모달의 초점') — 창별. 실제 창을 붙여 본다.
// 2026-10-11 실측: 정보·비교·관리자 창은 연 직후 초점이 뒤에 그대로라 1번째 Tab 부터 뒤 카드 단추였고, 설정 창은 10번째에 상단바로 나갔다.
//  창마다: 열면 초점이 창 안 · Tab 30번·Shift+Tab 10번이 창 안에서만 · 닫으면 열기 전 자리로.
//  (지연 로딩 창 — 관리자·비교 — 은 tests/lazyModalShell.test.tsx)
import { act, StrictMode, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 응답은 전부 '아직 안 옴'으로 둔다(창의 틀과 단추는 응답 없이도 그려진다).
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const urls: Record<string, unknown> = { assetFileUrl: () => "/fixture.png", assetThumbUrl: () => "/fixture-thumb.png", thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path };
  return { api: new Proxy(urls, { get: (target, key: string) => target[key] ?? pending }), GEN_PAGE: 200 };
});
vi.mock("../src/lib/modelCatalog", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useModelDisplayName: () => (code?: string | null) => code ?? "",
}));
vi.mock("../src/lib/generationViews", () => ({ recordGenerationView: vi.fn() }));
// 격자(ThumbnailGrid)를 붙이는 시험용 — tests/gridLooseKeys 와 같은 경계.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/teamSeen", () => ({
  subscribeTeamSeen: () => () => {}, getTeamSeenVersion: () => 0,
  isFreshGen: () => false, ackTeamFresh: vi.fn(), getTeamBase: () => null,
  ackAllLabel: () => "", isAckedFor: () => false, ackTeamFreshKeys: vi.fn(),
}));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => <span>thumbnail</span> }));

import { MountManager } from "../src/components/assets/MountManager";
import { CutInfoPopup } from "../src/components/CutInfoPopup";
import { CutReel } from "../src/components/CutReel";
import { PartialEditModal } from "../src/components/edit/PartialEditModal";
import { FloatingPrompt } from "../src/components/FloatingPrompt";
import { ConfirmQuestion } from "../src/components/generation/ConfirmQuestion";
import { GenerationConfirmOverlay } from "../src/components/generation/GenerationConfirmOverlay";
import { GenerationReviewOverlay } from "../src/components/generation/GenerationReviewOverlay";
import { GradeStepModal } from "../src/components/GradeStepModal";
import { InfoPopup } from "../src/components/InfoPopup";
import { ManageAccount } from "../src/components/ManageAccount";
import { MediaPreview } from "../src/components/MediaPreview";
import { McpConnection } from "../src/components/mcp/McpConnection";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { ShortcutsWindow } from "../src/components/ShortcutsWindow";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import { TopBar } from "../src/components/TopBar";
import { computeGradeStep } from "../src/lib/gradeStep";
import { focusCameByTab } from "../src/lib/keyGate";
import type { AssetMeta, AssetNode, FolderCard, GenQuery, Generation, PreviewTarget } from "../src/types";

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  localStorage.clear();
  // jsdom 에는 영상 재생이 없다 — 창들이 부르는 것만 빈 함수로
  for (const name of ["pause", "load"] as const) vi.spyOn(HTMLMediaElement.prototype, name).mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  // 격자는 폭으로 열 수를 정한다 — 두 열
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const el = (id: string) => document.getElementById(id) as HTMLElement;
const focus = (id: string) => act(() => el(id).focus());
const active = () => document.activeElement as HTMLElement;
const noop = () => {};
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const flushFrames = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
const key = (name: string, target: EventTarget = document.activeElement ?? document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};
/** 마우스로 누른다 — 누름(pointerdown)·초점·뗌(pointerup)·click 순서 그대로. */
const press = (target: HTMLElement) => {
  act(() => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  act(() => target.focus());
  act(() => { target.dispatchEvent(new Event("pointerup", { bubbles: true })); });
  act(() => target.click());
};

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음(이전) 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
const stops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest("[inert]"));
function tab(shift = false): KeyboardEvent {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  act(() => { from.dispatchEvent(event); });
  if (event.defaultPrevented) return event;
  const all = stops();
  const at = all.indexOf(from);
  let next: HTMLElement | undefined;
  if (at >= 0) next = all[at + (shift ? -1 : 1)];
  else if (from === document.body) next = shift ? all[all.length - 1] : all[0];
  else if (shift) next = all.filter((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING && !item.contains(from)).pop();
  else next = all.find((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  act(() => { if (next) next.focus(); else from.blur(); });
  return event;
}
/** Tab 을 count 번 — 그때마다 초점이 놓인 요소. */
const walk = (count: number, shift = false) => Array.from({ length: count }, () => { tab(shift); return active(); });
const outside = (visited: HTMLElement[], ...regions: (HTMLElement | null)[]) =>
  visited.filter((at) => !regions.some((region) => region?.contains(at))).map((at) => at.id || at.className || at.tagName);

// 뒤 화면: 창을 연 단추 · (창) · 떠 있는 선택 막대 · 접힌 프롬프트의 단추. 창은 그 사이(문서 순서)에 그려진다.
const page = (window: ReactElement | null) => (
  <>
    <button id="opener">연 단추</button>
    <button id="behind">뒤 카드의 ⤓</button>
    {window}
    <div className="select-bar"><button id="bar">전체 내보내기</button></div>
    <button id="dock">Generate</button>
  </>
);

const node: AssetNode = { name: "fixture.png", path: "folder/fixture.png", type: "image" };
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };

const gen = (id: string, extra: Partial<Generation> = {}) => ({ id, prompt: "p " + id, status: "done", created_at: "2026-10-11 10:00:00", sort_ts: 1, model: "m",
  params: {}, shared: true, is_held: false, is_final: false, is_mine: true, deleted: false, tags: [], auto_tags: [], references: [], comment_count: 0,
  folder_path: "e035/C0290", assets: [], ...extra } as unknown as Generation);
const folder: FolderCard = { path: "e035/C0290", name: "C0290", count: 3, rep: false,
  cover: gen("cover", { assets: [{ type: "image", file_path: "/m/c.png", thumbnail_path: null }] } as unknown as Partial<Generation>) };
const query: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035/C0290", colors: [], tags: [], auto_tags: [] };

// [이름, 창, 창의 뿌리(모달 영역)]
const windows: [string, (onClose: () => void) => ReactElement, string][] = [
  ["정보 창(InfoPopup)", (onClose) => <InfoPopup target={{ kind: "file", project: "fixture", node, meta, x: 100, y: 100 }} onClose={onClose} onPreview={noop} />, ".info-popup"],
  ["크게 보기(MediaPreview)", (onClose) => <MediaPreview target={{ url: "/o.png", type: "image", name: "n", genId: "g1" }} onClose={onClose} onOpenInBoard={noop} />, ".media-preview"],
  ["설정 창(SettingsPanel)", (onClose) => <SettingsPanel onClose={onClose} onImported={noop} />, ".settings-float"],
  ["단축키 창(ShortcutsWindow)", (onClose) => <ShortcutsWindow onClose={onClose} />, ".sc-float"],
  ["등급 확인(GradeStepModal)", (onClose) => <GradeStepModal pending={computeGradeStep([gen("g")], "down", () => true)} busy={false} onConfirm={noop} onCancel={onClose} />, ".gradestep-modal"],
  ["부분 수정(PartialEditModal)", (onClose) => <PartialEditModal gen={gen("g")} workspace={{ scope: "personal", id: null, name: null } as never} onQueued={noop} onClose={onClose} />, ".partial-edit-modal"],
  ["컷 정보(CutInfoPopup)", (onClose) => <CutInfoPopup folder={folder} x={100} y={100} query={query} savingRep={false} previewOpen={false} onClose={onClose} onOpen={noop} onPreview={noop} onPickCover={noop} />, ".info-popup.cutinfo"],
  ["모아보기(CutReel)", (onClose) => <CutReel folders={[folder]} mode="each" onModeChange={noop} previewOpen={false} onClose={onClose} onPreview={noop} onEnter={noop} />, ".reel"],
  ["이름 입력(FloatingPrompt)", (onClose) => <FloatingPrompt title="이름" onSubmit={noop} onCancel={onClose} />, ".fp-panel"],
  ["내 계정(ManageAccount)", (onClose) => <ManageAccount provider={null} account={null} onClose={onClose} onProviderUpdated={noop} />, ".manage-float"],
  ["폴더 등록(MountManager)", (onClose) => <MountManager onClose={onClose} onChanged={noop} />, ".mount-float"],
];

describe.each(windows)("%s", (_name, render, rootSelector) => {
  it("열면 초점이 창 안 · Tab 30번·Shift+Tab 10번이 창 안에서만 돈다 · 닫으면 연 단추로 돌아간다", async () => {
    act(() => root.render(page(null)));
    focus("opener");
    act(() => root.render(page(render(noop))));
    await settle();
    const win = document.querySelector<HTMLElement>(rootSelector)!;
    expect(win.contains(active())).toBe(true);
    expect(outside([...walk(30), ...walk(10, true)], win)).toEqual([]);
    act(() => root.render(page(null)));
    expect(active()).toBe(el("opener"));
  });
});

describe("설정 창 + 옆 패널 + 단축키 창", () => {
  const float = () => document.querySelector<HTMLElement>(".settings-float")!;
  const flyout = () => document.querySelector<HTMLElement>(".settings-group-flyout");
  const shortcuts = () => document.querySelector<HTMLElement>(".sc-float");

  it("AI·MCP 연결을 누르면 설정 닫기 콜백 뒤에 연결 열기를 호출한다", async () => {
    const order: string[] = [];
    act(() => root.render(<SettingsPanel onClose={() => order.push("close")} onOpenMcp={() => order.push("mcp")} />));
    await settle();
    const button = [...document.querySelectorAll<HTMLButtonElement>(".settings-float button")].find((item) => item.textContent === "AI·MCP 연결 열기")!;
    expect(button).toBeDefined();
    press(button);
    expect(order).toEqual(["close", "mcp"]);
  });

  it("옆 패널은 설정 창과 한 영역이다 — Tab 이 둘 사이를 돌고 뒤 화면으로는 나가지 않는다", async () => {
    act(() => root.render(page(<SettingsPanel onClose={noop} onImported={noop} />)));
    await settle();
    press(float().querySelector<HTMLElement>(".settings-group-toggle")!);
    expect(flyout()).not.toBeNull();
    const visited = [...walk(60), ...walk(20, true)];
    expect(outside(visited, float(), flyout())).toEqual([]);
    expect(visited.some((at) => flyout()!.contains(at))).toBe(true); // 옆 패널에도 선다
    expect(visited.some((at) => float().contains(at))).toBe(true);
  });

  it("그 위의 단축키 창 — Tab 은 단축키 창 안에서만 돈다(옆 패널로 가지 않는다). 닫으면 초점이 연 단추로 돌아오고 다시 설정+옆 패널 안에서 돈다", async () => {
    act(() => root.render(page(<SettingsPanel onClose={noop} onImported={noop} />)));
    await settle();
    press(float().querySelector<HTMLElement>(".settings-group-toggle")!);
    const opener = [...flyout()!.querySelectorAll<HTMLElement>(".settings-action")].find((button) => button.textContent?.includes("단축키"))!;
    press(opener);
    expect(shortcuts()).not.toBeNull();
    expect(shortcuts()!.contains(active())).toBe(true);
    expect(outside([...walk(30), ...walk(10, true)], shortcuts())).toEqual([]);
    key("Escape");
    expect(shortcuts()).toBeNull();
    expect(flyout()).not.toBeNull(); // Esc 한 번에 한 겹
    expect(active()).toBe(opener);
    expect(outside([...walk(60), ...walk(20, true)], float(), flyout())).toEqual([]);
  });
});

// ── 격자를 붙인 화면 ──
const video = (id: string, extra: Partial<Generation> = {}) => gen(id, { shared: false,
  assets: [{ id: "as-" + id, type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: `/m/${id}.png` }], ...extra } as unknown as Partial<Generation>);
const cards = ["g1", "g2", "g3", "g4", "g5"].map((id) => video(id));
const opened: PreviewTarget[] = [];
function GridScreen() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  return (
    <>
      <ThumbnailGrid generations={cards} tab="my" scale={1} fill layout="grid" groupByDate={false}
        selectedIds={selected} onSelectedChange={setSelected} onToggleSelect={noop} onSetSource={noop} onSetTags={noop} onOpenComments={noop}
        onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop} onImport={noop} onRestore={noop}
        dimDeleted={false} onInfo={noop} onPreview={(target) => { opened.push(target); setPreview(target); }} />
      {preview && <MediaPreview target={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
const grid = () => host.querySelector<HTMLElement>(".gen-grid")!;
const cell = (id: string) => host.querySelector<HTMLElement>(`.gen-cell[data-id="${id}"]`)!;
const focusedCard = () => host.querySelector<HTMLElement>(".gen-cell.focused")?.dataset.id;
const clickCard = (id: string) => {
  act(() => { cell(id).querySelector(".card")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })); });
  act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 })); });
};

describe("크게 보기 — 격자에서 열고 닫기", () => {
  it("초점은 창으로 가도 방향키·Space·Enter 는 전처럼 창이 쓰고, 닫으면 초점과 격자의 초점 카드·방향키 기준이 그대로다", () => {
    opened.length = 0;
    act(() => root.render(<GridScreen />));
    flushFrames();
    clickCard("g2");
    expect(focusedCard()).toBe("g2");
    key("Enter", grid());
    const box = host.querySelector<HTMLElement>(".media-preview")!;
    expect(active()).toBe(box); // 초점은 창의 뿌리 — 창 안의 단추(다운로드)가 아니다
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockClear();
    expect(key(" ").defaultPrevented).toBe(true);
    expect(play).toHaveBeenCalledTimes(1); // Space = 재생/정지(창 안 단추를 누르지 않는다)
    // 길게 눌린 Space(반복 keydown)는 막기만 한다 — 재생/정지가 반복마다 뒤집히지 않는다(조작 규칙 38)
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    pause.mockClear();
    expect(key(" ", document.activeElement ?? document.body, { repeat: true }).defaultPrevented).toBe(true);
    expect([play.mock.calls.length, pause.mock.calls.length]).toEqual([1, 0]);
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(opened).toHaveLength(1); // Enter 가 뒤 격자에서 크게 보기를 또 열지 않는다
    expect(host.querySelector(".preview-count")?.textContent?.trim()).toBe("2/5");
    key("ArrowRight");
    expect(host.querySelector(".preview-count")?.textContent?.trim()).toBe("3/5");
    expect(focusedCard()).toBe("g2"); // 뒤 격자의 초점 카드는 움직이지 않는다
    key("Escape");
    expect(host.querySelector(".media-preview")).toBeNull();
    expect(active()).toBe(grid());
    expect(focusedCard()).toBe("g2");
    key("ArrowLeft"); // 초점이 격자에 있어 바로 먹는다 — 기준은 g2(두 열의 오른쪽 칸)
    expect(focusedCard()).toBe("g1");
  });
});

describe("크게 보기 — 영상·오디오의 조작부", () => {
  const tabKey = (shift = false) => key("Tab", document.activeElement ?? document.body, { shiftKey: shift });

  it.each([["video", "/o.mp4"], ["audio", "/o.mp3"]] as const)("%s: 닫기 단추에서 Tab 은 매체로 간다(머리 첫 단추로 돌지 않는다) · 매체의 Tab 이 창 밖으로 나가면 첫 단추로 되돌린다", (type, url) => {
    act(() => root.render(page(<MediaPreview target={{ url, type, name: "n" }} onClose={noop} />)));
    const box = host.querySelector<HTMLElement>(".media-preview")!;
    const media = box.querySelector<HTMLElement>(type)!;
    const first = box.querySelector<HTMLElement>(".preview-dl-btn")!;
    act(() => box.querySelector<HTMLElement>(".assets-x")!.focus());
    expect(tabKey().defaultPrevented).toBe(false); // 브라우저에 맡긴다 — 다음 자리는 매체다
    act(() => { document.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab" })); });
    media.tabIndex = 0; // 실제 브라우저에서 조작부가 있는 매체는 초점을 받는다 — jsdom 에서는 tabindex 로 흉내 낸다
    act(() => media.focus());
    expect(active()).toBe(media);
    expect(tab().defaultPrevented).toBe(false); // 안쪽 조작부를 도는 Tab — 가로채지 않는다. 끝에서 나가면(시험의 흉내: 창 뒤의 단추로)
    expect(active()).toBe(first); // … 첫 단추로 되돌린다
    act(() => first.focus());
    expect(tab(true).defaultPrevented).toBe(true); // 첫 자리에서 뒤로 — 끝 자리(매체)로
    expect(active()).toBe(media);
  });
});

// 2026-10-11 실측: 컷 정보 창에서 영상의 **안쪽 조작부**(Tab 4~9번째 — 재생·음량·전체 화면…)에 초점이 있으면 Esc 가 창을 못 닫았다.
//  영상 요소 자체(Tab 3번째)에서는 닫혔다. 두 경우 모두 앱이 보는 것은 같다(target·activeElement = video) — 앱은 둘을 가르지 않는다.
//  여기서는 "앱은 매체에서 난 Esc 를 양보하지 않는다"만 지킨다(안쪽 조작부의 키가 페이지에 오는지는 브라우저의 일이라 jsdom 으로 못 본다).
describe("매체에 초점이 있을 때의 Esc — 앱은 양보하지 않는다", () => {
  const onMedia = (selector: string) => {
    const media = host.querySelector<HTMLElement>(selector)!;
    media.tabIndex = 0; // 실제 브라우저에서 조작부가 있는 매체는 초점을 받는다 — jsdom 에서는 tabindex 로 흉내 낸다
    act(() => media.focus());
    expect(active()).toBe(media);
    return media;
  };

  it.each([["video", "/o.mp4"], ["audio", "/o.mp3"]] as const)("크게 보기(%s): 매체에서 난 Esc 한 번에 닫힌다", (type, url) => {
    const onClose = vi.fn();
    act(() => root.render(page(<MediaPreview target={{ url, type, name: "n" }} onClose={onClose} />)));
    key("Escape", onMedia(`.media-preview ${type}`));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("컷 정보 창(영상이 든 컷): 영상에서 난 Esc 한 번에 닫힌다", async () => {
    const onClose = vi.fn();
    const cut: FolderCard = { ...folder, cover: video("cover") };
    act(() => root.render(page(<CutInfoPopup folder={cut} x={100} y={100} query={query} savingRep={false} previewOpen={false} onClose={onClose} onOpen={noop} onPreview={noop} onPickCover={noop} />)));
    await settle();
    key("Escape", onMedia(".info-popup.cutinfo video"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// 폴더 창이 뜬 동안 App 이 상단바에 inert 를 넘긴다(tests/resolveSelectionRender) — 여기서는 상단바가 그것을 머리 전체에 거는지만 본다.
describe("상단바", () => {
  it.each(["닫기", "Escape"])("설정에서 MCP를 연 뒤 %s로 닫으면 계정 아바타로 초점을 돌린다", async (close) => {
    const onOpenMcp = vi.fn();
    function Screen() {
      const [open, setOpen] = useState(false);
      const workspace = { scope: "personal" as const, id: null, name: null };
      return <>
        <TopBar filters={{ tab: "my" } as never} onTab={noop} onSearch={noop} onWorkspaceSwitched={noop}
          workspaceContext={workspace} onWorkspaceContextChange={noop} onImported={noop}
          onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop}
          onOpenMcp={() => { onOpenMcp(); setOpen(true); }} />
        <McpConnection open={open} onClose={() => setOpen(false)} authReady authKey="account" workspace={workspace}
          activeSceneId={null} flushScenePending={noop} patchSceneById={() => false}
          prepareCanvasGenerationBatch={async () => []} settleCanvasGeneration={noop} discardCanvasGeneration={noop} />
      </>;
    }
    act(() => root.render(<Screen />));
    expect([...host.querySelectorAll("header button")].some((button) => button.textContent === "AI 연결")).toBe(false);
    const avatar = host.querySelector<HTMLElement>(".acct-avatar-btn")!;
    press(avatar);
    await settle();
    const settings = [...document.querySelectorAll<HTMLButtonElement>(".acct-pop button")].find((item) => item.textContent?.includes("Setting"))!;
    expect(settings).toBeDefined();
    press(settings); await settle();
    const mcp = [...document.querySelectorAll<HTMLButtonElement>(".settings-float button")].find((item) => item.textContent === "AI·MCP 연결 열기")!;
    expect(mcp).toBeDefined();
    press(mcp); await settle();
    expect(onOpenMcp).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".settings-float")).toBeNull();
    expect(document.querySelector(".acct-pop")).toBeNull();
    const dialog = document.querySelector<HTMLElement>(".mcp-dialog")!;
    expect(dialog.contains(active())).toBe(true);
    if (close === "Escape") key("Escape");
    else press(dialog.querySelector<HTMLElement>('button[aria-label="닫기"]')!);
    await settle();
    expect(document.querySelector(".mcp-dialog")).toBeNull();
    expect(active()).toBe(avatar);
  });

  it("inert 를 받으면 머리 전체가 inert 다(로고·탭·검색·Assets — Tab 으로 닿지 않는다). 풀면 다시 닿는다", () => {
    const bar = (inert: boolean) => (
      <TopBar filters={{ tab: "my" } as never} onTab={noop} onSearch={noop} onWorkspaceSwitched={noop}
        workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
        onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop} inert={inert} />
    );
    act(() => root.render(bar(true)));
    const header = host.querySelector<HTMLElement>(".topbar")!;
    expect(header.hasAttribute("inert")).toBe(true);
    for (const selector of [".brand", ".tabs button", ".assets-btn"]) expect(header.querySelector(selector)!.closest("[inert]")).toBe(header);
    act(() => root.render(bar(false)));
    expect(header.hasAttribute("inert")).toBe(false);
  });

  // 2026-10-12(조작 점검 10회차, Codex 검토): 검색어를 치고 0.3초 안에 **지금 켜진 탭**을 다시 누르면(필터 초기화) 예약해 둔 검색이
  //  초기화 뒤에 다시 걸렸다 — 탭이 안 바뀌어 검색칸이 그대로 남았다.
  it("검색어를 친 직후 켜진 탭을 다시 누르면 예약된 검색이 버려진다 — 초기화한 화면에 검색이 되살아나지 않는다", async () => {
    const onSearch = vi.fn();
    function Bar() {
      // 확정된 검색어가 없는 상태 — 초기화해도 검색 값(undefined)은 그대로라, 검색칸은 값의 변화로는 초기화를 알 수 없다(탭 누름으로 안다)
      const [filters, setFilters] = useState<{ tab: string; search?: string }>({ tab: "my" });
      return (
        <TopBar filters={filters as never} onTab={(tab) => setFilters({ tab })} onWorkspaceSwitched={noop}
          onSearch={(q) => { onSearch(q); setFilters((f) => ({ ...f, search: q })); }}
          workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
          onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop} />
      );
    }
    act(() => root.render(<Bar />));
    const input = () => host.querySelector<HTMLInputElement>(".topbar-search input")!;
    expect(input().value).toBe("");
    act(() => { // React 가 듣는 방식으로 입력칸의 값을 바꾼다
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "bar");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input().value).toBe("bar");
    act(() => { host.querySelector<HTMLButtonElement>(".tabs button.on")!.click(); }); // 켜진 탭을 다시 누른다 — 0.3초가 지나기 전
    expect(input().value).toBe("");
    await act(async () => { await new Promise((done) => setTimeout(done, 350)); });
    expect(onSearch).not.toHaveBeenCalled();
    expect(input().value).toBe("");
  });

  // 탭 누름이 아닌 바깥 초기화(Resolve 자동 따라가기가 필터를 갈아 끼움 등)도 같다 — 검색칸은 그대로 떠 있고 값만 밖에서 바뀐다.
  //  내 검색의 메아리(친 글이 0.3초 뒤 부모를 돌아옴)에는 손대지 않는다: 그사이 더 친 글자가 남는다.
  it("밖에서 검색어가 비워지면 예약된 검색을 버린다 — 내가 보낸 검색이 돌아온 것이면 그사이 더 친 글자를 덮지 않는다", async () => {
    const onSearch = vi.fn();
    let reset: () => void = noop;
    let follow: () => void = noop;
    function Bar() {
      const [filters, setFilters] = useState<{ tab: string; search?: string }>({ tab: "my", search: "foo" });
      const [followed, setFollowed] = useState(0);
      reset = () => setFilters({ tab: "my" });
      follow = () => { setFilters({ tab: "my" }); setFollowed((n) => n + 1); }; // 자동 따라가기: 필터를 갈아 끼우고 횟수를 올린다(useLibraryFilters.followLocation)
      return (
        <TopBar filters={filters as never} onTab={noop} onWorkspaceSwitched={noop} searchResetKey={followed}
          onSearch={(q) => { onSearch(q); setFilters((f) => ({ ...f, search: q })); }}
          workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
          onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop} />
      );
    }
    act(() => root.render(<Bar />));
    const input = () => host.querySelector<HTMLInputElement>(".topbar-search input")!;
    const type = (text: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    const wait = (ms: number) => act(async () => { await new Promise((done) => setTimeout(done, ms)); });

    type("bar");
    act(() => reset()); // 0.3초가 지나기 전에 밖에서 초기화됐다(탭은 누르지 않았다)
    expect(input().value).toBe("");
    await wait(350);
    expect(onSearch).not.toHaveBeenCalled();

    // 메아리: "ab " 를 치고 0.3초 뒤 부모가 "ab" 로 돌려줘도 끝의 빈칸이 남는다(이어 칠 수 있다)
    type("ab ");
    await wait(350);
    expect(onSearch).toHaveBeenLastCalledWith("ab");
    expect(input().value).toBe("ab ");

    // 확정된 검색어가 없는 채 첫 검색어를 치는 중에 자동 따라가기가 왔다 — 검색 값은 undefined → undefined 라 값으로는 알 수 없다.
    //  따라가기 횟수(searchResetKey)를 신호로 받아 예약을 버리고 입력을 비운다. 입력칸은 그대로다 — 따라가기는 사용자가 아무것도
    //  안 해도 오므로, 검색칸을 다시 올리면 치던 사람의 초점이 사라진다(Codex 코드 리뷰).
    act(() => reset());
    await wait(350);
    onSearch.mockClear();
    const box = input();
    box.focus();
    type("zz");
    act(() => follow());
    expect([input() === box, document.activeElement === box, input().value]).toEqual([true, true, ""]);
    await wait(350);
    expect(onSearch).not.toHaveBeenCalled();
    type("다시"); // 이어서 친 검색어는 평소대로 간다
    await wait(350);
    expect(onSearch).toHaveBeenLastCalledWith("다시");
  });
});

describe("StrictMode(개발 화면)", () => {
  it("폴더 등록 창: 경로 칸의 autoFocus 가 남는다 — 열자마자 치는 글자가 들어간다", async () => {
    act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
    focus("opener");
    act(() => root.render(<StrictMode>{page(<MountManager onClose={noop} onChanged={noop} />)}</StrictMode>));
    await settle();
    expect(active()).toBe(host.querySelector(".mount-input"));
    act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
    expect(active()).toBe(el("opener"));
  });
});

describe("카드의 확인 덮개(S)", () => {
  const yes = () => host.querySelector<HTMLElement>(".cs-final-yes")!;
  const no = () => host.querySelector<HTMLElement>(".cs-final-no")!;

  it("뜨면 No 에 초점 · Tab 은 Yes ↔ No 만 돈다 · 걷히면 연 단추로 돌아간다", () => {
    const view = (open: boolean) => page(open ? <GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={noop} onNo={noop} /> : null);
    act(() => root.render(view(false)));
    focus("opener");
    act(() => root.render(view(true)));
    expect(active()).toBe(no());
    expect(tab().defaultPrevented).toBe(true);
    expect(active()).toBe(yes());
    tab();
    expect(active()).toBe(no());
    tab(true);
    expect(active()).toBe(yes());
    expect(outside([...walk(40), ...walk(10, true)], host.querySelector<HTMLElement>(".cs-final-actions"))).toEqual([]);
    act(() => root.render(view(false)));
    expect(active()).toBe(el("opener"));
  });

  it("앱 루트와 같은 StrictMode(effect 가 두 번 돈다)에서도 걷히면 연 단추로 돌아간다", () => {
    const view = (open: boolean) => <StrictMode>{page(open ? <GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={noop} onNo={noop} /> : null)}</StrictMode>;
    act(() => root.render(view(false)));
    focus("opener");
    act(() => root.render(view(true)));
    expect(active()).toBe(no());
    act(() => root.render(view(false)));
    expect(active()).toBe(el("opener"));
  });

  it("덮개가 뜨는 사이 글 칸으로 옮겨 간 초점은 뺏지 않는다 — 적던 글이 끊기지 않는다", () => {
    const view = (open: boolean) => (
      <>
        <input id="typing" />
        {open && <GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={noop} onNo={noop} />}
      </>
    );
    act(() => root.render(view(false)));
    focus("typing"); // S 를 누른 뒤 덮개가 뜨기 전에(한 번·두 번 누름을 가르는 기다림) 프롬프트를 눌렀다
    act(() => root.render(view(true)));
    expect(active()).toBe(el("typing"));
    act(() => root.render(view(false)));
    expect(active()).toBe(el("typing"));
  });

  it("검토 메뉴(해제·공유·보류·최종 고르기): 뜨면 덮개에 초점 · Tab 은 켜진 항목들 안에서 돈다 · 고르면 No 에 초점 · 걷히면 연 단추로", () => {
    const allowed = { unshared: true, shared: true, held: false, final: true };
    const view = (open: boolean) => page(open ? <GenerationReviewOverlay state="shared" allowed={allowed} onAction={noop} onCancel={noop} /> : null);
    const option = (name: string) => host.querySelector<HTMLElement>(`.review-${name}`)!;
    act(() => root.render(view(false)));
    focus("opener");
    act(() => root.render(view(true)));
    expect(active()).toBe(host.querySelector(".review-panel")); // 첫 항목이 아니라 덮개 — 바로 누른 Enter 가 아무것도 고르지 않는다
    expect(tab().defaultPrevented).toBe(true);
    expect(active()).toBe(option("unshared"));
    tab();
    expect(active()).toBe(option("final")); // 꺼진 항목(보류)은 건너뛴다
    tab();
    expect(active()).toBe(option("unshared"));
    tab(true);
    expect(active()).toBe(option("final"));
    expect(outside([...walk(12), ...walk(4, true)], host.querySelector<HTMLElement>(".review-panel"))).toEqual([]);
    act(() => option("final").click()); // 고른다 → 확인 단계
    expect(active()).toBe(no());
    tab();
    expect(active()).toBe(yes());
    act(() => root.render(view(false)));
    expect(active()).toBe(el("opener")); // 확인 단계에서 닫혀도 연 단추로
  });

  it("검토 메뉴: 초점이 덮개에 있을 때 Shift+Tab 은 끝 항목으로 간다 · Space 는 놓인 항목의 것이다(격자까지 올라가지 않는다)", () => {
    const allowed = { unshared: true, shared: true, held: true, final: true };
    const seen = vi.fn();
    act(() => root.render(<div onKeyDown={seen}><GenerationReviewOverlay state="unshared" allowed={allowed} onAction={noop} onCancel={noop} /></div>));
    // 연 직후(초점은 덮개 — 누를 항목이 없다)의 Space: 격자의 스크롤 막기에도 닿지 않으니 여기서 기본 동작(뒤 목록 스크롤)을 막는다
    expect(active()).toBe(host.querySelector(".review-panel"));
    expect(key(" ").defaultPrevented).toBe(true);
    tab(true);
    expect(active()).toBe(host.querySelector(".review-final"));
    expect(key(" ").defaultPrevented).toBe(false); // 항목에 놓인 Space — 그 항목을 누르는 기본 동작은 살린다
    expect(seen.mock.calls.some(([event]) => event.key === " ")).toBe(false);
    key("Enter");
    expect(seen.mock.calls.some(([event]) => event.key === "Enter")).toBe(true); // 다른 키는 그대로 올라간다
  });

  it("Yes 가 꺼져 있으면 Tab 은 No 에 머문다", () => {
    act(() => root.render(page(<ConfirmQuestion question="q" onYes={noop} onNo={noop} yesDisabled />)));
    expect(active()).toBe(no());
    expect(tab().defaultPrevented).toBe(true);
    expect(active()).toBe(no());
  });

  it("걷히는 사이 다른 곳으로 간 초점은 뺏지 않는다(바깥을 눌러 닫음)", () => {
    const view = (open: boolean) => page(open ? <GenerationConfirmOverlay mode="share" shared isFinal={false} onYes={noop} onNo={noop} /> : null);
    act(() => root.render(view(false)));
    focus("opener");
    act(() => root.render(view(true)));
    focus("bar");
    act(() => root.render(view(false)));
    expect(active()).toBe(el("bar"));
  });

  it("격자의 카드에서: 마우스로 S 를 누르면 덮개의 No 에 초점이 가고, Space 는 그 단추의 것이다. 닫으면 S 로 돌아가되 '마우스로 누른 단추'로 남는다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => root.render(<GridScreen />));
    flushFrames();
    clickCard("g1");
    const s = cell("g1").querySelector<HTMLElement>(".card-sf")!;
    press(s);
    act(() => { vi.advanceTimersByTime(300); }); // 한 번 누름과 두 번 누름을 가르는 기다림
    expect(host.querySelector(".sconfirm")).not.toBeNull();
    expect(active()).toBe(no());
    // 격자는 위에 뜬 것이 있으면 Space 의 기본 동작을 막는다(뒤 목록 스크롤) — 덮개의 단추에서 난 Space 는 거기까지 가지 않는다
    expect(key(" ").defaultPrevented).toBe(false);
    expect(key("Enter").defaultPrevented).toBe(false);
    press(no());
    expect(host.querySelector(".sconfirm")).toBeNull();
    expect(active()).toBe(s);
    expect(focusCameByTab()).toBe(false);
    expect(key(" ").defaultPrevented).toBe(true); // 마우스로 눌러 남은 초점 — Space 는 격자의 것(S 를 또 누르지 않는다)
    act(() => { vi.advanceTimersByTime(300); });
    expect(host.querySelector(".sconfirm")).toBeNull();
  });
});

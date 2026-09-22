// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResolveProjectBrowser } from "../src/components/assets/ResolveProjectBrowser";
import { api } from "../src/api";
import { HttpError } from "../src/lib/http";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  open: vi.fn(),
  thumbnails: vi.fn(),
  launch: vi.fn(),
  launchState: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../src/api", () => ({
  api: {
    resolveLibraryProjects: mocks.list,
    openResolveLibraryConnectDialog: mocks.connect,
    openResolveLibraryProject: mocks.open,
    resolveLibraryThumbnails: mocks.thumbnails,
    launchResolve: mocks.launch,
    resolveLaunchState: mocks.launchState,
  },
}));

vi.mock("../src/lib/resolveTransfer", () => ({
  getResolveConnectionStatus: mocks.status,
}));

const READY_ELSEWHERE = {
  status: "no_project",
  connected: true,
  process_running: true,
  project_open: false,
  project_id: "",
  project_name: "",
  database_name: "FUSION",
  message: "",
};

let host: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); // 보기(리스트/카드)·정렬이 localStorage 에 남아 다음 시험에 새지 않게
  mocks.list.mockResolvedValue({
    library_name: "MVHub - 뻘뻘뻘",
    library_path: "Z:/PROJECT_MUDX/10_ai/@davinci",
    projects: [
      { name: "Mud_Ai", folder_path: "", mtime: 1_700_000_000, size: 100 },
      { name: "Episode 1", folder_path: "Episodes", mtime: 1_700_000_001, size: 200 },
    ],
  });
  mocks.connect.mockResolvedValue({ message: "Resolve 라이브러리를 연결했습니다." });
  mocks.thumbnails.mockResolvedValue({ thumbnails: {} });
  mocks.status.mockResolvedValue(READY_ELSEWHERE);
  mocks.launch.mockResolvedValue({ status: "starting" });
  mocks.launchState.mockResolvedValue({ running: true, window: true });
  mocks.open.mockResolvedValue({
    status: "complete",
    project_name: "Mud_Ai",
    already_open: false,
    message: "Mud_Ai 프로젝트를 열었습니다.",
    library_name: "MVHub - 뻘뻘뻘",
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("@davinci에서 폴더 대신 Resolve 프로젝트 카드를 보여 준다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(mocks.list).toHaveBeenCalledExactlyOnceWith("뻘뻘뻘", "@davinci");
  expect(host.querySelectorAll(".resolve-project-card")).toHaveLength(2);
  expect(host.textContent).toContain("Mud_Ai");
  expect(host.textContent).toContain("Episode 1");
  // 머리글 = 'DaVinci Resolve · 2'(Jay 2026-09-22)
  expect(host.querySelector(".resolve-project-heading strong")?.textContent).toBe("DaVinci Resolve");
  expect(host.querySelector(".rp-count")?.textContent).toBe("· 2");
  expect(host.textContent).not.toContain("Resolve Projects");
});

it("프로젝트 카드를 누르면 이름과 Resolve 폴더 경로를 그대로 전달한다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const card = [...host.querySelectorAll<HTMLButtonElement>(".resolve-project-card")]
    .find((button) => button.textContent?.includes("Episode 1"));

  await act(async () => card!.click());

  expect(api.openResolveLibraryProject).toHaveBeenCalledExactlyOnceWith(
    "뻘뻘뻘",
    "@davinci",
    "Episode 1",
    "Episodes",
    "", // Resolve 를 켜지 않았으니 켜기 번호도 없다
  );
  expect(host.textContent).toContain("Mud_Ai 프로젝트를 열었습니다.");
});

it("라이브러리 연결 버튼은 연결 API만 부르고, 끝나면 목록을 다시 읽은 뒤 결과 글을 남긴다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  // 목록이 있을 때 다시 연결은 사슬 아이콘 — 글자 대신 설명(aria-label·title)으로 이름을 댄다.
  const button = host.querySelector<HTMLButtonElement>('.rp-relink[aria-label="라이브러리 다시 연결"]');

  await act(async () => button!.click());
  await settle();

  expect(api.openResolveLibraryConnectDialog).toHaveBeenCalledExactlyOnceWith(
    "뻘뻘뻘",
    "@davinci",
  );
  expect(mocks.list).toHaveBeenCalledTimes(2);
  // 목록 읽기가 글을 지우므로, 글은 목록을 다 읽은 뒤에 남아 있어야 한다.
  expect(host.textContent).toContain("Resolve 라이브러리를 연결했습니다.");
});

it("프로젝트를 여는 동안 라이브러리 연결을 동시에 시작할 수 없다", async () => {
  let finishOpen: ((value: Awaited<ReturnType<typeof api.openResolveLibraryProject>>) => void) | undefined;
  mocks.open.mockReturnValue(new Promise((resolve) => { finishOpen = resolve; }));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => {
    host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click();
    await Promise.resolve();
  });

  expect(host.querySelector<HTMLButtonElement>(".rp-relink")!.disabled).toBe(true);
  expect([...host.querySelectorAll<HTMLButtonElement>(".resolve-project-card")]
    .every((button) => button.disabled)).toBe(true);
  expect(mocks.connect).not.toHaveBeenCalled();

  await act(async () => finishOpen!({
    status: "complete",
    project_name: "Mud_Ai",
    already_open: false,
    message: "열었습니다.",
    library_name: "MVHub - 뻘뻘뻘",
  }));
});

it("같은 화면의 늦은 목록 응답이 최신 목록을 덮어쓰지 않는다", async () => {
  const replies: Array<(value: Awaited<ReturnType<typeof api.resolveLibraryProjects>>) => void> = [];
  mocks.list.mockImplementation(() => new Promise((resolve) => { replies.push(resolve); }));
  act(() => root.render(
    <StrictMode><ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" /></StrictMode>,
  ));
  await settle();
  expect(replies).toHaveLength(2);

  await act(async () => replies[1]({
    library_name: "new",
    library_path: "new",
    projects: [{ name: "New Project", folder_path: "", mtime: 2, size: 2 }],
  }));
  await act(async () => replies[0]({
    library_name: "old",
    library_path: "old",
    projects: [{ name: "Old Project", folder_path: "", mtime: 1, size: 1 }],
  }));

  expect(host.textContent).toContain("New Project");
  expect(host.textContent).not.toContain("Old Project");
});

// ── 라이브러리가 아직 안 붙었을 때 ──

function emptyLibrary() {
  mocks.list.mockResolvedValue({
    library_name: "MVHub - 뻘뻘뻘",
    library_path: "Z:/PROJECT_MUDX/10_ai/@davinci",
    projects: [],
  });
}

it("열 수 있는 프로젝트가 없으면 연결 버튼이 머리글 대신 빈 자리 가운데로 내려온다", async () => {
  emptyLibrary();
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelector(".resolve-project-tools")).toBeNull();
  const button = host.querySelector<HTMLButtonElement>(
    ".resolve-project-empty .resolve-library-connect-button",
  );
  expect(button?.textContent).toBe("라이브러리 연결");
  expect(host.textContent).toContain("Resolve 라이브러리가 아직 연결되지 않았습니다");
});

it("목록을 읽지 못한 이유는 머리글이 아니라 연결 버튼 바로 위에 붙는다", async () => {
  mocks.list.mockRejectedValue(new Error("Resolve Projects 아래에서 사용자 프로젝트 폴더를 찾지 못했습니다."));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelector(".resolve-project-empty .rpe-lead")?.textContent)
    .toContain("사용자 프로젝트 폴더를 찾지 못했습니다");
  expect(host.querySelector(".resolve-project-heading")?.textContent)
    .not.toContain("찾지 못했습니다");
});

it("연결이 끝나면 '다시 확인' 없이 바로 목록이 나온다", async () => {
  emptyLibrary();
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  expect(mocks.list).toHaveBeenCalledTimes(1);
  // 연결 뒤 두 번째 읽기에서는 프로젝트가 보인다.
  mocks.list.mockResolvedValueOnce({
    library_name: "MVHub - 뻘뻘뻘",
    library_path: "Z:/PROJECT_MUDX/10_ai/@davinci",
    projects: [{ name: "Mud_Ai", folder_path: "", mtime: 1_700_000_000, size: 1 }],
  });

  const connect = host.querySelector<HTMLButtonElement>(".resolve-library-connect-button")!;
  await act(async () => connect.click());
  await settle();

  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("다시 확인");
  expect(host.querySelectorAll(".resolve-project-card")).toHaveLength(1);
});

it("연결이 실패하면 목록을 다시 읽지 않고 이유를 가운데 보여 준다", async () => {
  emptyLibrary();
  // 실제 jsonFetch 와 같은 모양(src/lib/http.ts) — 문자열로 바꾸면 "HttpError: 400: …".
  const detail = "DaVinci Resolve가 실행 중이지 않습니다. 먼저 Resolve를 켜세요.";
  mocks.connect.mockRejectedValueOnce(new HttpError(400, `400: ${detail}`, detail));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-library-connect-button")!.click());
  await settle();

  expect(mocks.list).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".rpe-lead")?.textContent)
    .toBe("DaVinci Resolve가 실행 중이지 않습니다. 먼저 Resolve를 켜세요.");
  expect(host.querySelector(".resolve-library-connect-button")!.textContent).toBe("라이브러리 연결");
});

// ── 보기(리스트/카드)와 정렬 ──

it("리스트/카드 전환은 화면을 바꾸고 다음에도 기억된다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  expect(host.querySelector(".resolve-project-grid")).not.toBeNull();

  const listButton = host.querySelector<HTMLButtonElement>(".layout-toggle button")!;
  await act(async () => listButton.click());

  expect(host.querySelector(".resolve-project-list")).not.toBeNull();
  expect(host.querySelector(".resolve-project-grid")).toBeNull();
  expect(localStorage.getItem("ch.resolve.layout")).toBe("list");
});

it("정렬 기준을 바꾸면 카드 순서가 따라 바뀐다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const names = () => [...host.querySelectorAll(".resolve-project-copy strong")]
    .map((el) => el.textContent);
  // 고른 항목 앞에는 ● 가 붙는다 — 이름만 떼어 본다.
  const menu = () => [...host.querySelectorAll<HTMLButtonElement>(".asort-item")]
    .map((el) => ({ el, label: (el.textContent ?? "").replace("●", "") }));
  expect(names()).toEqual(["Episode 1", "Mud_Ai"]); // 기본값 = 날짜 내림차순

  await act(async () => host.querySelector<HTMLButtonElement>(".asort-btn")!.click());
  // Resolve Project Manager 정렬 메뉴와 같은 다섯 항목(에셋 메뉴의 '유형'은 없다).
  expect(menu().map((m) => m.label)).toEqual([
    "이름", "수정 날짜", "타임라인 수", "해상도", "프레임 레이트", "오름차순", "내림차순",
  ]);

  await act(async () => menu().find((m) => m.label === "이름")!.el.click());
  expect(names()).toEqual(["Mud_Ai", "Episode 1"]); // 이름 내림차순

  await act(async () => menu().find((m) => m.label === "오름차순")!.el.click());
  expect(names()).toEqual(["Episode 1", "Mud_Ai"]);
  expect(localStorage.getItem("ch.resolve.sortField")).toBe("name");
  expect(localStorage.getItem("ch.resolve.sortDir")).toBe("asc");
});

it("머리글은 에셋 툴바와 같은 CSS 를 받고, 같은 단추는 같은 자리(크기·보기·정렬), 사슬·ⓘ 는 그 왼쪽 묶음이다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelector(".resolve-project-header")?.classList.contains("assets-crumb")).toBe(true);
  expect(host.querySelector(".resolve-project-tools")?.classList.contains("assets-tools")).toBe(true);
  const tools = [...host.querySelectorAll(".resolve-project-tools > *")].map((el) => el.className);
  expect(tools).toEqual(["rp-pair", "size-slider", "layout-toggle", "asset-sort"]); // 에셋 툴바와 같은 순서
  const pair = [...host.querySelectorAll(".rp-pair > *")].map((el) => el.className);
  expect(pair).toEqual([
    "af-btn rp-icon-btn rp-relink",
    "af-btn rp-icon-btn rp-info on", // ⓘ 는 다시 연결 오른쪽, 기본으로 켜져 있다
  ]);
  expect(host.textContent).not.toContain("라이브러리 다시 연결"); // 글자 단추는 없어졌다
});

it("켜져 있는 보기를 한 번 더 누르면 날짜로 나눠 보여 준다", async () => {
  mocks.list.mockResolvedValue({
    library_name: "MVHub - 뻘뻘뻘",
    library_path: "Z:/PROJECT_MUDX/10_ai/@davinci",
    projects: [
      { name: "Today_A", folder_path: "", mtime: 1_758_400_000, size: 1 },
      { name: "Today_B", folder_path: "", mtime: 1_758_390_000, size: 1 },
      { name: "Older", folder_path: "", mtime: 1_757_000_000, size: 1 },
    ],
  });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const grid = () => host.querySelector<HTMLButtonElement>(".layout-toggle button:last-child")!;
  expect(grid().className).toBe("on"); // 기본값이 카드형
  expect(host.querySelectorAll(".gen-date-header")).toHaveLength(0);

  await act(async () => grid().click()); // 켜져 있는 쪽을 한 번 더 → 날짜로 나누기

  const headers = [...host.querySelectorAll(".gen-date-header")];
  expect(headers).toHaveLength(2);
  expect(host.querySelectorAll(".resolve-project-grid")).toHaveLength(2);
  expect(grid().className).toContain("grouped");
  expect(localStorage.getItem("ch.resolve.groupByDate")).toBe("1");

  await act(async () => grid().click()); // 한 번 더 → 원래대로
  expect(host.querySelectorAll(".gen-date-header")).toHaveLength(0);
  expect(localStorage.getItem("ch.resolve.groupByDate")).toBe("0");
});

it("그림을 못 받은 카드는 DaVinci Resolve 아이콘을 자리표시로 쓴다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  const badge = host.querySelector<HTMLImageElement>(".rp-thumb .rp-placeholder")!;
  expect(badge.tagName).toBe("IMG");
  expect(badge.getAttribute("src")).toContain("davinci-resolve");
  expect(host.textContent).not.toContain("DR");
  expect(host.textContent).not.toContain("열기"); // Resolve 처럼 글자 없이 카드 자체를 누른다
});

// ── 대표 그림 · 넘겨 보기 (Resolve Project Manager 와 같은 방식, Jay 2026-09-22) ──

const FRAMES = { "/Mud_Ai": ["AAA", "BBB", "CCC", "DDD"] };
const imgOf = (name: string) => [...host.querySelectorAll(".resolve-project-card")]
  .find((card) => card.textContent?.includes(name))!
  .querySelector<HTMLImageElement>(".rp-thumb img")!;

function hoverAt(thumb: Element, fraction: number) {
  Object.defineProperty(thumb, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 100, top: 0, width: 200, height: 112, right: 300, bottom: 112, x: 100, y: 0 }),
  });
  thumb.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100 + 200 * fraction }));
}

it("목록 뒤에 Resolve 가 저장한 첫 그림을 카드에 싣는다", async () => {
  mocks.thumbnails.mockResolvedValue({ thumbnails: FRAMES });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(mocks.thumbnails).toHaveBeenCalledExactlyOnceWith("뻘뻘뻘", "@davinci");
  expect(imgOf("Mud_Ai").getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  expect(imgOf("Episode 1").classList.contains("rp-placeholder")).toBe(true);
});

it("그림 위에서 마우스를 옮기면 그 자리의 그림으로 넘어가고 세로선이 따라온다", async () => {
  mocks.thumbnails.mockResolvedValue({ thumbnails: FRAMES });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const thumb = imgOf("Mud_Ai").parentElement!;

  await act(async () => hoverAt(thumb, 0.6)); // 4장 중 60% 지점 → 세 번째

  expect(imgOf("Mud_Ai").getAttribute("src")).toBe("data:image/jpeg;base64,CCC");
  const line = thumb.querySelector<HTMLElement>(".rp-scrub")!;
  expect(line.style.left).toBe("60%");
  expect(host.querySelectorAll(".ticks")).toHaveLength(0); // 아래 눈금은 쓰지 않는다

  await act(async () => thumb.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  expect(imgOf("Mud_Ai").getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  expect(thumb.querySelector(".rp-scrub")).toBeNull();
});

it("그림이 한 장뿐이면 넘겨 볼 게 없어 세로선도 없다", async () => {
  mocks.thumbnails.mockResolvedValue({ thumbnails: { "/Mud_Ai": ["ONLY"] } });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const thumb = imgOf("Mud_Ai").parentElement!;

  await act(async () => hoverAt(thumb, 0.9));

  expect(thumb.querySelector(".rp-scrub")).toBeNull();
  expect(imgOf("Mud_Ai").getAttribute("src")).toBe("data:image/jpeg;base64,ONLY");
});

// ── Resolve 상태 ──

const READY_HERE = {
  ...READY_ELSEWHERE,
  status: "ready",
  project_open: true,
  project_name: "Mud_Ai",
  database_name: "MVHub - 뻘뻘뻘",
};

it("Resolve 가 이 라이브러리의 프로젝트를 열고 있으면 그 카드에 '열려 있음'을 붙이되, 누르면 여전히 서버로 보낸다", async () => {
  mocks.status.mockResolvedValue(READY_HERE);
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  const card = [...host.querySelectorAll<HTMLButtonElement>(".resolve-project-card")]
    .find((button) => button.textContent?.includes("Mud_Ai"))!;
  expect(card.classList.contains("is-open")).toBe(true);
  expect(card.textContent).toContain("열려 있음");
  // 칩 글자는 'Resolve' 하나, 상태는 색(on) — 풀어 쓴 말은 설명으로(Jay 2026-09-22, Codex P1 접근성).
  const chip = host.querySelector(".rp-status.on")!;
  expect(chip.textContent).toBe("Resolve");
  expect(chip.getAttribute("aria-label")).toBe("Resolve 연결됨 · 지금 열린 프로젝트 Mud_Ai");
  expect(chip.getAttribute("title")).toBe(chip.getAttribute("aria-label"));

  await act(async () => card.click());
  expect(mocks.open).toHaveBeenCalledTimes(1); // 상태가 낡았을 수 있다 — 막지 않는다(Codex P1)
});

it("다른 라이브러리의 같은 이름 프로젝트는 '열려 있음'으로 보지 않는다", async () => {
  mocks.status.mockResolvedValue({ ...READY_HERE, database_name: "FUSION" });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelectorAll(".resolve-project-card.is-open")).toHaveLength(0);
  expect(host.querySelector(".rp-status.warn")?.getAttribute("aria-label")).toContain("다른 라이브러리(FUSION)의");
});

it("라이브러리 이름을 알 수 없는 구버전 서버면 '열려 있음'을 붙이지 않는다", async () => {
  const { database_name: _unused, ...legacy } = READY_HERE;
  mocks.status.mockResolvedValue(legacy);
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelectorAll(".resolve-project-card.is-open")).toHaveLength(0);
  const chip = host.querySelector(".rp-status")?.getAttribute("aria-label") ?? "";
  expect(chip).not.toContain("다른 라이브러리");
  expect(chip).not.toContain("지금 열린"); // 이 라이브러리인지도 모른다(Codex P2)
  expect(chip).toContain("라이브러리 확인 불가");
});

it("Resolve 를 켜는 동안에는 창으로 돌아와도 상태를 묻지 않는다(Codex P1)", async () => {
  mocks.open.mockRejectedValueOnce(notReady());
  let windowUp: ((value: { running: boolean; window: boolean }) => void) | undefined;
  mocks.launchState.mockReturnValueOnce(new Promise((resolve) => { windowUp = resolve; }));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();
  const before = mocks.status.mock.calls.length;

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.status.mock.calls.length).toBe(before); // 켜지는 중인 Resolve 와 겹치지 않게

  await act(async () => windowUp!({ running: true, window: true }));
  await settle();
  expect(mocks.status.mock.calls.length).toBeGreaterThan(before); // 끝나면 한 번 묻는다
});

it("Resolve 가 꺼져 있으면 칩이 '누르면 켜고 엽니다'라고 알린다", async () => {
  mocks.status.mockResolvedValue({ ...READY_ELSEWHERE, status: "not_running", process_running: false });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(host.querySelector(".rp-status.off")?.getAttribute("aria-label")).toBe("Resolve 꺼짐 — 누르면 켜고 엽니다");
});

// ── 이름 없는 빈 새 프로젝트 — 묻지 않고 바로 연다(Jay 2026-09-22, 실제 Resolve 로 확인) ──

it("Resolve 에 이름 없는 빈 새 프로젝트가 열려 있어도 묻지 않고 한 번에 연다", async () => {
  mocks.status.mockResolvedValue({ ...READY_HERE, project_name: "Untitled Project", project_id: "u1" });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  expect(host.querySelector(".rp-status")?.getAttribute("aria-label")).toBe("Resolve 켜짐 · 이름 없는 새 프로젝트");
  const card = [...host.querySelectorAll<HTMLButtonElement>(".resolve-project-card")]
    .find((button) => button.textContent?.includes("Episode 1"))!;

  await act(async () => card.click());
  await settle();

  expect(mocks.open).toHaveBeenCalledExactlyOnceWith("뻘뻘뻘", "@davinci", "Episode 1", "Episodes", "");
  expect(host.textContent).not.toContain("저장하지 않고 닫고"); // 확인 줄은 없다
  expect(host.textContent).toContain("Mud_Ai 프로젝트를 열었습니다.");
});

it("이름 없는 새 프로젝트에 작업이 들어 있으면 서버가 멈추고, 그 이유를 보여 준다", async () => {
  const reason = "Resolve 에 이름 없는 새 프로젝트가 열려 있고 작업이 들어 있습니다. Resolve 에서 이름을 붙여 저장한 뒤 다시 누르세요.";
  mocks.open.mockRejectedValueOnce(new HttpError(400, `400: ${reason}`, reason));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();

  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(host.querySelector(".rp-note")?.textContent).toBe(reason);
});

// ── Resolve 가 꺼져 있을 때 — 켜고 연다(서버는 켜고 바로 돌아오고, 기다림은 화면이 한다) ──

const notReady = () => new HttpError(503, "503: DaVinci Resolve가 실행 중이지 않습니다.", "DaVinci Resolve가 실행 중이지 않습니다.");

it("열기가 '준비 안 됨'(503)이면 Resolve 를 켜고 창이 뜨면 다시 연다", async () => {
  mocks.open.mockRejectedValueOnce(notReady());
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();

  expect(mocks.launch).toHaveBeenCalledTimes(1);
  expect(mocks.launchState).toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Mud_Ai 프로젝트를 열었습니다.");
});

it("400 같은 진짜 실패면 Resolve 를 켜지 않고 이유를 보여 준다", async () => {
  mocks.open.mockRejectedValueOnce(new HttpError(400, "400: 선택한 Resolve 프로젝트를 찾지 못했습니다.", "선택한 Resolve 프로젝트를 찾지 못했습니다."));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();

  expect(mocks.launch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("선택한 Resolve 프로젝트를 찾지 못했습니다.");
});

it("Resolve 를 켜는 동안 화면을 떠나면 늦게라도 열기를 보내지 않는다(Codex P1)", async () => {
  mocks.open.mockRejectedValueOnce(notReady());
  let windowUp: ((value: { running: boolean; window: boolean }) => void) | undefined;
  mocks.launchState.mockReturnValueOnce(new Promise((resolve) => { windowUp = resolve; }));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();
  expect(host.querySelector(".rp-busy")?.textContent).toBe("Resolve 켜는 중…");

  act(() => root.unmount());
  await act(async () => windowUp!({ running: true, window: true }));
  await settle();

  expect(mocks.open).toHaveBeenCalledTimes(1); // 첫 시도뿐
  root = createRoot(host); // afterEach 의 unmount 가 두 번 불리지 않게
});

it("Resolve 를 켰으면 서버가 준 켜기 번호를 붙여 다시 연다 — 켜는 동안엔 그 열기만 Resolve 에 닿는다", async () => {
  mocks.open.mockRejectedValueOnce(notReady());
  mocks.launch.mockResolvedValueOnce({ status: "starting", launch_id: "L1" });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();

  expect(mocks.open.mock.calls.map((call) => call[4])).toEqual(["", "L1"]);
  expect(host.textContent).toContain("Mud_Ai 프로젝트를 열었습니다.");
});

it("서버가 켜는 중(starting)이라고 하면 칩이 '켜는 중'을 보여 준다(서버 켜기 창)", async () => {
  mocks.status.mockResolvedValue({
    ...READY_ELSEWHERE,
    status: "starting",
    connected: false,
    database_name: undefined,
    message: "DaVinci Resolve 를 켜는 중입니다. 잠시 뒤 다시 시도하세요.",
  });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  const chip = host.querySelector(".rp-status");
  expect(chip?.classList.contains("warn")).toBe(true);
  expect(chip?.getAttribute("aria-label")).toBe("Resolve 켜는 중…");
});

// ── 크기 막대 · 정렬 5항목 · ⓘ 정보 (Resolve Project Manager 와 같게, Jay 2026-09-22) ──

const DETAILS = {
  "/Mud_Ai": { timelines: 2, width: 1920, height: 1080, fps: 24 },
  "Episodes/Episode 1": { timelines: 7 }, // 타임라인마다 해상도가 달라 비워 둔 프로젝트
};
const copyOf = (name: string) => [...host.querySelectorAll(".resolve-project-card")]
  .find((card) => card.querySelector("strong")?.textContent === name)!
  .querySelector(".resolve-project-copy")!;

it("ⓘ 정보가 켜져 있으면 이름 아래 '해상도 · 타임라인 수'와 수정 날짜가, 끄면 이름만 보인다", async () => {
  mocks.thumbnails.mockResolvedValue({ thumbnails: {}, details: DETAILS });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  expect(copyOf("Mud_Ai").querySelector(".rp-format")?.textContent).toBe("1920 x 1080 · 타임라인 2개");
  expect(copyOf("Mud_Ai").querySelector(".rp-date")?.textContent).toMatch(/^수정 /);
  // 해상도를 모르면 지어내지 않고 아는 것만.
  expect(copyOf("Episode 1").querySelector(".rp-format")?.textContent).toBe("타임라인 7개");
  expect(copyOf("Episode 1").querySelector(".rp-date")?.textContent).toMatch(/^Episodes · 수정 /);

  await act(async () => host.querySelector<HTMLButtonElement>(".rp-info")!.click());

  expect(host.querySelector(".rp-info")?.getAttribute("aria-pressed")).toBe("false");
  expect(copyOf("Mud_Ai").textContent).toBe("Mud_Ai");
  expect(localStorage.getItem("ch.resolve.info")).toBe("0");
});

it("목록을 다시 읽으면 새 그림·정보가 오기 전에 옛 것을 비운다(Codex P1)", async () => {
  mocks.thumbnails.mockResolvedValueOnce({ thumbnails: FRAMES, details: DETAILS });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  expect(host.querySelectorAll(".rp-format")).toHaveLength(2);

  mocks.thumbnails.mockReturnValueOnce(new Promise(() => undefined)); // 두 번째 응답은 오지 않는다
  await act(async () => host.querySelector<HTMLButtonElement>(".rp-relink")!.click()); // 다시 연결 → 목록 다시 읽기
  await settle();

  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll(".rp-format")).toHaveLength(0);
  expect(imgOf("Mud_Ai").classList.contains("rp-placeholder")).toBe(true);
});

it("타임라인 수·해상도·프레임 레이트로 정렬하고, 정보가 없는 프로젝트는 방향과 무관하게 뒤로 간다", async () => {
  mocks.list.mockResolvedValue({
    library_name: "MVHub - 뻘뻘뻘",
    library_path: "Z:/PROJECT_MUDX/10_ai/@davinci",
    projects: [
      { name: "HD", folder_path: "", mtime: 3, size: 1 },
      { name: "UHD", folder_path: "", mtime: 2, size: 1 },
      { name: "Unknown", folder_path: "", mtime: 1, size: 1 },
    ],
  });
  mocks.thumbnails.mockResolvedValue({
    thumbnails: {},
    details: {
      "/HD": { timelines: 5, width: 1920, height: 1080, fps: 30 },
      "/UHD": { timelines: 1, width: 3840, height: 2160, fps: 23.976 },
    },
  });
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const names = () => [...host.querySelectorAll(".resolve-project-copy strong")].map((el) => el.textContent);
  const pick = async (label: string) => {
    // 메뉴 안을 눌러도 메뉴는 열린 채다(기준·방향을 한 번에 고르게) — 닫혀 있을 때만 연다.
    if (!host.querySelector(".asort-menu")) {
      await act(async () => host.querySelector<HTMLButtonElement>(".asort-btn")!.click());
    }
    const item = [...host.querySelectorAll<HTMLButtonElement>(".asort-item")]
      .find((el) => (el.textContent ?? "").replace("●", "") === label)!;
    await act(async () => item.click());
  };

  await pick("타임라인 수"); // 기본 방향 = 내림차순
  expect(names()).toEqual(["HD", "UHD", "Unknown"]);
  await pick("해상도");
  expect(names()).toEqual(["UHD", "HD", "Unknown"]);
  await pick("프레임 레이트");
  expect(names()).toEqual(["HD", "UHD", "Unknown"]);
  await pick("오름차순");
  expect(names()).toEqual(["UHD", "HD", "Unknown"]); // 모르는 건 여전히 끝
  expect(localStorage.getItem("ch.resolve.sortField")).toBe("fps");
});

it("크기 막대는 카드 크기 배율을 바꾸고 다음에도 기억된다", async () => {
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();
  const body = () => host.querySelector<HTMLElement>(".resolve-project-body")!;
  expect(body().style.getPropertyValue("--rp-scale")).toBe("1");

  const slider = host.querySelector<HTMLInputElement>(".size-slider input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(slider, "1.5");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(body().style.getPropertyValue("--rp-scale")).toBe("1.5");
  expect(localStorage.getItem("ch.resolve.scale")).toBe("1.5");
});

it("이미 켜진 Resolve 가 다른 작업 중이라 기다리면 '켜는 중'이 아니라 '기다리는 중'이라고 한다", async () => {
  mocks.open.mockRejectedValueOnce(new HttpError(503, "503: 다른 작업이 진행 중입니다.", "다른 작업이 진행 중입니다."));
  mocks.launch.mockResolvedValueOnce({ status: "running" });
  let windowUp: ((value: { running: boolean; window: boolean }) => void) | undefined;
  mocks.launchState.mockReturnValueOnce(new Promise((resolve) => { windowUp = resolve; }));
  act(() => root.render(<ResolveProjectBrowser project="뻘뻘뻘" dir="@davinci" />));
  await settle();

  await act(async () => host.querySelector<HTMLButtonElement>(".resolve-project-card")!.click());
  await settle();
  expect(host.querySelector(".rp-busy")?.textContent).toBe("기다리는 중…");

  await act(async () => windowUp!({ running: true, window: true }));
  await settle();
  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Mud_Ai 프로젝트를 열었습니다.");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardView } from "../src/components/manage/KanbanBoard";
import { TableView } from "../src/components/manage/TableView";
import { CalendarView } from "../src/components/manage/CalendarView";
import { CutThumbs } from "../src/components/manage/CutThumbs";
import { newDescDraftStore, statusColor, statusLabel, workActivityStatusLabel, type Task, type WorkViewProps } from "../src/components/manage/types";
import { setLang } from "../src/lib/i18n";

vi.mock("../src/components/MediaThumbnail", () => ({
  MediaThumbnail: ({ thumb }: { thumb?: string }) => <img src={thumb} />,
}));

let host: HTMLDivElement;
let root: Root;
const task: Task = {
  id: "task", project_id: "project", name: "episode", sequence: "cut", status: "hold",
  created_at: "2026-09-17", derived_start: "2026-09-17", derived_due: "2026-09-17",
  cuts: [{ id: "held", status: "done", shared: true, is_held: true, thumb: "/held",
    creator_uid: "me", creator_name: "Me", created_at: "2026-09-17" }],
};
const props: WorkViewProps = {
  tasks: [task], seqOptions: [], thumb: (path) => path || undefined, disabled: new Set(),
  onPatch: vi.fn(), onDelete: vi.fn(), onLinkGen: vi.fn(), onUnlinkGen: vi.fn(),
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 17));
  setLang("ko");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it("shows the hold column between generation and sharing without hiding other table statuses", () => {
  act(() => root.render(<BoardView {...props} />));
  const headers = [...host.querySelectorAll(".kanban-col-head")].map((node) => node.textContent);
  expect(headers).toEqual(["생성 0", "보류 1", "공유 0", "완료 0"]);
  expect(host.querySelectorAll(".kanban-col")[1].textContent).toContain("episode");
  act(() => root.render(<TableView {...props} tasks={[task,
    { ...task, id: "not-started", status: "not_started", cuts: [] },
    { ...task, id: "omit", status: "omit", cuts: [] },
  ]} />));
  expect([...host.querySelectorAll(".work-status-badge")].map((node) => node.textContent))
    .toEqual(["보류", "시작 전", "생략"]);
  expect(statusColor("hold")).toBe("#c9384a");
});

it("uses a red-S badge for valid held cuts without adding a held border class", () => {
  const cuts = [task.cuts![0],
    { ...task.cuts![0], id: "final", is_final: true },
    { ...task.cuts![0], id: "private", shared: false },
  ];
  act(() => root.render(<CutThumbs task={{ ...task, cuts }} thumb={props.thumb} onUnlinkGen={props.onUnlinkGen} />));
  const badges = [...host.querySelectorAll(".work-cut-badge")];
  expect(badges.map((node) => node.textContent)).toEqual(["S", "★"]);
  expect(badges[0].className).toBe("work-cut-badge held");
  expect(badges[0].getAttribute("title")).toBe("보류");
  expect(badges[0].parentElement?.className).toBe("work-cut shared");
  expect(host.querySelectorAll(".work-cut.held")).toHaveLength(0);
});

it("shows hold in monthly status and creator-day cut badges", () => {
  act(() => root.render(<CalendarView {...props} />));
  expect(host.querySelector(".mcal-bar")?.getAttribute("title")).toContain("상태: 보류");
  act(() => [...host.querySelectorAll("button")].find((node) => node.textContent === "생성자별")?.click());
  expect(host.querySelector(".work-cut-badge.held")?.textContent).toBe("S");
  expect(host.querySelector(".work-cut-badge.held")?.getAttribute("title")).toBe("보류");
});

it("keeps activity labels consistently Korean while translating status definitions and cut tooltips", () => {
  setLang("en");
  expect(statusLabel("hold")).toBe("On hold");
  expect(["in_progress", "hold", "publish", "done"].map(workActivityStatusLabel))
    .toEqual(["생성", "보류", "공유", "완료"]);
  act(() => root.render(<BoardView {...props} />));
  expect([...host.querySelectorAll(".kanban-col-head")].map((node) => node.textContent))
    .toEqual(["생성 0", "보류 1", "공유 0", "완료 0"]);
  act(() => root.render(<CutThumbs task={task} thumb={props.thumb} onUnlinkGen={props.onUnlinkGen} />));
  expect(host.querySelector(".work-cut-badge.held")?.getAttribute("title")).toBe("On hold");
});

// 폴더 자동 작업의 상태는 서버가 컷에서 파생한다(repo/manage_tasks.py) — 보드에서 끌기를 받아 주면 열이 강조되고 PATCH 까지 나가는데
// 카드는 제자리였다(2026-09-21 실측). 폴더 작업은 끌 수 없고 놓아도 저장하지 않는다. 수동(레거시) 작업의 끌기는 그대로다.
it("board ignores status drags for folder-derived tasks but keeps them for manual tasks", () => {
  const onPatch = vi.fn();
  const derived: Task = { ...task, id: "derived", folder_path: "ep001/c0010", status: "in_progress" };
  const manual: Task = { ...task, id: "manual", folder_path: null, status: "in_progress" };
  act(() => root.render(<BoardView {...props} onPatch={onPatch} tasks={[derived, manual]} />));
  const cards = [...host.querySelectorAll<HTMLElement>(".kanban-card")];
  expect(cards.map((card) => card.getAttribute("draggable"))).toEqual(["false", "true"]);
  expect(cards[0].title).toContain("자동");
  const target = host.querySelectorAll(".kanban-col")[2];
  const drop = (taskId: string) => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: { getData: () => taskId, types: [] } });
    act(() => { target.dispatchEvent(event); });
  };
  drop("derived");
  expect(onPatch).not.toHaveBeenCalled();
  drop("manual");
  expect(onPatch).toHaveBeenCalledExactlyOnceWith("manual", { status: "publish" });
});

it("설명 칸 — 치는 중에 목록이 새로 와도 친 글자를 지우지 않고, Esc 는 저장하지 않고 되돌린다", async () => {
  const onPatch = vi.fn();
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description }]} />));
  draw("처음");
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = (name: string) => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  act(() => input().focus());
  type("치는 중");
  draw("서버 값"); // 주기 조회가 새 목록을 가져왔다 — 전엔 칸을 통째로 다시 만들어 친 글자가 사라졌다
  expect(input().value).toBe("치는 중");
  expect(document.activeElement).toBe(input());
  press("Escape"); // 취소 — 저장하지 않고 서버 값으로
  expect(onPatch).not.toHaveBeenCalled();
  expect(input().value).toBe("서버 값");
  act(() => input().focus());
  type("새 설명");
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }); // 저장 결과까지 기다린다
  expect(onPatch).toHaveBeenCalledExactlyOnceWith("task", { description: "새 설명" }, "서버 값"); // 기준 = 처음 칠 때의 목록 글(50회차)
  // 초점만 두고 고치지 않은 칸은 남의 변경을 따라가고, 벗어날 때 옛 글을 저장하지 않는다(옛 초안이 남의 변경을 되돌렸다)
  onPatch.mockClear();
  draw("새 설명");
  act(() => input().focus());
  draw("남이 바꾼 값");
  expect(input().value).toBe("남이 바꾼 값");
  act(() => input().blur());
  expect(onPatch).not.toHaveBeenCalled();
});

it("설명 저장이 실패하면 친 글을 남기고 '저장 안 됨'을 표시한다 — 새 목록이 와도 지키고, [다시 저장]·다시 벗어남에 한 번 더 저장한다", async () => {
  let answer: (ok: boolean) => void = () => {};
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (ok: boolean) => act(async () => { answer(ok); await Promise.resolve(); await Promise.resolve(); });
  act(() => input().focus());
  type("색 보정 다시");
  act(() => input().blur());
  expect(onPatch).toHaveBeenCalledExactlyOnceWith("task", { description: "색 보정 다시" }, "원래 값");
  expect(host.querySelector(".work-desc-chip")).toBeNull(); // 아직 답이 안 왔다
  await settle(false); // 저장 실패
  expect(host.querySelector(".work-desc-chip")!.textContent).toBe("저장 안 됨");
  expect(input().value).toBe("색 보정 다시");
  draw("원래 값 "); // 복구 재조회가 새 목록을 가져와도 친 글을 지킨다
  expect(input().value).toBe("색 보정 다시");
  // [다시 저장] — 같은 글로 한 번 더, 성공하면 표시가 사라진다
  act(() => host.querySelector<HTMLButtonElement>(".work-desc-retry")!.click());
  expect(onPatch).toHaveBeenCalledTimes(2);
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "색 보정 다시" }, "원래 값");
  await settle(true);
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  // 다시 실패한 뒤 Esc = 그 글을 버리고 서버 값으로, 표시도 사라진다
  act(() => input().focus());
  type("또 고침");
  act(() => input().blur());
  await settle(false);
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  act(() => input().focus());
  act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(input().value).toBe("원래 값 ");
  expect(onPatch).toHaveBeenCalledTimes(3);
});

it("설명 저장의 응답을 기다리는 동안 새 목록이 와도 친 글을 지키고, 늦게 온 옛 저장의 결과는 지금 글에 적용하지 않는다", async () => {
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  const chip = () => host.querySelector(".work-desc-chip");
  // ① 응답을 기다리는 사이 복구 재조회가 먼저 온다 → 그다음 실패. 표시는 **친 글**에 붙어야 한다(서버 글에 붙으면 안 된다)
  act(() => input().focus());
  type("첫 글");
  act(() => input().blur());
  draw("원래 값 "); // 새 목록(같은 값이지만 새 객체)
  expect(input().value).toBe("첫 글");
  act(() => { input().focus(); input().blur(); }); // 같은 글의 저장이 가는 중이면 또 보내지 않는다
  expect(onPatch).toHaveBeenCalledTimes(1);
  await settle(0, false);
  expect(chip()).not.toBeNull();
  expect(input().value).toBe("첫 글");
  // ② 실패한 글을 고쳐 다시 저장하는 사이, 앞 저장(가는 중이던 것)의 늦은 실패가 와도 지금 글에는 적용하지 않는다
  act(() => input().focus());
  type("둘째 글");
  act(() => input().blur()); // 저장 2 출발
  act(() => input().focus());
  type("셋째 글"); // 저장 2 가 끝나기 전에 또 고쳤다
  await settle(1, true); // 저장 2 성공 — 옛 글의 결과라 표시·상태를 바꾸지 않는다
  expect(chip()).not.toBeNull();
  act(() => input().blur()); // 저장 3 출발('셋째 글' 은 아직 서버에 없다)
  expect(onPatch).toHaveBeenCalledTimes(3);
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "셋째 글" }, "둘째 글"); // 저장 2 가 성공했다 — 기준은 서버에 쓴 그 글
  await settle(2, true);
  expect(chip()).toBeNull();
  // ③ Esc 로 버린 뒤에 온 늦은 실패가 표시를 다시 켜지 않는다
  act(() => input().focus());
  type("버릴 글");
  act(() => input().blur()); // 저장 4 출발
  act(() => input().focus());
  act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle(3, false);
  expect(chip()).toBeNull();
  expect(input().value).toBe("원래 값 ");
});

it("설명 저장이 가는 중에 원래 글로 되돌려 벗어나면 그 글도 보낸다 — 마지막에 친 글이 앞 저장에 덮이지 않게", async () => {
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  act(() => input().focus());
  type("새 글");
  act(() => input().blur()); // 저장 1 출발(목록의 값은 아직 "원래 값")
  draw("원래 값"); // 그사이 목록이 새로 온다(같은 값, 새 객체) — 가는 중인 저장이 있으면 목록 값을 다시 믿지 않는다
  expect(input().value).toBe("새 글");
  act(() => input().focus());
  type("원래 값"); // 마음을 바꿔 원래 글로
  act(() => input().blur());
  expect(onPatch).toHaveBeenCalledTimes(2); // 목록의 값과 같아도 보낸다 — 안 보내면 저장 1 이 끝난 뒤 서버·화면이 "새 글"이 된다
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "원래 값" }, "원래 값"); // 저장 1 이 가는 중 — 잇기는 줄(WorkBoard)의 몫
  await settle(0, true);
  await settle(1, true);
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(input().value).toBe("원래 값");
  // 저장이 다 끝난 뒤 목록이 새로 오면 다시 목록 값을 믿는다 — 고쳤다가 서버 값으로 되돌린 글은 보내지 않는다(전과 같다)
  draw("원래 값");
  act(() => input().focus());
  type("잠깐");
  type("원래 값");
  await act(async () => { input().blur(); await Promise.resolve(); await Promise.resolve(); });
  expect(onPatch).toHaveBeenCalledTimes(2);
});

it("설명 저장이 성공한 직후, 목록이 따라오기 전에 원래 글로 되돌려 벗어나도 그 글을 보낸다 — 실패한 뒤에도 같다", async () => {
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description: "원래 값" }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  const chip = () => host.querySelector(".work-desc-chip");
  act(() => input().focus());
  type("새 글");
  act(() => input().blur()); // 저장 1 출발
  act(() => input().focus());
  type("원래 값"); // 응답을 기다리는 사이 원래 글로 — 아직 벗어나지 않았다
  await settle(0, true); // 저장 1 성공: 서버는 "새 글". 이 시험의 목록은 따라오지 않는다(성공 직후의 틈)
  act(() => input().blur());
  expect(onPatch).toHaveBeenCalledTimes(2); // 목록의 옛 값과 같다고 생략하면 서버·화면이 "새 글"로 남는다
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "원래 값" }, "새 글"); // 저장 1 이 성공했다 — 서버 글은 "새 글"
  await settle(1, true);
  expect(chip()).toBeNull();
  // 저장이 실패한 뒤에도 목록이 새로 오기 전에는 목록 값을 믿지 않는다 — 원래 글로 되돌리면 보내고, 성공하면 표시를 걷는다
  act(() => input().focus());
  type("실패할 글");
  act(() => input().blur()); // 저장 3
  await settle(2, false);
  expect(chip()).not.toBeNull();
  act(() => input().focus());
  type("원래 값");
  act(() => input().blur()); // 저장 4
  expect(onPatch).toHaveBeenCalledTimes(4);
  await settle(3, true);
  expect(chip()).toBeNull();
  expect(input().value).toBe("원래 값");
});

it("설명 저장의 성공 응답이 더 새 목록보다 늦게 와도, 그 뒤에 친 글은 목록의 값과 견준다(늦은 응답이 기준을 되돌리지 않는다)", async () => {
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  act(() => input().focus());
  type("내 글");
  act(() => input().blur()); // 저장 1 출발
  draw("남이 바꾼 값"); // 내 저장 뒤에 남이 바꾼 값이 목록으로 먼저 온다
  await settle(0, true); // 내 저장의 성공 응답은 그 뒤에 온다
  act(() => input().focus());
  act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(input().value).toBe("남이 바꾼 값"); // 지금 서버에 있는 글
  act(() => input().focus());
  type("내 글"); // 다시 내 글로
  act(() => input().blur());
  expect(onPatch).toHaveBeenCalledTimes(2); // 서버는 "남이 바꾼 값"이다 — 보내야 한다
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "내 글" }, "남이 바꾼 값");
});

it("저장에 실패한 설명 글은 표 밖에 적어 둔다 — 그 줄이 화면에서 빠졌다 돌아와도 글과 '저장 안 됨'이 남고, 저장되거나 Esc 로 버리면 지운다", async () => {
  const drafts = newDescDraftStore();
  let fail = true;
  const onPatch = vi.fn(async () => !fail);
  const draw = () => act(() => root.render(<TableView {...props} onPatch={onPatch} descDrafts={drafts} tasks={[{ ...task, description: "원래 값" }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const leave = () => act(async () => { input().blur(); await Promise.resolve(); await Promise.resolve(); });
  draw();
  act(() => input().focus());
  type("못 간 글");
  await leave();
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  expect(drafts.drafts.get("task")).toMatchObject({ text: "못 간 글", failed: true });
  // 표가 내려갔다 다시 뜬다(보드로 갔다 오거나 검색으로 줄이 빠졌다 돌아온 것과 같다)
  act(() => root.render(<div />));
  draw();
  expect(input().value).toBe("못 간 글");
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  // 다시 저장 → 성공하면 표시도, 적어 둔 것도 지운다
  fail = false;
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc-retry")!.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(onPatch).toHaveBeenLastCalledWith("task", { description: "못 간 글" }, "원래 값");
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(drafts.drafts.size).toBe(0);
  // 실패한 글을 Esc 로 버려도 지운다
  fail = true;
  act(() => input().focus());
  type("버릴 글");
  await leave();
  expect(drafts.drafts.get("task")).toMatchObject({ text: "버릴 글", failed: true });
  act(() => input().focus());
  act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(drafts.drafts.size).toBe(0);
  act(() => root.render(<div />));
  draw();
  expect(input().value).toBe("원래 값");
});

it("실패한 글을 고쳐 다시 보내는 사이 줄이 화면에서 빠졌다 돌아와도, 새 칸은 가장 최근 글을 보이고 옛 글로 새 저장을 덮지 않는다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const sentTexts: string[] = [];
  const onPatch = vi.fn((_id: string, patch: { description?: string }) => {
    sentTexts.push(patch.description ?? "");
    return new Promise<boolean>((resolve) => { answers.push(resolve); });
  });
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch as never} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  draw("원래 값");
  act(() => input().focus());
  type("A");
  act(() => input().blur());
  await settle(0, false); // A 실패
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
  act(() => input().focus());
  type("B");
  act(() => input().blur()); // B 가는 중
  act(() => root.render(<div />)); // 줄이 화면에서 빠졌다
  draw("원래 값"); // 돌아왔다 — 새 칸
  expect(input().value).toBe("B"); // 가장 최근 글(옛 A 가 아니다)
  await settle(1, true); // 떠난 칸의 B 가 성공했다
  expect(drafts.drafts.size).toBe(0);
  draw("B"); // 목록이 따라온다
  act(() => { input().focus(); });
  await act(async () => { input().blur(); await Promise.resolve(); await Promise.resolve(); });
  expect(sentTexts).toEqual(["A", "B"]); // A 를 다시 보내 B 를 덮지 않는다
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(input().value).toBe("B");
});

it("같은 작업의 칸 둘(본 줄·상세 줄)은 목록이 새로 올 때 서로 맞춘다 — 한쪽에서 실패한 글과 표시가 다른 쪽에도 뜨고, 저장되면 같이 걷힌다", async () => {
  const drafts = newDescDraftStore();
  let fail = true;
  const onPatch = vi.fn(async () => !fail);
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  act(() => { host.querySelector<HTMLElement>("[aria-controls]")!.click(); }); // 상세 줄을 편다 — 설명 칸이 둘이 된다
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>("input.work-cell-in[placeholder]")];
  expect(inputs()).toHaveLength(2);
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs()[0], value);
    inputs()[0].dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => inputs()[0].focus());
  type("못 간 글");
  await act(async () => { inputs()[0].blur(); await Promise.resolve(); await Promise.resolve(); });
  // 목록이 새로 오기를 기다리지 않는다 — 내용이 같은 목록은 줄 객체가 그대로라 칸이 다시 그려지지 않는다(격리 실측)
  expect(inputs().map((input) => input.value)).toEqual(["못 간 글", "못 간 글"]);
  expect(host.querySelectorAll(".work-desc-chip")).toHaveLength(2);
  fail = false;
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc-retry")!.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelectorAll(".work-desc-chip")).toHaveLength(0); // 표시는 바로 같이 걷힌다
  draw("못 간 글"); // 저장된 값으로 목록이 온다
  expect(host.querySelectorAll(".work-desc-chip")).toHaveLength(0);
  expect(inputs().map((input) => input.value)).toEqual(["못 간 글", "못 간 글"]);
  expect(onPatch).toHaveBeenCalledTimes(2); // 다른 쪽 칸이 따로 또 보내지 않는다
});

it("저장이 가는 중에 줄이 화면에서 빠졌다 돌아와도 친 글이 보이고, 옛 글의 늦은 실패가 더 새로 친 글의 보관을 건드리지 않는다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  draw("원래 값");
  act(() => input().focus());
  type("A");
  act(() => input().blur()); // A 가는 중(실패한 적은 없다)
  act(() => root.render(<div />));
  draw("원래 값");
  expect(input().value).toBe("A"); // 가는 중인 글이 새 칸에 보인다
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  act(() => input().focus());
  type("B"); // 새 칸에서 더 고쳤다(아직 벗어나지 않았다)
  await settle(0, false); // 떠난 칸의 A 가 뒤늦게 실패했다
  expect(drafts.drafts.get("task")).toMatchObject({ text: "B", failed: false }); // 보관함은 가장 최근 글 그대로
  draw("원래 값"); // 목록이 새로 와도
  expect(input().value).toBe("B");
});

it("가는 중에 새로 만들어진 칸은, 떠난 칸의 저장이 끝나면 그 글을 놓는다 — 그사이 남이 바꾼 값을 옛 글로 덮지 않는다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const sentTexts: string[] = [];
  const onPatch = vi.fn((_id: string, patch: { description?: string }) => {
    sentTexts.push(patch.description ?? "");
    return new Promise<boolean>((resolve) => { answers.push(resolve); });
  });
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch as never} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  draw("원래 값");
  act(() => input().focus());
  type("A");
  act(() => input().blur()); // A 가는 중(실패한 적 없음)
  act(() => root.render(<div />));
  draw("원래 값"); // 새 칸 — A 를 쥐고 있다
  expect(input().value).toBe("A");
  await settle(0, true); // 떠난 칸의 A 가 저장됐다
  draw("B"); // 그 뒤 남이 B 로 바꾼 값이 목록으로 온다
  expect(input().value).toBe("B"); // A 를 놓고 서버 값을 따른다
  act(() => { input().focus(); });
  await act(async () => { input().blur(); await Promise.resolve(); await Promise.resolve(); });
  expect(sentTexts).toEqual(["A"]); // A 를 다시 보내 B 를 덮지 않는다
});

it("같은 글자의 옛 저장이 뒤늦게 성공해도 새로 친 그 글의 보관을 지우지 않는다 — 응답의 주인은 편집 번호로 가린다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const sentTexts: string[] = [];
  const onPatch = vi.fn((_id: string, patch: { description?: string }) => {
    sentTexts.push(patch.description ?? "");
    return new Promise<boolean>((resolve) => { answers.push(resolve); });
  });
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch as never} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  draw("원래 값");
  act(() => input().focus());
  type("A");
  act(() => input().blur());
  await settle(0, false); // A 실패
  await act(async () => { host.querySelector<HTMLButtonElement>(".work-desc-retry")!.click(); }); // A 다시 저장 — 가는 중(1)
  act(() => input().focus());
  type("B");
  act(() => input().blur()); // B 가는 중(2)
  act(() => input().focus());
  type("A"); // 다시 A 로 — 아직 벗어나지 않았다
  await settle(1, true); // 앞의 A 가 성공
  await settle(2, true); // B 가 성공 — 서버는 B
  draw("B"); // 목록이 따라온다
  expect(input().value).toBe("A"); // 새로 친 A 를 쥐고 있다
  expect(drafts.drafts.get("task")).toMatchObject({ text: "A" });
  act(() => input().blur()); // 벗어나면 그 A 를 보낸다
  expect(sentTexts).toEqual(["A", "A", "B", "A"]);
});

it("가는 중에 새로 만들어진 칸은, 떠난 칸의 저장이 실패하면 다음 목록에서 '저장 안 됨'을 보인다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const onPatch = vi.fn(() => new Promise<boolean>((resolve) => { answers.push(resolve); }));
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  draw("원래 값");
  act(() => input().focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "A");
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => input().blur()); // A 가는 중
  act(() => root.render(<div />));
  draw("원래 값");
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  await act(async () => { answers[0](false); await Promise.resolve(); await Promise.resolve(); }); // 떠난 칸의 A 실패
  // 복구 조회가 와도 내용이 같으면 줄 객체가 그대로다 — 목록을 다시 넣지 않고도 표시가 붙어야 한다(격리 실측에서 42초가 지나도 안 붙었다)
  expect(input().value).toBe("A");
  expect(host.querySelector(".work-desc-chip")).not.toBeNull();
});

it("가는 중에 새로 만들어진 칸에서 원래 글로 되돌려 벗어나도 그 글을 보낸다 — 앞 칸이 보낸 저장을 새 칸도 안다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const sentTexts: string[] = [];
  const onPatch = vi.fn((_id: string, patch: { description?: string }) => {
    sentTexts.push(patch.description ?? "");
    return new Promise<boolean>((resolve) => { answers.push(resolve); });
  });
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch as never} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  const input = () => host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const settle = (index: number, ok: boolean) => act(async () => { answers[index](ok); await Promise.resolve(); await Promise.resolve(); });
  draw("원래 값");
  act(() => input().focus());
  type("A");
  act(() => input().blur()); // A 가는 중
  act(() => root.render(<div />));
  draw("원래 값"); // 새 칸
  act(() => input().focus());
  type("원래 값"); // 마음을 바꿔 원래 글로
  act(() => input().blur());
  expect(sentTexts).toEqual(["A", "원래 값"]); // 목록 값과 같아도 보낸다 — 안 보내면 A 가 반영돼 되돌린 글이 사라진다
  await settle(0, true);
  await settle(1, true);
  draw("원래 값");
  expect(input().value).toBe("원래 값");
  expect(host.querySelector(".work-desc-chip")).toBeNull();
  expect(drafts.drafts.size).toBe(0);
  // 다 끝나고 목록이 왔으니 다시 믿는다 — 고쳤다가 되돌린 글은 보내지 않는다
  act(() => input().focus());
  type("잠깐");
  type("원래 값");
  await act(async () => { input().blur(); await Promise.resolve(); await Promise.resolve(); });
  expect(sentTexts).toEqual(["A", "원래 값"]);
});

it("옛 글을 쥔 칸은 다시 보내지 않는다 — 같은 작업의 다른 칸이 그사이 고쳤으면, 목록이 오기 전에 벗어나도 그 글을 따른다", async () => {
  const drafts = newDescDraftStore();
  const answers: ((ok: boolean) => void)[] = [];
  const sentTexts: string[] = [];
  const onPatch = vi.fn((_id: string, patch: { description?: string }) => {
    sentTexts.push(patch.description ?? "");
    return new Promise<boolean>((resolve) => { answers.push(resolve); });
  });
  const draw = (description: string) => act(() => root.render(<TableView {...props} onPatch={onPatch as never} descDrafts={drafts} tasks={[{ ...task, description }]} />));
  draw("원래 값");
  act(() => { host.querySelector<HTMLElement>("[aria-controls]")!.click(); }); // 상세 줄을 편다 — 설명 칸이 둘
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>("input.work-cell-in[placeholder]")];
  const type = (index: number, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs()[index], value);
    inputs()[index].dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => inputs()[0].focus());
  type(0, "A");
  act(() => inputs()[0].blur());
  await act(async () => { answers[0](false); await Promise.resolve(); await Promise.resolve(); }); // A 실패 — 두 칸 모두 A 를 쥔다
  expect(inputs().map((input) => input.value)).toEqual(["A", "A"]);
  act(() => inputs()[0].focus());
  type(0, "B");
  act(() => inputs()[0].blur()); // 본 줄에서 B 로 고쳐 보냈다(가는 중) — 목록은 아직 안 왔다
  act(() => inputs()[1].focus());
  await act(async () => { inputs()[1].blur(); await Promise.resolve(); await Promise.resolve(); }); // 상세 줄(옛 A)에 초점을 줬다 벗어남
  expect(sentTexts).toEqual(["A", "B"]); // A 를 B 뒤에 다시 보내 덮지 않는다
  expect(inputs()[1].value).toBe("B"); // 가장 최근 글을 따른다
});

// 7회차(R30): 저장이 실패한 줄이 읽기 전용이 되면(예: 409 뒤의 복구 조회가 과거 공간 기록으로 가져온다) 입력칸도 [다시 저장]도 잠겨
// '저장 안 됨'을 걷을 길이 없었다.
it("잠긴 줄의 '저장 안 됨'은 [버리기]로 걷는다 — 다시 저장도 Esc 도 못 하는 칸에서 친 글과 표시를 지우고 서버 값을 보인다(상세 줄도 같이)", async () => {
  const drafts = newDescDraftStore();
  const onPatch = vi.fn(async () => false);
  const row: Task = { ...task, description: "원래 값" };
  const draw = (tasks: Task[]) => act(() => root.render(<TableView {...props} onPatch={onPatch} descDrafts={drafts} tasks={tasks} />));
  draw([row]);
  act(() => { host.querySelector<HTMLElement>("[aria-controls]")!.click(); }); // 상세 줄을 편다 — 설명 칸이 둘
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>("input.work-cell-in[placeholder]")];
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".work-desc-retry")];
  act(() => inputs()[0].focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs()[0], "못 간 글");
    inputs()[0].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { inputs()[0].blur(); await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelectorAll(".work-desc-chip")).toHaveLength(2);
  expect(buttons().map((button) => button.textContent)).toEqual(["다시 저장", "다시 저장"]); // 잠기지 않은 줄은 전과 같다
  draw([{ ...row, workspace_historical: true }]); // 복구 조회가 이 줄을 읽기 전용으로 가져왔다
  expect(inputs().map((input) => input.disabled)).toEqual([true, true]);
  expect(inputs().map((input) => input.value)).toEqual(["못 간 글", "못 간 글"]);
  expect(buttons().map((button) => button.textContent)).toEqual(["버리기", "버리기"]);
  expect(buttons().map((button) => button.disabled)).toEqual([false, false]);
  act(() => buttons()[0].click()); // 목록을 다시 넣지 않는다 — 다른 칸은 보관함의 알림만으로 풀려야 한다
  expect(host.querySelectorAll(".work-desc-chip")).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
  expect(inputs().map((input) => input.value)).toEqual(["원래 값", "원래 값"]);
  expect(drafts.drafts.size).toBe(0);
  expect(onPatch).toHaveBeenCalledTimes(1); // 버리기는 저장을 다시 보내지 않는다
  // 줄이 화면에서 빠졌다 돌아와도 버린 글은 돌아오지 않는다
  act(() => root.render(<div />));
  draw([{ ...row, workspace_historical: true }]);
  expect(host.querySelector<HTMLInputElement>("input.work-cell-in[placeholder]")!.value).toBe("원래 값");
  expect(host.querySelector(".work-desc-chip")).toBeNull();
});

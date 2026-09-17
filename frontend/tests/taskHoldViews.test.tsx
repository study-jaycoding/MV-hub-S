// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardView } from "../src/components/manage/KanbanBoard";
import { TableView } from "../src/components/manage/TableView";
import { CalendarView } from "../src/components/manage/CalendarView";
import { CutThumbs } from "../src/components/manage/CutThumbs";
import { statusColor, statusLabel, workActivityStatusLabel, type Task, type WorkViewProps } from "../src/components/manage/types";
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

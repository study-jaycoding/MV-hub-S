// @vitest-environment jsdom
import { act, StrictMode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAppNavigation } from "../src/lib/useAppNavigation";
import type { Filters, InfoTarget, PreviewTarget } from "../src/types";

let host: HTMLDivElement;
let root: Root;
let navigation: ReturnType<typeof useAppNavigation>;
let preview: PreviewTarget | null;
const targetA: PreviewTarget = { url: "/test-a.png", type: "image", name: "A", genId: "a" };
const targetB: PreviewTarget = { url: "/test-b.png", type: "image", name: "B", genId: "b" };

function Harness({ scope }: { scope?: string }) {
  const [filters, setFilters] = useState<Filters>({ tab: "team" });
  const [shown, setPreview] = useState<PreviewTarget | null>(null);
  const [, setCommentGenId] = useState<string | null>(null);
  const [, setAdminOpen] = useState(false);
  const [, setInfo] = useState<InfoTarget | null>(null);
  const [, setBoardFocusId] = useState<string | null>(null);
  const [, setBoardArrange] = useState(0);
  const lastBoardFocusRef = useRef<string | null>(null);
  navigation = useAppNavigation({ currentTab: filters.tab, lastBoardFocusRef,
    setPreview, setCommentGenId, setAdminOpen, setInfo, setBoardFocusId, setBoardArrange,
    setFilters, previewScopeKey: scope });
  preview = shown;
  return <div>{shown?.name || "none"}</div>;
}

function render(scope?: string) {
  act(() => root.render(<StrictMode><Harness scope={scope} /></StrictMode>));
}

function pop(state: unknown) {
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("공간 전환 뒤 뒤로가기는 옛 미리보기를 되살리지 않고 새 공간 기록은 보존", () => {
  render("team:a:auto");
  act(() => navigation.openPreview(targetA));
  const oldEntry = window.history.state;
  expect(preview).toEqual(targetA);

  render("team:b:auto");
  act(() => navigation.openPreview(targetB));
  const newEntry = window.history.state;
  expect(preview).toEqual(targetB);

  pop(oldEntry);
  expect(preview).toBeNull();
  expect(host.textContent).toBe("none");
  pop(newEntry);
  expect(preview).toEqual(targetB);
});

it("동일 공간 재렌더는 미리보기 기록을 무효화하지 않는다", () => {
  render("team:a:auto");
  act(() => navigation.openPreview(targetA));
  const entry = window.history.state;
  render("team:a:auto");
  act(() => navigation.navTab("my"));
  pop(entry);
  expect(preview).toEqual(targetA);
});

it("전체보기에서 자동 복귀해도 이전 범위 미리보기 기록을 차단", () => {
  render("team:a:all");
  act(() => navigation.openPreview(targetB));
  const entry = window.history.state;
  render("team:a:auto");
  pop(entry);
  expect(preview).toBeNull();
});

it("범위키가 없는 기존 호출자는 미리보기 뒤로가기 동작을 유지", () => {
  render();
  act(() => navigation.openPreview(targetA));
  const entry = window.history.state;
  render();
  act(() => navigation.navTab("my"));
  expect(preview).toBeNull();
  pop(entry);
  expect(preview).toEqual(targetA);
});

it("새로 고침 전의 기록으로 돌아가면 미리보기는 닫힌 채다 — 번호가 같은 지금 세션의 다른 미리보기가 뜨지 않는다", () => {
  // payload 번호는 페이지를 열 때마다 1 부터 다시 센다. 브라우저는 새로 고침 뒤에도 옛 기록의 state 를 보존하므로, 표식이 없으면
  // 옛 기록(번호 1)이 지금 세션의 번호 1(다른 그림)을 꺼냈다.
  render("team:a:auto");
  act(() => navigation.openPreview(targetB)); // 지금 세션의 번호 1
  const current = window.history.state as { chv: { key: number; sid?: string } };
  expect(current.chv.key).toBe(1);
  expect(current.chv.sid).toBeTruthy();
  pop({ chv: { tab: "team", focusId: null, ov: "preview", key: 1, sid: "before-reload" } }); // 새로 고침 전의 기록
  expect(preview).toBeNull();
  pop({ chv: { tab: "team", focusId: null, ov: "preview", key: 1 } }); // 표식이 없던 옛 판의 기록
  expect(preview).toBeNull();
  pop(current);
  expect(preview).toEqual(targetB);
});

// ── 보는 자리(폴더 위치)의 기록 — 2026-10-13 ②: 뒤로·앞으로 가기가 폴더 위치를 되살린다 ──
type Loc = { project_id?: string; folder_path?: string; ctx: string };
let restored: Loc[] = [];
let nav2: ReturnType<typeof useAppNavigation>;
function LocHarness({ loc, ctx = "ctx-a", ctxFor }: { loc: { project_id?: string; folder_path?: string }; ctx?: string; ctxFor?: (tab: Filters["tab"]) => string }) {
  const [filters, setFilters] = useState<Filters>({ tab: "team" });
  const [, setPreview] = useState<PreviewTarget | null>(null);
  const [, setCommentGenId] = useState<string | null>(null);
  const [, setAdminOpen] = useState(false);
  const [, setInfo] = useState<InfoTarget | null>(null);
  const [, setBoardFocusId] = useState<string | null>(null);
  const [, setBoardArrange] = useState(0);
  const lastBoardFocusRef = useRef<string | null>(null);
  nav2 = useAppNavigation({ currentTab: filters.tab, lastBoardFocusRef,
    setPreview, setCommentGenId, setAdminOpen, setInfo, setBoardFocusId, setBoardArrange, setFilters,
    currentLocation: { project_id: loc.project_id, folder_path: loc.folder_path, ctx },
    restoreLocation: (next) => restored.push(next), locationCtxFor: ctxFor });
  return <div>{filters.tab}</div>;
}
const stateLoc = () => (window.history.state as { chv: { loc?: Loc; ov?: string | null } }).chv;
const showLoc = (loc: { project_id?: string; folder_path?: string }, ctx?: string, ctxFor?: (tab: Filters["tab"]) => string) =>
  act(() => root.render(<StrictMode><LocHarness loc={loc} ctx={ctx} ctxFor={ctxFor} /></StrictMode>));

it("자리 기록 — 처음 기록부터 자리를 싣고, 명시적 이동은 한 칸 쌓으며 그 밖은 지금 기록을 고쳐 적는다. 뒤로 가면 그 기록의 자리를 되살린다", () => {
  restored = [];
  showLoc({ project_id: "p1" }); // 프로젝트 맨 위
  expect(stateLoc().loc).toEqual({ project_id: "p1", folder_path: undefined, ctx: "ctx-a" });
  const before = window.history.length;
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: "e035", ctx: "ctx-a" }, true)); // 컷 카드·사이드바를 눌러 들어감
  expect([window.history.length - before, stateLoc().loc?.folder_path]).toEqual([1, "e035"]);
  const entered = window.history.state;
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: "e035/C0010", ctx: "ctx-a" }, false)); // 따라가기 — 고쳐 적는다
  expect([window.history.length - before, stateLoc().loc?.folder_path]).toEqual([1, "e035/C0010"]);
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: "e035/C0010", ctx: "ctx-a" }, true)); // 같은 자리 — 아무 일도 없다
  expect(window.history.length - before).toBe(1);
  pop(entered); // 뒤로 — 되살린다(그 기록은 따라가기 전의 자리)
  expect(restored).toEqual([{ project_id: "p1", folder_path: "e035", ctx: "ctx-a" }]);
  pop({ chv: { tab: "team", focusId: null, ov: null, key: 0 } }); // 자리가 없는 옛 판의 기록 — 지금 자리를 둔다
  expect(restored).toHaveLength(1);
  pop({ chv: { tab: "team", focusId: null, ov: null, key: 0, loc: { project_id: "p9", folder_path: "x", ctx: "ctx-other" } } }); // 다른 문맥
  expect(restored).toHaveLength(1);
  pop({ chv: { tab: "team", focusId: null, ov: null, key: 0, loc: { project_id: undefined, folder_path: undefined, ctx: "ctx-a" } } }); // 명시적 맨 위
  expect(restored[1]).toEqual({ project_id: undefined, folder_path: undefined, ctx: "ctx-a" });
});

it("자리 기록 — 문맥은 지금 탭이 아니라 **그 기록의 탭**이 지금 갖게 될 문맥과 견준다(공유 탭의 폴더 → 작업 공간 탭 → 뒤로). 휴지통 보기도 자리다", () => {
  restored = [];
  // 지금은 my 탭(문맥 "my-ctx") — 공유 탭의 기록(문맥 "team-ctx")으로 돌아간다
  showLoc({ project_id: undefined }, "my-ctx", (tab) => (tab === "team" ? "team-ctx" : "my-ctx"));
  pop({ chv: { tab: "team", focusId: null, ov: null, key: 0, loc: { project_id: "p1", folder_path: "e035", ctx: "team-ctx" } } });
  expect(restored).toEqual([{ project_id: "p1", folder_path: "e035", ctx: "team-ctx" }]);
  pop({ chv: { tab: "team", focusId: null, ov: null, key: 0, loc: { project_id: "p1", folder_path: "e035", ctx: "team-ctx-old" } } }); // 다른 공간의 기록
  expect(restored).toHaveLength(1);
  // 휴지통 보기는 같은 프로젝트라도 다른 자리 — 기록을 고쳐 적고, 되살릴 때도 실린다
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: undefined, deleted_only: true, ctx: "my-ctx" }, true));
  expect(stateLoc().loc).toMatchObject({ project_id: "p1", deleted_only: true });
  const before = window.history.length;
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: undefined, deleted_only: true, ctx: "my-ctx" }, true)); // 같은 자리
  expect(window.history.length).toBe(before);
  // 휴지통을 나온 일반 목록 — 프로젝트·폴더·문맥이 같아도 다른 자리(한 칸 더)
  act(() => nav2.syncLocation({ project_id: "p1", folder_path: undefined, ctx: "my-ctx" }, true));
  expect([window.history.length, stateLoc().loc?.deleted_only]).toEqual([before + 1, undefined]);
  pop({ chv: { tab: "my", focusId: null, ov: null, key: 0, loc: { project_id: "p1", deleted_only: true, ctx: "my-ctx" } } });
  expect(restored[1]).toMatchObject({ project_id: "p1", deleted_only: true });
});

it("자리 기록 — 겹(미리보기)을 열 때도 지금 자리를 싣고, 탭을 누른 기록도 자리를 싣는다", () => {
  restored = [];
  showLoc({ project_id: "p1", folder_path: "e035" });
  act(() => nav2.openPreview(targetA));
  expect([stateLoc().ov, stateLoc().loc?.folder_path]).toEqual(["preview", "e035"]);
  act(() => nav2.navTab("my"));
  expect([stateLoc().ov, stateLoc().loc?.folder_path]).toEqual([null, "e035"]);
  act(() => nav2.syncLocation({ project_id: undefined, folder_path: undefined, ctx: "ctx-a" }, false)); // App 이 탭을 누른 뒤 자리를 지운다
  expect(stateLoc().loc).toEqual({ project_id: undefined, folder_path: undefined, ctx: "ctx-a" });
});

it("이미 떠 있는 관리자 창을 또 열어도 기록은 한 겹 — Esc(뒤로 한 번)에 닫힌다", () => {
  render();
  const before = window.history.length;
  act(() => navigation.openAdmin());
  act(() => navigation.openAdmin()); // 초점이 로고에 남은 채 Space
  expect(window.history.length).toBe(before + 1);
  expect((window.history.state as { chv: { ov: string | null } }).chv.ov).toBe("admin");
});

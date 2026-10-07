// @vitest-environment jsdom
// 편집 탭은 filters.tab 의 값이 아니라 내비 기록의 별도 '보기'다 — 진입·위에 뜬 창·뒤로/앞으로·옛 기록.
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAppNavigation } from "../src/lib/useAppNavigation";
import type { Filters, InfoTarget, PreviewTarget } from "../src/types";

let host: HTMLDivElement;
let root: Root;
let nav: ReturnType<typeof useAppNavigation>;
let seen: { tab: Filters["tab"]; edit: boolean; admin: boolean };

function Harness() {
  const [filters, setFilters] = useState<Filters>({ tab: "team" });
  const [editOpen, setEditOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [, setPreview] = useState<PreviewTarget | null>(null);
  const [, setCommentGenId] = useState<string | null>(null);
  const [, setInfo] = useState<InfoTarget | null>(null);
  const [, setBoardFocusId] = useState<string | null>(null);
  const [, setBoardArrange] = useState(0);
  const lastBoardFocusRef = useRef<string | null>(null);
  nav = useAppNavigation({
    currentTab: filters.tab, lastBoardFocusRef, setPreview, setCommentGenId, setAdminOpen, setInfo,
    setBoardFocusId, setBoardArrange, setFilters, setEditOpen,
  });
  seen = { tab: filters.tab, edit: editOpen, admin: adminOpen };
  return null;
}
const pop = (state: unknown) => act(() => { window.dispatchEvent(new PopStateEvent("popstate", { state })); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("편집에 들어가도 밑의 탭은 그대로고, 다른 탭을 누르면 편집에서 나온다", () => {
  const start = window.history.state;
  act(() => nav.openEdit());
  expect(seen).toEqual({ tab: "team", edit: true, admin: false });
  const inEdit = window.history.state;
  act(() => nav.openEdit()); // 이미 편집이면 기록을 또 쌓지 않는다
  expect(window.history.state).toBe(inEdit);
  act(() => nav.navTab("my"));
  expect(seen).toEqual({ tab: "my", edit: false, admin: false });
  pop(inEdit); // 뒤로 = 편집으로
  expect(seen).toEqual({ tab: "team", edit: true, admin: false });
  pop(start);
  expect(seen.edit).toBe(false);
});

it("편집 위에 뜬 창을 닫으면 편집으로 돌아온다", () => {
  act(() => nav.openEdit());
  const inEdit = window.history.state;
  act(() => nav.openAdmin());
  expect(seen).toEqual({ tab: "team", edit: true, admin: true });
  pop(inEdit); // closeOverlay = history.back()
  expect(seen).toEqual({ tab: "team", edit: true, admin: false });
});

it("편집 칸이 없는 옛 기록과 빈 기록은 편집이 아니다", () => {
  act(() => nav.openEdit());
  pop({ chv: { tab: "compose", focusId: null, ov: null, key: 0 } });
  expect(seen).toEqual({ tab: "compose", edit: false, admin: false });
  act(() => nav.openEdit());
  pop(null);
  expect(seen).toEqual({ tab: "my", edit: false, admin: false });
});

it("구성 보기로 들어가면(구성에서 보기) 편집에서 나온다", () => {
  act(() => nav.openEdit());
  act(() => nav.enterBoard("g1"));
  expect(seen).toEqual({ tab: "compose", edit: false, admin: false });
});

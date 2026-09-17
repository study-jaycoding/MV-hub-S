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

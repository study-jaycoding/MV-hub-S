// @vitest-environment jsdom
// jsdom은 실제 줄 배치를 계산하지 않는다. 실제 컴포넌트에 적용되는 CSS 계약을 검증하며,
// 창 폭별 줄 수·잘림은 브라우저에서 별도로 실측한다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let style: HTMLStyleElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // 29회차: 프롬프트를 숨겼을 때의 막대는 화면 아래 묶음 `.dock-float`(left/right 0·클릭 통과) 안의 `.selbar-bottom-float` 에 뜬다 — 전엔 `.selbar-top-float`
  const dock = document.createElement("div");
  dock.className = "dock-float";
  host = document.createElement("div");
  host.className = "selbar-bottom-float";
  dock.appendChild(host);
  document.body.appendChild(dock);
  style = document.createElement("style");
  style.textContent = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.parentElement?.remove();
  style.remove();
  vi.unstubAllGlobals();
});

it.each(["workspace", "shared", "mixed"])("%s: 상단바에 전체 폭을 주고 글자 대신 버튼 단위로 접는다", (mode) => {
  const mixed = mode === "mixed";
  const selected = [
    { id: "active", deleted: false },
    ...(mixed ? [{ id: "deleted", deleted: true }] : []),
  ] as Generation[];
  const noop = vi.fn();
  act(() => root.render(<LibrarySelectionActionBar
    selectedCount={selected.length} selectedGenerations={selected} projects={[]}
    onShare={noop} onGradeStep={mode === "shared" ? noop : undefined}
    onDownload={noop} onResolveTransfer={noop} onResolveRetry={mixed ? noop : null}
    resolveRetryProjectName="검증" resolveTransferBusy={mixed} resolveTransferPendingCount={12}
    onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop}
  />));

  const dockStyle = getComputedStyle(host.parentElement!);
  expect(dockStyle.left).toBe("0px");
  expect(dockStyle.right).toBe("0px");
  expect(dockStyle.bottom).toBe("54px"); // 화면 아래(프롬프트가 있던 자리) — 상태 줄(bottom 18px·약 28px) 위, 오류 문구와 같은 묶음(세로)
  expect(dockStyle.flexDirection).toBe("column");
  expect(dockStyle.transform).not.toContain("translateX");
  // 폭을 늘린 투명 영역은 아래 카드 클릭을 가로막지 않는다.
  expect(dockStyle.pointerEvents).toBe("none");
  const overlayStyle = getComputedStyle(host);
  expect(overlayStyle.pointerEvents).toBe("none");
  const bar = host.querySelector(".select-bar")!;
  const barStyle = getComputedStyle(bar);
  expect(barStyle.pointerEvents).toBe("auto");
  expect(barStyle.flexWrap).toBe("wrap");
  expect(barStyle.maxWidth).toBe("100%");
  for (const child of bar.children) expect(getComputedStyle(child).flexShrink).toBe("0");
  const labels = host.querySelectorAll(".sb-count, .select-bar > button, .proj-assign > button");
  expect(labels.length).toBeGreaterThan(3);
  for (const label of labels) expect(getComputedStyle(label).whiteSpace).toBe("nowrap");

  const download = [...bar.querySelectorAll("button")].find(el => el.textContent === "⤓ 다운로드")!;
  act(() => download.click());
  expect(noop).toHaveBeenCalledWith(selected);
});

it("프롬프트 위(도크 안)에서도 바는 가운데에 선다", () => {
  host.className = "sl-dock";
  const noop = vi.fn();
  act(() => root.render(<LibrarySelectionActionBar
    selectedCount={1} selectedGenerations={[{ id: "a", deleted: false }] as Generation[]} projects={[]}
    onShare={noop} onDownload={noop} onResolveTransfer={noop} onResolveRetry={null}
    resolveRetryProjectName="" resolveTransferBusy={false} resolveTransferPendingCount={0}
    onCompare={noop} onAssign={noop} onDelete={noop} onRestore={noop} onPurge={noop}
  />));
  expect(getComputedStyle(host.querySelector(".select-bar")!).alignSelf).toBe("center");
});

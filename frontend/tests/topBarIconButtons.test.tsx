// @vitest-environment jsdom
// 머리줄 아이콘 단추(Jay 2026-10-26) — 편집을 가운데 탭 줄에서 빼서 Assets 왼쪽에 두고, 편집·Assets·관리는 글자 없는 아이콘 단추.
//  켜짐(.lit — 선 그림 대신 투톤 그림): 편집 = 편집 탭이 열린 동안 · Assets·관리 = 그 별도 창이 떠 있는 동안. 라임 테두리(.on)는 없다.
//  켜진 단추를 다시 누르면 닫는다: 편집 = 밑의 탭을 누른 것과 같게 떠남 · 창 = 닫음.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만 — 응답은 전부 '아직 안 옴'(머리줄의 틀과 단추는 응답 없이도 그려진다).
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  return { api: new Proxy({}, { get: () => pending }) };
});

import { TopBar } from "../src/components/TopBar";
import { t } from "../src/lib/i18n";
import { EMBED_MODES, openEmbedWindow } from "../src/lib/popupWindows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bar(props: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return (
    <TopBar filters={{ tab: "my" } as never} onTab={noop} onSearch={noop} onWorkspaceSwitched={noop}
      workspaceContext={{ scope: "personal", id: null, name: null } as never} onWorkspaceContextChange={noop} onImported={noop}
      onOpenAssets={noop} onOpenAdmin={noop} hasUnreadComments={false} onOpenNotificationComment={noop} onNotificationsChanged={noop}
      {...props} />
  );
}
const iconButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".topbar .top-ic-btn")];
const lit = () => iconButtons().map((b) => b.classList.contains("lit"));

describe("머리줄 아이콘 단추", () => {
  it("가운데 탭 줄에 편집이 없고, 검색 뒤에 편집·Assets·관리 순서의 글자 없는 아이콘 단추가 있다 — 누르면 제 일을 한다", () => {
    const onOpenEdit = vi.fn(), onOpenAssets = vi.fn(), onOpenManage = vi.fn();
    act(() => root.render(bar({ onOpenEdit, onOpenAssets, onOpenManage })));
    const tabs = [...host.querySelectorAll(".tabs button")].map((b) => b.textContent);
    expect(tabs).toEqual([t("워크스페이스"), t("공유 & 리뷰"), t("캔버스")]);
    const buttons = iconButtons();
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([t("편집"), "Assets", t("프로젝트 관리 — 별도 창")]);
    expect(buttons.map((b) => b.textContent)).toEqual(["", "", ""]); // 글자 없음 — 이름은 title·aria-label
    expect(buttons.every((b) => b.title)).toBe(true);
    // 셋은 한 캡슐(.top-ic-group — 시안 G3) 안에, 그 캡슐은 검색칸 뒤·알림 앞
    const group = host.querySelector(".topbar .top-ic-group")!;
    expect([...group.children]).toEqual(buttons);
    const order = [...host.querySelector(".topbar")!.children];
    const search = order.findIndex((el) => el.classList.contains("topbar-search"));
    expect(order.indexOf(group)).toBe(search + 1);
    expect(order.indexOf(group) + 1).toBe(order.findIndex((el) => el.classList.contains("notification-center")));
    // 단추마다 평소(선)·켜짐(투톤) 그림을 둘 다 갖고 있다
    for (const b of buttons) expect([b.querySelectorAll(".top-ic-line").length, b.querySelectorAll(".top-ic-lit").length]).toEqual([1, 1]);
    // 투톤 앞면 그라데이션 id 가 단추마다 다르다(같은 문서에서 겹치면 엉뚱한 색이 칠해진다)
    const gradIds = buttons.flatMap((b) => [...b.querySelectorAll("linearGradient")].map((g) => g.id));
    expect(gradIds).toHaveLength(3);
    expect(new Set(gradIds).size).toBe(3);
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    act(() => buttons[2].click());
    expect([onOpenEdit.mock.calls.length, onOpenAssets.mock.calls.length, onOpenManage.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("편집·관리 연결이 없으면(관리 플래그 꺼짐 등) 그 단추는 없다 — Assets 만 남는다(캡슐 안 하나뿐 = 동그라미)", () => {
    act(() => root.render(bar()));
    expect(iconButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["Assets"]);
    expect(host.querySelectorAll(".top-ic-group > .top-ic-btn:only-child")).toHaveLength(1);
  });

  it("편집 탭이 열린 동안만 편집 단추가 켜진다 — 라임 테두리(.on)는 붙지 않는다", () => {
    act(() => root.render(bar({ onOpenEdit: noop, onOpenManage: noop })));
    expect(lit()).toEqual([false, false, false]);
    act(() => root.render(bar({ onOpenEdit: noop, onOpenManage: noop, editOpen: true })));
    expect(lit()).toEqual([true, false, false]);
    expect(iconButtons()[0].getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".topbar .top-ic-btn.on")).toBeNull();
    expect(host.querySelector(".tabs button.on")).toBeNull(); // 편집 중엔 아래 탭 단추도 켜지 않는다(지금 동작)
  });

  it("Assets·관리는 연 별도 창이 떠 있는 동안 켜지고, 창을 닫으면 1초 안에 꺼진다 — 창 열기가 막히면 켜지지 않는다", () => {
    vi.useFakeTimers();
    const windows: Record<string, { closed: boolean; focus: () => void } | null> = {
      "contenthub-assets": { closed: false, focus: vi.fn() },
      "contenthub-manage": null, // 팝업 차단 — 창이 없다
    };
    vi.spyOn(window, "open").mockImplementation(((_url: string, name: string) => windows[name]) as never);
    act(() => root.render(bar({
      onOpenEdit: noop,
      onOpenAssets: () => openEmbedWindow(EMBED_MODES.assets),
      onOpenManage: () => openEmbedWindow(EMBED_MODES.manage),
    })));
    const [, assets, manage] = iconButtons();
    act(() => assets.click());
    expect(lit()).toEqual([false, true, false]);
    act(() => manage.click()); // 막힘
    expect(lit()).toEqual([false, true, false]);
    windows["contenthub-assets"]!.closed = true; // 사용자가 창의 X 로 닫음
    act(() => { vi.advanceTimersByTime(1000); });
    expect(lit()).toEqual([false, false, false]);
    // 닫힌 뒤 다시 누르면 새로 열고 다시 켜진다
    windows["contenthub-assets"] = { closed: false, focus: vi.fn() };
    act(() => assets.click());
    expect(lit()).toEqual([false, true, false]);
    windows["contenthub-assets"]!.closed = true; // 다음 시험에 남기지 않는다
    act(() => { vi.advanceTimersByTime(1000); });
    expect(lit()).toEqual([false, false, false]);
  });

  it("켜진 단추를 다시 누르면 닫는다 — 편집은 밑의 탭으로 떠나고, 창은 그 창만 닫는다(다시 열지 않는다)", () => {
    vi.useFakeTimers();
    const fake = () => {
      const w = { closed: false, focus: vi.fn(), close: vi.fn(() => { w.closed = true; }) };
      return w;
    };
    const windows: Record<string, ReturnType<typeof fake>> = { "contenthub-assets": fake(), "contenthub-manage": fake() };
    vi.spyOn(window, "open").mockImplementation(((_url: string, name: string) => windows[name]) as never);
    const onTab = vi.fn(), onOpenEdit = vi.fn();
    const onOpenAssets = vi.fn(() => openEmbedWindow(EMBED_MODES.assets));
    const onOpenManage = vi.fn(() => openEmbedWindow(EMBED_MODES.manage));
    act(() => root.render(bar({ filters: { tab: "team" } as never, onTab, onOpenEdit, onOpenAssets, onOpenManage, editOpen: true })));
    const [edit, assets, manage] = iconButtons();
    act(() => edit.click()); // 켜진 편집 → 밑의 탭(공유 & 리뷰)을 누른 것과 같다
    expect(onTab).toHaveBeenCalledWith("team");
    expect(onOpenEdit).not.toHaveBeenCalled();
    act(() => { assets.click(); manage.click(); });
    expect(lit()).toEqual([true, true, true]);
    act(() => assets.click()); // 켜진 Assets → 그 창만 닫고 바로 꺼진다
    expect(windows["contenthub-assets"].close).toHaveBeenCalledTimes(1);
    expect(windows["contenthub-manage"].close).not.toHaveBeenCalled();
    expect(onOpenAssets).toHaveBeenCalledTimes(1);
    expect(lit()).toEqual([true, false, true]);
    act(() => manage.click());
    expect(windows["contenthub-manage"].close).toHaveBeenCalledTimes(1);
    expect(onOpenManage).toHaveBeenCalledTimes(1);
    expect(lit()).toEqual([true, false, false]);
    act(() => { vi.advanceTimersByTime(1000); }); // 닫힌 창이 다시 켜지지 않는다
    expect(lit()).toEqual([true, false, false]);
  });
});

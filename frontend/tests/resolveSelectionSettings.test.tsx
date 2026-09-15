// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRenderRoot } from "./seedanceRenderHarness";

let view: ReturnType<typeof createRenderRoot>;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  view = createRenderRoot();
});
afterEach(() => {
  view.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountSettings() {
  const settings = await import("../src/lib/resolveSelectionSettings");
  const { ResolveScriptSettingsSection } = await import("../src/components/settings/SettingsSections");
  function Host() {
    return <ResolveScriptSettingsSection selectionFollow={settings.useResolveSelectionFollow()}
      onSelectionFollowChange={settings.saveResolveSelectionFollow} status={null} connection={null}
      diagnostics={null} connectionBusy={false} busy={false} msg="" onInstall={() => {}}
      onRefreshConnection={() => {}} />;
  }
  act(() => view.root.render(<Host />));
  return { settings, checkbox: view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')! };
}

it("실시간 체크 기본 체크, 클릭 즉시 저장·반영, 설정을 다시 열어도 해제 유지", async () => {
  const { checkbox, settings } = await mountSettings();
  expect(checkbox.checked).toBe(true);
  act(() => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(settings.loadResolveSelectionFollow()).toBe(false);
  act(() => view.root.render(null));
  expect((await mountSettings()).checkbox.checked).toBe(false);
});

it("다른 탭에서 바꾼 설정을 현재 설정 UI에도 반영한다", async () => {
  const { checkbox } = await mountSettings();
  act(() => {
    localStorage.setItem("ch.resolveSelectionFollow", "0");
    window.dispatchEvent(new StorageEvent("storage", { key: "ch.resolveSelectionFollow" }));
  });
  expect(checkbox.checked).toBe(false);
});

it("저장소 쓰기가 차단돼도 현재 창에서 연동을 해제할 수 있다", async () => {
  const { checkbox, settings } = await mountSettings();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  act(() => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(settings.loadResolveSelectionFollow()).toBe(false);
});

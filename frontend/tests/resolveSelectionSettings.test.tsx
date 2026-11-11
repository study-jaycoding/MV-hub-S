// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRenderRoot } from "./seedanceRenderHarness";
import type { ResolvePanelPluginStatus } from "../src/lib/resolveTransfer";

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

it.each([
  ["up_to_date", "설치됨 1.0.0"], ["outdated", "옛 판"], ["not_installed", "설치 안 됨"],
  ["deferred", "다음 시작 때 다시 설치"], ["permission_denied", "권한이 없습니다 — 관리자가 폴더 권한을 열어야 합니다"],
  ["busy", "다른 설치가 진행 중"], ["damaged", "망가진 설치 — 보존본"],
  ["newer_installed", "더 새 판 1.0.0 이 깔려 있어 그대로 둡니다"],
  ["foreign", "MV가 깐 것이 아닌 폴더가 있어 손대지 않았습니다"], ["no_resolve", "리졸브가 없는 PC"],
] as const)("패널 설치 %s 문구와 조건부 재시작 안내", async (state, message) => {
  const { ResolveScriptSettingsSection } = await import("../src/components/settings/SettingsSections");
  const plugin: ResolvePanelPluginStatus = { state, path: "temporary/plugin", installed_version: "1.0.0", bundled_version: "0.9.0", backup_path: "temporary/backup", reason: "injected", changed_at: "2026-11-11" };
  act(() => view.root.render(<ResolveScriptSettingsSection selectionFollow={false} onSelectionFollowChange={() => {}}
    status={null} connection={null} diagnostics={null} connectionBusy={false} busy={false} msg="" onInstall={() => {}} onRefreshConnection={() => {}}
    panelPlugin={plugin} onInstallPanelPlugin={() => {}} />));
  const line = view.container.querySelector(".settings-resolve-panel-plugin")!;
  expect(line.textContent).toContain(message);
  expect(line.textContent?.includes("그 뒤 리졸브를 다시 켜지 않았다면 다시 켜야 적용됩니다")).toBe(state === "up_to_date");
  expect(line.textContent).not.toContain("...");
  expect(line.querySelector("button")!.disabled).toBe(["busy", "foreign", "no_resolve"].includes(state));
});

it.each(["outdated", "not_installed", "newer_installed", "up_to_date"] as const)("%s에서 마지막 실패 대체는 필요한 상태에만", async state => {
  const { ResolveScriptSettingsSection } = await import("../src/components/settings/SettingsSections");
  const plugin: ResolvePanelPluginStatus = { state, path: "temporary/plugin", installed_version: "1.1.0", bundled_version: "1.0.0", changed_at: "2026-11-11T01:02:03Z", last_attempt: { state: "deferred", at: "now", reason: "사용 중이거나 권한 문제" } };
  act(() => view.root.render(<ResolveScriptSettingsSection selectionFollow={false} onSelectionFollowChange={() => {}}
    status={null} connection={null} diagnostics={null} connectionBusy={false} busy={false} msg="" onInstall={() => {}} onRefreshConnection={() => {}}
    panelPlugin={plugin} onInstallPanelPlugin={() => {}} />));
  const text = view.container.querySelector(".settings-resolve-panel-plugin")!.textContent;
  expect(text?.includes("다음 시작 때 다시 설치 — 사용 중이거나 권한 문제")).toBe(state === "outdated" || state === "not_installed");
  expect(text).not.toContain("옛 판");
  expect(text?.includes("설치 파일을 바꿨습니다")).toBe(state === "up_to_date");
  if (state === "newer_installed") expect(text).toContain("더 새 판 1.1.0");
});

it.each(["2026-11-11T01:02:03Z", "unreadable-date"])("설치 시각 %s는 지역 형식 또는 원문", async changedAt => {
  const { ResolveScriptSettingsSection } = await import("../src/components/settings/SettingsSections");
  const plugin: ResolvePanelPluginStatus = { state: "up_to_date", path: "temporary/plugin", changed_at: changedAt };
  act(() => view.root.render(<ResolveScriptSettingsSection selectionFollow={false} onSelectionFollowChange={() => {}}
    status={null} connection={null} diagnostics={null} connectionBusy={false} busy={false} msg="" onInstall={() => {}} onRefreshConnection={() => {}}
    panelPlugin={plugin} onInstallPanelPlugin={() => {}} />));
  const text = view.container.querySelector(".settings-resolve-panel-plugin")!.textContent;
  expect(text).toContain(changedAt === "unreadable-date" ? changedAt : new Date(changedAt).toLocaleString());
  if (changedAt !== "unreadable-date") expect(text).not.toContain(changedAt);
});

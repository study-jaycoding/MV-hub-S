// @vitest-environment jsdom
// 설치 대상은 공개본이다 — 공지 전 후보를 쓰던 PC 에서 공개본이 더 옛 판이면 '새 버전'이라 부르지 않는다(Codex 2026-10-03).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReleaseUpdateSettingsSection } from "../src/components/settings/SettingsSections";
import type { ReleaseUpdateStatus } from "../src/lib/releaseUpdate";

const status = (current: string, latest: string): ReleaseUpdateStatus => ({
  state: "available", message: "", install_mode: "release", current_version: current, latest_version: latest,
  can_update: true, generation_active: 0, comfy_active: 0, resolve_active: 0, active_total: 0, updated_at: "",
});

function render(value: ReleaseUpdateStatus): string {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(
      <ReleaseUpdateSettingsSection status={value} busy={false} msg="" onRefresh={() => {}} onUpdate={() => {}}
        onForceUpdate={() => {}} />,
    );
  });
  const text = host.textContent || "";
  act(() => root.unmount());
  return text;
}

it("공개본이 지금보다 옛 날짜 판이면 옛 판이라고 말한다", () => {
  const text = render(status("2026.10.03-1420", "2026.10.03-0926"));
  expect(text).toContain("공개본 2026.10.03-0926(지금보다 옛 판)");
  expect(text).not.toContain("새 버전");
});

it("공개본이 더 새 판이면 지금처럼 새 버전이다", () => {
  expect(render(status("2026.10.03-0926", "2026.10.03-1420"))).toContain("새 버전 2026.10.03-1420");
});

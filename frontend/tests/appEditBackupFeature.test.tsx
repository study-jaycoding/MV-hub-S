// @vitest-environment jsdom
import appSource from "../src/App.tsx?raw";
import { act, useEffect, useSyncExternalStore, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Auth = { authPending: boolean; authReady: boolean; hubAccount: { email: string } | null; apiPause: boolean };
let host: HTMLDivElement, root: Root;
let Probe: ComponentType<Auth>;
let features: typeof import("../src/lib/hubFeatures");
const stop = vi.fn(), start = vi.fn(() => stop);
const ready: Auth = { authPending: false, authReady: true, hubAccount: { email: "a@test" }, apiPause: false };

beforeEach(async () => {
  vi.resetModules(); start.mockClear(); stop.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  features = await import("../src/lib/hubFeatures");
  // App의 실제 배선만 실행한다. 효과를 시험에 복사하면 구독 누락을 잡지 못한다.
  const wiring = appSource.split("} = useHubAuth();")[1]?.split("// 그룹 사용 모델 정책")[0];
  expect(wiring).toContain("return startEditDocBackup();");
  Probe = new Function("useEffect", "useSyncExternalStore", "subscribeHubFeatures", "hubHasFeature", "startEditDocBackup",
    `return function Probe({ authPending, authReady, hubAccount, apiPause }) { ${wiring} return null; };`)(
    useEffect, useSyncExternalStore, features.subscribeHubFeatures, features.hubHasFeature, start,
  );
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (auth: Auth = ready) => act(() => root.render(<Probe {...auth} />));

it("늦은 기능 응답만으로 백업이 시작되고 같은 표식은 재시작하지 않으며 해제 때 정리한다", () => {
  render(); expect(start).not.toHaveBeenCalled();
  act(() => features.setHubFeatures(["edit_doc_backup_v1"]));
  expect(start).toHaveBeenCalledTimes(1);
  act(() => features.setHubFeatures(["edit_doc_backup_v1", "scene_writer_v1"]));
  expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
  act(() => features.setHubFeatures([])); expect(stop).toHaveBeenCalledTimes(1);
});

it.each([
  { authPending: true }, { authReady: false }, { hubAccount: null }, { apiPause: true },
])("늦은 기능 응답도 기존 인증·일시정지 조건을 지킨다: %j", (blocked) => {
  render({ ...ready, ...blocked });
  act(() => features.setHubFeatures(["edit_doc_backup_v1"]));
  expect(start).not.toHaveBeenCalled();
  render(); expect(start).toHaveBeenCalledTimes(1);
  render({ ...ready, hubAccount: { email: "b@test" } });
  expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(2);
  render({ ...ready, apiPause: true }); expect(stop).toHaveBeenCalledTimes(2);
});

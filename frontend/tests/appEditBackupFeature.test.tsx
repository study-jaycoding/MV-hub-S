// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { start, stop } = vi.hoisted(() => { const stop = vi.fn(); return { stop, start: vi.fn(() => stop) }; });
vi.mock("../src/lib/editDocBackup", () => ({ startEditDocBackup: start }));

type Auth = import("../src/lib/useEditDocBackup").EditDocBackupAuth;
let host: HTMLDivElement, root: Root;
let features: typeof import("../src/lib/hubFeatures");
let useEditDocBackup: typeof import("../src/lib/useEditDocBackup").useEditDocBackup;
const ready: Auth = { authPending: false, authReady: true, hubAccount: { email: "a@test" }, apiPause: null };
function Probe(auth: Auth) {
  useEditDocBackup(auth);
  return null;
}

beforeEach(async () => {
  vi.resetModules(); start.mockClear(); stop.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  features = await import("../src/lib/hubFeatures");
  ({ useEditDocBackup } = await import("../src/lib/useEditDocBackup"));
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
  { authPending: true }, { authPending: "token" }, { authReady: false }, { hubAccount: null }, { apiPause: "shared" as const }, { apiPause: "hub" as const },
])("늦은 기능 응답도 기존 인증·일시정지 조건을 지킨다: %j", (blocked) => {
  render({ ...ready, ...blocked });
  act(() => features.setHubFeatures(["edit_doc_backup_v1"]));
  expect(start).not.toHaveBeenCalled();
  render(); expect(start).toHaveBeenCalledTimes(1);
  render({ ...ready, hubAccount: { email: "b@test" } });
  expect(stop).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(2);
  render({ ...ready, apiPause: "hub" }); expect(stop).toHaveBeenCalledTimes(2);
});

it("이메일이 같은 새 계정 객체로는 다시 시작하지 않는다", () => {
  act(() => features.setHubFeatures(["edit_doc_backup_v1"]));
  render(); render({ ...ready, hubAccount: { email: "a@test" } });
  expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
});

it("App 이 인증 값 그대로 이 훅을 부른다", async () => {
  const app = (await import("../src/App.tsx?raw")).default;
  expect(app).toContain("useEditDocBackup({ authPending, authReady, hubAccount, apiPause });");
});

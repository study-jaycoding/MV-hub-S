// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../src/components/AccountMenu";
import { setAuthToken } from "../src/lib/http";
import { setAccountScope, setConnectionKey } from "../src/lib/accountScope";
import type { Account } from "../src/types";
import { APP_EVENTS } from "../src/lib/appEvents";

const api = vi.hoisted(() => ({ workspaces: vi.fn(), accountHf: vi.fn(), cliCheck: vi.fn(), consoleSummary: vi.fn() }));
vi.mock("../src/api", () => ({ api }));
vi.mock("../src/components/ManageAccount", () => ({ ManageAccount: ({ cliVersion }: { cliVersion: string }) => <output data-testid="cli">{cliVersion}</output> }));
vi.mock("../src/components/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("../src/lib/useSyncStatus", () => ({ useSyncStatus: () => null, latestSyncSuccess: () => null, formatTelemetryLastSuccess: () => "", syncFailedCount: () => 0, syncPendingCount: () => 0 }));
vi.mock("../src/lib/myCreditQuota", () => ({ useMyCreditQuota: () => ({ value: null, loading: false }), hasPersonalQuota: () => false, quotaUncertainty: () => "", showsWorkspacePool: () => false }));

let root: Root;
let element: HTMLDivElement;
const noop = () => {};
async function render(email = "one@example.test", localHub = true) {
  await act(async () => {
    root.render(<AccountMenu provider={null} account={{ email, name: "Test" } as Account}
      workspaceContext={{ scope: "personal", id: null, name: null }} localHub={localHub}
      manageEnabled={false} onProviderUpdated={noop} onWorkspaceSwitched={noop} onWorkspaceContextChange={noop} />);
  });
}
async function openAccount() {
  await act(async () => { element.querySelector<HTMLButtonElement>(".acct-avatar-btn")!.click(); });
  await act(async () => { document.querySelector<HTMLElement>(".acct-head-btn")!.click(); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setAuthToken("test-token");
  setAccountScope("one@example.test");
  setConnectionKey("hub-one");
  api.workspaces.mockReset().mockResolvedValue([]);
  api.accountHf.mockReset().mockResolvedValue({ reported: true, cli_version: "9.9.9", workspaces: [] });
  api.cliCheck.mockReset().mockResolvedValue({ required: "1.2.3", pin: "8.8.8" });
  api.consoleSummary.mockReset().mockResolvedValue({ local_worker: true, cli: { version: "1.2.3", pinned: "7.7.7" } });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  element.remove();
  setAuthToken(null);
  vi.unstubAllGlobals();
});

describe("CLI version sources", () => {
  it("uses the server requirement and this app's actual worker version", async () => {
    await render();
    await openAccount();
    expect(document.querySelector("[data-testid=cli]")?.textContent).toBe("1.2.3 (기준) / 1.2.3 (앱)");
  });

  it("does not borrow a reported worker or local pin when this app is not a local worker", async () => {
    api.consoleSummary.mockResolvedValue({ local_worker: false, cli: { version: "1.2.3", pinned: "7.7.7" } });
    await render("one@example.test", false);
    await openAccount();
    expect(document.querySelector("[data-testid=cli]")?.textContent).toBe("1.2.3 (기준) / 확인 안 됨 (앱)");
  });

  it("keeps unavailable sources unknown instead of falling back", async () => {
    api.cliCheck.mockResolvedValue({ pin: "1.2.3", server: "1.2.2" });
    api.consoleSummary.mockRejectedValue(new Error("403"));
    await render();
    await openAccount();
    expect(document.querySelector("[data-testid=cli]")?.textContent).toBe("확인 안 됨 (기준) / 확인 안 됨 (앱)");
  });

  it("rejects old identity responses and refreshes when the account window opens", async () => {
    const oldCheck = deferred<{ required: string }>();
    const oldSummary = deferred<{ local_worker: boolean; cli: { version: string } }>();
    api.cliCheck.mockReturnValueOnce(oldCheck.promise);
    api.consoleSummary.mockReturnValueOnce(oldSummary.promise);
    await render();
    api.cliCheck.mockResolvedValue({ required: "2.0.0" });
    api.consoleSummary.mockResolvedValue({ local_worker: true, cli: { version: "2.0.1" } });
    setAccountScope("two@example.test");
    setAuthToken("new-token");
    await render("two@example.test");
    await act(async () => {
      oldCheck.resolve({ required: "0.1.0" });
      oldSummary.resolve({ local_worker: true, cli: { version: "0.1.0" } });
    });
    await openAccount();
    expect(document.querySelector("[data-testid=cli]")?.textContent).toBe("2.0.0 (기준) / 2.0.1 (앱)");
  });

  it("refreshes the existing balance on completion and preserves it on read failure", async () => {
    const personal = (credits: number) => [{ id: "personal", name: null, plan_type: "free", credits, user_role: "owner", is_selected: true }];
    api.workspaces.mockResolvedValue(personal(100));
    await render();
    expect(element.querySelector(".acct-avatar-btn")?.getAttribute("title")).toContain("100");
    api.workspaces.mockResolvedValue(personal(70));
    await act(async () => { window.dispatchEvent(new Event(APP_EVENTS.creditsChanged)); });
    expect(element.querySelector(".acct-avatar-btn")?.getAttribute("title")).toContain("70");
    api.workspaces.mockRejectedValue(new Error("offline"));
    await act(async () => { window.dispatchEvent(new Event(APP_EVENTS.creditsChanged)); });
    expect(element.querySelector(".acct-avatar-btn")?.getAttribute("title")).toContain("70");
  });
});

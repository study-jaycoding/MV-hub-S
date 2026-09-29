// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { jsonFetch } from "../src/lib/http";
import { useMyCreditQuota } from "../src/lib/myCreditQuota";

vi.mock("../src/lib/http", () => ({ jsonFetch: vi.fn() }));
vi.mock("../src/lib/progressSocket", () => ({ connectProgress: vi.fn(() => () => {}) }));

let root: Root;
let host: HTMLDivElement;
function Probe({ workspace, account = "a", open = false }: { workspace: string; account?: string; open?: boolean }) {
  const state = useMyCreditQuota(workspace, account, open);
  return <div>{state.loading ? "loading" : state.value?.remaining ?? "unavailable"}</div>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(jsonFetch).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("ignores an old workspace response that arrives after switching", async () => {
  let finishOld!: (value: unknown) => void;
  vi.mocked(jsonFetch)
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ workspace_id: "new", remaining: 4000 });
  await act(async () => root.render(<Probe workspace="old" />));
  await act(async () => root.render(<Probe workspace="new" />));
  expect(host.textContent).toBe("4000");
  await act(async () => finishOld({ workspace_id: "old", remaining: 100 }));
  expect(host.textContent).toBe("4000");
});

it("clears the previous account's allowance on failure for the next account", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ workspace_id: "ws", remaining: 4000 }).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Probe workspace="ws" account="a" />));
  expect(host.textContent).toBe("4000");
  await act(async () => root.render(<Probe workspace="ws" account="b" />));
  expect(host.textContent).toBe("unavailable");
});

it("refreshes on menu open and refuses mismatched authority responses", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ workspace_id: "ws", remaining: 4000 }).mockResolvedValueOnce({ workspace_id: "other", remaining: 9000 });
  await act(async () => root.render(<Probe workspace="ws" />));
  await act(async () => root.render(<Probe workspace="ws" open />));
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("unavailable");
});

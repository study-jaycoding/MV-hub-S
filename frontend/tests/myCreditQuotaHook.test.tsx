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

// 81회차 실측 2 M2-12: 메뉴를 열 때와 닫을 때 모두 다시 물어 창 한 번(열고 닫기)에 GET 이 2건이었다 — 닫는 것만으로는 다시 묻지 않는다.
it("asks again when the menu opens, not when it closes", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({ workspace_id: "ws", remaining: 4000 });
  await act(async () => root.render(<Probe workspace="ws" />));
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Probe workspace="ws" open />));
  await act(async () => root.render(<Probe workspace="ws" />));
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("4000");
});

it("asks once when it first renders open", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({ workspace_id: "ws", remaining: 4000 });
  await act(async () => root.render(<Probe workspace="ws" open />));
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(1);
});

it("keeps an open-time answer that lands after closing, and still asks (dropping late answers) on a closed workspace switch", async () => {
  let finishOpen!: (value: unknown) => void;
  let finishWs2!: (value: unknown) => void;
  vi.mocked(jsonFetch)
    .mockResolvedValueOnce({ workspace_id: "ws", remaining: 4000 })
    .mockImplementationOnce(() => new Promise((resolve) => { finishOpen = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finishWs2 = resolve; }))
    .mockResolvedValueOnce({ workspace_id: "ws3", remaining: 7 });
  await act(async () => root.render(<Probe workspace="ws" />));
  await act(async () => root.render(<Probe workspace="ws" open />));
  await act(async () => root.render(<Probe workspace="ws" />));
  await act(async () => finishOpen({ workspace_id: "ws", remaining: 3000 }));
  expect(host.textContent).toBe("3000"); // 닫았다고 열 때의 조회를 버리지 않는다(멈춘 '불러오는 중' 없음)
  await act(async () => root.render(<Probe workspace="ws2" />)); // 닫힌 채 공간을 바꿨다
  await act(async () => root.render(<Probe workspace="ws3" />));
  await act(async () => finishWs2({ workspace_id: "ws2", remaining: 100 })); // 늦게 온 옛 공간의 답
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(4);
  expect(host.textContent).toBe("7");
});

it("refreshes on menu open and refuses mismatched authority responses", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ workspace_id: "ws", remaining: 4000 }).mockResolvedValueOnce({ workspace_id: "other", remaining: 9000 });
  await act(async () => root.render(<Probe workspace="ws" />));
  await act(async () => root.render(<Probe workspace="ws" open />));
  expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(2);
  expect(host.textContent).toBe("unavailable");
});

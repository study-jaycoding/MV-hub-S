// @vitest-environment jsdom
// 계보 판은 대상(focusId)이 바뀌어도 새 계보가 올 때까지 앞 계보를 그대로 보여 줬다(조작 규칙 46 — 19회차, Codex 전수 검토).
// 같은 계보 안에서 옮길 때는 그대로 둔다(누를 때마다 깜빡이지 않게) — 보이던 계보에 지금 대상이 없으면 다른 계보라 감춘다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const historyTree = vi.hoisted(() => vi.fn());
vi.mock("../src/api", () => ({ api: { historyTree } }));

import { useHistoryGraph } from "../src/components/history/useHistoryGraph";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const graphOf = (...ids: string[]) =>
  ({ nodes: ids.map((id) => ({ id })), edges: [], root_ids: [ids[0]], focus_id: ids[0], truncated: false }) as never;

it("다른 계보의 카드로 바뀌면 새 계보가 올 때까지 앞 계보를 보이지 않는다 — 같은 계보 안에서는 그대로 둔다", async () => {
  const arrive: Array<(graph: unknown) => void> = [];
  historyTree.mockReset().mockImplementation(() => new Promise((resolve) => { arrive.push(resolve); }));
  let shown: string[] | null = null;
  function Probe({ focusId }: { focusId: string | null }) {
    const { graph } = useHistoryGraph(focusId);
    shown = graph ? graph.nodes.map((node) => node.id) : null;
    return null;
  }
  const show = (focusId: string | null) => act(async () => { root.render(<Probe focusId={focusId} />); });
  await show("a1");
  expect(shown).toBeNull();
  await act(async () => { arrive[0](graphOf("a1", "a2")); });
  expect(shown).toEqual(["a1", "a2"]);

  await show("a2"); // 같은 계보의 다른 카드 — 새 응답이 오기 전에도 그대로 보인다
  expect(shown).toEqual(["a1", "a2"]);
  await show("b1"); // 다른 계보 — 전엔 응답이 올 때까지 a 의 계보가 b1 의 것처럼 보였다
  expect(shown).toBeNull();
  await act(async () => { arrive[2](graphOf("b1")); });
  expect(shown).toEqual(["b1"]);
  await show(null);
  expect(shown).toBeNull();
});

// Codex 코드 리뷰: '보이던 계보에 지금 대상이 있나'만 보면, 서버 id(job)로 연 계보는 받고도 영영 안 보인다 — 백엔드가 그 id 를 이 PC 의 id 로
//  풀어 답해서, 응답의 노드에는 물은 id 가 없다(팀 탭에서 로컬본이 있는 내 공유물의 [히스토리]).
it("서버 id 로 물어 받은 계보도 보인다 — 응답의 노드 id 가 물은 id 와 달라도 지금 대상의 응답이다", async () => {
  const arrive: Array<(graph: unknown) => void> = [];
  historyTree.mockReset().mockImplementation(() => new Promise((resolve) => { arrive.push(resolve); }));
  let shown: string[] | null = null;
  function Probe({ focusId }: { focusId: string | null }) {
    const { graph } = useHistoryGraph(focusId);
    shown = graph ? graph.nodes.map((node) => node.id) : null;
    return null;
  }
  await act(async () => { root.render(<Probe focusId="server-job-9" />); });
  await act(async () => { arrive[0](graphOf("local-1", "local-2")); });
  expect(shown).toEqual(["local-1", "local-2"]);
  await act(async () => { root.render(<Probe focusId="other-job" />); }); // 다른 것을 물었다 — 그 응답 전에는 감춘다
  expect(shown).toBeNull();
  await act(async () => { arrive[1](graphOf("local-1", "local-2")); }); // 같은 계보였다(응답이 앞의 것과 같다) — 그래도 지금 물은 것의 응답이다
  expect(shown).toEqual(["local-1", "local-2"]);
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 카드를 다른 워크스페이스로 옮겼을 때 **목록에서 뺄지 말지**를 고정한다.
//
// ★중복 선택(Jay 2026-09-14) 때문에 단수 비교로는 틀린다. A·B 를 같이 보는 중에
//  A 카드를 **B 로** 옮기면 그 카드는 계속 보여야 한다 — 단수 비교였다면 '내가 보는 공간이
//  아니다'라며 사라졌다가, 새로고침하면 다시 나타난다(사용자에겐 카드가 날아간 것처럼 보인다).
//
// ★반대로 고르지 않은 C 로 옮겼거나 팀 소속을 아예 뗐으면 그 자리에서 빠져야 한다.

const setGenerationWorkspace = vi.fn();
vi.mock("../src/api", () => ({ api: { setGenerationWorkspace: (...a: unknown[]) => setGenerationWorkspace(...a) } }));

const { useGenerationWorkspaceActions } = await import("../src/lib/useGenerationWorkspaceActions");
type Generation = Parameters<typeof useGenerationWorkspaceActions>[0]["gensRef"]["current"][number];

const card = (id: string, workspaceId: string): Generation =>
  ({
    id,
    job_id: id,
    workspace_scope: "team",
    workspace_id: workspaceId,
    workspace_name: workspaceId,
  }) as Generation;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setGenerationWorkspace.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 훅을 제품 그대로 마운트하고, 명령 한 번을 돌린 뒤 남은 목록을 돌려준다. */
async function moveCard(options: {
  armed?: string[];
  operation: "assign" | "remove";
  to: string;
}) {
  const gens = [card("a1", "ws-a"), card("b1", "ws-b")];
  const gensRef = { current: gens };
  let rendered: ReturnType<typeof useGenerationWorkspaceActions> | undefined;
  let latest = gens;

  setGenerationWorkspace.mockResolvedValue({
    workspace: { id: options.to, name: options.to },
    changed: ["a1"],
    updates: [
      {
        requested_id: "a1",
        generation: { workspace_scope: "team", workspace_id: options.to, workspace_name: options.to },
      },
    ],
  });

  function Probe() {
    rendered = useGenerationWorkspaceActions({
      activeWorkspaceIds: options.armed,
      flash: vi.fn(),
      gensRef,
      reload: vi.fn(),
      selectedRef: { current: new Set<string>() },
      setGens: (update) => {
        latest = typeof update === "function" ? update(latest) : update;
      },
      setSelected: vi.fn(),
    });
    return null;
  }

  act(() => root.render(<Probe />));
  await act(async () => {
    await rendered!.onWorkspaceCommand(gens[0], options.operation, { id: options.to, name: options.to });
  });
  return latest.map((g) => g.id);
}

describe("카드를 옮긴 뒤 목록에서 빼는 판정", () => {
  it("보고 있는 공간들 **안에서** 옮기면 계속 보인다 (A·B 를 보는 중 A→B)", async () => {
    expect(await moveCard({ armed: ["ws-a", "ws-b"], operation: "assign", to: "ws-b" })).toEqual([
      "a1",
      "b1",
    ]);
  });

  it("고르지 않은 공간으로 옮기면 그 자리에서 빠진다 (A·B 를 보는 중 A→C)", async () => {
    expect(await moveCard({ armed: ["ws-a", "ws-b"], operation: "assign", to: "ws-c" })).toEqual([
      "b1",
    ]);
  });

  it("보고 있는 공간에서 소속을 떼면 빠진다", async () => {
    expect(await moveCard({ armed: ["ws-a", "ws-b"], operation: "remove", to: "ws-a" })).toEqual([
      "b1",
    ]);
  });

  it("아무 공간도 안 고른 상태(전체 보기)면 옮겨도 안 뺀다", async () => {
    expect(await moveCard({ armed: [], operation: "assign", to: "ws-c" })).toEqual(["a1", "b1"]);
  });
});

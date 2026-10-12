// @vitest-environment jsdom
// 27회차 격리 실측(M02)에서 찾은 것: Assets 창이 두 번째 폴더에 **두 번째로** 들어가는 순간(AP1 → AP2 → AP1 → AP2) React #185(갱신 무한 반복)로 통째로
//  깨졌다 — 어느 폴더든 메타(태그·색)가 비어 있지 않을 때만. 원인(스택·Codex 분석): 캐시를 적용하는 **함수형 갱신** `setMeta(prev => reconcile(prev, cached))`
//  가, 같은 값이라 버려진(밀린) 갱신이 큐에 남은 채로는 렌더마다 그 위에서 다시 계산돼 새 객체를 만들고 → files 새 배열 → 선택 정리 레이아웃 효과 →
//  동기 재렌더 → 반복(조작 규칙 54). jsdom 에서는 그 되먹임이 닫히지 않아(아래 둘째 시험은 고치기 전에도 통과했다) 흐름만 지킨다 — 진짜 판정은
//  격리 실측(docs/status/조작점검_고정흐름_2026-10-12.md). 셋째 시험은 고친 계약 자체(적용한 값이 고정 객체인가)를 본다.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssetNode } from "../src/types";

const mocks = vi.hoisted(() => ({ assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn() }));
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const known: Record<string, unknown> = {
    assetProjects: mocks.assetProjects, assetTree: mocks.assetTree, assetMeta: mocks.assetMeta,
    assetFileUrl: (_project: string, path: string) => `/files/${path}`, assetThumbUrl: (_project: string, path: string) => `/thumbs/${path}`,
  };
  return { api: new Proxy(known, { get: (target, name: string) => target[name] ?? pending }) };
});
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

import { useAssetProjectData } from "../src/components/assets/useAssetProjectData";
import { AssetsView } from "../src/components/AssetsView";

let host: HTMLDivElement;
let root: Root;
const metaOf = (project: string) => ({ "same.png": { tags: [`old-${project}`], color: null, is_source: false, source_name: null, comment: null, comment_count: 0, has_unread: false } });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.assetProjects.mockResolvedValue({ projects: ["AP1", "AP2"], linked: [], default: "AP1" });
  mocks.assetTree.mockImplementation(async () => ({ children: [{ name: "same.png", path: "same.png", type: "image" } as AssetNode] }));
  mocks.assetMeta.mockImplementation(async (project: string) => (project === "AP1" ? metaOf(project) : {}));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };

it("폴더 자료 훅: AP1 → AP2 → AP1 → AP2 로 오가도 갱신이 무한히 돌지 않고 화면은 그 폴더의 것이다", async () => {
  let data!: ReturnType<typeof useAssetProjectData>;
  let renders = 0;
  function Host() { renders++; data = useAssetProjectData({ workspaceId: "w" }); return null; }
  await act(async () => root.render(<Host />));
  await settle();
  expect(data.project).toBe("AP1");
  for (const next of ["AP2", "AP1", "AP2"]) {
    const before = renders;
    await act(async () => { data.setProject(next); });
    await settle();
    expect(renders - before).toBeLessThan(20);
    expect([data.project, data.meta["same.png"]?.tags ?? null, data.metaReady]).toEqual([next, next === "AP1" ? ["old-AP1"] : null, true]);
  }
});

it("실제 Assets 창: AP1 → AP2 → AP1 → AP2 로 오가도(메타가 있는 채) 창이 깨지지 않고 그 폴더의 파일이 보인다", async () => {
  await act(async () => { root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />); });
  await settle();
  const select = () => host.querySelector<HTMLSelectElement>("select.assets-project")!;
  expect(select().value).toBe("AP1");
  const pick = async (project: string) => {
    await act(async () => {
      flushSync(() => { // 사용자의 선택은 동기 갱신이다 — 받아 둔 폴더면 레이아웃 효과 안에서 캐시가 바로 적용된다
        select().value = project;
        select().dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    await settle();
  };
  for (const next of ["AP2", "AP1", "AP2", "AP1", "AP2"]) {
    await pick(next); // 실측에서는 네 번째(두 번째 AP2)에서 React #185 로 창 전체가 사라졌다
    expect(select().value).toBe(next);
    expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
  }
});

// 고친 계약("한 번 예약한 갱신을 React 가 다시 처리해도 같은 객체를 적용한다")은 jsdom 에서 그 재처리 순서를 만들지 못해 시험으로 잡지 못했다 — 다른 폴더를
//  다녀와 **새로** 예약한 적용은 정당하게 새 객체를 만들므로(reconcile 은 내용이 다르면 새 객체) '방문 사이 참조 유지'로 바꿔 적을 수도 없다(Codex 코드 리뷰).
//  판정은 격리 실측(고친 빌드로 AP1→AP2→AP1→AP2 3회)이다.

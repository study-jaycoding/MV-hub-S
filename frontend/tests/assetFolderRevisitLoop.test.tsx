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

const mocks = vi.hoisted(() => ({ assetProjects: vi.fn(), assetTree: vi.fn(), assetMeta: vi.fn(), assetThumbUrl: vi.fn() }));
vi.mock("../src/api", () => {
  const pending = () => new Promise(() => {});
  const known: Record<string, unknown> = {
    assetProjects: mocks.assetProjects, assetTree: mocks.assetTree, assetMeta: mocks.assetMeta,
    assetFileUrl: (_project: string, path: string) => `/files/${path}`, assetThumbUrl: mocks.assetThumbUrl,
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
  mocks.assetThumbUrl.mockImplementation((_project: string, path: string) => `/thumbs/${path}`);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const select = () => host.querySelector<HTMLSelectElement>("select.assets-project")!;
const pick = async (project: string) => {
  await act(async () => {
    flushSync(() => { // 사용자의 선택은 동기 갱신이다 — 받아 둔 폴더면 레이아웃 효과 안에서 캐시가 바로 적용된다
      select().value = project;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  await settle();
};

it("폴더 자료 훅: AP1 → AP2 → AP1 → AP2 로 오가도 갱신이 무한히 돌지 않고 화면은 그 폴더의 것이다 — 어느 렌더에서도 앞 폴더의 메타가 새 폴더 이름 아래 나오지 않고, 받아 둔 폴더로 돌아가는 첫 렌더부터 그 폴더의 것이다", async () => {
  let data!: ReturnType<typeof useAssetProjectData>;
  let renders = 0;
  const seen: string[] = []; // 렌더마다 '폴더:메타:파일 수' — 가림(규칙 45 의 남은 한 박자)은 렌더 단위라 settle 뒤의 값만 보면 못 잡는다
  function Host() {
    renders++; data = useAssetProjectData({ workspaceId: "w" });
    seen.push(`${data.project}:${data.meta["same.png"]?.tags?.join() ?? "-"}:${data.tree.length}`);
    return null;
  }
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
  expect(seen).toContain("AP1:old-AP1:1");
  expect(seen.filter((pair) => pair.startsWith("AP2:") && !pair.startsWith("AP2:-:"))).toEqual([]); // AP2 의 메타는 늘 비어 있다
  // 받아 둔 폴더로 돌아가는 첫 렌더부터 그 폴더의 캐시다 — 빈 렌더(메타 없음·파일 0)가 없다(빈 값으로 가리면 빈 격자가 한 프레임 그려졌다, p6 실측)
  const loaded = seen.indexOf("AP1:old-AP1:1");
  expect(seen.slice(loaded).filter((pair) => pair.startsWith("AP1:") && pair !== "AP1:old-AP1:1")).toEqual([]);
  expect(seen.slice(seen.indexOf("AP2:-:1")).filter((pair) => pair.startsWith("AP2:") && pair !== "AP2:-:1")).toEqual([]);
});

it("실제 Assets 창: AP1 → AP2 → AP1 → AP2 로 오가도(메타가 있는 채) 창이 깨지지 않고 그 폴더의 파일이 보인다", async () => {
  await act(async () => { root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />); });
  await settle();
  expect(select().value).toBe("AP1");
  for (const next of ["AP2", "AP1", "AP2", "AP1", "AP2"]) {
    await pick(next); // 실측에서는 네 번째(두 번째 AP2)에서 React #185 로 창 전체가 사라졌다
    expect(select().value).toBe(next);
    expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
  }
});

it("폴더를 바꾼 첫 렌더가 앞 폴더의 파일 이름으로 새 폴더에 썸네일을 묻지 않는다(규칙 45 의 남은 한 박자) — 처음 여는 폴더도, 받아 둔 폴더로 돌아갈 때도", async () => {
  mocks.assetTree.mockImplementation(async (project: string) => ({ children: [{ name: `only-${project}.png`, path: `only-${project}.png`, type: "image" } as AssetNode] }));
  await act(async () => { root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />); });
  await settle();
  for (const next of ["AP2", "AP1", "AP2"]) {
    await pick(next);
    expect(host.querySelectorAll(".asset-cell")).toHaveLength(1); // 가림이 과하지 않다 — 받아 둔 폴더로 돌아와도 파일은 보인다
  }
  const asked = mocks.assetThumbUrl.mock.calls.map(([project, path]) => `${project}:${path}`);
  expect(asked).toContain("AP2:only-AP2.png");
  expect(asked.filter((pair) => pair === "AP2:only-AP1.png" || pair === "AP1:only-AP2.png")).toEqual([]);
});

it("받아 둔 폴더로 돌아갈 때 트리·메타가 앞 폴더와 같은 내용이라 React 가 갱신을 건너뛰어도(메타 조회가 실패한 폴더를 거쳐) 파일이 보인다 — 가림의 열쇠가 state 인 까닭", async () => {
  // AP2 의 메타 조회 실패 → '받은 폴더'(metaFor)가 AP1 에 남는다. 돌아온 AP1 에서 setTree(같은 내용)·setMeta(빈 것)·setMetaFor(이미 AP1) 가 모두 건너뛰면
  //  가림을 ref 로 풀 때는 다시 그릴 계기가 없어 빈 화면이 남았다 — treeFor(state)가 AP2 → AP1 로 바뀌는 것이 유일한 계기다.
  mocks.assetMeta.mockImplementation(async (project: string) => { if (project === "AP2") throw new Error("Failed to fetch"); return {}; });
  await act(async () => { root.render(<AssetsView onInfo={() => {}} onPreview={() => {}} />); });
  await settle();
  await pick("AP2");
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
  // 돌아온 AP1 의 서버 조회는 오지 않는다 — 받아 둔 것만으로 즉시 보여야 한다(캐시의 목적). 응답을 기다려 주면 뒤따르는 조회가 열쇠를 맞춰 주어
  //  캐시 적용 자리의 setTreeFor 를 빼도 안 잡혔다(되돌려 확인 28회차 생존 → 보강).
  mocks.assetTree.mockImplementation(() => new Promise(() => {}));
  await pick("AP1");
  expect(select().value).toBe("AP1");
  expect(host.querySelectorAll(".asset-cell")).toHaveLength(1);
});

// 고친 계약("한 번 예약한 갱신을 React 가 다시 처리해도 같은 객체를 적용한다")은 jsdom 에서 그 재처리 순서를 만들지 못해 시험으로 잡지 못했다 — 다른 폴더를
//  다녀와 **새로** 예약한 적용은 정당하게 새 객체를 만들므로(reconcile 은 내용이 다르면 새 객체) '방문 사이 참조 유지'로 바꿔 적을 수도 없다(Codex 코드 리뷰).
//  판정은 격리 실측(고친 빌드로 AP1→AP2→AP1→AP2 3회)이다.

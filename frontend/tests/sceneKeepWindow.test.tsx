// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneKeepDialog } from "../src/components/scene/SceneKeepDialog";
import { SceneKeepWindow } from "../src/components/scene/SceneKeepWindow";
import { sceneKeepApi, type SceneKeepPayload, type SceneKeepRow } from "../src/lib/sceneKeep";
import { setAccountScope } from "../src/lib/accountScope";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import type { Project } from "../src/types";
import { api } from "../src/api";
import { HttpError } from "../src/lib/http";

let host: HTMLDivElement;
let root: Root;
const scope = "acct:alice";
const project = { id: "p", name: "지금 프로젝트", archived: false } as Project;
const row = (id: string, projectId = "p"): SceneKeepRow => ({ id, name: `씬 ${id}`, project_id: projectId, project_name: "옛 프로젝트",
  workspace: { id: "w", name: "R" }, node_count: 2, preview: [["text", 0, 0, 500, 500]], missing_count: 0, revision: 3, updated_at: "2026-11-02T01:00:00Z" });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label)!;
const click = async (el: HTMLElement) => { await act(async () => el.click()); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear(); localStorage.clear(); setAccountScope("alice");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("프로젝트 현재 이름·개수·표식으로 묶고 이미지/리스트 보기를 기억하며 선택한 항목만 연다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a"), row("b"), row("c", "gone")]);
  const open = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[project]} onOpen={open} onClose={() => {}} />));
  expect(host.querySelector(".admin-tabs")?.textContent).toContain("전체 3");
  expect(host.querySelector(".admin-tabs")?.textContent).toContain("지금 프로젝트 2");
  expect(host.querySelector(".admin-tabs")?.textContent).toContain("옛 프로젝트 1");
  expect(host.querySelectorAll(".ws-mark-box")).toHaveLength(2);
  expect(host.querySelectorAll(".scene-minimap-card.k-text")).toHaveLength(3);
  expect(button("+ 새 탭으로 열기").disabled).toBe(true);
  await click(host.querySelectorAll<HTMLButtonElement>(".admin-tab")[1]);
  expect(host.querySelectorAll(".scene-keep-item")).toHaveLength(2);
  await click(host.querySelector<HTMLElement>('[title="리스트 보기"]')!);
  expect(localStorage.getItem(STORAGE_KEYS.sceneKeepView)).toBe("list");
  expect(host.querySelector(".scene-keep-items.list")).not.toBeNull();
  await click(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("+ 새 탭으로 열기"));
  expect(open).toHaveBeenCalledWith("a");
});

it("휴지통은 확인 전 쓰지 않고 선택한 id와 revision으로 삭제한다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a")]);
  const remove = vi.spyOn(sceneKeepApi, "remove").mockResolvedValue({ ok: true });
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={() => {}} />));
  await click(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(host.querySelector<HTMLElement>('[aria-label="보관본 삭제"]')!);
  expect(remove).not.toHaveBeenCalled();
  await click(button("삭제"));
  expect(remove).toHaveBeenCalledWith(scope, "a", 3);
  expect(host.textContent).toContain("보관본이 없습니다.");
});

it("목록과 열기 실패를 창에 표시하고 성공한 것으로 닫지 않는다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a")]);
  const close = vi.fn();
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn().mockRejectedValue(new Error("기록은 복원했지만 탭을 열지 못했습니다."))} onClose={close} />));
  await click(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("+ 새 탭으로 열기"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("기록은 복원했지만");
  expect(close).not.toHaveBeenCalled();
});

const payload: SceneKeepPayload = { name: "사본", project_id: "p", project_name: "지금 프로젝트", workspace: null, scene_text: "fixed", preview: [] };
it("옛 서버의 null id 표식과 새 서버의 null 표식 모두 보관함을 그릴 수 있다", async () => {
  const legacy = JSON.parse(JSON.stringify({ ...row("legacy", "old"), workspace: { id: null, name: null } })) as SceneKeepRow;
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([legacy, { ...row("empty", "new"), workspace: null }]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelectorAll(".scene-keep-item")).toHaveLength(2);
  expect(host.textContent).toContain("씬 legacy");
  expect(host.textContent).toContain("씬 empty");
  expect(host.querySelectorAll(".ws-mark-box")).toHaveLength(0);
});

it.each(["save", "list", "open"])("연결 실패는 한국어로 표시한다: %s", async operation => {
  const failure = new TypeError("Failed to fetch");
  const close = vi.fn();
  if (operation === "save") {
    vi.spyOn(sceneKeepApi, "save").mockRejectedValue(failure);
    await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={() => payload} onSaved={vi.fn()} onClose={close} />));
    await click(button("보관"));
  } else {
    const list = vi.spyOn(sceneKeepApi, "list");
    if (operation === "list") list.mockRejectedValue(failure);
    else list.mockResolvedValue([row("a")]);
    await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn().mockRejectedValue(failure)} onClose={close} />));
    if (operation === "open") {
      await click(host.querySelector<HTMLElement>(".scene-keep-item")!);
      await click(button("+ 새 탭으로 열기"));
    }
  }
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("서버에 연결하지 못했습니다.");
  expect(host.textContent).not.toContain("Failed to fetch");
  expect(close).not.toHaveBeenCalled();
});

it("보관 창은 이름·프로젝트만 받고 성공 전에 이름을 바꾸지 않으며 같은 사본으로 덮어쓴다", async () => {
  const save = vi.spyOn(sceneKeepApi, "save").mockResolvedValueOnce({ status: "exists", id: "a", revision: 2, updated_at: "now" }).mockResolvedValueOnce({ status: "saved", id: "a", revision: 3, missing_count: 4 });
  const capture = vi.fn().mockReturnValue(payload), saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={capture} onSaved={saved} onClose={close} />));
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("워크스페이스 보관");
  expect(host.querySelectorAll("label")).toHaveLength(2);
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("p");
  await click(button("보관"));
  expect(saved).not.toHaveBeenCalled();
  expect(host.textContent).toContain("같은 이름이 있습니다");
  expect(host.textContent).toContain("'사본' 보관본을 덮어쓰겠습니까?");
  await click(button("덮어쓰기"));
  expect(capture).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith(scope, { ...payload, overwrite_id: "a", overwrite_revision: 2 });
  expect(saved).toHaveBeenCalledWith("사본", 4);
  expect(close).toHaveBeenCalledTimes(1);
});

it("보관 실패와 도중 계정 전환은 성공 처리하지 않는다", async () => {
  let finish!: (value: {status: "saved"; id: string; revision: number; missing_count: number}) => void;
  vi.spyOn(sceneKeepApi, "save").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const saved = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="" projects={[]} capture={() => payload} onSaved={saved} onClose={vi.fn()} />));
  await click(button("보관"));
  setAccountScope("bob");
  await act(async () => finish({ status: "saved", id: "a", revision: 1, missing_count: 0 }));
  expect(saved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("계정이 바뀌었습니다");
});

it("덮어쓰기 충돌은 바뀐 id·revision을 다시 확인받고 사본은 다시 캡처하지 않는다", async () => {
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "old", revision: 2, updated_at: "now" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "new", revision: 2, missing_count: 0 });
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([{ ...row("new"), name: payload.name, revision: 1 }]);
  const capture = vi.fn().mockReturnValue(payload), saved = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={capture} onSaved={saved} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기"));
  expect(saved).not.toHaveBeenCalled();
  expect(host.textContent).toContain("보관본이 바뀌었습니다");
  expect(save).toHaveBeenCalledTimes(2);
  await click(button("덮어쓰기"));
  expect(save).toHaveBeenLastCalledWith(scope, { ...payload, overwrite_id: "new", overwrite_revision: 1 });
  expect(capture).toHaveBeenCalledTimes(1);
});

it("보관 요청이 실패하면 오류를 보이고 성공 콜백을 호출하지 않는다", async () => {
  vi.spyOn(sceneKeepApi, "save").mockRejectedValue(new Error("공유 서버 연결 실패"));
  const saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={() => payload} onSaved={saved} onClose={close} />));
  await click(button("보관"));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("공유 서버 연결 실패");
  expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});

it("옛 서버 목록 오류를 보여 주고 저장한 보기 설정으로 시작한다", async () => {
  localStorage.setItem(STORAGE_KEYS.sceneKeepView, "list");
  vi.spyOn(sceneKeepApi, "list").mockRejectedValue(new Error("공유 서버 업데이트가 필요합니다."));
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("공유 서버 업데이트가 필요합니다.");
  expect(host.querySelector('[title="리스트 보기"]')?.getAttribute("aria-pressed")).toBe("true");
});

it("충돌한 보관본이 사라져도 자동 재저장하지 않고 다음 클릭에 같은 사본을 쓴다", async () => {
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "old", revision: 2, updated_at: "now" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "new", revision: 1, missing_count: 0 });
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([]);
  const capture = vi.fn().mockReturnValue(payload), saved = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={capture} onSaved={saved} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기"));
  expect(save).toHaveBeenCalledTimes(2); expect(saved).not.toHaveBeenCalled();
  await click(button("보관"));
  expect(save).toHaveBeenLastCalledWith(scope, payload);
  expect(capture).toHaveBeenCalledTimes(1);
});

it("삭제 충돌 때 목록을 지우지 않고 확인창 밖에 오류를 표시한다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a")]);
  vi.spyOn(sceneKeepApi, "remove").mockRejectedValue(new Error("보관본이 바뀌었습니다"));
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  await click(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(host.querySelector<HTMLElement>('[aria-label="보관본 삭제"]')!);
  await click(button("삭제"));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("보관본이 바뀌었습니다");
  expect(host.querySelectorAll(".scene-keep-item")).toHaveLength(1);
});

it("앱은 M을 보여도 R 탭의 프로젝트를 따로 읽어 기본값과 선택 목록으로 쓴다", async () => {
  const mine = { ...project, id: "r", name: "R 프로젝트", workspace_id: "R" };
  const m = { ...project, id: "m", name: "M 프로젝트", workspace_id: "M" };
  let finish!: (result: { projects: Project[]; unassigned: number }) => void;
  const fetchProjects = vi.spyOn(api, "projects").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const capture = vi.fn().mockReturnValue(payload);
  vi.spyOn(sceneKeepApi, "save").mockResolvedValue({ status: "saved", id: "s", revision: 1, missing_count: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="" projects={[m]} workspace={{ id: "R", name: "R" }} selectedProjectId="m" capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(fetchProjects).toHaveBeenCalledWith("my", false, "R");
  expect(button("보관").disabled).toBe(true);
  await act(async () => finish({ projects: [mine], unassigned: 0 }));
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("r");
  expect(host.querySelector("select")?.textContent).not.toContain("M 프로젝트");
  await click(button("보관"));
  expect(capture).toHaveBeenCalledWith("씬", mine);
});

it("탭 프로젝트 조회 실패는 보관을 막고 정해진 오류를 표시한다", async () => {
  vi.spyOn(api, "projects").mockRejectedValue(new TypeError("Failed to fetch"));
  const capture = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} workspace={{ id: "R", name: "R" }} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(button("보관").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("프로젝트 목록을 불러오지 못했습니다.");
  await click(button("보관"));
  expect(capture).not.toHaveBeenCalled();
});

it("보관창을 교체한 뒤 도착한 옛 프로젝트 응답은 새 선택을 바꾸지 않는다", async () => {
  let finish!: (result: { projects: Project[]; unassigned: number }) => void;
  const r = { ...project, id: "r", workspace_id: "R" }, s = { ...project, id: "s", workspace_id: "S" };
  vi.spyOn(api, "projects").mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ projects: [s], unassigned: 0 });
  const render = (id: string) => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="" projects={[]} workspace={{ id, name: id }} capture={() => payload} onSaved={vi.fn()} onClose={vi.fn()} />);
  await act(async () => render("R"));
  await act(async () => render("S"));
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("s");
  await act(async () => finish({ projects: [r], unassigned: 0 }));
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("s");
  expect(host.querySelectorAll('option[value="r"]')).toHaveLength(0);
});

it("탭 공간에 프로젝트가 없으면 기존 앱 프로젝트 대신 없음만 선택한다", async () => {
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [], unassigned: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} workspace={{ id: "R", name: "R" }} capture={() => payload} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelectorAll("option")).toHaveLength(1);
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("");
  expect(button("보관").disabled).toBe(false);
});

it.each(["save", "list", "open"])("HTTP409 오류에서 숫자 접두사 대신 설명만 표시한다: %s", async operation => {
  const failure = new HttpError(409, "409: 보관본이 바뀌었습니다", "보관본이 바뀌었습니다");
  if (operation === "save") {
    vi.spyOn(sceneKeepApi, "save").mockRejectedValue(failure);
    await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={() => payload} onSaved={vi.fn()} onClose={vi.fn()} />));
    await click(button("보관"));
  } else {
    const list = vi.spyOn(sceneKeepApi, "list");
    if (operation === "list") list.mockRejectedValue(failure); else list.mockResolvedValue([row("a")]);
    await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn().mockRejectedValue(failure)} onClose={vi.fn()} />));
    if (operation === "open") { await click(host.querySelector<HTMLElement>(".scene-keep-item")!); await click(button("+ 새 탭으로 열기")); }
  }
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("보관본이 바뀌었습니다");
});

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
  description: "", workspace: { id: "w", name: "R" }, node_count: 2, preview: [["text", 0, 0, 500, 500]], missing_count: 0, revision: 3, updated_at: "2026-11-02T01:00:00Z" });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label)!;
const click = async (el: HTMLElement) => { await act(async () => el.click()); };
const contextMenu = async (el: HTMLElement, x = 20, y = 20) => { await act(async () => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }))); };
const key = async (el: EventTarget, value: string, shiftKey = false) => { await act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }))); };
const mouseDown = async (el: HTMLElement) => { await act(async () => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))); };
const change = async (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};
const textarea = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear(); localStorage.clear(); setAccountScope("alice");
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([]);
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
  expect(host.querySelectorAll(".admin-tabs .ws-mark-box")).toHaveLength(2);
  expect(host.querySelectorAll(".scene-keep-item-title .ws-mark-box")).toHaveLength(3);
  expect(host.querySelectorAll(".scene-minimap-card.k-text")).toHaveLength(3);
  expect(button("+ 새 탭으로 열기")).toBeUndefined();
  expect(host.querySelector('.scene-keep-toolbar [aria-label="보관본 삭제"]')).toBeNull();
  await click(host.querySelectorAll<HTMLButtonElement>(".admin-tab")[1]);
  expect(host.querySelectorAll(".scene-keep-item")).toHaveLength(2);
  await click(host.querySelector<HTMLElement>('[title="리스트 보기"]')!);
  expect(localStorage.getItem(STORAGE_KEYS.sceneKeepView)).toBe("list");
  expect(host.querySelector(".scene-keep-items.list")).not.toBeNull();
  await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("열기"));
  expect(open).toHaveBeenCalledWith("a");
});

it("휴지통은 확인 전 쓰지 않고 선택한 id와 revision으로 삭제한다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a")]);
  const remove = vi.spyOn(sceneKeepApi, "remove").mockResolvedValue({ ok: true });
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={() => {}} />));
  await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("삭제"));
  expect(remove).not.toHaveBeenCalled();
  await click(button("삭제"));
  expect(remove).toHaveBeenCalledWith(scope, "a", 3);
  expect(host.textContent).toContain("보관본이 없습니다.");
});

it("목록과 열기 실패를 창에 표시하고 성공한 것으로 닫지 않는다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([row("a")]);
  const close = vi.fn();
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn().mockRejectedValue(new Error("기록은 복원했지만 탭을 열지 못했습니다."))} onClose={close} />));
  await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("열기"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("기록은 복원했지만");
  expect(close).not.toHaveBeenCalled();
});

const payload: SceneKeepPayload = { name: "사본", description: "", project_id: "p", project_name: "지금 프로젝트", workspace: null, scene_text: "fixed", preview: [] };
it("옛 서버의 null id 표식과 새 서버의 null 표식 모두 보관함을 그릴 수 있다", async () => {
  const legacy = JSON.parse(JSON.stringify({ ...row("legacy", "old"), workspace: { id: null, name: null } })) as SceneKeepRow;
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([legacy, { ...row("empty", "new"), workspace: null }]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelectorAll(".scene-keep-item")).toHaveLength(2);
  expect(host.textContent).toContain("씬 legacy");
  expect(host.textContent).toContain("씬 empty");
  expect(host.querySelectorAll(".ws-mark-box")).toHaveLength(0);
});

it("프로젝트 없는 보관본도 표식이 있으면 카드와 읽기 창에 마크를 보이고, 왼쪽 프로젝트 없음 줄에는 안 붙인다", async () => {
  vi.spyOn(sceneKeepApi, "list").mockResolvedValue([{ ...row("marked", ""), description: "글" }, { ...row("plain", ""), workspace: null }]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelectorAll(".scene-keep-item-title .ws-mark-box")).toHaveLength(1);
  expect(host.querySelectorAll(".admin-tabs .ws-mark-box")).toHaveLength(0);
  await click(host.querySelector<HTMLElement>(".scene-keep-item-desc")!);
  expect(host.querySelectorAll(".scene-keep-desc-head .ws-mark-box")).toHaveLength(1);
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
      await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!);
      await click(button("열기"));
    }
  }
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("서버에 연결하지 못했습니다.");
  expect(host.textContent).not.toContain("Failed to fetch");
  expect(close).not.toHaveBeenCalled();
});

it("보관 창은 이름·프로젝트·설명을 받고 성공 전에 이름을 바꾸지 않으며 같은 사본으로 덮어쓴다", async () => {
  const save = vi.spyOn(sceneKeepApi, "save").mockResolvedValueOnce({ status: "exists", id: "a", revision: 2, description: "", updated_at: "now" }).mockResolvedValueOnce({ status: "saved", id: "a", revision: 3, missing_count: 4 });
  const capture = vi.fn().mockReturnValue(payload), saved = vi.fn(), close = vi.fn();
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="씬" projectId="p" projects={[project]} capture={capture} onSaved={saved} onClose={close} />));
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("워크스페이스 보관");
  expect(host.querySelectorAll("label")).toHaveLength(3);
  expect(textarea().maxLength).toBe(2000);
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
    .mockResolvedValueOnce({ status: "exists", id: "old", revision: 2, description: "", updated_at: "now" })
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
    .mockResolvedValueOnce({ status: "exists", id: "old", revision: 2, description: "", updated_at: "now" })
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
  await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!);
  await click(button("삭제"));
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
    if (operation === "open") { await contextMenu(host.querySelector<HTMLElement>(".scene-keep-item")!); await click(button("열기")); }
  }
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("보관본이 바뀌었습니다");
});

const described = (description: string, name = "사본", projectId = "p"): SceneKeepRow => ({ ...row("a", projectId), name, description });
const captureInput = (name: string, selected: Project | null) => ({ ...payload, name: name.normalize("NFC").trim(), project_id: selected?.id ?? "" });

it("설명은 같은 프로젝트와 NFC·trim 이름을 먼저 찾고 빈 이름은 허용한다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([
    described("다른 프로젝트", "Café", "other"), described("내 설명", "Café"), described("다른 이름", "다른 씬"),
  ]);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name={"  Cafe\u0301  "} projectId="p" projects={[project, { ...project, id: "other" }]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(textarea().value).toBe("내 설명");
  await change(host.querySelector<HTMLSelectElement>("select")!, "other");
  expect(textarea().value).toBe("다른 프로젝트");
  await change(host.querySelector<HTMLInputElement>("input")!, " ");
  expect(textarea().value).toBe("내 설명"); // 바꾼 대상이 없으면 쓰던 보관본의 설명이 따라온다
  await change(host.querySelector<HTMLInputElement>("input")!, "Café");
  expect(textarea().value).toBe("다른 프로젝트");
  expect(sceneKeepApi.list).toHaveBeenCalledTimes(1);
});

it("이름을 바꿔 새로 보관하면 쓰던 보관본의 설명이 따라오고, 바꾼 이름의 보관본이 있으면 그 설명이 먼저다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("쓰던 설명", "사본"), described("다른 씬 설명", "다른 씬")]);
  const save = vi.spyOn(sceneKeepApi, "save").mockResolvedValue({ status: "saved", id: "b", revision: 1, missing_count: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(host.querySelector<HTMLInputElement>("input")!, "다른 씬");
  expect(textarea().value).toBe("다른 씬 설명");
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  expect(textarea().value).toBe("쓰던 설명");
  await click(button("보관"));
  expect(save.mock.calls[0][1]).toEqual(expect.objectContaining({ name: "새 이름", description: "쓰던 설명" }));
});

it("이름과 프로젝트를 모두 바꾸면 새 프로젝트의 같은 이름이 아니라 쓰던 보관본의 설명이 따라온다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("쓰던 설명", "사본"), described("관계없는 설명", "사본", "other")]);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project, { ...project, id: "other" }]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  await change(host.querySelector<HTMLSelectElement>("select")!, "other");
  expect(textarea().value).toBe("쓰던 설명");
});

it("쓰던 보관본이 없으면 바꾼 프로젝트에 처음 이름의 보관본이 있어도 빈 칸이다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("관계없는 설명", "사본", "other")]);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project, { ...project, id: "other" }]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  await change(host.querySelector<HTMLSelectElement>("select")!, "other");
  expect(textarea().value).toBe("");
});

it("워크스페이스 조회가 기본 프로젝트를 바꿔도 그 프로젝트의 보관본 설명이 따라온다", async () => {
  const mine = { ...project, id: "r", name: "R 프로젝트", workspace_id: "R" };
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("쓰던 설명", "사본", "r")]);
  vi.spyOn(api, "projects").mockResolvedValue({ projects: [mine], unassigned: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="" projects={[]} workspace={{ id: "R", name: "R" }} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("r");
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  expect(textarea().value).toBe("쓰던 설명");
});

it("프로젝트를 바꿔 새로 보관해도 쓰던 설명이 따라오고, 손댄 설명이 이기며, 쓰던 보관본이 없으면 빈 칸이다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("쓰던 설명", "사본")]);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project, { ...project, id: "other" }]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(host.querySelector<HTMLSelectElement>("select")!, "other");
  expect(textarea().value).toBe("쓰던 설명");
  await change(textarea(), "내가 쓴 글");
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  expect(textarea().value).toBe("내가 쓴 글");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="처음" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(host.querySelector<HTMLInputElement>("input")!, "새 이름");
  expect(textarea().value).toBe("");
});

it.each(["내가 쓴 설명", ""])("늦은 목록은 사용자가 입력한 설명 %j을 덮지 않는다", async text => {
  const listing = deferred<SceneKeepRow[]>();
  vi.mocked(sceneKeepApi.list).mockReturnValue(listing.promise);
  const save = vi.spyOn(sceneKeepApi, "save").mockResolvedValue({ status: "saved", id: "a", revision: 1, missing_count: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(textarea(), "입력 시작");
  await change(textarea(), text);
  await act(async () => listing.resolve([described("늦게 온 옛 설명")]));
  expect(textarea().value).toBe(text);
  await click(button("보관"));
  expect(save).toHaveBeenLastCalledWith(scope, expect.objectContaining({ description: text }));
});

it("exists 확인 취소 뒤에는 최신 설명을 유지하며 현재 씬을 새로 캡처한다", async () => {
  vi.mocked(sceneKeepApi.list).mockRejectedValue(new Error("목록 실패"));
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "서버 최신\n설명" })
    .mockResolvedValueOnce({ status: "saved", id: "a", revision: 4, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(button("보관").disabled).toBe(false);
  await click(button("보관"));
  await click(button("취소"));
  expect(textarea().value).toBe("서버 최신\n설명");
  capture.mockImplementation((name, selected) => ({ ...captureInput(name, selected), scene_text: "changed scene" }));
  await click(button("보관"));
  expect(save).toHaveBeenLastCalledWith(scope, expect.objectContaining({ description: "서버 최신\n설명", scene_text: "changed scene" }));
  expect(capture).toHaveBeenCalledTimes(2);
});

it("conflict에서 보존한 재시도 사본은 exists에서도 유지하며 설명만 갱신한다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("old")]).mockResolvedValueOnce([]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "first" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "exists", id: "b", revision: 1, updated_at: "now", description: "latest" })
    .mockResolvedValueOnce({ status: "saved", id: "b", revision: 2, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기"));
  capture.mockImplementation((name, selected) => ({ ...captureInput(name, selected), scene_text: "changed scene" }));
  await click(button("보관")); await click(button("취소"));
  expect(textarea().value).toBe("latest");
  await click(button("보관"));
  expect(capture).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[3][1]).toEqual({ ...payload, description: "latest" });
});

it("exists 뒤 도착한 초기 목록은 서버가 방금 준 설명을 되돌리지 않는다", async () => {
  const listing = deferred<SceneKeepRow[]>();
  vi.mocked(sceneKeepApi.list).mockReturnValue(listing.promise);
  vi.spyOn(sceneKeepApi, "save").mockResolvedValue({ status: "exists", id: "a", revision: 2, updated_at: "now", description: "최신" });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관"));
  await act(async () => listing.resolve([described("옛 값")]));
  await click(button("취소"));
  expect(textarea().value).toBe("최신");
});

it("exists·conflict는 각각 서버 최신 설명을 덮어쓰기 사본과 취소 후 화면에 반영한다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("목록의 옛 설명")])
    .mockResolvedValueOnce([{ ...described("충돌 뒤 최신 설명"), revision: 7 }]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "exists 최신 설명" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "a", revision: 8, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  expect(textarea().value).toBe("목록의 옛 설명");
  await click(button("보관")); await click(button("덮어쓰기"));
  expect(save.mock.calls[1][1]).toEqual(expect.objectContaining({ description: "exists 최신 설명", overwrite_revision: 3 }));
  await click(button("취소"));
  expect(textarea().value).toBe("충돌 뒤 최신 설명");
  await click(button("보관"));
  expect(save.mock.calls[2][1]).toEqual(expect.objectContaining({ description: "충돌 뒤 최신 설명" }));
  expect(capture).toHaveBeenCalledTimes(1);
});

it("설명을 손대지 않고 연속 덮어쓰면 exists와 conflict가 준 최신 설명으로 갱신한다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("old")])
    .mockResolvedValueOnce([{ ...described("conflict-latest"), revision: 7 }]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "exists-latest" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "a", revision: 8, missing_count: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기")); await click(button("덮어쓰기"));
  expect(save.mock.calls.map(call => call[1].description)).toEqual(["old", "exists-latest", "conflict-latest"]);
  expect(save.mock.calls[2][1].overwrite_revision).toBe(7);
});

it("충돌 조회에서 행이 없어져도 마지막 설명과 캡처를 다음 보관에 그대로 쓴다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("old")]).mockResolvedValueOnce([]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "last-known" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "new", revision: 1, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기"));
  expect(textarea().value).toBe("last-known");
  await click(button("보관"));
  expect(save.mock.calls[2][1]).toEqual({ ...payload, description: "last-known" });
  expect(capture).toHaveBeenCalledTimes(1);
});

it.each(["  내가 쓴 글\n다음 줄  ", ""])("사용자가 쓴 설명 %j은 exists·conflict의 설명보다 우선한다", async text => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("기존")])
    .mockResolvedValueOnce([{ ...described("충돌 최신"), revision: 9 }]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "exists 최신" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "a", revision: 10, missing_count: 0 });
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={captureInput} onSaved={vi.fn()} onClose={vi.fn()} />));
  await change(textarea(), text);
  await click(button("보관")); await click(button("덮어쓰기")); await click(button("덮어쓰기"));
  expect(save.mock.calls.map(call => call[1].description)).toEqual([text, text, text]);
  expect(save.mock.calls[2][1].overwrite_revision).toBe(9);
});

it("충돌 뒤 보관본이 없어지면 설명과 캡처를 유지하고 설명 수정은 재시도 사본을 버린다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValueOnce([described("기존")]).mockResolvedValueOnce([]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "마지막 설명" })
    .mockResolvedValueOnce({ status: "conflict" })
    .mockResolvedValueOnce({ status: "saved", id: "b", revision: 1, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("덮어쓰기"));
  expect(textarea().value).toBe("마지막 설명");
  expect(capture).toHaveBeenCalledTimes(1);
  await change(textarea(), "다시 쓴 설명");
  await click(button("보관"));
  expect(save.mock.calls[2][1].description).toBe("다시 쓴 설명");
  expect(capture).toHaveBeenCalledTimes(2);
});

it("확인을 취소하고 이름을 바꾸면 다른 이름의 설명을 새 사본에 붙인다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("기존"), described("다른 씬 설명", "다른 씬")]);
  const save = vi.spyOn(sceneKeepApi, "save")
    .mockResolvedValueOnce({ status: "exists", id: "a", revision: 3, updated_at: "now", description: "최신" })
    .mockResolvedValueOnce({ status: "saved", id: "b", revision: 1, missing_count: 0 });
  const capture = vi.fn(captureInput);
  await act(async () => root.render(<SceneKeepDialog scope={scope} name="사본" projectId="p" projects={[project]} capture={capture} onSaved={vi.fn()} onClose={vi.fn()} />));
  await click(button("보관")); await click(button("취소"));
  await change(host.querySelector<HTMLInputElement>("input")!, "  다른 씬  ");
  expect(textarea().value).toBe("다른 씬 설명");
  await click(button("보관"));
  expect(save.mock.calls[1][1]).toEqual(expect.objectContaining({ name: "다른 씬", description: "다른 씬 설명" }));
  expect(capture).toHaveBeenCalledTimes(2);
});

it("카드 메뉴는 포털에 열리고 선택·화살표 초점·Esc 한 겹·바깥 닫기를 지킨다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([row("a"), row("b")]);
  const open = vi.fn(), close = vi.fn();
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={open} onClose={close} />));
  const cards = host.querySelectorAll<HTMLElement>('[role="listitem"]');
  expect(host.querySelector('[role="list"]')).not.toBeNull();
  expect(cards[1].tabIndex).toBe(0);
  await click(cards[0]);
  await contextMenu(cards[1], 99999, 99999);
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(host.contains(menu)).toBe(false);
  expect(cards[0].classList.contains("on")).toBe(false);
  expect(cards[1].classList.contains("on")).toBe(true);
  expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
  expect(parseFloat(menu.style.left) + 96).toBeLessThanOrEqual(window.innerWidth);
  expect(parseFloat(menu.style.top) + 64).toBeLessThanOrEqual(window.innerHeight);
  await act(async () => button("열기").focus());
  await key(button("열기"), "ArrowDown");
  expect(document.activeElement).toBe(button("삭제"));
  await key(button("삭제"), "ArrowUp");
  expect(document.activeElement).toBe(button("열기"));
  await key(window, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await contextMenu(cards[1]);
  await mouseDown(document.querySelector<HTMLElement>(".preview-menu-catcher")!);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  await act(async () => cards[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(open).not.toHaveBeenCalled();
});

it.each([["ContextMenu", false], ["F10", true]] as const)("메뉴 키 %s는 keydown 대신 브라우저 contextmenu에서 해당 카드를 연다", async (menuKey, shift) => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([row("a"), row("b")]);
  const open = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={open} onClose={vi.fn()} />));
  const card = host.querySelectorAll<HTMLElement>('[role="listitem"]')[1];
  await act(async () => card.focus());
  const down = new KeyboardEvent("keydown", { key: menuKey, shiftKey: shift, bubbles: true, cancelable: true });
  await act(async () => card.dispatchEvent(down));
  expect(down.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => card.dispatchEvent(new KeyboardEvent("keyup", { key: menuKey, shiftKey: shift, bubbles: true })));
  // jsdom does not synthesize the browser's native keyboard contextmenu event.
  await contextMenu(document.activeElement as HTMLElement);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await click(button("열기"));
  expect(open).toHaveBeenCalledExactlyOnceWith("b");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it.each(["Enter", " "])("카드의 %j 키는 해당 카드를 선택한다", async value => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([row("a"), row("b")]);
  const open = vi.fn();
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={open} onClose={vi.fn()} />));
  const cards = host.querySelectorAll<HTMLElement>('[role="listitem"]');
  await click(cards[0]);
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  await act(async () => cards[1].dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(cards[0].classList.contains("on")).toBe(false);
  expect(cards[1].classList.contains("on")).toBe(true);
  expect(open).not.toHaveBeenCalled();
});

it("설명 단추의 Enter는 카드가 취소하거나 선택을 바꾸지 않는다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([{ ...row("a"), description: "설명" }, row("b")]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  const cards = host.querySelectorAll<HTMLElement>('[role="listitem"]');
  await click(cards[1]);
  const description = cards[0].querySelector<HTMLButtonElement>(".scene-keep-item-desc")!;
  await act(async () => description.focus());
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => description.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(cards[0].classList.contains("on")).toBe(false);
  expect(cards[1].classList.contains("on")).toBe(true);
  // Complete the button activation that jsdom does not synthesize from Enter.
  await click(description);
  expect(document.querySelector('[aria-label="보관본 설명"]')).not.toBeNull();
  expect(cards[1].classList.contains("on")).toBe(true);
});

it("열기 처리 중에는 다른 카드 메뉴의 열기와 삭제를 모두 막는다", async () => {
  vi.mocked(sceneKeepApi.list).mockResolvedValue([row("a"), row("b")]);
  const pending = deferred<void>();
  const open = vi.fn().mockReturnValue(pending.promise), remove = vi.spyOn(sceneKeepApi, "remove");
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={open} onClose={vi.fn()} />));
  const cards = host.querySelectorAll<HTMLElement>(".scene-keep-item");
  await contextMenu(cards[0]); await click(button("열기"));
  await contextMenu(cards[1]);
  expect(button("열기").disabled).toBe(true); expect(button("삭제").disabled).toBe(true);
  await click(button("열기")); await click(button("삭제"));
  expect(open).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => pending.resolve());
});

it("설명은 글자로 줄바꿈 그대로 읽고 선택을 바꾸지 않으며 Esc·닫기·바깥은 읽기창만 닫는다", async () => {
  const text = '<img src=x onerror="alert(1)">\n둘째 줄\n  마지막  ';
  vi.mocked(sceneKeepApi.list).mockResolvedValue([{ ...row("a"), description: text }, row("b"), { ...row("none", ""), description: "없음 프로젝트" }]);
  const close = vi.fn(), open = vi.fn();
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={open} onClose={close} />));
  const cards = host.querySelectorAll<HTMLElement>(".scene-keep-item");
  expect(cards[1].querySelector(".scene-keep-item-desc")).toBeNull();
  expect(cards[2].querySelector(".ws-mark-box")).not.toBeNull(); // 프로젝트가 없어도 탭의 워크스페이스 소속이다(Jay 11-03)
  await click(cards[1]);
  const description = cards[0].querySelector<HTMLButtonElement>(".scene-keep-item-desc")!;
  expect(description.closest("button")?.querySelector("button")).toBeNull();
  for (const dismissal of ["escape", "close", "outside"]) {
    await click(description);
    const reading = document.querySelector<HTMLElement>('[role="dialog"][aria-label="보관본 설명"]')!;
    expect(reading).not.toBeNull();
    expect(reading.querySelector(".scene-keep-desc-body")?.textContent).toBe(text);
    expect(reading.querySelector("img")).toBeNull();
    expect(cards[1].classList.contains("on")).toBe(true);
    expect(cards[0].classList.contains("on")).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    if (dismissal === "escape") await key(window, "Escape");
    if (dismissal === "close") await click(reading.querySelector<HTMLButtonElement>('[title="닫기"]')!);
    if (dismissal === "outside") await mouseDown(reading.parentElement!);
    expect(document.querySelector('[aria-label="보관본 설명"]')).toBeNull();
    expect(host.querySelector('[aria-label="보관함"]')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  }
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => description.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(cards[0].classList.contains("on")).toBe(true);
  expect(cards[1].classList.contains("on")).toBe(false);
  expect(document.querySelector('[aria-label="보관본 설명"]')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  await click(button("열기"));
  expect(open).toHaveBeenCalledExactlyOnceWith("a");
});

it("설명 끝 흐림은 ResizeObserver 치수 변경과 1px 여유를 따른다", async () => {
  const observed: { callback: ResizeObserverCallback; element: Element | null; disconnect: ReturnType<typeof vi.fn> }[] = [];
  class Observer {
    record: typeof observed[number];
    constructor(callback: ResizeObserverCallback) { this.record = { callback, element: null, disconnect: vi.fn() }; observed.push(this.record); }
    observe(element: Element) { this.record.element = element; }
    unobserve() {}
    disconnect() { this.record.disconnect(); }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.mocked(sceneKeepApi.list).mockResolvedValue([described("설명")]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  const desc = host.querySelector<HTMLButtonElement>(".scene-keep-item-desc")!;
  const record = observed.find(record => record.element === desc.firstElementChild)!;
  expect(record).toBeDefined();
  const span = desc.firstElementChild!;
  Object.defineProperty(span, "clientHeight", { configurable: true, value: 40 });
  for (const [height, expected] of [[41, false], [42, true], [20, false]] as const) {
    Object.defineProperty(span, "scrollHeight", { configurable: true, value: height });
    await act(async () => record.callback([], {} as ResizeObserver));
    expect(desc.classList.contains("more")).toBe(expected);
  }
  await act(async () => root.render(null));
  expect(record.disconnect).toHaveBeenCalledOnce();
});

it("ResizeObserver가 없어도 처음 치수로 넘친 설명에만 흐림을 붙인다", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.textContent === "긴 설명" ? 60 : 40; });
  vi.mocked(sceneKeepApi.list).mockResolvedValue([{ ...row("a"), description: "긴 설명" }, { ...row("b"), description: "짧은 설명" }]);
  await act(async () => root.render(<SceneKeepWindow scope={scope} projects={[]} onOpen={vi.fn()} onClose={vi.fn()} />));
  expect([...host.querySelectorAll(".scene-keep-item-desc")].map(el => el.classList.contains("more"))).toEqual([true, false]);
});

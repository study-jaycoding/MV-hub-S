// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyConnectionSection, hasUnsavedComfySettings, keySourceOf, teamKeyText } from "../src/components/settings/ComfyConnectionSection";
import { comfyApi, type ComfySettings, type TeamKeyState } from "../src/lib/comfyApi";

const saved: ComfySettings = {
  comfy_url: "http://127.0.0.1:8188",
  comfy_target: "cloud",
  comfy_api_key: "***",
  has_api_key: true,
  comfy_concurrency: 5,
  comfy_input_dir: "",
};
const team: ComfySettings = {
  ...saved, comfy_target: "local", comfy_api_key: "", has_api_key: false,
  comfy_key_source: "team", team_key: { state: "available", updated_at: "2026-11-04T05:20:00Z" },
};
const STATES: TeamKeyState[] = ["available", "stale", "none", "unreachable", "undecryptable", "off"];

describe("Comfy 연결 설정 저장 경계", () => {
  it("서버에서 읽은 값 그대로면 바로 연결 확인할 수 있다", () => {
    expect(hasUnsavedComfySettings({ ...saved }, saved, "")).toBe(false);
  });

  it("연결 대상·주소·동시 실행·input 폴더 변경을 저장 전 상태로 판정한다", () => {
    expect(hasUnsavedComfySettings({ ...saved, comfy_target: "local" }, saved, "")).toBe(true);
    expect(hasUnsavedComfySettings({ ...saved, comfy_url: "http://127.0.0.1:8288" }, saved, "")).toBe(true);
    expect(hasUnsavedComfySettings({ ...saved, comfy_concurrency: 4 }, saved, "")).toBe(true);
    expect(hasUnsavedComfySettings({ ...saved, comfy_input_dir: "D:\\ComfyUI\\input" }, saved, "")).toBe(true);
  });

  it("새 API 키 입력도 저장 전 상태로 판정한다", () => {
    expect(hasUnsavedComfySettings({ ...saved }, saved, "new-key")).toBe(true);
  });

  it("키 출처 변경을 저장 전 상태로 판정하고, 옛 허브(출처 없음)는 개인 키로 본다", () => {
    expect(hasUnsavedComfySettings({ ...team, comfy_key_source: "personal" }, team, "")).toBe(true);
    expect(hasUnsavedComfySettings({ ...saved, comfy_key_source: "personal" }, saved, "")).toBe(false);
    expect(keySourceOf(saved)).toBe("personal");
    expect(keySourceOf(null)).toBe("personal");
  });
});

describe("'지금 쓰는 키' 안내 줄", () => {
  it("상태마다 다른 문구를 주고 말줄임표로 끝나지 않는다", () => {
    const texts = STATES.map((state) => teamKeyText(state, "2026-11-04T05:20:00Z"));
    expect(new Set(texts).size).toBe(STATES.length);
    for (const text of texts) expect(text).not.toMatch(/(\.\.\.|…)\s*$/);
    expect(teamKeyText("available", "2026-11-04T05:20:00Z")).toContain("관리자 등록 2026-11-04 05:20:00");
    expect(teamKeyText("stale", null)).toContain("마지막 받은 팀 키");
    expect(teamKeyText("none", null)).toContain("관리자에게");
    expect(teamKeyText("undecryptable", null)).toContain("다시 등록");
    expect(teamKeyText("off", null)).toContain("로그인과 접근 권한");
  });
});

describe("설정 화면", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function mount(settings: ComfySettings) {
    vi.spyOn(comfyApi, "settings").mockResolvedValue(settings);
    await act(async () => { root.render(createElement(ComfyConnectionSection)); });
    await act(async () => { await Promise.resolve(); });
  }
  const keyInput = () => host.querySelector<HTMLInputElement>('input[type="password"]')!;
  const radio = (value: string) => host.querySelector<HTMLInputElement>(`input[name="comfy-key-source"][value="${value}"]`)!;

  it("팀 키 모드는 API 키 칸을 잠그고 지금 쓰는 키를 보인다", async () => {
    await mount(team);
    expect(keyInput().disabled).toBe(true);
    expect(keyInput().placeholder).toContain("팀 키 사용 중");
    expect(host.querySelector(".comfy-key-now")?.textContent).toBe(teamKeyText("available", "2026-11-04T05:20:00Z"));
    expect(radio("team").checked).toBe(true);
  });

  it("개인 키로 바꾸면 칸이 풀리고 저장 본문에 키 출처가 실린다", async () => {
    await mount(team);
    const put = vi.spyOn(comfyApi, "setSettings").mockResolvedValue({ ...team, comfy_key_source: "personal" });
    await act(async () => { radio("personal").click(); });
    expect(keyInput().disabled).toBe(false);
    expect(host.querySelector(".comfy-key-now")).toBeNull();
    const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "저장")!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatchObject({ comfy_key_source: "personal" });
    expect(put.mock.calls[0][0]).not.toHaveProperty("comfy_api_key"); // 비워 둔 칸은 기존 키 유지
  });

  it("상태마다 안내 줄이 바뀌고 옛 허브(출처 없음)에는 키 출처 칸이 없다", async () => {
    for (const state of ["none", "off"] as const) {
      await mount({ ...team, team_key: { state, updated_at: null } });
      expect(host.querySelector(".comfy-key-now")?.textContent).toBe(teamKeyText(state, null));
      await act(async () => root.unmount());
      root = createRoot(host);
    }
    await mount(saved);
    expect(host.querySelector('input[name="comfy-key-source"]')).toBeNull();
    expect(keyInput().disabled).toBe(false);
  });
});

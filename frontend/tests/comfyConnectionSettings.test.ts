import { describe, expect, it } from "vitest";
import { hasUnsavedComfySettings } from "../src/components/settings/ComfyConnectionSection";
import type { ComfySettings } from "../src/lib/comfyApi";

const saved: ComfySettings = {
  comfy_url: "http://127.0.0.1:8188",
  comfy_target: "cloud",
  comfy_api_key: "***",
  has_api_key: true,
  comfy_concurrency: 5,
  comfy_input_dir: "",
};

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
});

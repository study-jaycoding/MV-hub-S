// withEffectiveDefaults — 저장된 옵션(모델 카드)을 하단 바에 적용할 때 실효 기본값 위에 얹는다(통째 바꿔치기 금지).
//  힉스필드 잡 기록엔 mode 가 없어 옛 생성물에서 복사한 설정은 mode 가 빈다(2026-09-09) — 화면은 기본값이 켜져 보이는데
//  전송값은 비어 CLI 기본 t2v 로 나가던 불일치의 프론트 쪽 방어.
import { describe, it, expect } from "vitest";
import { withEffectiveDefaults } from "../src/lib/useModels";
import type { ModelParam } from "../src/types";

const params = [
  { name: "mode", enum: ["t2v", "omni_reference", "video_edit", "video_extension"], default: "t2v" },
  { name: "duration", default: 5 },
  { name: "extension_mode", enum: ["backward", "forward"], default: null },
  { name: "prompt" },
] as unknown as ModelParam[];

describe("withEffectiveDefaults", () => {
  it("mode 없는 저장값(옛 생성물에서 복사) → 기본값 omni_reference 가 채워지고 저장값은 그대로", () => {
    expect(withEffectiveDefaults(params, "seedance_2_5", { duration: 12 })).toEqual({
      mode: "omni_reference",
      duration: 12,
    });
  });
  it("저장값의 mode 가 우선(사용자가 고른 video_edit) · 게이트 깨진 extension_mode 는 기본값에서 빠진다", () => {
    const out = withEffectiveDefaults(params, "seedance_2_5", { mode: "video_edit" });
    expect(out.mode).toBe("video_edit");
    expect("extension_mode" in out).toBe(false);
  });
});

// 조건부 파라미터 게이트 — extension_mode 는 mode=video_extension 에서만 CLI 가 허용한다.
// 회귀: 기본값 규칙(enum 첫값)이 backward 를 자동 선택해 t2v/omni/edit 생성이 전부
// CLI 거부("only allowed for mode 'video_extension'")되던 버그.
import { describe, expect, it } from "vitest";
import {
  correctedOptions,
  defaultOptions,
  paramGateAllows,
} from "../src/lib/useModels";
import type { ModelParam } from "../src/types";

const SEEDANCE_2_5_PARAMS: ModelParam[] = [
  { name: "mode", type: "string", default: "t2v", required: false, enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
  { name: "extension_mode", type: "string|null", default: null, required: false, enum: ["backward", "forward"] },
  { name: "duration", type: "integer", default: 5, required: false },
];

describe("PARAM_GATES (seedance_2_5.extension_mode)", () => {
  it("기본값(mode=t2v)에서는 extension_mode 를 처음부터 싣지 않는다", () => {
    const init = defaultOptions(SEEDANCE_2_5_PARAMS, "seedance_2_5");
    expect(init.mode).toBe("t2v");
    expect("extension_mode" in init).toBe(false);
  });

  it("mode 가 video_extension 이 아니면 잔존 extension_mode 를 제거한다", () => {
    for (const mode of ["t2v", "omni_reference", "video_edit"]) {
      const next = correctedOptions("seedance_2_5", SEEDANCE_2_5_PARAMS, {
        mode, extension_mode: "backward", duration: 4,
      });
      expect("extension_mode" in next).toBe(false);
      expect(next.mode).toBe(mode);
    }
  });

  it("mode=video_extension 으로 바꾸면 기본값(backward)을 채워 되살린다", () => {
    const next = correctedOptions("seedance_2_5", SEEDANCE_2_5_PARAMS, {
      mode: "video_extension", duration: 4,
    });
    expect(next.extension_mode).toBe("backward");
  });

  it("멱등 — 유효한 조합은 재보정해도 같은 참조를 돌려준다", () => {
    const valid = { mode: "video_extension", extension_mode: "forward", duration: 4 };
    expect(correctedOptions("seedance_2_5", SEEDANCE_2_5_PARAMS, valid)).toBe(valid);
    const plain = { mode: "t2v", duration: 4 };
    expect(correctedOptions("seedance_2_5", SEEDANCE_2_5_PARAMS, plain)).toBe(plain);
  });

  it("게이트가 없는 모델·파라미터는 항상 허용", () => {
    expect(paramGateAllows("seedance_2_0", "bitrate_mode", {})).toBe(true);
    expect(paramGateAllows("seedance_2_5", "duration", { mode: "t2v" })).toBe(true);
  });
});

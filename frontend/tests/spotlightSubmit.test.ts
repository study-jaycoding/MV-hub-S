// buildSpotlightCreateBody 특성화 — 생성 요청 body 의 마지막 관문(크레딧 낭비 직결).
import { describe, it, expect } from "vitest";
import {
  buildSpotlightCreateBody,
  normalizeSpotlightBatch,
} from "../src/lib/spotlightSubmit";
import type { ChipRef } from "../src/lib/promptEditor";

const img = (over: Partial<ChipRef> = {}): ChipRef => ({
  file_path: "asset:p|a.png",
  type: "image",
  role: "@Image",
  name: "소스",
  thumb: "",
  ...over,
});

const base = {
  parts: [],
  displayPrompt: "",
  optionValues: {},
  armedAutoTags: [],
};

describe("buildSpotlightCreateBody — Seedance 2.5 모드 계약", () => {
  const seedance = {
    ...base, model: "seedance_2_5", text: "장면 생성", inlineRefs: [], trayRefs: [],
  };
  const video = () => img({ type: "video", file_path: "asset:p|clip.mp4" });

  it("480p 신규 생성은 Draft이며 복사된 원격 Draft 번호를 재사용하지 않는다", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...seedance, optionValues: { resolution: "480p", draft_job_id: "old-remote-job", seed: 15 },
    });
    expect(error).toBeNull();
    expect(body?.params).toMatchObject({ resolution: "480p", draft: true, seed: 15 });
    expect(body?.params).not.toHaveProperty("draft_job_id");
  });

  it.each([
    { trayRefs: [], inlineRefs: [], mode: "t2v" },
    { trayRefs: [img()], inlineRefs: [], mode: "omni_reference" },
    { trayRefs: [], inlineRefs: [img()], mode: "omni_reference" },
    { trayRefs: [img()], inlineRefs: [video()], mode: "omni_reference" },
  ])("토큰 없이 트레이+인라인 첨부로 모드 결정: $mode", ({ trayRefs, inlineRefs, mode }) => {
    for (const initialMode of ["t2v", "omni_reference"]) {
      const options = Object.freeze({ mode: initialMode, duration: 8 });
      const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs, inlineRefs, optionValues: options });
      expect(error).toBeNull();
      expect(body?.params).toEqual({ mode, duration: 8 });
      expect(body?.references).toHaveLength(trayRefs.length + inlineRefs.length);
      expect(options).toEqual({ mode: initialMode, duration: 8 });
      expect(body?.params).not.toBe(options);
    }
  });

  it("빈 본문에 첨부만 있어도 omni로 전송한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "", trayRefs: [img()], optionValues: { mode: "t2v" } });
    expect(error).toBeNull();
    expect(body?.prompt).toBe("(no text)");
    expect(body?.params?.mode).toBe("omni_reference");
  });

  it("인라인 영상 하나로도 edit 가능하고 무시되는 길이·비율은 전송한다", () => {
    const options = Object.freeze({ mode: "video_edit", duration: 12, aspect_ratio: "auto" });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [img()], inlineRefs: [video()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).toEqual(options);
    expect(body?.references?.map((ref) => ref.role)).toEqual(["@Image1", "@Video1"]);
  });

  it("edit 영상 개수는 트레이+인라인 합계로 차단한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], inlineRefs: [video()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toBe("영상은 1개만 넣을 수 있습니다 — 지금 2개입니다.");
  });

  it.each(["video_edit", "video_extension"])("영상 없는 %s를 t2v로 바꾸어 제출하지 않는다", (mode) => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, optionValues: { mode, extension_mode: "forward" } });
    expect(body).toBeNull();
    expect(error).toContain(mode === "video_edit" ? "고칠 영상" : "이어붙일 영상");
  });

  it.each([undefined, null, "", " "])("extension_mode=%s이면 방향을 추측하지 않고 오류", (direction) => {
    const options = Object.freeze({ mode: "video_extension", extension_mode: direction });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, inlineRefs: [video()], optionValues: options });
    expect(body).toBeNull();
    expect(error).toContain("extension_mode");
    expect(options.extension_mode).toBe(direction);
  });

  it.each(["forward", "backward"])("extension은 복수 영상과 명시한 %s 방향을 유지", (direction) => {
    const options = Object.freeze({ mode: "video_extension", extension_mode: direction, duration: 9, aspect_ratio: "16:9" });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], inlineRefs: [video(), img()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).toEqual(options);
    expect(body?.references).toHaveLength(3);
  });

  it.each(["t2v", "omni_reference", "video_edit"])("%s의 잔존 방향은 복사본에서만 제거", (mode) => {
    const options = Object.freeze({ mode, extension_mode: "backward", duration: 8 });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).not.toHaveProperty("extension_mode");
    expect(options).toEqual({ mode, extension_mode: "backward", duration: 8 });
  });

  it("토큰 정합 오류를 모드 오류보다 먼저 알린다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "@simage2", trayRefs: [img()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toBe("이미지 레퍼런스 2번이 없습니다.");
  });

  it.each(["@simage1", "@eimage1"])("edit의 유효한 이미지 토큰 %s도 모드 검사로 막는다", (token) => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: token, trayRefs: [img(), video()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toContain("첫/끝 프레임은 레퍼런스 모드에서만");
  });

  it("첫/끝 프레임만 붙어도 omni로 선택하고 역할을 보존한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "@simage1 @eimage2", trayRefs: [img(), img()], optionValues: { mode: "t2v" } });
    expect(error).toBeNull();
    expect(body?.params?.mode).toBe("omni_reference");
    expect(body?.references?.map((ref) => ref.role)).toEqual(["@Start", "@End"]);
  });

  it.each(["seedance_2_0", "seedance_2_0_mini"])("%s의 std/fast·파라미터에는 간섭하지 않는다", (model) => {
    for (const mode of ["std", "fast"]) {
      const options = Object.freeze({ mode, extension_mode: "backward" });
      const { body, error } = buildSpotlightCreateBody({ ...seedance, model, trayRefs: [img()], optionValues: options });
      expect(error).toBeNull();
      expect(body?.params).toEqual(options);
    }
  });
});

describe("buildSpotlightCreateBody — 없는 레퍼런스 토큰 차단", () => {
  it("트레이에 이미지 1개인데 @image2 를 쓰면 에러(크레딧 낭비 방지)", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "@image2 스타일",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(body).toBeNull();
    expect(error).toContain("2번");
  });
  it("있는 번호(@image1)면 통과", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "@image1 스타일",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(error).toBeNull();
    expect(body).not.toBeNull();
  });
});

describe("buildSpotlightCreateBody — 영상 모델 레퍼런스 규칙(CLI 거절 조합)", () => {
  const gemini = { ...base, model: "gemini_omni_flash_1_2", text: "움직인다", inlineRefs: [] };
  it("Gemini Omni 에 레퍼런스가 있으면 길이를 10초로 줄여 보낸다(칸이 보여 준 값과 같다), 없으면 15초 그대로", () => {
    const withRef = buildSpotlightCreateBody({ ...gemini, optionValues: { mode: "text-to-video", duration: 15 }, trayRefs: [img()] });
    expect(withRef.error).toBeNull();
    expect(withRef.body!.params!.duration).toBe(10);
    const textOnly = buildSpotlightCreateBody({ ...gemini, optionValues: { mode: "text-to-video", duration: 15 }, trayRefs: [] });
    expect(textOnly.body!.params!.duration).toBe(15);
  });
  it("Kling·Gemini 에 오디오 레퍼런스를 넣으면 요청을 만들지 않고 이유를 알린다", () => {
    const audio = img({ type: "audio", file_path: "asset:p|a.mp3" });
    for (const model of ["kling4_0", "gemini_omni_flash_1_2"]) {
      const { body, error } = buildSpotlightCreateBody({ ...base, model, text: "x", inlineRefs: [], trayRefs: [img(), audio] });
      expect(body).toBeNull();
      expect(error).toContain("오디오");
    }
    expect(buildSpotlightCreateBody({ ...base, model: "wan3_0", text: "x", inlineRefs: [], trayRefs: [img(), audio] }).error).toBeNull();
  });
});

describe("buildSpotlightCreateBody — 레퍼런스 개수 한도", () => {
  it("한도를 넘으면 요청을 만들지 않고 이유를 알린다(이미지·영상 모델 모두), 한도 안이면 그대로", () => {
    const many = (n: number) => Array.from({ length: n }, () => img());
    const run = (model: string, tray: ChipRef[]) => buildSpotlightCreateBody({ ...base, model, text: "x", inlineRefs: [], trayRefs: tray } as never);
    expect(run("gemini_omni_flash_1_2", many(8)).error).toContain("7개까지");
    expect(run("gemini_omni_flash_1_2", many(7)).error).toBeNull();
    expect(run("seedream_5_5", many(11)).error).toContain("10개까지");
    expect(run("nano_banana_pro", many(14)).error).toBeNull();
    expect(run("seedance_2_0", many(10)).error).toContain("9개까지");
    expect(run("gpt_image_2_6", many(16)).error).toBeNull();
  });
});

describe("buildSpotlightCreateBody — 시작·끝 프레임(@simage·@eimage)을 새 영상 모델에도", () => {
  const frames = (model: string, text: string, tray: ChipRef[], optionValues: Record<string, unknown> = { duration: 4 }) =>
    buildSpotlightCreateBody({ ...base, model, text, inlineRefs: [], trayRefs: tray, optionValues } as never);
  it("Kling·Gemini·Wan·MiniMax 도 @simage·@eimage 를 @Start·@End 로 보낸다(예전엔 일반 이미지 참조였다)", () => {
    for (const model of ["kling4_0", "gemini_omni_flash_1_2", "wan3_0", "wan3_0_prime", "minimax_h3", "minimax_h3_max"]) {
      const { body, error } = frames(model, "@simage1 에서 @eimage2 로 천천히 이동", [img(), img()]);
      expect(error).toBeNull();
      expect(body!.references!.map((r) => r.role)).toEqual(["@Start", "@End"]);
      expect(body!.prompt).toBe("첫 프레임 에서 끝 프레임 로 천천히 이동");
    }
  });
  it("프레임이 아닌 이미지는 번호가 이어진다(@Image1), Kling 은 프레임+참조를 함께 보낸다", () => {
    const { body, error } = frames("kling4_0", "@simage1 에서 시작해 @image2 의 인물처럼", [img(), img()]);
    expect(error).toBeNull();
    expect(body!.references!.map((r) => r.role)).toEqual(["@Start", "@Image1"]);
    expect(body!.prompt).toBe("첫 프레임 에서 시작해 <<<image1>>> 의 인물처럼");
  });
  it("모델 제약 — 끝만·Flash 끝·Gemini/Wan/MiniMax 의 프레임+참조는 요청을 만들지 않고 이유를 알린다", () => {
    expect(frames("kling4_0", "@eimage1 로", [img()]).error).toContain("시작 프레임");
    expect(frames("kling_4_0_flash", "@simage1 에서 @eimage2 로", [img(), img()]).error).toContain("Flash");
    expect(frames("kling_4_0_flash", "@simage1 에서", [img()]).error).toBeNull();
    for (const model of ["gemini_omni_flash_1_2", "wan3_0", "minimax_h3"]) {
      expect(frames(model, "@simage1 에서 @image2 처럼", [img(), img()]).error).toContain("함께 쓸 수 없습니다");
    }
  });
  it("프레임을 안 쓰는 일반 참조는 종전 그대로 @Image 로 나가고 Seedance 의 프레임도 그대로다", () => {
    const plain = frames("wan3_0", "@image1 처럼", [img()]);
    expect(plain.body!.references!.map((r) => r.role)).toEqual(["@Image1"]);
    expect(frames("seedance_2_0", "@simage1 에서 @eimage2 로", [img(), img()], { mode: "std" }).body!.references!.map((r) => r.role)).toEqual(["@Start", "@End"]);
  });
  it("Gemini 는 시작 한 장은 15초 그대로, 시작+끝은 10초로 줄인다", () => {
    expect(frames("gemini_omni_flash_1_2", "@simage1 에서", [img()], { mode: "text-to-video", duration: 15 }).body!.params!.duration).toBe(15);
    expect(frames("gemini_omni_flash_1_2", "@simage1 에서 @eimage2 로", [img(), img()], { mode: "text-to-video", duration: 15 }).body!.params!.duration).toBe(10);
  });
});

describe("buildSpotlightCreateBody — 역할 번호 부여", () => {
  it("트레이 이미지들은 @Image1,@Image2 로 순번(타입별)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "합성",
      inlineRefs: [],
      trayRefs: [img(), img({ type: "video" }), img()],
      model: "nano_banana",
    });
    const roles = body!.references!.map((r) => r.role);
    expect(roles).toEqual(["@Image1", "@Video1", "@Image2"]);
  });
});

describe("buildSpotlightCreateBody — 일반 태그와 전역 태그 분리", () => {
  it("Set 태그는 tags, 상단 전역 태그는 auto_tags로 보낸다", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "생성",
      inlineRefs: [],
      trayRefs: [],
      model: "nano_banana",
      tags: ["set-tag"],
      armedAutoTags: ["global-tag"],
    });
    expect(error).toBeNull();
    expect(body).toMatchObject({ tags: ["set-tag"], auto_tags: ["global-tag"] });
  });
});

describe("buildSpotlightCreateBody — CLI 프롬프트 한 줄 강제", () => {
  it("줄바꿈은 공백으로 합쳐진다(레퍼런스 부착 깨짐 방지)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "첫 줄\n둘째 줄",
      inlineRefs: [],
      trayRefs: [],
      model: "nano_banana",
    });
    expect(body!.prompt).toBe("첫 줄 둘째 줄");
  });
  it("빈 텍스트+레퍼런스만이면 (no text)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(body!.prompt).toBe("(no text)");
  });
});

describe("normalizeSpotlightBatch — 배치 요청 안전 범위", () => {
  it("노드 override는 정수화하고 1~4 범위로 제한한다", () => {
    expect(normalizeSpotlightBatch(0, 2, 4)).toBe(1);
    expect(normalizeSpotlightBatch(2.9, 1, 4)).toBe(2);
    expect(normalizeSpotlightBatch(9999, 1, 4)).toBe(4);
  });

  it("유효하지 않은 override는 UI 값을 쓰고, UI 값도 비정상이면 1로 복구한다", () => {
    expect(normalizeSpotlightBatch(Number.NaN, 3, 4)).toBe(3);
    expect(normalizeSpotlightBatch(Number.POSITIVE_INFINITY, 2, 4)).toBe(2);
    expect(normalizeSpotlightBatch(undefined, Number.NaN, 4)).toBe(1);
  });
});

// 26회차(조작 규칙 53, Codex 코드 리뷰): Set 카드의 태그는 태그 편집기의 검사를 거치지 않고 여기로 온다 — / 나 점만의 이름은 만들 수는 있어도 지울 수 없다.
describe("buildSpotlightCreateBody — 태그 이름", () => {
  const plain = { ...base, model: "nano_banana_flash", text: "장면", inlineRefs: [], trayRefs: [] };
  it("Set 카드의 태그에 / 나 점만의 이름이 있으면 요청을 만들지 않는다 — 조용히 빼지 않는다", () => {
    for (const bad of ["look/dev", ".", ".."]) {
      const { body, error } = buildSpotlightCreateBody({ ...plain, tags: ["hero", bad] });
      expect(body).toBeNull();
      expect(error).toContain("Set 카드의 태그");
    }
    const { body, error } = buildSpotlightCreateBody({ ...plain, tags: ["hero", "v.2"] }); // 점이 섞인 이름은 괜찮다
    expect(error).toBeNull();
    expect(body?.tags).toEqual(["hero", "v.2"]);
  });
});

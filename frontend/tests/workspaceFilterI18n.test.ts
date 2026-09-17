// @vitest-environment jsdom
// 라이브러리 툴바는 영어로 나오는데 그 안의 워크스페이스 필터·레퍼런스 역할 메뉴만
//  한국어로 남아 있었다(2026-09-15). 사전에서 빠지면 여기서 잡힌다.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../src/lib/i18n";

afterEach(() => setLang("ko"));

// 두 컴포넌트가 화면에 내보내는 문구 전부 — 늘어나면 여기도 늘려야 한다.
const WORKSPACE_FILTER = [
  "워크스페이스로 걸러 보기",
  "현재 워크스페이스 따라가기",
  "워크스페이스 변경 시 자동 적용으로 돌아갑니다.",
  "전체 보기",
  "자동",
  "수동",
  "확인 중",
  "이 워크스페이스만 빼기",
  "나머지는 버튼을 눌러 목록에서 뺄 수 있습니다",
  "불러오는 중…",
  "목록을 못 받았습니다 — 다시 시도",
  "속한 팀 워크스페이스가 없습니다.",
];
const REF_ROLE_MENU = [
  "레퍼런스 역할",
  "첫 프레임",
  "끝 프레임",
  "옴니 레퍼런스",
  "레퍼런스 모드에서만 지정할 수 있습니다.",
];

describe("워크스페이스 필터·레퍼런스 역할 메뉴 영어 문구", () => {
  it("English 로 바꾸면 한국어가 남지 않는다", () => {
    setLang("en");
    for (const ko of [...WORKSPACE_FILTER, ...REF_ROLE_MENU]) {
      const en = t(ko);
      expect(en, ko + " 사전 없음").not.toBe(ko);
      expect(en, ko + " 번역에 한글이 남음").not.toMatch(/[가-힣]/);
    }
  });

  it("한국어로 되돌리면 원문 그대로다", () => {
    setLang("ko");
    for (const ko of [...WORKSPACE_FILTER, ...REF_ROLE_MENU]) {
      expect(t(ko)).toBe(ko);
    }
  });

  it("칩 툴팁은 공간 이름을 번역하지 않고 끼워 넣는다", () => {
    const key = '지금 "{name}" 워크스페이스에 속한 것만 보는 중 (만든 곳이 아니라 현재 소속)';
    setLang("en");
    const en = t(key).replace("{name}", "우리팀 A");
    expect(en).toContain("우리팀 A"); // 사용자 자료는 그대로
    expect(en).not.toContain("{name}");
    expect(en.replace("우리팀 A", "")).not.toMatch(/[가-힣]/);
    setLang("ko");
    expect(t(key).replace("{name}", "우리팀 A")).toContain('지금 "우리팀 A"');
  });
});

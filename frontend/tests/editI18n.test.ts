// @vitest-environment jsdom
// 편집 탭의 편집 공유·단축키 창·V0·트랙 메뉴가 영어 화면에서 한국어로 남던 것(2026-10-23 묶음 정리). 목록을 손으로 적지 않고
//  소스의 t("…") 를 읽어 영어 사전에 있는지 본다 — 새 문구를 더하고 번역을 빠뜨리면 여기서 잡힌다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ERROR_TEXT } from "../src/components/timeline/EditShareMenu";
import { EDIT_ACTIONS, EDIT_GROUPS, slotText } from "../src/lib/editShortcuts";
import { setLang, t } from "../src/lib/i18n";

afterEach(() => setLang("ko"));

const FILES = [
  "components/timeline/EditShareMenu.tsx", "components/timeline/EditShareViewer.tsx", "components/timeline/EditShortcutsWindow.tsx",
  "components/timeline/EditTrackMenu.tsx", "components/timeline/EditViewer.tsx", "components/timeline/EditBackupPanel.tsx",
  "lib/editShortcuts.ts", "lib/editShare.ts",
];
const korean = (file: string) => {
  const src = readFileSync(resolve(fileURLToPath(import.meta.url), "../../src", file), "utf8"); // jsdom 의 URL 로는 경로가 안 풀린다
  return [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((text) => /[가-힣]/.test(text));
};

it("편집 공유·단축키 창·V0·트랙 메뉴·백업 경고가 t() 로 부르는 한국어는 모두 영어 사전에 있다", () => {
  setLang("en");
  const missing = FILES.flatMap((file) => korean(file).filter((text) => t(text) === text).map((text) => `${file} :: ${text}`));
  expect(missing).toEqual([]);
  expect(FILES.reduce((n, file) => n + korean(file).length, 0)).toBeGreaterThan(60); // 소스를 실제로 읽었다(정규식이 빈 손이 아니다)
});

// 표의 값을 t(값) 로 부르는 곳(정규식이 못 본다 — Codex 묶음 검토 R3): 단축키 창의 동작·묶음 이름, 편집 공유 오류
it("단축키 창의 동작·묶음 이름과 편집 공유 오류 문구도 영어가 있다(표의 값을 직접)", () => {
  setLang("en");
  const values = [...EDIT_ACTIONS.map((def) => def.label), ...Object.values(EDIT_GROUPS), ...Object.values(ERROR_TEXT)];
  expect(values.length).toBeGreaterThan(45);
  expect(values.filter((text) => /[가-힣]/.test(text) && t(text) === text)).toEqual([]);
  // 칸 글자(휠)도 — 실제 화면 실측에서 'Alt + 휠↑' 가 남았다
  expect(["alt+wheelup", "shift+wheeldown", "ctrl+wheel"].map((slot) => slotText(slot, true))).toEqual(["Alt + Wheel↑", "Shift + Wheel↓", "Ctrl + Wheel"]);
  setLang("ko");
  expect(slotText("alt+wheelup", true)).toBe("Alt + 휠↑");
});

it("백업 경고의 라벨 표(t(label) 로 부른다)도 영어가 있다", () => {
  setLang("en");
  for (const text of ["자동 백업 멈춤 · 다른 편집은 사본으로 보존", "DB 백업 실패 · 연결 후 다시 시도", "읽을 수 없는 원문 · DB 백업 안 됨", "1 MiB 초과 · DB 백업 안 됨"]) {
    expect(t(text)).not.toBe(text);
  }
});

it("단축키 창의 조각 문장은 영어 어순으로 읽힌다", () => {
  setLang("en");
  expect(`"A" ${t("은(는) 이미")} "B"${t("에 사용 중입니다.")}`).toBe(`"A" is already used by "B".`);
  expect(`${t("저장돼 있던")} "A" ${t("의 지정은")} ${t("다른 동작과 겹쳐")} ("B") ${t("기본값으로 돌렸습니다.")}`)
    .toBe(`Saved binding for "A" was in conflict with another action ("B") — reset to default.`);
  expect(`"X" ${t("은(는)")} "W"${t("가 먼저 받습니다")} — "S" ${t("의 Shift 변형 대신.")}`).toBe(`"X" goes to "W" first — "S" loses its Shift variant.`);
});

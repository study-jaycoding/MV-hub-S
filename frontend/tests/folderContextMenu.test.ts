// 폴더 우클릭 메뉴 순수 규칙 — 탭별 동작·폴더 색조·확인 문구·화면 가장자리 보정.
import { describe, it, expect } from "vitest";
import {
  clampMenuPosition,
  folderConfirmText,
  folderMenuKind,
  folderMenuLabel,
  folderTone,
  FOLDER_MENU_H,
  FOLDER_MENU_W,
} from "../src/lib/folderContextMenu";

describe("folderContextMenu", () => {
  it("내 작업 탭=팀에 공유 · 팀 탭=최종 경로로 저장", () => {
    expect(folderMenuLabel(folderMenuKind("my"))).toBe("팀에 공유");
    expect(folderMenuLabel(folderMenuKind("team"))).toBe("최종 경로로 저장");
  });
  it("버튼 색조는 폴더 자체의 깊이(최상위=하늘색 root, 하위=라임 child) — 선택 분홍과 무관", () => {
    expect(folderTone(0)).toBe("root");
    expect(folderTone(1)).toBe("child");
    expect(folderTone(3)).toBe("child");
  });
  it("확인 문구에 폴더 이름과 범위(하위 포함·대상 기준)가 들어간다", () => {
    expect(folderConfirmText("share", "e020")).toContain("'e020' 폴더를 공유하시겠습니까?");
    expect(folderConfirmText("share", "e020")).toContain("하위 폴더까지 포함");
    expect(folderConfirmText("save-finals", "c0010")).toContain("최종 경로로 저장하시겠습니까?");
    expect(folderConfirmText("save-finals", "c0010")).toContain("저장 대상 최종본만");
  });
  it("화면 가장자리에서 메뉴가 잘리지 않게 좌표를 안쪽으로 민다", () => {
    expect(clampMenuPosition(10, 20, 1000, 800)).toEqual({ left: 10, top: 20 });
    const p = clampMenuPosition(990, 795, 1000, 800);
    expect(p.left).toBe(1000 - FOLDER_MENU_W - 4);
    expect(p.top).toBe(800 - FOLDER_MENU_H - 4);
    expect(clampMenuPosition(-5, -5, 1000, 800)).toEqual({ left: 4, top: 4 });
  });
});

// 폴더 우클릭 메뉴 순수 규칙 — 탭별 동작·폴더 색조·확인 문구·화면 가장자리 보정.
import { describe, it, expect } from "vitest";
import {
  ackAllLabel,
  clampMenuPosition,
  folderConfirmText,
  folderMenuHeight,
  folderMenuKind,
  folderMenuLabel,
  folderTone,
  FOLDER_MENU_BTN_H,
  FOLDER_MENU_H,
  FOLDER_MENU_W,
  freshItemsInScope,
} from "../src/lib/folderContextMenu";

describe("folderContextMenu", () => {
  it("'모두 확인' 범위 — path '' 는 프로젝트 전체(폴더 미지정 포함), 폴더는 그 폴더와 하위만, 확인분 제외", () => {
    const at = "2026-09-10 01:00:00";
    const items = [
      { id: "a", project_id: "p", folder_path: "e020/c0010", shared_at: at, ack_key: "job-a" },
      { id: "b", project_id: "p", folder_path: "e020/c0020", shared_at: at },
      { id: "c", project_id: "p", folder_path: null, shared_at: at },
      { id: "d", project_id: "q", folder_path: "e020/c0010", shared_at: at },
      { id: "e", project_id: "p", folder_path: "e0200/c0010", shared_at: at }, // 접두 유사 폴더는 제외
    ];
    const none = () => false;
    expect(freshItemsInScope(items, "p", "", none).map((it) => it.id)).toEqual(["a", "b", "c", "e"]);
    expect(freshItemsInScope(items, "p", "e020", none).map((it) => it.id)).toEqual(["a", "b"]);
    expect(freshItemsInScope(items, "p", "e020/", none).map((it) => it.id)).toEqual(["a", "b"]);
    expect(freshItemsInScope(items, "p", "e020/c0010", none).map((it) => it.id)).toEqual(["a"]);
    // 확인(ack)된 항목은 ack_key(없으면 id)로 제외
    const acked = (key: string) => key === "job-a" || key === "c";
    expect(freshItemsInScope(items, "p", "", acked).map((it) => it.id)).toEqual(["b", "e"]);
  });
  it("'모두 확인' 라벨과 메뉴 높이(단추 수만큼)", () => {
    expect(ackAllLabel(406)).toBe("모두 확인 (+406)");
    expect(folderMenuHeight(1)).toBe(FOLDER_MENU_H);
    expect(folderMenuHeight(2)).toBe(FOLDER_MENU_H + FOLDER_MENU_BTN_H);
    expect(folderMenuHeight(3)).toBe(FOLDER_MENU_H + 2 * FOLDER_MENU_BTN_H);
    expect(folderMenuHeight(0)).toBe(FOLDER_MENU_H);
  });
  it("내 작업 탭=팀에 공유 · 팀 탭=골드만 저장과 원본 위치 열기", () => {
    expect(folderMenuLabel(folderMenuKind("my"))).toBe("팀에 공유");
    expect(folderMenuLabel(folderMenuKind("team"))).toBe("골드만 저장");
    expect(folderMenuLabel("open-folder")).toBe("원본 위치 열기");
  });
  it("버튼 색조는 폴더 자체의 깊이(최상위=하늘색 root, 하위=라임 child) — 선택 분홍과 무관", () => {
    expect(folderTone(0)).toBe("root");
    expect(folderTone(1)).toBe("child");
    expect(folderTone(3)).toBe("child");
  });
  it("확인 문구에 폴더 이름과 범위(하위 포함·대상 기준)가 들어간다", () => {
    expect(folderConfirmText("share", "e020")).toContain("'e020' 폴더를 공유하시겠습니까?");
    expect(folderConfirmText("share", "e020")).toContain("하위 폴더까지 포함");
    expect(folderConfirmText("save-finals", "c0010")).toContain("골드만 저장하시겠습니까?");
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

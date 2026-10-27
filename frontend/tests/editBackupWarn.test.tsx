// @vitest-environment jsdom
// DB 백업 경고(2026-10-23) — '저장·백업 안내'를 없애면서 실패·충돌이 보일 곳까지 사라졌다(Codex 묶음 검토 R2).
//  잃을 수 있는 상태(conflict·error·invalid·too_big)에만 경고 하나. 연결 대기·정상은 아무것도 없다.
//  2026-10-24 부터 막대의 알약이 아니라 화면 위 알림 줄(편집 탭이 '백업 보기' 단추와 함께 올린다 — editNotices 시험).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const backup = vi.hoisted(() => ({ state: "idle" as string, listeners: new Set<() => void>() }));
vi.mock("../src/lib/editDocBackup", async () => ({
  ...(await vi.importActual<object>("../src/lib/editDocBackup")),
  getEditBackupStatus: () => ({ state: backup.state, skipped: 0 }),
  subscribeEditBackup: (fn: () => void) => { backup.listeners.add(fn); return () => backup.listeners.delete(fn); },
}));

import { useEditBackupWarn } from "../src/components/timeline/EditBackupPanel";

let host: HTMLDivElement;
let root: Root;
let warn: ReturnType<typeof useEditBackupWarn> = null;
const set = (state: string) => act(() => { backup.state = state; backup.listeners.forEach((fn) => fn()); });
function Probe() {
  warn = useEditBackupWarn("mvhub.editDoc:local:p1:e070");
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  backup.state = "idle";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("실패·충돌·읽을 수 없음·1 MiB 초과에만 경고(상태가 열쇠) · 연결 대기·정상은 없다", () => {
  act(() => root.render(<Probe />));
  for (const quiet of ["off", "idle", "pending", "saving", "saved"]) {
    set(quiet);
    expect([quiet, warn]).toEqual([quiet, null]);
  }
  const shown: Record<string, string> = {
    conflict: "자동 백업 멈춤 · 다른 편집은 사본으로 보존", error: "DB 백업 실패 · 연결 후 다시 시도",
    invalid: "읽을 수 없는 원문 · DB 백업 안 됨", too_big: "1 MiB 초과 · DB 백업 안 됨",
  };
  for (const [state, text] of Object.entries(shown)) {
    set(state);
    expect(warn).toEqual({ state, text });
  }
  set("saved"); // 다시 저장되면 사라진다
  expect(warn).toBeNull();
});

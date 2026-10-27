// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyEditDoc, insertClip } from "../src/lib/editTimeline";
import { useEditDoc } from "../src/lib/useEditDoc";
import { editDocKey, keepUnsavedEditDoc, noteEditRaw, readEditRaw, writeEditRaw } from "../src/lib/editTimelineStore";
import { getEditBackupStatus, loadEditBackup, retryEditBackups, startEditDocBackup, stopEditDocBackup } from "../src/lib/editDocBackup";
import { getApiPause, jsonFetch, setApiPause, setAuthToken } from "../src/lib/http";
import { setAccountScope } from "../src/lib/accountScope";
import { EditBackupPanel } from "../src/components/timeline/EditBackupPanel";

vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: vi.fn() }));
const request = vi.mocked(jsonFetch);
const target = { projectId: "p", seq: "e070" };
const makeRaw = (gen: string) => JSON.stringify(insertClip(emptyEditDoc(), { cut: "e070/c1", gen, kind: "video", dur: 5 }));
const meta = (raw: string, revision = 1) => ({ data: raw, revision, data_hash: `hash-${revision}`, updated_at: `2026-10-17T12:00:0${revision}Z`, bytes: raw.length });
const listing = (raw: string | null, revision = 1) => ({ head: raw === null ? null : meta(raw, revision), copies: [], total_copies: 0 });
let host: HTMLDivElement;
let root: Root;
let key: string;
let edit: ReturnType<typeof useEditDoc>;
let canonical: string | null;
let revision: number;
let serial = 0;
let copies: string[];
const flash = vi.fn();
function Harness({ recover = false, panel = false }: { recover?: boolean; panel?: boolean }) {
  edit = useEditDoc(key, flash, recover ? target : undefined);
  return panel ? <EditBackupPanel docKey={key} target={target} edit={edit} onClose={() => {}} /> : null;
}
const render = (recover = false) => act(() => root.render(<Harness recover={recover} />));
const tick = async (ms = 2100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const editOnce = (gen: string) => act(() => { edit.applyEdit((doc) => insertClip(doc, { cut: "e070/c1", gen, kind: "video", dur: 5 })); });
const puts = () => request.mock.calls.filter(([, init]) => init?.method === "PUT");
const bodyOf = (call: typeof request.mock.calls[number]) => JSON.parse(String(call[1]?.body));

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); setAccountScope(""); setAuthToken(null); setApiPause(null);
  canonical = null; revision = 0; copies = []; flash.mockReset(); request.mockReset();
  target.projectId = `p${++serial}`;
  key = editDocKey(target.projectId, target.seq);
  request.mockImplementation(async (url, init) => {
    if (getApiPause()) throw new Error("paused");
    if (!init?.method) return listing(canonical, revision) as never;
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith("/restore")) { // 백엔드 restore_edit_backup 과 같게 — 같은 원문이면 same(판 그대로)
      const data = body.source.data ?? copies[0];
      const same = canonical === data;
      if (!same && body.base_revision !== (canonical === null ? null : revision)) return { status: "conflict", head: canonical && meta(canonical, revision) } as never;
      if (body.local_raw !== null && body.local_raw !== data && body.local_raw !== canonical) copies.push(body.local_raw);
      if (same) return { status: "same", head: meta(canonical!, revision), data } as never;
      if (canonical !== null) copies.push(canonical);
      canonical = data; revision += 1;
      return { status: "saved", head: meta(canonical!, revision), data } as never;
    }
    if (canonical === body.data) return { status: "same", head: meta(canonical!, revision) } as never;
    if (body.base_revision !== (canonical === null ? null : revision)) {
      copies.push(body.data);
      return { status: "conflict", head: meta(canonical!, revision) } as never;
    }
    canonical = body.data; revision += 1;
    return { status: "saved", head: meta(canonical!, revision) } as never;
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); stopEditDocBackup(); keepUnsavedEditDoc(key, null);
  setApiPause(null); vi.useRealTimers(); vi.restoreAllMocks();
});

it("실제 편집 훅의 성공한 저장을 2초 뒤 원문 그대로 계정 헤더와 백업한다", async () => {
  startEditDocBackup(); render(); editOnce("first");
  expect(puts()).toHaveLength(0);
  await tick();
  expect(canonical).toBe(readEditRaw(key).kind === "ok" ? localStorage.getItem(key) : null);
  expect(bodyOf(puts()[0]).base_revision).toBeNull();
  expect(puts()[0][1]?.headers).toEqual({ "X-MVHub-Expect-Account": "local" });
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("동일 원문이 서버에 있으면 GET 확인만 하고 쓰지 않는다", async () => {
  canonical = makeRaw("same"); revision = 9; localStorage.setItem(key, canonical);
  startEditDocBackup(); await tick();
  noteEditRaw(key, canonical); retryEditBackups(); await tick();
  expect(puts()).toHaveLength(0);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("로컬 저장에 실패한 작업본은 서버로 보내지 않는다", async () => {
  startEditDocBackup(); render();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  editOnce("unsaved"); await tick();
  expect(edit.dirty).toBe(true); expect(request).not.toHaveBeenCalled();
});
it("열지 않은 옛 문서도 스캔하고 새 자리가 있으면 그것을 우선한다", async () => {
  const old = key.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(old, makeRaw("old")); localStorage.setItem(key, makeRaw("new"));
  localStorage.setItem(`${old}.bad`, makeRaw("bad-copy"));
  startEditDocBackup(); await tick();
  expect(puts()).toHaveLength(1); expect(canonical).toBe(makeRaw("new"));
  expect(localStorage.getItem(old)).toBe(makeRaw("old"));
});
it("옛 키만 있는 opaque 문서 이름을 분해하지 않고 백업한다", async () => {
  const old = "ch.editTimeline:local:a:b:c:d";
  localStorage.setItem(old, makeRaw("legacy")); startEditDocBackup(); await tick();
  expect(bodyOf(puts()[0]).doc_key).toBe("a:b:c:d");
});
it("처음 로컬과 head가 다르면 판 번호를 승계하지 않고 충돌 사본을 보존한다", async () => {
  canonical = makeRaw("other-tab"); revision = 5; localStorage.setItem(key, makeRaw("stale"));
  startEditDocBackup(); await tick();
  expect(bodyOf(puts()[0]).base_revision).toBeNull(); expect(canonical).toBe(makeRaw("other-tab"));
  expect(copies).toEqual([makeRaw("stale")]); expect(getEditBackupStatus(key).state).toBe("conflict");
});
it("충돌 중 후속 편집은 마지막 편집 뒤 5초 또는 숨김 때 사본만 남긴다", async () => {
  canonical = makeRaw("other"); revision = 1; localStorage.setItem(key, makeRaw("mine"));
  startEditDocBackup(); await tick();
  writeEditRaw(key, makeRaw("mine-2")); await tick(2100);
  expect(puts()).toHaveLength(1);
  writeEditRaw(key, makeRaw("mine-3")); await tick(5100);
  expect(copies).toEqual([makeRaw("mine"), makeRaw("mine-3")]);
  writeEditRaw(key, makeRaw("hidden"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange")); await tick(0);
  expect(copies.at(-1)).toBe(makeRaw("hidden")); expect(canonical).toBe(makeRaw("other"));
});
it("충돌 뒤 head가 현재 원문과 같아지면 GET으로 확인한 판 번호만 승계한다", async () => {
  canonical = makeRaw("other"); revision = 1; localStorage.setItem(key, makeRaw("mine"));
  startEditDocBackup(); await tick();
  canonical = makeRaw("mine"); revision = 7;
  retryEditBackups(); await tick(0);
  expect(getEditBackupStatus(key).state).toBe("saved");
  writeEditRaw(key, makeRaw("next")); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(7);
});
it("자기 요청 ACK 뒤에 이어진 자기 편집만 새 판 번호로 보낸다", async () => {
  localStorage.setItem(key, makeRaw("first"));
  const normal = request.getMockImplementation()!;
  let release!: (value: unknown) => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && puts().length === 1) return await new Promise((done) => { release = done; }) as never;
    return normal(url, init);
  });
  startEditDocBackup(); await tick(); writeEditRaw(key, makeRaw("second"));
  canonical = makeRaw("first"); revision = 1;
  await act(async () => { release({ status: "saved", head: meta(canonical!, 1) }); });
  await tick();
  expect(bodyOf(puts()[1]).base_revision).toBe(1); expect(canonical).toBe(makeRaw("second"));
});
it("요청 중 후속 편집이 크기 한도를 넘으면 이전 성공 응답으로 누락 표시를 지우지 않는다", async () => {
  localStorage.setItem(key, makeRaw("first"));
  let release!: (value: unknown) => void;
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => init?.method === "PUT"
    ? await new Promise((done) => { release = done; }) as never : normal(url, init));
  startEditDocBackup(); await tick();
  writeEditRaw(key, JSON.stringify({ v: 1, clips: [], unknown: "x".repeat(1024 * 1024) }));
  await act(async () => { release({ status: "saved", head: meta(makeRaw("first"), 1) }); });
  expect(getEditBackupStatus(key)).toMatchObject({ state: "too_big", skipped: 1 });
});
it("다른 창 원문 수용 뒤 늦은 ACK는 판 번호를 되살리지 않는다", async () => {
  localStorage.setItem(key, makeRaw("first"));
  const normal = request.getMockImplementation()!;
  let release!: (value: unknown) => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && puts().length === 1) return await new Promise((done) => { release = done; }) as never;
    return normal(url, init);
  });
  startEditDocBackup(); await tick();
  canonical = makeRaw("other-tab"); revision = 2;
  localStorage.setItem(key, canonical); noteEditRaw(key, canonical);
  await act(async () => { release({ status: "saved", head: meta(makeRaw("first"), 1) }); });
  await tick(); expect(puts()).toHaveLength(1);
  writeEditRaw(key, makeRaw("accepted-then-edited")); await tick();
  expect(bodyOf(puts()[1]).base_revision).toBe(2);
});
it("열지 않은 문서도 다른 창의 저장 알림으로 읽고 정확히 일치한 head만 승계한다", async () => {
  startEditDocBackup(); canonical = makeRaw("external"); revision = 4;
  localStorage.setItem(key, canonical);
  window.dispatchEvent(new StorageEvent("storage", { key })); await tick();
  expect(puts()).toHaveLength(0);
  writeEditRaw(key, makeRaw("next")); await tick();
  expect(bodyOf(puts()[0]).base_revision).toBe(4);
});
it("독립된 두 탭의 요청이 역순으로 끝나도 늦은 탭은 head를 후퇴시키지 않는다", async () => {
  localStorage.setItem(key, makeRaw("tab-a"));
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  let first = true;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && first) { first = false; await new Promise<void>((done) => { release = done; }); }
    return normal(url, init);
  });
  startEditDocBackup(); await tick();
  vi.resetModules();
  const tabB = await import("../src/lib/editDocBackup");
  try {
    localStorage.setItem(key, makeRaw("tab-b")); tabB.startEditDocBackup(); await tick();
    expect(canonical).toBe(makeRaw("tab-b"));
    await act(async () => { release(); });
    expect(canonical).toBe(makeRaw("tab-b")); expect(copies).toContain(makeRaw("tab-a"));
    expect(bodyOf(puts()[0]).base_revision).toBeNull(); expect(bodyOf(puts()[1]).base_revision).toBeNull();
  } finally { tabB.stopEditDocBackup(); }
});
it("계정이나 토큰이 바뀐 뒤 도착한 GET은 PUT으로 이어지지 않는다", async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  localStorage.setItem(key, makeRaw("mine")); startEditDocBackup(); await tick();
  setAuthToken("different-token"); setAccountScope("other@example.test");
  await act(async () => { release(listing(null)); }); await tick(31000);
  expect(puts()).toHaveLength(0); expect(getEditBackupStatus(key).state).toBe("off");
});
it.each(["404", "401", "offline"])("%s 실패 뒤 30초 또는 online에 재시도한다", async (reason) => {
  const normal = request.getMockImplementation()!;
  request.mockRejectedValueOnce(new Error(reason));
  localStorage.setItem(key, makeRaw("retry")); startEditDocBackup(); await tick();
  expect(getEditBackupStatus(key).state).toBe("error");
  request.mockImplementation(normal);
  if (reason === "offline") window.dispatchEvent(new Event("online"));
  await tick(reason === "offline" ? 0 : 30100);
  expect(canonical).toBe(makeRaw("retry"));
});
it.each(["offline", "response_lost", "other_tab"])("확인한 판 번호는 %s PUT 실패 뒤 재시도에도 유지한다", async (scenario) => {
  startEditDocBackup(); render(); editOnce("first"); await tick();
  expect(revision).toBe(1); expect(getEditBackupStatus(key).state).toBe("saved");
  const normal = request.getMockImplementation()!;
  let failNext = true;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && failNext) {
      failNext = false;
      if (scenario === "response_lost") await normal(url, init);
      throw new TypeError("offline or response lost");
    }
    return normal(url, init);
  });
  editOnce("offline-edit");
  const latestRaw = localStorage.getItem(key)!;
  await tick();
  expect(getEditBackupStatus(key).state).toBe("error");
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(1);
  if (scenario === "other_tab") { canonical = makeRaw("newer-other-tab"); revision += 1; }
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(puts()).toHaveLength(3);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(1);
  if (scenario === "other_tab") {
    expect(getEditBackupStatus(key).state).toBe("conflict");
    expect(canonical).toBe(makeRaw("newer-other-tab")); expect(copies).toContain(latestRaw);
  } else {
    expect(getEditBackupStatus(key).state).toBe("saved");
    expect(canonical).toBe(latestRaw); expect(revision).toBe(2); expect(copies).toEqual([]);
  }
});
it("R1 저장 응답을 잃고 R2를 편집하면 GET으로 R1을 확인한 뒤 R2까지 백업한다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let loseNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && loseNext) { loseNext = false; throw new TypeError("R1 response lost"); }
    return result;
  });
  editOnce("R1"); await tick();
  expect(revision).toBe(2); expect(getEditBackupStatus(key).state).toBe("error");
  editOnce("R2"); const latestRaw = localStorage.getItem(key)!;
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(getEditBackupStatus(key).state).toBe("saved");
  expect(canonical).toBe(latestRaw); expect(revision).toBe(3); expect(copies).toEqual([]);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(2);
});
it.each(["not_saved", "other_tab"])("불명 R1 뒤 R2 전송에서 head가 %s이면 새 판 번호를 임의로 승계하지 않는다", async (scenario) => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let failNext = true;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && failNext) {
      failNext = false;
      if (scenario === "other_tab") await normal(url, init);
      throw new TypeError("R1 result unknown");
    }
    return normal(url, init);
  });
  editOnce("R1"); await tick();
  if (scenario === "other_tab") { canonical = makeRaw("other-tab"); revision = 3; }
  editOnce("R2"); const latestRaw = localStorage.getItem(key)!;
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(1);
  if (scenario === "other_tab") {
    expect(canonical).toBe(makeRaw("other-tab")); expect(copies).toEqual([latestRaw]);
    expect(getEditBackupStatus(key).state).toBe("conflict");
  } else {
    expect(canonical).toBe(latestRaw); expect(revision).toBe(2); expect(copies).toEqual([]);
    expect(getEditBackupStatus(key).state).toBe("saved");
  }
});
it("R1 GET 확인 중 R3로 편집하면 R2를 전송하지 않고 최신 원문을 다시 확인한다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let loseNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && loseNext) { loseNext = false; throw new TypeError("R1 response lost"); }
    return result;
  });
  editOnce("R1"); await tick();
  const r1Raw = canonical!;
  let release!: (value: unknown) => void;
  let holdNextGet = true;
  request.mockImplementation(async (url, init) => {
    if (!init?.method && holdNextGet) { holdNextGet = false; return await new Promise((done) => { release = done; }) as never; }
    return normal(url, init);
  });
  editOnce("R2"); const r2Raw = localStorage.getItem(key)!;
  window.dispatchEvent(new Event("online")); await tick(0);
  editOnce("R3"); const r3Raw = localStorage.getItem(key)!;
  await act(async () => { release(listing(r1Raw, 2)); });
  await tick();
  expect(puts().map((call) => bodyOf(call).data)).not.toContain(r2Raw);
  expect(canonical).toBe(r3Raw); expect(revision).toBe(3); expect(copies).toEqual([]);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(2);
});
it("불명 R1 확인 GET이 실패해도 보내지 않은 R2를 불명 원문으로 기록하지 않는다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let loseNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && loseNext) { loseNext = false; throw new TypeError("R1 response lost"); }
    return result;
  });
  editOnce("R1"); await tick();
  request.mockRejectedValueOnce(new TypeError("confirmation GET offline"));
  editOnce("R2"); const r2Raw = localStorage.getItem(key)!;
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(getEditBackupStatus(key).state).toBe("error");
  editOnce("R3"); const r3Raw = localStorage.getItem(key)!;
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(puts().map((call) => bodyOf(call).data)).not.toContain(r2Raw);
  expect(canonical).toBe(r3Raw); expect(revision).toBe(3); expect(copies).toEqual([]);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(2);
});
it("R1 실패를 기다리는 동안 R2를 편집해도 실제 보낸 R1 원문만 확인한다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let reject!: (reason: Error) => void;
  let holdNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && holdNext) { holdNext = false; return await new Promise((_done, fail) => { reject = fail; }) as never; }
    return result;
  });
  editOnce("R1"); await tick();
  expect(revision).toBe(2);
  editOnce("R2"); const r2Raw = localStorage.getItem(key)!;
  await act(async () => { reject(new TypeError("R1 response lost")); });
  window.dispatchEvent(new Event("online")); await tick(0);
  expect(canonical).toBe(r2Raw); expect(revision).toBe(3); expect(copies).toEqual([]);
});
it("외부 원문을 수용한 뒤 옛 PUT이 실패해도 불명 원문이나 옛 오류 상태를 되살리지 않는다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let reject!: (reason: Error) => void;
  let holdNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && holdNext) { holdNext = false; return await new Promise((_done, fail) => { reject = fail; }) as never; }
    return result;
  });
  editOnce("R1"); await tick(); const r1Raw = canonical!;
  const externalRaw = makeRaw("external-read");
  act(() => { localStorage.setItem(key, externalRaw); window.dispatchEvent(new StorageEvent("storage", { key })); });
  await act(async () => { reject(new TypeError("old R1 response lost")); });
  expect(getEditBackupStatus(key).state).toBe("pending");
  await tick();
  expect(canonical).toBe(r1Raw); expect(copies).toEqual([externalRaw]);
  expect(bodyOf(puts().at(-1)!).base_revision).toBeNull();
});
it.each(["account", "token", "generation"])("PUT 대기 중 %s 변경 뒤 늦은 실패는 이전 불명 원문을 이어 보내지 않는다", async (change) => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let reject!: (reason: Error) => void;
  let holdNext = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && holdNext) { holdNext = false; return await new Promise((_done, fail) => { reject = fail; }) as never; }
    return result;
  });
  editOnce("R1"); await tick(); editOnce("R2");
  if (change === "account") setAccountScope("other@example.test");
  else if (change === "token") setAuthToken("other-token");
  else stopEditDocBackup();
  await act(async () => { reject(new TypeError("late old PUT failure")); });
  await tick(31_000);
  expect(puts()).toHaveLength(2); expect(getEditBackupStatus(key).state).toBe("off");
});
it("유효하지 않은 원문과 1 MiB 초과는 보내지 않고 누락 수를 표시한다", async () => {
  localStorage.setItem(key, "not json");
  const big = editDocKey("big", "opaque");
  localStorage.setItem(big, JSON.stringify({ v: 1, clips: [], unknown: "x".repeat(1024 * 1024) }));
  startEditDocBackup(); await tick();
  expect(request).not.toHaveBeenCalled();
  expect(getEditBackupStatus(key)).toMatchObject({ state: "invalid", skipped: 2 });
  expect(getEditBackupStatus(big).state).toBe("too_big");
});
it("프로필에 키가 없으면 실제 훅이 유효한 DB 원문을 자동 복구하고 Undo는 만들지 않는다", async () => {
  canonical = makeRaw("recover"); revision = 3;
  startEditDocBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips[0].gen).toBe("recover"); expect(localStorage.getItem(key)).toBe(canonical);
  expect(edit.canUndo).toBe(false);
});
it("인증 완료가 훅 마운트보다 늦어도 백업 시작 뒤 자동 복구한다", async () => {
  canonical = makeRaw("recover-after-auth"); revision = 3;
  render(true);
  expect(request).not.toHaveBeenCalled();
  await act(async () => { startEditDocBackup(); });
  expect(edit.doc.clips[0].gen).toBe("recover-after-auth");
});
it("저장된 빈 문서나 읽기 오류는 부재로 보고 자동 복구하지 않는다", async () => {
  canonical = makeRaw("should-not-recover"); localStorage.setItem(key, JSON.stringify(emptyEditDoc()));
  startEditDocBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips).toHaveLength(0); expect(request).not.toHaveBeenCalled();
});
it("읽을 수 없는 저장소는 부재로 보지 않아 head를 가져오지 않는다", async () => {
  const original = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, name: string) {
    if (this === localStorage && name === key) throw new Error("read error");
    return original.call(this, name);
  });
  canonical = makeRaw("do-not-recover");
  startEditDocBackup(); await act(async () => { render(true); });
  expect(edit.readError).toBe(true); expect(request).not.toHaveBeenCalled();
});
it("자동 복구 GET을 기다리는 동안 사용자가 편집하면 늦은 head를 적용하지 않는다", async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  startEditDocBackup(); render(true); editOnce("user");
  await act(async () => { release(listing(makeRaw("recover"), 3)); });
  expect(edit.doc.clips.map((clip) => clip.gen)).toEqual(["user"]);
});
it("서버 사본 보존이 실패하면 수동 복원은 로컬을 바꾸지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startEditDocBackup(); render(); const before = localStorage.getItem(key);
  request.mockRejectedValueOnce(new Error("preserve failed"));
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(canonical!, snapshot, 3, target); });
  expect(result).toBe("uncertain"); expect(localStorage.getItem(key)).toBe(before);
});
it("불명 응답은 GET으로 확인하지만 자동으로 로컬을 덮지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { copies.push(makeRaw("mine")); throw new TypeError("response lost"); }
    return normal(url, init);
  });
  let result: unknown;
  const snapshot = edit.captureArchiveSnapshot(true)!;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target); });
  expect(result).toBe("uncertain"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  expect(request.mock.calls.some(([url, init]) => String(url).includes("include_data=1") && !init?.method)).toBe(true);
});
it("현재 문서를 명시적으로 채택하면 이전 head와 현재 원문을 먼저 보존한다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startEditDocBackup(); render();
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(snapshot.raw!, snapshot, 3, target, true); });
  expect(result).toBe("saved"); expect(canonical).toBe(makeRaw("mine")); expect(copies).toContain(makeRaw("backup"));
  const post = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(bodyOf(post)).toMatchObject({ local_raw: makeRaw("mine"), kind: "pre_adopt", base_revision: 3 });
});
it("복원 요청 중 새 편집은 성공 응답이 도착해도 덮어쓰지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startEditDocBackup(); render();
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target);
  editOnce("new-edit");
  let result: unknown;
  await act(async () => { release({ status: "saved", head: meta(makeRaw("backup"), 4), data: makeRaw("backup") }); result = await pending; });
  expect(result).toBe("stopped"); expect(edit.doc.clips.map((clip) => clip.gen)).toContain("new-edit");
});
it.each(["token", "account", "generation"])("복원 요청 중 %s 변경은 늦은 성공 응답의 로컬 적용을 차단한다", async (change) => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startEditDocBackup(); render();
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target);
  if (change === "token") setAuthToken("new-token");
  else if (change === "account") setAccountScope("other@example.test");
  else stopEditDocBackup();
  await act(async () => { release({ status: "saved", head: meta(makeRaw("backup"), 4), data: makeRaw("backup") }); await pending; });
  expect(localStorage.getItem(key)).toBe(makeRaw("mine")); expect(edit.doc.clips[0].gen).toBe("mine");
});
it("수동 복원의 CAS 충돌은 현재 로컬을 유지한다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("newer-head"); revision = 5;
  startEditDocBackup(); render(); const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("old-head"), snapshot, 4, target); });
  expect(result).toBe("stopped"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  expect(canonical).toBe(makeRaw("newer-head"));
});
it("복원 문맥을 벗어난 clip은 서버 쓰기 전에 거절한다", async () => {
  localStorage.setItem(key, makeRaw("mine")); startEditDocBackup(); render();
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("wrong-target"), snapshot, null, { projectId: target.projectId, seq: "other" }); });
  expect(result).toBe("failed"); expect(request).not.toHaveBeenCalled();
});
it("사본 본문은 선택한 hash 하나로 요청하며 페이지 매개변수를 보존한다", async () => {
  startEditDocBackup(); await loadEditBackup(key, 20, "copy/hash");
  expect(String(request.mock.calls[0][0])).toContain("offset=20&limit=20&copy_hash=copy%2Fhash");
});
// ── 열자마자 바뀐 편집이 영구 충돌에 갇히던 것(2026-10-26 — 실측: head 가 10-23 에 멈추고 사본 7개가 전부 conflict) ──
//  잇는 기준 = 지금 원문 또는 syncedRaw(지금 로컬이 그 위에 이어진 원문 — 읽어 들인 원문·서버가 받아 준 원문·로컬 적용을 확인한 복원 원문).
it("열 때 읽은 원문이 head 와 같으면 첫 확인 전에 바뀐 편집도 head 판 번호로 저장한다(사본 없음)", async () => {
  canonical = makeRaw("loaded"); revision = 4; localStorage.setItem(key, canonical);
  startEditDocBackup(); writeEditRaw(key, makeRaw("edited-before-check")); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(4);
  expect(canonical).toBe(makeRaw("edited-before-check")); expect(copies).toEqual([]);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("같은 프로필 다른 창의 저장 알림 뒤 그 창 PUT 보다 먼저 충돌해도, 그 창이 저장하면 다음 편집은 이어서 저장한다", async () => {
  canonical = makeRaw("first"); revision = 1; localStorage.setItem(key, canonical);
  startEditDocBackup(); await tick();
  const other = makeRaw("other-r1");
  act(() => { localStorage.setItem(key, other); window.dispatchEvent(new StorageEvent("storage", { key })); });
  await tick(); // 다른 창의 PUT 이 아직 — 이 창은 충돌 사본
  expect(copies).toEqual([other]); expect(getEditBackupStatus(key).state).toBe("conflict");
  canonical = other; revision = 2; // 다른 창의 PUT 이 닿았다
  writeEditRaw(key, makeRaw("mine-after")); await tick(5100);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(2);
  expect(canonical).toBe(makeRaw("mine-after")); expect(getEditBackupStatus(key).state).toBe("saved");
});
it("로컬 없음 → 자동 복구 → 2초 안 편집도 복구한 head 판 번호로 저장한다", async () => {
  canonical = makeRaw("recover"); revision = 3;
  startEditDocBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips[0].gen).toBe("recover");
  editOnce("after-recover"); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(3); expect(copies).toEqual([]);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it.each([
  ["같은 원문(same — 판 그대로)", "backup", 3, [makeRaw("mine")]],
  ["다른 원문(saved — 판 +1)", "server-head", 4, [makeRaw("mine"), makeRaw("server-head")]],
])("수동 복원 직후(첫 확인 전) 편집도 복원한 head 판 번호로 저장한다 — %s", async (_label, head, after, preserved) => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw(head as string); revision = 3;
  startEditDocBackup(); render(); const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target); });
  expect([result, canonical, revision]).toEqual(["saved", makeRaw("backup"), after]);
  editOnce("after-restore"); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(after);
  expect(copies).toEqual(preserved); // 복원 직전 보존뿐 — 편집은 사본이 아니라 head 로
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("옛 기준과 같은 원문으로 복원하는 중 로컬 적용이 멈추면, 자동 백업은 복원된 head 를 옛 기준으로 잇지 않는다", async () => {
  canonical = makeRaw("S"); revision = 1; localStorage.setItem(key, canonical);
  startEditDocBackup(); render(); await tick(); // 기준 S
  canonical = makeRaw("H"); revision = 2; // 다른 프로필이 먼저 저장
  editOnce("L"); await tick();
  expect(getEditBackupStatus(key).state).toBe("conflict");
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") await new Promise<void>((done) => { release = done; });
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target); // 서버는 S 로 돌아간다
  editOnce("L2");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect([result, canonical]).toEqual(["stopped", makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S")); expect(copies).toContain(localStorage.getItem(key));
});
it("자동 저장 응답과 복원 응답을 모두 잃어도, 자동 백업은 복원본을 옛 불명 원문으로 이어 덮지 않는다", async () => {
  startEditDocBackup(); render(); editOnce("base"); await tick();
  const normal = request.getMockImplementation()!;
  let losePut = true;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT" && losePut) { losePut = false; throw new TypeError("X response lost"); }
    if (init?.method === "POST") throw new TypeError("restore response lost"); // 서버는 복원했다
    return result;
  });
  editOnce("X"); await tick(); // X 는 서버에 닿았지만 응답을 잃음 — 불명 원문 X
  const xRaw = canonical!;
  expect(getEditBackupStatus(key).state).toBe("error");
  canonical = makeRaw("H"); revision = 3; // 다른 프로필이 먼저 저장
  editOnce("L");
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(xRaw, snapshot, 3, target); });
  expect([result, canonical]).toEqual(["uncertain", xRaw]);
  await tick(5100);
  expect(canonical).toBe(xRaw); expect(copies).toContain(localStorage.getItem(key));
});
it.each(["성공 응답", "응답 유실"])("복원을 기다리는 사이 다른 창 원문을 받아들이고 편집해도(%s), 자동 백업은 복원본을 덮지 않는다", async (mode) => {
  localStorage.setItem(key, makeRaw("L")); canonical = makeRaw("H"); revision = 2;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method !== "POST") return normal(url, init);
    await new Promise<void>((done) => { release = done; });
    const result = await normal(url, init);
    if (mode === "응답 유실") throw new TypeError("restore response lost");
    return result;
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target);
  act(() => { localStorage.setItem(key, makeRaw("S")); window.dispatchEvent(new StorageEvent("storage", { key })); }); // 다른 창이 S 를 저장
  editOnce("L2");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect([result === "saved", canonical]).toEqual([false, makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S"));
});
it("복원 응답을 잃은 뒤 재조회를 기다리는 사이 다른 창 원문을 받아들이고 편집해도, 자동 백업은 복원본을 덮지 않는다", async () => {
  localStorage.setItem(key, makeRaw("L")); canonical = makeRaw("H"); revision = 2;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  let releaseGet: (() => void) | null = null;
  let holdGet = false;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { await normal(url, init); holdGet = true; throw new TypeError("restore response lost"); } // 서버는 복원했다
    if (!init?.method && holdGet) { holdGet = false; await new Promise<void>((done) => { releaseGet = done; }); }
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target);
  await tick(0);
  expect(releaseGet).not.toBeNull(); // 결과 확인 GET 을 기다리는 중
  act(() => { localStorage.setItem(key, makeRaw("S")); window.dispatchEvent(new StorageEvent("storage", { key })); });
  editOnce("L2");
  let result: unknown;
  await act(async () => { releaseGet!(); result = await pending; });
  expect([result, canonical]).toEqual(["uncertain", makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S")); expect(copies).toContain(localStorage.getItem(key));
});
it("이전 세션의 늦은 복원 오류는 새 세션의 이어받을 기준을 지우지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("S"); revision = 3;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  let fail!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { await new Promise<void>((done) => { fail = done; }); throw new TypeError("late old restore failure"); }
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("other"), snapshot, 3, target);
  stopEditDocBackup(); localStorage.setItem(key, makeRaw("S")); startEditDocBackup(); // 새 세션이 S 를 읽음
  writeEditRaw(key, makeRaw("L"));
  await act(async () => { fail(); await pending; });
  await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(3);
  expect(canonical).toBe(makeRaw("L")); expect(getEditBackupStatus(key).state).toBe("saved");
});
it("복원 성공 응답을 기다리는 사이 편집해 로컬 적용이 멈추면, 자동 백업은 복원된 head 를 덮지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("server-head"); revision = 3;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") await new Promise<void>((done) => { release = done; });
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target);
  editOnce("during-restore");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect(result).toBe("stopped");
  await tick(5100);
  expect(canonical).toBe(makeRaw("backup")); expect(copies).toContain(localStorage.getItem(key));
});
it("복원 응답 뒤 로컬 쓰기가 실패해도 자동 백업은 복원된 head 를 덮지 않는다", async () => {
  localStorage.setItem(key, makeRaw("mine")); canonical = makeRaw("server-head"); revision = 3;
  startEditDocBackup(); render();
  const normal = request.getMockImplementation()!;
  const setItem = Storage.prototype.setItem;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "POST") {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name: string, value: string) {
        if (this === localStorage && name === key) throw new Error("quota");
        return setItem.call(this, name, value);
      });
    }
    return result;
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target); });
  expect(result).toBe("failed"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  await tick(5100);
  expect(canonical).toBe(makeRaw("backup"));
});
it("따로인 다른 프로필이 먼저 저장하면 이 창의 뒤 편집은 계속 충돌한다 — 일반 저장(쓰기 → 같은 원문 읽기)은 기준을 바꾸지 않는다", async () => {
  canonical = makeRaw("start"); revision = 1; localStorage.setItem(key, canonical);
  startEditDocBackup(); render(); await tick();
  canonical = makeRaw("other-profile"); revision = 2; // 저장 알림이 오지 않는 다른 프로필
  editOnce("mine-1"); await tick();
  editOnce("mine-2"); await tick(5100);
  expect(canonical).toBe(makeRaw("other-profile"));
  expect(copies).toHaveLength(2); expect(puts().map((call) => bodyOf(call).base_revision)).toEqual([1, null]);
  expect(getEditBackupStatus(key).state).toBe("conflict");
});
it("패널에서 사본 선택 뒤 현재 head를 다시 선택하면 본문을 새로 GET한다", async () => {
  canonical = makeRaw("head"); revision = 2; localStorage.setItem(key, canonical);
  const copy = { data_hash: "copy-hash", kind: "conflict", created_at: "2026-10-17T10:00:00Z", bytes: 100 };
  request.mockImplementation(async (url) => {
    const head = meta(canonical!, revision);
    if (String(url).includes("copy_hash=")) {
      const { data: _data, ...withoutData } = head;
      return { head: withoutData, copies: [copy], total_copies: 1, copy: { ...copy, data: makeRaw("copy") } } as never;
    }
    return { head, copies: [copy], total_copies: 1 } as never;
  });
  startEditDocBackup(); await act(async () => { root.render(<Harness panel />); });
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith(label))!;
  await act(async () => { button("보존 사본").click(); });
  expect(button("보존 사본").getAttribute("aria-pressed")).toBe("true");
  expect(button("현재 DB 백업").disabled).toBe(false);
  const callsBefore = request.mock.calls.length;
  await act(async () => { button("현재 DB 백업").click(); });
  expect(request.mock.calls.length).toBe(callsBefore + 1);
  expect(button("현재 DB 백업").getAttribute("aria-pressed")).toBe("true");
});

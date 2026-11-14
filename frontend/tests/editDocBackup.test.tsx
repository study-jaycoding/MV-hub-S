// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyEditDoc, insertClip } from "../src/lib/editTimeline";
import { useEditDoc } from "../src/lib/useEditDoc";
import { editDocKey, keepUnsavedEditDoc, noteEditRaw, readEditRaw, writeEditRaw } from "../src/lib/editTimelineStore";
import { getEditBackupStatus, loadEditBackup, retryEditBackups, startEditDocBackup, stopEditDocBackup, readEditRecoveryCandidates } from "../src/lib/editDocBackup";
import { getApiPause, jsonFetch, setApiPause, setAuthToken } from "../src/lib/http";
import { setAccountScope } from "../src/lib/accountScope";
import { EditBackupPanel } from "../src/components/timeline/EditBackupPanel";
import { sha256Js } from "../src/lib/editShare";
import { getLang, setLang } from "../src/lib/i18n";

const download = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/download", () => ({ downloadText: download }));

vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: vi.fn() }));
const request = vi.mocked(jsonFetch);
const target = { projectId: "p", seq: "e070" };
const makeRaw = (gen: string) => JSON.stringify(insertClip(emptyEditDoc(), { cut: "e070/c1", gen, kind: "video", dur: 5 }));
const meta = (raw: string, revision = 1) => ({ data: raw, revision, data_hash: `hash-${revision}`, updated_at: `2026-10-17T12:00:0${revision}Z`, bytes: raw.length });
const listing = (raw: string | null, revision = 1) => ({ restore_generation: "restore-1", head: raw === null ? null : meta(raw, revision), copies: [], total_copies: 0 });
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
function storeKnownRaw(doc: string, raw: string) {
  localStorage.setItem(doc, raw);
  localStorage.setItem(`mvhub.editRecovery:${JSON.stringify(["local", doc.slice("mvhub.editDoc:local:".length)])}`, JSON.stringify({ generation: "restore-1", rawHash: sha256Js(new TextEncoder().encode(raw)) }));
}
function startKnownBackup() {
  try {
  // Compatibility cases begin with provenance from an already adopted current generation.
  const keys = new Set([key, ...Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((value): value is string => !!value)]);
  for (const doc of keys) {
    const match = /^(?:mvhub.editDoc|ch.editTimeline):local:(.+)$/.exec(doc);
    if (!match || doc.endsWith(".bad") || doc.endsWith(".ui")) continue;
    const saved = `mvhub.editRecovery:${JSON.stringify(["local", match[1]])}`;
    const raw = localStorage.getItem(doc);
    if (!localStorage.getItem(saved)) localStorage.setItem(saved, JSON.stringify({ generation: "restore-1", rawHash: raw === null ? null : sha256Js(new TextEncoder().encode(raw)) }));
  }
  } catch { /* The read-error cases intentionally make storage unavailable. */ }
  return startEditDocBackup();
}
const puts = () => request.mock.calls.filter(([, init]) => init?.method === "PUT");
const recoveryRecordKey = () => `mvhub.editRecovery:${JSON.stringify(["local", key.slice("mvhub.editDoc:local:".length)])}`;
it("recovery candidates use the explicitly selected account", () => {
  for (const account of ["local", "acct:other@test"]) {
    localStorage.setItem(`mvhub.editRecovery:${JSON.stringify([account, "doc"])}`, JSON.stringify({ blocked: true, originals: [{ raw: account }] }));
  }
  expect(readEditRecoveryCandidates("acct:other@test")).toEqual([{ docKey: "doc", originals: [{ raw: "acct:other@test" }] }]);
  expect(readEditRecoveryCandidates()).toEqual([{ docKey: "doc", originals: [{ raw: "local" }] }]);
});
it("backup panel uses the English loading dictionary key without trailing ellipsis", async () => {
  const language = getLang();
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }) as never);
  startKnownBackup();
  try {
    act(() => { setLang("en"); root.render(<Harness panel />); });
    expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe("Loading");
    await act(async () => { finish(listing(null)); });
  } finally { act(() => setLang(language)); }
});
it("fifty edits while held do not grow the recovery record", async () => {
  const original = makeRaw("held");
  localStorage.setItem(key, original);
  startEditDocBackup(); await tick();
  const held = localStorage.getItem(recoveryRecordKey());
  expect(JSON.parse(held!).originals.map((item: { raw: string }) => item.raw)).toEqual([original]);
  for (let i = 0; i < 50; i++) writeEditRaw(key, makeRaw(`edit-${i}`));
  await tick();
  expect(localStorage.getItem(recoveryRecordKey())).toBe(held);
  expect(localStorage.getItem(key)).toBe(makeRaw("edit-49"));
  expect(puts()).toHaveLength(0);
});
it("recovery panel shows three choices and export only downloads the current original", async () => {
  const original = makeRaw("held");
  localStorage.setItem(key, original);
  startEditDocBackup(); await tick();
  download.mockClear();
  await act(async () => { root.render(<Harness panel />); });
  await tick(0);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("허브와 기록 시점이 달라 자동 백업을 멈췄습니다. 이 브라우저의 편집은 남아 있습니다. 아래에서 하나를 고르기 전까지 허브로 보내지 않습니다.");
  const buttons = [...dialog.querySelectorAll("button")];
  for (const name of ["허브 문서 가져오기", "이 브라우저 문서를 허브에 반영", "원문 내보내고 보류"]) expect(buttons.some((button) => button.textContent === name)).toBe(true);
  const callsBefore = request.mock.calls.length;
  act(() => buttons.find((button) => button.textContent === "원문 내보내고 보류")!.click());
  await tick(31000);
  expect(download).toHaveBeenCalledWith("mvhub-edit-recovery.json", original, "application/json");
  expect(request.mock.calls).toHaveLength(callsBefore);
  expect(getEditBackupStatus(key).state).toBe("recovery");
  expect(localStorage.getItem(key)).toBe(original);
});
it("unknown generation with a different original stays blocked across restart and online", async () => {
  localStorage.setItem(key, makeRaw("offline"));
  startEditDocBackup(); await tick();
  expect(puts()).toHaveLength(0);
  expect(getEditBackupStatus(key).state).toBe("recovery");
  stopEditDocBackup(); startEditDocBackup();
  window.dispatchEvent(new Event("online")); await tick(31000);
  expect(puts()).toHaveLength(0);
  expect(localStorage.getItem(key)).toBe(makeRaw("offline"));
});
it("unknown generation adopts only a clean matching head and saves subsequent edits", async () => {
  canonical = makeRaw("clean"); revision = 4;
  localStorage.setItem(key, canonical);
  startEditDocBackup(); await tick();
  expect(getEditBackupStatus(key).state).toBe("saved"); expect(puts()).toHaveLength(0);
  writeEditRaw(key, makeRaw("new edit")); await tick();
  expect(puts()).toHaveLength(1);
  expect(bodyOf(puts()[0])).toMatchObject({ restore_generation: "restore-1", base_revision: 4 });
});
it("unknown generation adopts the startup head and sends this tab's edit before the first backup", async () => {
  canonical = makeRaw("clean"); revision = 4;
  localStorage.setItem(key, canonical);
  startEditDocBackup(); writeEditRaw(key, makeRaw("unsent")); await tick();
  expect(puts()).toHaveLength(1); expect(getEditBackupStatus(key).state).toBe("saved");
  expect(bodyOf(puts()[0])).toMatchObject({ restore_generation: "restore-1", base_revision: 4, data: makeRaw("unsent") });
});
it("unknown generation holds when another tab changes the startup baseline before the first backup", async () => {
  localStorage.setItem(key, makeRaw("startup"));
  startEditDocBackup();
  canonical = makeRaw("other tab"); revision = 4;
  localStorage.setItem(key, canonical); noteEditRaw(key, canonical);
  writeEditRaw(key, makeRaw("this tab after external read")); await tick();
  expect(puts()).toHaveLength(0); expect(getEditBackupStatus(key).state).toBe("recovery");
});
it("a late ACK from the old restore generation cannot resume automatic backups", async () => {
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  let changed = false;
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT") { changed = true; return result; }
    return changed ? { ...result as object, restore_generation: "restore-2" } as never : result;
  });
  editOnce("old request"); await tick();
  expect(getEditBackupStatus(key).state).toBe("recovery");
  editOnce("new local edit"); await tick(31000);
  expect(puts()).toHaveLength(1);
});
it("a late generation change preserves both the in-flight original and hold-time edit once", async () => {
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  let changed = false, sent = "";
  request.mockImplementation(async (url, init) => {
    const result = await normal(url, init);
    if (init?.method === "PUT") {
      sent = JSON.parse(String(init.body)).data;
      writeEditRaw(key, makeRaw("while-sending")); changed = true;
      return result;
    }
    return changed ? { ...result as object, restore_generation: "restore-2" } as never : result;
  });
  editOnce("request"); await tick();
  const held = localStorage.getItem(recoveryRecordKey())!;
  expect(JSON.parse(held).originals.map((item: { raw: string }) => item.raw)).toEqual([makeRaw("while-sending"), sent]);
  writeEditRaw(key, makeRaw("later")); await tick();
  expect(localStorage.getItem(recoveryRecordKey())).toBe(held);
  expect(puts()).toHaveLength(1);
});
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
      if (!same && body.base_revision !== (canonical === null ? null : revision)) return { restore_generation: "restore-1", status: "conflict", head: canonical && meta(canonical, revision) } as never;
      if (body.local_raw !== null && body.local_raw !== data && body.local_raw !== canonical) copies.push(body.local_raw);
      if (same) return { restore_generation: "restore-1", status: "same", head: meta(canonical!, revision), data } as never;
      if (canonical !== null) copies.push(canonical);
      canonical = data; revision += 1;
      return { restore_generation: "restore-1", status: "saved", head: meta(canonical!, revision), data } as never;
    }
    if (canonical === body.data) return { restore_generation: "restore-1", status: "same", head: meta(canonical!, revision) } as never;
    if (body.base_revision !== (canonical === null ? null : revision)) {
      copies.push(body.data);
      return { restore_generation: "restore-1", status: "conflict", head: meta(canonical!, revision) } as never;
    }
    canonical = body.data; revision += 1;
    return { restore_generation: "restore-1", status: "saved", head: meta(canonical!, revision) } as never;
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); stopEditDocBackup(); keepUnsavedEditDoc(key, null);
  setApiPause(null); vi.useRealTimers(); vi.restoreAllMocks();
});

it("실제 편집 훅의 성공한 저장을 2초 뒤 원문 그대로 계정 헤더와 백업한다", async () => {
  startKnownBackup(); render(); editOnce("first");
  expect(puts()).toHaveLength(0);
  await tick();
  expect(canonical).toBe(readEditRaw(key).kind === "ok" ? localStorage.getItem(key) : null);
  expect(bodyOf(puts()[0]).base_revision).toBeNull();
  expect(puts()[0][1]?.headers).toEqual({ "X-MVHub-Expect-Account": "local" });
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("동일 원문이 서버에 있으면 GET 확인만 하고 쓰지 않는다", async () => {
  canonical = makeRaw("same"); revision = 9; storeKnownRaw(key, canonical);
  startKnownBackup(); await tick();
  noteEditRaw(key, canonical); retryEditBackups(); await tick();
  expect(puts()).toHaveLength(0);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("로컬 저장에 실패한 작업본은 서버로 보내지 않는다", async () => {
  startKnownBackup(); render();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  editOnce("unsaved"); await tick();
  expect(edit.dirty).toBe(true); expect(request).not.toHaveBeenCalled();
});
it("열지 않은 옛 문서도 스캔하고 새 자리가 있으면 그것을 우선한다", async () => {
  const old = key.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(old, makeRaw("old")); storeKnownRaw(key, makeRaw("new"));
  localStorage.setItem(`${old}.bad`, makeRaw("bad-copy"));
  startKnownBackup(); await tick();
  expect(puts()).toHaveLength(1); expect(canonical).toBe(makeRaw("new"));
  expect(localStorage.getItem(old)).toBe(makeRaw("old"));
});
it("옛 키만 있는 opaque 문서 이름을 분해하지 않고 백업한다", async () => {
  const old = "ch.editTimeline:local:a:b:c:d";
  localStorage.setItem(old, makeRaw("legacy")); startKnownBackup(); await tick();
  expect(bodyOf(puts()[0]).doc_key).toBe("a:b:c:d");
});
it("처음 로컬과 head가 다르면 판 번호를 승계하지 않고 충돌 사본을 보존한다", async () => {
  canonical = makeRaw("other-tab"); revision = 5; storeKnownRaw(key, makeRaw("stale"));
  startKnownBackup(); await tick();
  expect(bodyOf(puts()[0]).base_revision).toBeNull(); expect(canonical).toBe(makeRaw("other-tab"));
  expect(copies).toEqual([makeRaw("stale")]); expect(getEditBackupStatus(key).state).toBe("conflict");
});
it("충돌 중 후속 편집은 마지막 편집 뒤 5초 또는 숨김 때 사본만 남긴다", async () => {
  canonical = makeRaw("other"); revision = 1; storeKnownRaw(key, makeRaw("mine"));
  startKnownBackup(); await tick();
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
  canonical = makeRaw("other"); revision = 1; storeKnownRaw(key, makeRaw("mine"));
  startKnownBackup(); await tick();
  canonical = makeRaw("mine"); revision = 7;
  retryEditBackups(); await tick(0);
  expect(getEditBackupStatus(key).state).toBe("saved");
  writeEditRaw(key, makeRaw("next")); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(7);
});
it("자기 요청 ACK 뒤에 이어진 자기 편집만 새 판 번호로 보낸다", async () => {
  storeKnownRaw(key, makeRaw("first"));
  const normal = request.getMockImplementation()!;
  let release!: (value: unknown) => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && puts().length === 1) return await new Promise((done) => { release = done; }) as never;
    return normal(url, init);
  });
  startKnownBackup(); await tick(); writeEditRaw(key, makeRaw("second"));
  canonical = makeRaw("first"); revision = 1;
  await act(async () => { release({ restore_generation: "restore-1", status: "saved", head: meta(canonical!, 1) }); });
  await tick();
  expect(bodyOf(puts()[1]).base_revision).toBe(1); expect(canonical).toBe(makeRaw("second"));
});
it("요청 중 후속 편집이 크기 한도를 넘으면 이전 성공 응답으로 누락 표시를 지우지 않는다", async () => {
  storeKnownRaw(key, makeRaw("first"));
  let release!: (value: unknown) => void;
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => init?.method === "PUT"
    ? await new Promise((done) => { release = done; }) as never : normal(url, init));
  startKnownBackup(); await tick();
  writeEditRaw(key, JSON.stringify({ v: 1, clips: [], unknown: "x".repeat(1024 * 1024) }));
  await act(async () => { release({ restore_generation: "restore-1", status: "saved", head: meta(makeRaw("first"), 1) }); });
  expect(getEditBackupStatus(key)).toMatchObject({ state: "too_big", skipped: 1 });
});
it("다른 창 원문 수용 뒤 늦은 ACK는 판 번호를 되살리지 않는다", async () => {
  storeKnownRaw(key, makeRaw("first"));
  const normal = request.getMockImplementation()!;
  let release!: (value: unknown) => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && puts().length === 1) return await new Promise((done) => { release = done; }) as never;
    return normal(url, init);
  });
  startKnownBackup(); await tick();
  canonical = makeRaw("other-tab"); revision = 2;
  storeKnownRaw(key, canonical); noteEditRaw(key, canonical);
  await act(async () => { release({ restore_generation: "restore-1", status: "saved", head: meta(makeRaw("first"), 1) }); });
  await tick(); expect(puts()).toHaveLength(1);
  writeEditRaw(key, makeRaw("accepted-then-edited")); await tick();
  expect(bodyOf(puts()[1]).base_revision).toBe(2);
});
it("열지 않은 문서도 다른 창의 저장 알림으로 읽고 정확히 일치한 head만 승계한다", async () => {
  startKnownBackup(); canonical = makeRaw("external"); revision = 4;
  storeKnownRaw(key, canonical);
  window.dispatchEvent(new StorageEvent("storage", { key })); await tick();
  expect(puts()).toHaveLength(0);
  writeEditRaw(key, makeRaw("next")); await tick();
  expect(bodyOf(puts()[0]).base_revision).toBe(4);
});
it("독립된 두 탭의 요청이 역순으로 끝나도 늦은 탭은 head를 후퇴시키지 않는다", async () => {
  storeKnownRaw(key, makeRaw("tab-a"));
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  let first = true;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT" && first) { first = false; await new Promise<void>((done) => { release = done; }); }
    return normal(url, init);
  });
  startKnownBackup(); await tick();
  vi.resetModules();
  const tabB = await import("../src/lib/editDocBackup");
  try {
    storeKnownRaw(key, makeRaw("tab-b")); tabB.startEditDocBackup(); await tick();
    expect(canonical).toBe(makeRaw("tab-b"));
    await act(async () => { release(); });
    expect(canonical).toBe(makeRaw("tab-b")); expect(copies).toContain(makeRaw("tab-a"));
    expect(bodyOf(puts()[0]).base_revision).toBeNull(); expect(bodyOf(puts()[1]).base_revision).toBeNull();
  } finally { tabB.stopEditDocBackup(); }
});
it("계정이나 토큰이 바뀐 뒤 도착한 GET은 PUT으로 이어지지 않는다", async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  storeKnownRaw(key, makeRaw("mine")); startKnownBackup(); await tick();
  setAuthToken("different-token"); setAccountScope("other@example.test");
  await act(async () => { release(listing(null)); }); await tick(31000);
  expect(puts()).toHaveLength(0); expect(getEditBackupStatus(key).state).toBe("off");
});
it.each(["404", "401", "offline"])("%s 실패 뒤 30초 또는 online에 재시도한다", async (reason) => {
  const normal = request.getMockImplementation()!;
  request.mockRejectedValueOnce(new Error(reason));
  storeKnownRaw(key, makeRaw("retry")); startKnownBackup(); await tick();
  expect(getEditBackupStatus(key).state).toBe("error");
  request.mockImplementation(normal);
  if (reason === "offline") window.dispatchEvent(new Event("online"));
  await tick(reason === "offline" ? 0 : 30100);
  expect(canonical).toBe(makeRaw("retry"));
});
it.each(["offline", "response_lost", "other_tab"])("확인한 판 번호는 %s PUT 실패 뒤 재시도에도 유지한다", async (scenario) => {
  startKnownBackup(); render(); editOnce("first"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  act(() => { storeKnownRaw(key, externalRaw); window.dispatchEvent(new StorageEvent("storage", { key })); });
  await act(async () => { reject(new TypeError("old R1 response lost")); });
  expect(getEditBackupStatus(key).state).toBe("pending");
  await tick();
  expect(canonical).toBe(r1Raw); expect(copies).toEqual([externalRaw]);
  expect(bodyOf(puts().at(-1)!).base_revision).toBeNull();
});
it.each(["account", "token", "generation"])("PUT 대기 중 %s 변경 뒤 늦은 실패는 이전 불명 원문을 이어 보내지 않는다", async (change) => {
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  storeKnownRaw(key, "not json");
  const big = editDocKey("big", "opaque");
  localStorage.setItem(big, JSON.stringify({ v: 1, clips: [], unknown: "x".repeat(1024 * 1024) }));
  startKnownBackup(); await tick();
  expect(request).not.toHaveBeenCalled();
  expect(getEditBackupStatus(key)).toMatchObject({ state: "invalid", skipped: 2 });
  expect(getEditBackupStatus(big).state).toBe("too_big");
});
it("프로필에 키가 없으면 실제 훅이 유효한 DB 원문을 자동 복구하고 Undo는 만들지 않는다", async () => {
  canonical = makeRaw("recover"); revision = 3;
  startKnownBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips[0].gen).toBe("recover"); expect(localStorage.getItem(key)).toBe(canonical);
  expect(edit.canUndo).toBe(false);
});
it("인증 완료가 훅 마운트보다 늦어도 백업 시작 뒤 자동 복구한다", async () => {
  canonical = makeRaw("recover-after-auth"); revision = 3;
  render(true);
  expect(request).not.toHaveBeenCalled();
  await act(async () => { startKnownBackup(); });
  expect(edit.doc.clips[0].gen).toBe("recover-after-auth");
});
it("저장된 빈 문서나 읽기 오류는 부재로 보고 자동 복구하지 않는다", async () => {
  canonical = makeRaw("should-not-recover"); storeKnownRaw(key, JSON.stringify(emptyEditDoc()));
  startKnownBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips).toHaveLength(0); expect(request).not.toHaveBeenCalled();
});
it("읽을 수 없는 저장소는 부재로 보지 않아 head를 가져오지 않는다", async () => {
  const original = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, name: string) {
    if (this === localStorage && name === key) throw new Error("read error");
    return original.call(this, name);
  });
  canonical = makeRaw("do-not-recover");
  startKnownBackup(); await act(async () => { render(true); });
  expect(edit.readError).toBe(true); expect(request).not.toHaveBeenCalled();
});
it("자동 복구 GET을 기다리는 동안 사용자가 편집하면 늦은 head를 적용하지 않는다", async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(() => new Promise((done) => { release = done; }) as never);
  startKnownBackup(); render(true); editOnce("user");
  await act(async () => { release(listing(makeRaw("recover"), 3)); });
  expect(edit.doc.clips.map((clip) => clip.gen)).toEqual(["user"]);
});
it("서버 사본 보존이 실패하면 수동 복원은 로컬을 바꾸지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startKnownBackup(); render(); const before = localStorage.getItem(key);
  request.mockRejectedValueOnce(new Error("preserve failed"));
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(canonical!, snapshot, 3, target, undefined, undefined, "restore-1"); });
  expect(result).toBe("uncertain"); expect(localStorage.getItem(key)).toBe(before);
});
it("불명 응답은 GET으로 확인하지만 자동으로 로컬을 덮지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { copies.push(makeRaw("mine")); throw new TypeError("response lost"); }
    return normal(url, init);
  });
  let result: unknown;
  const snapshot = edit.captureArchiveSnapshot(true)!;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1"); });
  expect(result).toBe("uncertain"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  expect(request.mock.calls.some(([url, init]) => String(url).includes("include_data=1") && !init?.method)).toBe(true);
});
it("현재 문서를 명시적으로 채택하면 이전 head와 현재 원문을 먼저 보존한다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startKnownBackup(); render();
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(snapshot.raw!, snapshot, 3, target, true, undefined, "restore-1"); });
  expect(result).toBe("saved"); expect(canonical).toBe(makeRaw("mine")); expect(copies).toContain(makeRaw("backup"));
  const post = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(bodyOf(post)).toMatchObject({ local_raw: makeRaw("mine"), kind: "pre_adopt", base_revision: 3 });
});
it("복원 요청 중 새 편집은 성공 응답이 도착해도 덮어쓰지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startKnownBackup(); render();
  let release!: (value: unknown) => void;
  request.mockImplementation((_url, init) => init?.method ? new Promise((done) => { release = done; }) as never : Promise.resolve(listing(canonical, revision)) as never);
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1");
  editOnce("new-edit");
  let result: unknown;
  await act(async () => { release({ restore_generation: "restore-1", status: "saved", head: meta(makeRaw("backup"), 4), data: makeRaw("backup") }); result = await pending; });
  expect(result).toBe("stopped"); expect(edit.doc.clips.map((clip) => clip.gen)).toContain("new-edit");
});
it.each(["token", "account", "generation"])("복원 요청 중 %s 변경은 늦은 성공 응답의 로컬 적용을 차단한다", async (change) => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("backup"); revision = 3;
  startKnownBackup(); render();
  let release!: (value: unknown) => void;
  request.mockImplementation((_url, init) => init?.method ? new Promise((done) => { release = done; }) as never : Promise.resolve(listing(canonical, revision)) as never);
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1");
  if (change === "token") setAuthToken("new-token");
  else if (change === "account") setAccountScope("other@example.test");
  else stopEditDocBackup();
  await act(async () => { release({ restore_generation: "restore-1", status: "saved", head: meta(makeRaw("backup"), 4), data: makeRaw("backup") }); await pending; });
  expect(localStorage.getItem(key)).toBe(makeRaw("mine")); expect(edit.doc.clips[0].gen).toBe("mine");
});
it("same-generation manual restore CAS conflict keeps local edits and resumes prior unblocked backup", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("newer-head"); revision = 5;
  startKnownBackup(); render(); const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("old-head"), snapshot, 4, target, undefined, undefined, "restore-1"); });
  expect(result).toBe("stopped"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  expect(canonical).toBe(makeRaw("newer-head"));
  expect(JSON.parse(localStorage.getItem(recoveryRecordKey())!)).toEqual({ generation: "restore-1", rawHash: sha256Js(new TextEncoder().encode(makeRaw("mine"))) });
  editOnce("after-conflict"); await tick();
  expect(puts()).toHaveLength(1);
  expect(getEditBackupStatus(key).state).not.toBe("recovery");
});
it("same-generation CAS conflict restores an already blocked record unchanged", async () => {
  localStorage.setItem(key, makeRaw("held")); canonical = makeRaw("head"); revision = 5;
  startEditDocBackup(); render(); await tick();
  const before = localStorage.getItem(recoveryRecordKey());
  const snapshot = edit.captureArchiveSnapshot(true)!;
  await act(async () => { expect(await edit.replaceFromBackup(makeRaw("old"), snapshot, 4, target, undefined, undefined, "restore-1")).toBe("stopped"); });
  expect(localStorage.getItem(recoveryRecordKey())).toBe(before);
  editOnce("still-held"); await tick();
  expect(puts()).toHaveLength(0); expect(getEditBackupStatus(key).state).toBe("recovery");
});
it("explicit adoption clears held originals after local apply succeeds", async () => {
  localStorage.setItem(key, makeRaw("held"));
  startEditDocBackup(); render(); await tick();
  expect(JSON.parse(localStorage.getItem(recoveryRecordKey())!).originals).toHaveLength(1);
  const snapshot = edit.captureArchiveSnapshot(true)!;
  await act(async () => { expect(await edit.replaceFromBackup(makeRaw("held"), snapshot, null, target, true, undefined, "restore-1")).toBe("saved"); });
  expect(JSON.parse(localStorage.getItem(recoveryRecordKey())!)).toEqual({ generation: "restore-1", rawHash: sha256Js(new TextEncoder().encode(makeRaw("held"))), blocked: false });
});
it("복원 문맥을 벗어난 clip은 서버 쓰기 전에 거절한다", async () => {
  storeKnownRaw(key, makeRaw("mine")); startKnownBackup(); render();
  const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("wrong-target"), snapshot, null, { projectId: target.projectId, seq: "other" }, undefined, undefined, "restore-1"); });
  expect(result).toBe("failed"); expect(request).not.toHaveBeenCalled();
});
it("사본 본문은 선택한 hash 하나로 요청하며 페이지 매개변수를 보존한다", async () => {
  startKnownBackup(); await loadEditBackup(key, 20, "copy/hash");
  expect(String(request.mock.calls[0][0])).toContain("offset=20&limit=20&copy_hash=copy%2Fhash");
});
// ── 열자마자 바뀐 편집이 영구 충돌에 갇히던 것(2026-10-26 — 실측: head 가 10-23 에 멈추고 사본 7개가 전부 conflict) ──
//  잇는 기준 = 지금 원문 또는 syncedRaw(지금 로컬이 그 위에 이어진 원문 — 읽어 들인 원문·서버가 받아 준 원문·로컬 적용을 확인한 복원 원문).
it("열 때 읽은 원문이 head 와 같으면 첫 확인 전에 바뀐 편집도 head 판 번호로 저장한다(사본 없음)", async () => {
  canonical = makeRaw("loaded"); revision = 4; storeKnownRaw(key, canonical);
  startKnownBackup(); writeEditRaw(key, makeRaw("edited-before-check")); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(4);
  expect(canonical).toBe(makeRaw("edited-before-check")); expect(copies).toEqual([]);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("같은 프로필 다른 창의 저장 알림 뒤 그 창 PUT 보다 먼저 충돌해도, 그 창이 저장하면 다음 편집은 이어서 저장한다", async () => {
  canonical = makeRaw("first"); revision = 1; storeKnownRaw(key, canonical);
  startKnownBackup(); await tick();
  const other = makeRaw("other-r1");
  act(() => { storeKnownRaw(key, other); window.dispatchEvent(new StorageEvent("storage", { key })); });
  await tick(); // 다른 창의 PUT 이 아직 — 이 창은 충돌 사본
  expect(copies).toEqual([other]); expect(getEditBackupStatus(key).state).toBe("conflict");
  canonical = other; revision = 2; // 다른 창의 PUT 이 닿았다
  writeEditRaw(key, makeRaw("mine-after")); await tick(5100);
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(2);
  expect(canonical).toBe(makeRaw("mine-after")); expect(getEditBackupStatus(key).state).toBe("saved");
});
it("로컬 없음 → 자동 복구 → 2초 안 편집도 복구한 head 판 번호로 저장한다", async () => {
  canonical = makeRaw("recover"); revision = 3;
  startKnownBackup(); await act(async () => { render(true); });
  expect(edit.doc.clips[0].gen).toBe("recover");
  editOnce("after-recover"); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(3); expect(copies).toEqual([]);
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it.each([
  ["같은 원문(same — 판 그대로)", "backup", 3, [makeRaw("mine")]],
  ["다른 원문(saved — 판 +1)", "server-head", 4, [makeRaw("mine"), makeRaw("server-head")]],
])("수동 복원 직후(첫 확인 전) 편집도 복원한 head 판 번호로 저장한다 — %s", async (_label, head, after, preserved) => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw(head as string); revision = 3;
  startKnownBackup(); render(); const snapshot = edit.captureArchiveSnapshot(true)!;
  let result: unknown;
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1"); });
  expect([result, canonical, revision]).toEqual(["saved", makeRaw("backup"), after]);
  editOnce("after-restore"); await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(after);
  expect(copies).toEqual(preserved); // 복원 직전 보존뿐 — 편집은 사본이 아니라 head 로
  expect(getEditBackupStatus(key).state).toBe("saved");
});
it("옛 기준과 같은 원문으로 복원하는 중 로컬 적용이 멈추면, 자동 백업은 복원된 head 를 옛 기준으로 잇지 않는다", async () => {
  canonical = makeRaw("S"); revision = 1; storeKnownRaw(key, canonical);
  startKnownBackup(); render(); await tick(); // 기준 S
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
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target, undefined, undefined, "restore-1"); // 서버는 S 로 돌아간다
  editOnce("L2");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect([result, canonical]).toEqual(["stopped", makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S")); expect(getEditBackupStatus(key).state).toBe("recovery");
});
it("자동 저장 응답과 복원 응답을 모두 잃어도, 자동 백업은 복원본을 옛 불명 원문으로 이어 덮지 않는다", async () => {
  startKnownBackup(); render(); editOnce("base"); await tick();
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
  await act(async () => { result = await edit.replaceFromBackup(xRaw, snapshot, 3, target, undefined, undefined, "restore-1"); });
  expect([result, canonical]).toEqual(["uncertain", xRaw]);
  await tick(5100);
  expect(canonical).toBe(xRaw); expect(copies).toContain(localStorage.getItem(key));
});
it.each(["성공 응답", "응답 유실"])("복원을 기다리는 사이 다른 창 원문을 받아들이고 편집해도(%s), 자동 백업은 복원본을 덮지 않는다", async (mode) => {
  storeKnownRaw(key, makeRaw("L")); canonical = makeRaw("H"); revision = 2;
  startKnownBackup(); render();
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
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target, undefined, undefined, "restore-1");
  act(() => { storeKnownRaw(key, makeRaw("S")); window.dispatchEvent(new StorageEvent("storage", { key })); }); // 다른 창이 S 를 저장
  editOnce("L2");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect([result === "saved", canonical]).toEqual([false, makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S"));
});
it("복원 응답을 잃은 뒤 재조회를 기다리는 사이 다른 창 원문을 받아들이고 편집해도, 자동 백업은 복원본을 덮지 않는다", async () => {
  storeKnownRaw(key, makeRaw("L")); canonical = makeRaw("H"); revision = 2;
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  let releaseGet: (() => void) | null = null;
  let holdGet = false;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { await normal(url, init); holdGet = true; throw new TypeError("restore response lost"); } // 서버는 복원했다
    if (!init?.method && holdGet) { holdGet = false; await new Promise<void>((done) => { releaseGet = done; }); }
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("S"), snapshot, 2, target, undefined, undefined, "restore-1");
  await tick(0);
  expect(releaseGet).not.toBeNull(); // 결과 확인 GET 을 기다리는 중
  act(() => { storeKnownRaw(key, makeRaw("S")); window.dispatchEvent(new StorageEvent("storage", { key })); });
  editOnce("L2");
  let result: unknown;
  await act(async () => { releaseGet!(); result = await pending; });
  expect([result, canonical]).toEqual(["uncertain", makeRaw("S")]);
  await tick(5100);
  expect(canonical).toBe(makeRaw("S")); expect(getEditBackupStatus(key).state).toBe("recovery");
});
it("이전 세션의 늦은 복원 오류는 새 세션의 이어받을 기준을 지우지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("S"); revision = 3;
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  let fail!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") { await new Promise<void>((done) => { fail = done; }); throw new TypeError("late old restore failure"); }
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("other"), snapshot, 3, target, undefined, undefined, "restore-1");
  stopEditDocBackup(); storeKnownRaw(key, makeRaw("S")); startKnownBackup(); // 새 세션이 S 를 읽음
  writeEditRaw(key, makeRaw("L"));
  await act(async () => { fail(); await pending; });
  await tick();
  expect(bodyOf(puts().at(-1)!).base_revision).toBe(3);
  expect(canonical).toBe(makeRaw("L")); expect(getEditBackupStatus(key).state).toBe("saved");
});
it("복원 성공 응답을 기다리는 사이 편집해 로컬 적용이 멈추면, 자동 백업은 복원된 head 를 덮지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("server-head"); revision = 3;
  startKnownBackup(); render();
  const normal = request.getMockImplementation()!;
  let release!: () => void;
  request.mockImplementation(async (url, init) => {
    if (init?.method === "POST") await new Promise<void>((done) => { release = done; });
    return normal(url, init);
  });
  const snapshot = edit.captureArchiveSnapshot(true)!;
  const pending = edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1");
  editOnce("during-restore");
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect(result).toBe("stopped");
  await tick(5100);
  expect(canonical).toBe(makeRaw("backup")); expect(getEditBackupStatus(key).state).toBe("recovery");
});
it("복원 응답 뒤 로컬 쓰기가 실패해도 자동 백업은 복원된 head 를 덮지 않는다", async () => {
  storeKnownRaw(key, makeRaw("mine")); canonical = makeRaw("server-head"); revision = 3;
  startKnownBackup(); render();
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
  await act(async () => { result = await edit.replaceFromBackup(makeRaw("backup"), snapshot, 3, target, undefined, undefined, "restore-1"); });
  expect(result).toBe("failed"); expect(localStorage.getItem(key)).toBe(makeRaw("mine"));
  await tick(5100);
  expect(canonical).toBe(makeRaw("backup"));
});
it("따로인 다른 프로필이 먼저 저장하면 이 창의 뒤 편집은 계속 충돌한다 — 일반 저장(쓰기 → 같은 원문 읽기)은 기준을 바꾸지 않는다", async () => {
  canonical = makeRaw("start"); revision = 1; storeKnownRaw(key, canonical);
  startKnownBackup(); render(); await tick();
  canonical = makeRaw("other-profile"); revision = 2; // 저장 알림이 오지 않는 다른 프로필
  editOnce("mine-1"); await tick();
  editOnce("mine-2"); await tick(5100);
  expect(canonical).toBe(makeRaw("other-profile"));
  expect(copies).toHaveLength(2); expect(puts().map((call) => bodyOf(call).base_revision)).toEqual([1, null]);
  expect(getEditBackupStatus(key).state).toBe("conflict");
});
it("패널에서 사본 선택 뒤 현재 head를 다시 선택하면 본문을 새로 GET한다", async () => {
  canonical = makeRaw("head"); revision = 2; storeKnownRaw(key, canonical);
  const copy = { data_hash: "copy-hash", kind: "conflict", created_at: "2026-10-17T10:00:00Z", bytes: 100 };
  request.mockImplementation(async (url) => {
    const head = meta(canonical!, revision);
    if (String(url).includes("copy_hash=")) {
      const { data: _data, ...withoutData } = head;
      return { restore_generation: "restore-1", head: withoutData, copies: [copy], total_copies: 1, copy: { ...copy, data: makeRaw("copy") } } as never;
    }
    return { restore_generation: "restore-1", head, copies: [copy], total_copies: 1 } as never;
  });
  startKnownBackup(); await act(async () => { root.render(<Harness panel />); });
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith(label))!;
  await act(async () => { button("보존 사본").click(); });
  expect(button("보존 사본").getAttribute("aria-pressed")).toBe("true");
  expect(button("현재 DB 백업").disabled).toBe(false);
  const callsBefore = request.mock.calls.length;
  await act(async () => { button("현재 DB 백업").click(); });
  expect(request.mock.calls.length).toBe(callsBefore + 1);
  expect(button("현재 DB 백업").getAttribute("aria-pressed")).toBe("true");
});

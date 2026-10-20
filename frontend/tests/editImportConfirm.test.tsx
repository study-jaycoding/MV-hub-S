// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditArchiveExportConfirm, EditImportConfirm } from "../src/components/timeline/EditImportConfirm";
import { EditTab } from "../src/components/timeline/EditTab";
import { createEditArchive, MAX_ARCHIVE_BYTES, utf8Bytes } from "../src/lib/editArchive";
import { emptyEditDoc, type EditDoc } from "../src/lib/editTimeline";
import { clearUndo, editDocKey, keepPendingEditRestore, keepUnsavedEditDoc, pendingEditRestore } from "../src/lib/editTimelineStore";
import { useEditDoc, type ArchiveSnapshot } from "../src/lib/useEditDoc";
import { setLang } from "../src/lib/i18n";
import { setAccountScope } from "../src/lib/accountScope";

const downloads = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/download", () => ({ downloadText: downloads }));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  const tree = { state: "idle", complete: false, roots: [], note: null };
  return { ...actual,
    useEditProjects: () => ({ projects: [], projectsState: "ok", tree, reload: vi.fn(), reloadCounts: vi.fn(), freshByProject: {} }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, reload: vi.fn() }),
  };
});
let host: HTMLDivElement, root: Root, controller: ReturnType<typeof useEditDoc>;
let serial = 0;
let target: { projectId: string; seq: string }, key: string;
const flash = vi.fn();
const candidate = (): EditDoc => ({ ...emptyEditDoc(), clips: [{ cut: "seq/c1", gen: "g1", track: 1, dur: 5 }] });
const fileFor = (text: string) => ({ size: utf8Bytes(text), text: vi.fn(async () => text) });
const candidateFile = () => fileFor(JSON.stringify(createEditArchive(candidate(), target, true)));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
const confirm = () => document.querySelector<HTMLButtonElement>(".gradestep-btn.confirm")!;
const click = (label: string) => act(() => button(label).click());
const input = (index = 0) => document.querySelectorAll<HTMLInputElement>('input[type="file"]')[index];
const select = async (file: ReturnType<typeof fileFor> | null, index = 0) => {
  const element = input(index);
  Object.defineProperty(element, "files", { configurable: true, value: file ? [file] : [] });
  await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
};
function Harness({ contextKey = "auth", exportOnly = false }: { contextKey?: string; exportOnly?: boolean }) {
  controller = useEditDoc(key, flash);
  const [open, setOpen] = useState(true);
  const [snapshot] = useState<ArchiveSnapshot | null>(() => exportOnly ? controller.captureArchiveSnapshot() : null);
  return open ? snapshot
    ? <EditArchiveExportConfirm snapshot={snapshot} target={target} onClose={() => setOpen(false)} />
    : <EditImportConfirm edit={controller} target={target} contextKey={contextKey} onClose={() => setOpen(false)} flash={flash} />
    : null;
}
const mount = (props: { contextKey?: string; exportOnly?: boolean } = {}) => act(() => root.render(<Harness {...props} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); setLang("ko");
  target = { projectId: `ui-${++serial}`, seq: "seq" };
  key = editDocKey(target.projectId, target.seq);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  downloads.mockReset(); flash.mockReset();
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks();
  keepPendingEditRestore(key, null); keepUnsavedEditDoc(key, null); clearUndo(key);
  setLang("ko");
});

it("requires the downloaded recovery file to be selected and exactly verified before writing", async () => {
  mount();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await select(candidateFile());
  expect(confirm().disabled).toBe(true);
  click("복원 직전 파일 만들기");
  const backup = downloads.mock.calls[0][1] as string;
  expect(JSON.parse(backup).format).toBe("mvhub-edit-recovery");
  expect(confirm().disabled).toBe(true);
  await select(null, 1);
  expect(confirm().disabled).toBe(true);
  await select(fileFor(backup.replace("mvhub-edit-recovery", "mvhub-edit-recoverx")), 1);
  expect(confirm().disabled).toBe(true);
  expect(writes.mock.calls.filter(([name]) => name === key)).toHaveLength(0);
  await select(fileFor(backup), 1);
  expect(confirm().disabled).toBe(false);
  act(() => confirm().click());
  expect(JSON.parse(localStorage.getItem(key)!).clips).toEqual(candidate().clips);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("rejects oversized candidate files before calling file.text", async () => {
  mount();
  const file = { ...candidateFile(), size: MAX_ARCHIVE_BYTES + 1 };
  await select(file);
  expect(file.text).not.toHaveBeenCalled();
  expect(confirm().disabled).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});

it("explains dismissal when automatic duration measurement changes the captured edit", async () => {
  mount();
  await select(candidateFile());
  act(() => controller.applyEdit((doc) => ({ ...doc, tracks: 2 }), { undo: false }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(flash).toHaveBeenCalledWith("대상이나 편집이 바뀌어 복원을 중단했습니다. 다시 시작하세요.");
});

it("preserves the warning about overwriting another window when a dirty restore dialog closes", async () => {
  keepUnsavedEditDoc(key, { doc: emptyEditDoc(), base: null });
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  mount();
  fail.mockRestore();
  await select(candidateFile());
  localStorage.setItem(key, JSON.stringify(candidate()));
  flash.mockClear();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(flash.mock.calls.at(-1)?.[0]).toContain("다른 창의 변경은 사라집니다.");
  expect(controller.dirty).toBe(true);
  expect(controller.conflict).not.toBe(0);
});

it("treats an equal valid edit as no-op without a recovery file or storage write", async () => {
  localStorage.setItem(key, JSON.stringify(candidate())); mount();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  await select(candidateFile());
  expect(button("같은 편집 확인").disabled).toBe(false);
  click("같은 편집 확인");
  expect(downloads).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});

it("does not confuse damaged source with a valid empty edit", async () => {
  localStorage.setItem(key, "broken"); mount();
  await select(fileFor(JSON.stringify(createEditArchive(emptyEditDoc(), target, false))));
  expect(button("같은 편집 확인")).toBeUndefined();
  expect(confirm().disabled).toBe(true);
  click("복원 직전 파일 만들기");
  expect(JSON.parse(downloads.mock.calls[0][1])).toMatchObject({ workingArchive: null, storedRaw: "broken", storedInvalid: true });
});

it.each(["auth", "account", "edit", "close"])("invalidates a file read when %s changes", async (kind) => {
  mount();
  let resolve!: (text: string) => void;
  const text = JSON.stringify(createEditArchive(candidate(), target, false));
  const pending = { size: utf8Bytes(text), text: vi.fn(() => new Promise<string>((done) => { resolve = done; })) };
  Object.defineProperty(input(), "files", { configurable: true, value: [pending] });
  act(() => input().dispatchEvent(new Event("change", { bubbles: true })));
  if (kind === "auth") { mount({ contextKey: "other" }); mount({ contextKey: "auth" }); }
  else if (kind === "account") setAccountScope("other@example.invalid");
  else if (kind === "edit") act(() => controller.applyEdit((doc) => ({ ...doc, muted: true })));
  else click("취소");
  const before = localStorage.getItem(key);
  await act(async () => resolve(text));
  expect(localStorage.getItem(key)).toBe(before);
  expect(document.body.textContent).not.toContain("복원 직전 파일 만들기");
  expect(downloads).not.toHaveBeenCalled();
});

it("invalidates a recovery-file verification when a measurement updates the edit", async () => {
  mount(); await select(candidateFile()); click("복원 직전 파일 만들기");
  const text = downloads.mock.calls[0][1] as string;
  let resolve!: (text: string) => void;
  Object.defineProperty(input(1), "files", { configurable: true, value: [{ size: utf8Bytes(text), text: () => new Promise<string>((done) => { resolve = done; }) }] });
  act(() => input(1).dispatchEvent(new Event("change", { bubbles: true })));
  act(() => controller.applyEdit((doc) => ({ ...doc, muted: true }), { undo: false }));
  const before = localStorage.getItem(key);
  await act(async () => resolve(text));
  expect(localStorage.getItem(key)).toBe(before);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("does not overwrite another window's edit after backup verification", async () => {
  mount(); await select(candidateFile()); click("복원 직전 파일 만들기");
  await select(fileFor(downloads.mock.calls[0][1]), 1);
  const external = JSON.stringify({ ...emptyEditDoc(), muted: true }); localStorage.setItem(key, external);
  act(() => confirm().click());
  expect(localStorage.getItem(key)).toBe(external);
});

it("keeps the old edit when restore storage fails and requires verification again", async () => {
  mount(); await select(candidateFile()); click("복원 직전 파일 만들기");
  await select(fileFor(downloads.mock.calls[0][1]), 1);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  act(() => confirm().click());
  expect(controller.doc).toEqual(emptyEditDoc());
  expect(confirm().disabled).toBe(true);
  expect(document.body.textContent).toContain("복원 저장에 실패했습니다");
});

it("rescues captured unknown source separately without losing it from the working-file explanation", () => {
  const raw = JSON.stringify({ ...candidate(), future: { x: 1 } }); localStorage.setItem(key, raw);
  mount({ exportOnly: true });
  localStorage.setItem(key, "new external value");
  click("저장 원문 보관");
  expect(downloads.mock.calls[0][1]).toBe(raw);
  expect(downloads.mock.calls[0][0]).toMatch(/stored.*\.txt$/);
  click("작업본 파일 보관");
  expect(JSON.parse(JSON.parse(downloads.mock.calls[1][1]).docRaw).future).toBeUndefined();
  expect(document.body.textContent).toContain("모르는 필드를 보존하려면 저장 원문도 따로 보관");
});

it("offers damaged raw rescue but no working export when there is no valid working edit", () => {
  localStorage.setItem(key, "broken"); mount({ exportOnly: true });
  expect(button("작업본 파일 보관").disabled).toBe(true);
  click("손상 원문 구출");
  expect(downloads.mock.calls[0][1]).toBe("broken");
  expect(downloads.mock.calls[0][0]).toMatch(/damaged.*\.txt$/);
});

it("provides English controls, traps Tab and closes on Escape", () => {
  setLang("en"); mount();
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Restore edit from file");
  expect(document.body.textContent).toContain("Original media is not included");
  const cancel = button("Cancel"); cancel.focus();
  act(() => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("rechecks uncertain restoration in EditTab and accepts an external value only on the explicit button", () => {
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify(target));
  const external = JSON.stringify({ ...emptyEditDoc(), muted: true });
  localStorage.setItem(key, external);
  keepPendingEditRestore(key, { doc: emptyEditDoc(), raw: null, dirty: false, bad: false, valid: true,
    candidate: candidate(), candidateRaw: JSON.stringify(candidate()), backupText: "verified external backup" });
  act(() => root.render(<EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={flash}
    onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
    resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />));
  expect(button("외부 저장값 수용")).toBeUndefined();
  click("저장 결과 재확인");
  expect(pendingEditRestore(key)).toBeDefined();
  expect(document.body.textContent).toContain("이전 작업본은 직전 파일에 있습니다");
  click("외부 저장값 수용");
  expect(pendingEditRestore(key)).toBeUndefined();
  expect(button("저장 결과 재확인")).toBeUndefined();
  expect(localStorage.getItem(key)).toBe(external);
});

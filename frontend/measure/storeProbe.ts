// 씬 저장소 실측 — 진짜 브라우저(IndexedDB)에서 이관·용량·지연·두 창을 잰다. 시험(jsdom)은 메모리
// 대체 경로를 타므로 '정말 IndexedDB 로 가나'·'5MB 벽이 사라졌나'·'두 창이 서로를 안 덮나'를 확인하지 못한다.
// 빌드: npx vite build --config measure/vite.probe.config.ts
//
// 한 페이지가 두 역할을 한다. 주 창(main)이 순서를 이끌고, 같은 출처의 iframe(peer)이 **다른 창** 노릇을 한다 —
// iframe 은 모듈 상태가 따로라(화면 값·확정본을 따로 든다) IndexedDB·BroadcastChannel·storage 이벤트에서 다른
// 창과 같다. iframe 을 새로 만들면 '앱을 다시 켠 것'이다.
import { describeSceneMigration, exportSceneArchiveText, importSceneArchiveText } from "../src/lib/sceneArchive";
import { bootSceneStore } from "../src/lib/sceneBoot";
import {
  confirmSceneWrite,
  createScene,
  hasSceneConflicts,
  listPersistedScenes,
  listScenes,
  recoverSceneConflicts,
  saveScenes,
  updateScene,
  type Scene,
  type ScenesByProject,
} from "../src/lib/scenes";
import {
  abortSceneStoreWritesForTest,
  readSceneMigrationInfo,
  resetSceneStoreForTest,
  sceneStoreDurability,
  sceneStoreHasPending,
  subscribeSceneStoreExternal,
} from "../src/lib/sceneStore";

const LS_SCENES = "ch.scenes";
const LS_MARK = "ch.scenes.migration";
const BUCKET = "local::_none"; // 로그인 없는 로컬 계정
const role = new URLSearchParams(location.search).get("role") || "main";

const out: string[] = [];
const log = (line: string) => {
  out.push(line);
  const el = document.getElementById("out");
  if (el) el.textContent = out.join("\n");
};
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
const ms = (n: number) => `${n.toFixed(1)}ms`;
const sleep = (t: number) => new Promise((resolve) => setTimeout(resolve, t));
const sizeOf = (value: unknown) => new Blob([JSON.stringify(value)]).size;
const names = (list: Scene[]) => list.map((s) => s.name);

// 실제 씬과 비슷한 모양 — 텍스트 노드가 용량의 60%라는 실측(2026-10-07)에 맞춘다.
function bigScene(id: string, approxBytes: number): Scene {
  const body = "가".repeat(Math.max(1, Math.floor(approxBytes / 3)));
  return {
    id,
    name: id,
    created_at: Date.now(),
    cards: [{ id: `${id}-t`, kind: "text", x: 0, y: 0, text: body }],
    edges: [],
  } as Scene;
}

// ── 다른 창(peer) ────────────────────────────────────────────────────────────────
type PeerCommand =
  | { cmd: "boot" }
  | { cmd: "list" }
  | { cmd: "persisted" }
  | { cmd: "add"; name: string }
  | { cmd: "rename"; id: string; name: string };

async function runPeerCommand(command: PeerCommand): Promise<unknown> {
  switch (command.cmd) {
    case "boot": {
      const t0 = performance.now();
      const result = await bootSceneStore();
      // 앱은 켜자마자 다른 창의 저장 통지를 듣는다(useSceneCoordination) — 여기서도 같게 한다.
      subscribeSceneStoreExternal(() => {});
      return { kind: result.kind, ms: performance.now() - t0, count: listScenes(null).length };
    }
    case "list":
      return names(listScenes(null));
    case "persisted":
      return names(listPersistedScenes(null));
    case "add": {
      const { value, confirmed } = confirmSceneWrite(() => createScene(null, command.name));
      return { id: value?.id, confirmed: await confirmed };
    }
    case "rename": {
      const { value, confirmed } = confirmSceneWrite(() => updateScene(null, command.id, { name: command.name }));
      return { ok: value.ok, confirmed: await confirmed };
    }
  }
}

function servePeer(): void {
  window.addEventListener("message", (event) => {
    const { seq, command } = event.data as { seq: number; command: PeerCommand };
    void runPeerCommand(command).then(
      (result) => window.parent.postMessage({ seq, result }, "*"),
      (error) => window.parent.postMessage({ seq, error: String(error) }, "*"),
    );
  });
  window.parent.postMessage({ ready: true }, "*");
}

let peerFrame: HTMLIFrameElement | null = null;
let peerSeq = 0;
function openPeer(): Promise<void> {
  peerFrame?.remove();
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  peerFrame = frame;
  return new Promise((resolve) => {
    const onReady = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !(event.data as { ready?: boolean }).ready) return;
      window.removeEventListener("message", onReady);
      resolve();
    };
    window.addEventListener("message", onReady);
    frame.src = `${location.pathname}?role=peer`;
    document.body.append(frame);
  });
}
function closePeer(): void {
  peerFrame?.remove();
  peerFrame = null;
}
function peer<T>(command: PeerCommand): Promise<T> {
  const seq = (peerSeq += 1);
  const target = peerFrame!.contentWindow!;
  return new Promise<T>((resolve, reject) => {
    const onReply = (event: MessageEvent) => {
      const data = event.data as { seq?: number; result?: T; error?: string };
      if (event.source !== target || data.seq !== seq) return;
      window.removeEventListener("message", onReply);
      if (data.error) reject(new Error(data.error));
      else resolve(data.result as T);
    };
    window.addEventListener("message", onReply);
    target.postMessage({ seq, command }, "*");
  });
}

// ── 재기 ─────────────────────────────────────────────────────────────────────────
// 편집 한 번이 화면을 얼마나 멈추나. 저장은 뒤에서 가지만 IndexedDB 에 넘길 때의 복제는 화면 스레드가 한다 —
// 4ms 간격 타이머가 가장 오래 밀린 시간을 '멈춤'으로 본다.
// 앞의 몇 번은 버린다(직전 단계가 남긴 쓰레기 수거·첫 읽기의 사본 만들기가 섞인다). 가운데값과 최댓값을 함께 낸다 —
// 최댓값 하나는 쓰레기 수거 한 번에도 튄다.
async function measureEdits(label: string, sceneId: string, rounds: number): Promise<void> {
  const WARMUP = 3;
  const sync: number[] = [];
  const confirm: number[] = [];
  const stalls: number[] = [];
  for (let i = 0; i < rounds + WARMUP; i += 1) {
    let last = performance.now();
    let stall = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      stall = Math.max(stall, now - last - 4);
      last = now;
    }, 4);
    await sleep(20);
    const t0 = performance.now();
    const { value, confirmed } = confirmSceneWrite(() => updateScene(null, sceneId, { name: `${sceneId} 편집 ${i}` }));
    const t1 = performance.now();
    if (!value.ok || !(await confirmed)) throw new Error("편집이 확정되지 않았다");
    const t2 = performance.now();
    await sleep(20);
    clearInterval(ticker);
    if (i < WARMUP) continue;
    sync.push(t1 - t0);
    confirm.push(t2 - t0);
    stalls.push(stall);
  }
  const mid = (list: number[]) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
  const top = (list: number[]) => Math.max(...list);
  log(
    `${label}: 편집 ${rounds}번 — 화면 반영 ${ms(mid(sync))}(최대 ${ms(top(sync))}) · 저장 확정 ${ms(mid(confirm))}(최대 ${ms(top(confirm))})` +
      ` · 화면 멈춤 ${ms(mid(stalls))}(최대 ${ms(top(stalls))})`,
  );
}

function fillLegacyToTheBrim(): { count: number; bytes: number } {
  const legacy: ScenesByProject = { [BUCKET]: [] };
  let count = 0;
  try {
    for (let i = 0; i < 200; i += 1) {
      legacy[BUCKET].push(bigScene(`old${i}`, 150_000));
      localStorage.setItem(LS_SCENES, JSON.stringify(legacy));
      count = i + 1;
    }
  } catch {
    legacy[BUCKET].pop();
    localStorage.setItem(LS_SCENES, JSON.stringify(legacy));
  }
  // 남은 틈까지 메운다 — 표식 한 줄도 못 쓰는 '진짜 꽉 찬' 상태.
  for (let size = 1 << 20; size >= 1; size >>= 1) {
    try {
      localStorage.setItem(`probe.fill.${size}`, "x".repeat(size));
    } catch {
      // 이 크기는 안 들어간다 — 더 작은 것으로
    }
  }
  return { count, bytes: sizeOf(legacy) };
}
const dropFiller = () => {
  for (const key of Object.keys(localStorage)) if (key.startsWith("probe.fill.")) localStorage.removeItem(key);
};

async function wipe(): Promise<void> {
  resetSceneStoreForTest(); // 이 창이 쥔 연결을 놓는다(안 놓으면 지우기가 막힌다)
  localStorage.clear();
  document.cookie.split("; ").forEach((part) => {
    document.cookie = `${part.split("=")[0]}=; path=/; max-age=0`;
  });
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("mvhub-scenes");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  await sleep(150);
}

// 옛 배치(씬 전체가 한 키, DB 버전 1)를 쓰는 판의 창이 떠 있는 채로 새 판을 켠다. 둘이 같이 쓰면 옛 창은
// 지워진 옛 키를 다시 만들어 '확정'이라 알리고 새 창은 그것을 읽지 않는다 — 그래서 같이 열리면 안 된다.
async function probeOldLayoutWindow(): Promise<void> {
  const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("mvhub-scenes", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = oldDb.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    store.put({ [BUCKET]: [bigScene("v1-a", 1000), bigScene("v1-b", 1000)], "other::_none": [] }, "scenes");
    store.put(7, "version");
    store.put("g-v1", "generation");
    store.put({}, "absorbBase");
    store.put([], "conflicts");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const blocked = await bootSceneStore();
  log(
    `[0] 옛 배치 창이 열려 있을 때 켜기: ${blocked.kind === "failed" ? `막힘(${blocked.error})` : "열림 ← 막혀야 한다"}`,
  );
  oldDb.close(); // 옛 창을 닫는다
  await sleep(400);
  const opened = await bootSceneStore();
  const buckets = (JSON.parse(await exportSceneArchiveText()) as { buckets: ScenesByProject }).buckets;
  log(
    `    옛 창을 닫고 다시 켜기: ${opened.kind} · 옛 배치의 씬 ${names(listScenes(null)).join(",")}` +
      ` · 빈 버킷 보존 ${Array.isArray(buckets["other::_none"]) && buckets["other::_none"].length === 0}`,
  );
  const oldAgain = await new Promise<string>((resolve) => {
    const req = indexedDB.open("mvhub-scenes", 1);
    req.onsuccess = () => {
      req.result.close();
      resolve("열림 ← 막혀야 한다");
    };
    req.onerror = () => resolve(`못 엶(${req.error?.name})`);
  });
  log(`    그 뒤 옛 판이 다시 열려고 하면: ${oldAgain}`);
}

async function main() {
  log("== 씬 저장소 실측 ==");
  await wipe();
  await probeOldLayoutWindow();
  await wipe();

  // ── 1. 신고된 상태를 만든다: 옛 저장소가 꽉 차서 한 글자도 더 못 쓴다 ──
  const filled = fillLegacyToTheBrim();
  let canWrite = true;
  try {
    localStorage.setItem("probe.one", "1");
  } catch {
    canWrite = false;
  }
  log(`[1] 옛 저장소: 씬 ${filled.count}개 · ${mb(filled.bytes)} 에서 꽉 참 — 한 줄 더 쓰기 ${canWrite ? "됨(덜 찼다)" : "안 됨"}`);

  // 견줄 기준 — 종전 방식의 편집 한 번(옛 저장소를 통째로 읽고, 고치고, 통째로 다시 쓴다. 전부 화면 스레드).
  //  크기가 안 느는 편집(같은 길이의 이름)으로 잰다 — 느는 편집은 아래처럼 아예 저장되지 않는다(= 신고된 버그).
  let worstOld = 0;
  for (let i = 0; i < 5; i += 1) {
    const t = performance.now();
    const all = JSON.parse(localStorage.getItem(LS_SCENES)!) as ScenesByProject;
    all[BUCKET][0] = { ...all[BUCKET][0], name: `old${i}` };
    localStorage.setItem(LS_SCENES, JSON.stringify(all));
    worstOld = Math.max(worstOld, performance.now() - t);
  }
  let oldGrowFails = false;
  try {
    const all = JSON.parse(localStorage.getItem(LS_SCENES)!) as ScenesByProject;
    all[BUCKET][0] = { ...all[BUCKET][0], name: "old0", camera: { x: 1, y: 0, z: 1 } };
    localStorage.setItem(LS_SCENES, JSON.stringify(all));
  } catch {
    oldGrowFails = true;
  }
  log(
    `    (기준) 종전 방식으로 이 크기에서 편집 한 번: 화면 멈춤 최대 ${ms(worstOld)}` +
      ` · 내용이 느는 편집(연결선 하나)은 ${oldGrowFails ? "저장 실패 — 신고된 증상" : "저장됨"}`,
  );

  // ── 2. 앱을 켠다(부팅 게이트 = 이관) ──
  const t0 = performance.now();
  const boot = await bootSceneStore();
  const bootMs = performance.now() - t0;
  subscribeSceneStoreExternal(() => {}); // 앱과 같게 — 다른 창의 저장 통지를 듣는다
  const moved = listScenes(null);
  log(
    `[2] 꽉 찬 상태에서 켜기: ${boot.kind}${boot.kind === "ready" ? ` · 옮김=${boot.migrated}` : ` · ${boot.error}`} · ${ms(bootMs)}` +
      ` · 옮겨온 씬 ${moved.length}/${filled.count}개`,
  );
  log(
    `    이관 표식: 옛 저장소 ${localStorage.getItem(LS_MARK) ? "있음" : "없음(꽉 차서 못 씀)"} · 쿠키 ${document.cookie.includes("mvhub_scene_mig_") ? "있음" : "없음"}` +
      ` · 옛 자료는 그대로 ${localStorage.getItem(LS_SCENES) !== null}`,
  );
  if (boot.kind !== "ready") return log("DONE");
  log(`    남긴 기록: ${describeSceneMigration(await readSceneMigrationInfo())}`);

  // ── 3. 꽉 찼던 그 상태에서 편집이 되나, 얼마나 걸리나 ──
  const added = confirmSceneWrite(() => createScene(null, "꽉 찬 뒤에 만든 씬"));
  log(`[3] 꽉 찼던 PC 에서 새 씬 만들기: 화면 ${added.value ? "됨" : "안 됨"} · 저장 확정 ${await added.confirmed}`);
  await measureEdits(`    지금 크기(${mb(sizeOf(listScenes(null)))})`, "old0", 20);

  log(`    쓰기 내구성(브라우저가 적용한 값): ${sceneStoreDurability()}`);

  // ── 3b. 쓰기를 낸 뒤 중단되면 반쯤 남지 않는가(씬·순서·버전은 한 묶음) ──
  abortSceneStoreWritesForTest(true);
  const aborted = confirmSceneWrite(() => {
    updateScene(null, "old5", { name: "중단된 편집" });
    return createScene(null, "중단된 씬");
  });
  const abortedOk = await aborted.confirmed;
  await openPeer(); // 새 창이 보는 것 = 디스크에 실제로 든 것
  await peer({ cmd: "boot" });
  const onDisk = await peer<string[]>({ cmd: "persisted" });
  log(
    `[3b] 쓰기를 낸 뒤 중단: 확정 알림 ${abortedOk} · 저장소에 반쯤 남았나 ${onDisk.includes("중단된 편집") || onDisk.includes("중단된 씬")}` +
      ` · 확정본은 그대로 ${!names(listPersistedScenes(null)).includes("중단된 씬")} · 화면에는 남음 ${names(listScenes(null)).includes("중단된 씬")}`,
  );
  abortSceneStoreWritesForTest(false);
  await confirmSceneWrite(() => updateScene(null, "old6", { name: "다시 받은 뒤 편집" })).confirmed;
  await sleep(400);
  const afterRetry = await peer<string[]>({ cmd: "persisted" });
  log(
    `     다시 받은 뒤 전부 들어갔나: ${["중단된 편집", "중단된 씬", "다시 받은 뒤 편집"].every((name) => afterRetry.includes(name))}`,
  );

  // 다른 창이 떠 있으면, 내 편집마다 그 창이 저장소를 다시 읽는다(버전이 달라졌으므로 전체를). 여기서는 그 창이
  // 같은 스레드의 iframe 이라 그 비용이 내 '화면 멈춤'으로 잡힌다 — 실제 다른 창이면 그 창이 치르는 비용이다.
  await measureEdits(`    같은 크기, 다른 창이 떠 있을 때`, "old0", 20);
  closePeer();

  // ── 4. 옛 한도의 여러 배로 키운다 ──
  const grown = listScenes(null);
  for (let i = 0; i < 200; i += 1) grown.push(bigScene(`new${i}`, 150_000));
  const tGrow = performance.now();
  const growWrite = confirmSceneWrite(() => saveScenes(null, grown));
  const growOk = growWrite.value && (await growWrite.confirmed);
  log(`[4] 키우기: 씬 ${grown.length}개 · ${mb(sizeOf(grown))} · 저장 ${growOk ? "됨" : "실패"} · ${ms(performance.now() - tGrow)}`);
  await measureEdits(`    큰 크기(${mb(sizeOf(listScenes(null)))})`, "old0", 20);

  // ── 5. 두 창 ──
  await openPeer();
  const peerBoot = await peer<{ kind: string; ms: number; count: number }>({ cmd: "boot" });
  log(`[5] 다른 창 열기: ${peerBoot.kind} · ${ms(peerBoot.ms)} · 씬 ${peerBoot.count}개(주 창 ${listScenes(null).length}개)`);
  const mine = confirmSceneWrite(() => createScene(null, "주 창이 만든 씬"));
  await mine.confirmed;
  await sleep(400);
  const seenByPeer = (await peer<string[]>({ cmd: "list" })).includes("주 창이 만든 씬");
  log(`    주 창이 만든 씬이 다른 창에 보이나(새로고침 없이): ${seenByPeer}`);
  await measureEdits(`    큰 크기, 다른 창이 떠 있을 때`, "old0", 20);
  // 같은 순간에 서로 다른 것을 고친다 — 종전(localStorage)은 늦게 쓴 쪽이 다른 쪽을 지웠다.
  const peerAdd = peer<{ confirmed: boolean }>({ cmd: "add", name: "다른 창이 만든 씬" });
  const myRename = confirmSceneWrite(() => updateScene(null, "old1", { name: "주 창이 바꾼 이름" }));
  await Promise.all([peerAdd, myRename.confirmed]);
  await sleep(400);
  const stored = names(listPersistedScenes(null));
  const peerStored = await peer<string[]>({ cmd: "persisted" });
  const both = (list: string[]) => list.includes("다른 창이 만든 씬") && list.includes("주 창이 바꾼 이름");
  log(`    동시에 고친 두 변경이 다 남았나: 주 창 ${both(stored)} · 다른 창 ${both(peerStored)} · 화면도 ${both(names(listScenes(null)))}`);

  // ── 6. 앱을 다시 켠다(새 창 = 새 모듈) ──
  const expected = names(listPersistedScenes(null));
  await openPeer();
  const reboot = await peer<{ kind: string; ms: number; count: number }>({ cmd: "boot" });
  const afterReboot = await peer<string[]>({ cmd: "list" });
  log(
    `[6] 다시 켜기: ${reboot.kind} · ${ms(reboot.ms)} · 씬 ${reboot.count}개 · 내용 그대로 ${JSON.stringify(afterReboot) === JSON.stringify(expected)}`,
  );

  // ── 7. 옛 판 창이 옛 저장소에 쓴다(다른 창이 storage 이벤트로 받아 흡수한다) ──
  dropFiller();
  const legacy = JSON.parse(localStorage.getItem(LS_SCENES)!) as ScenesByProject;
  legacy[BUCKET][2].name = "옛 창이 고친 이름"; // 새 저장소에서 안 건드린 씬 → 그대로 가져온다
  legacy[BUCKET][1].name = "옛 창도 고친 이름"; // 주 창이 위에서 이름을 바꾼 씬 → 엇갈림
  localStorage.setItem(LS_SCENES, JSON.stringify(legacy));
  await sleep(1200);
  const absorbed = names(listScenes(null));
  log(
    `[7] 옛 창 변경: 안 건드린 씬은 가져옴 ${absorbed.includes("옛 창이 고친 이름")} · 엇갈린 씬은 내 것 유지 ${absorbed.includes("주 창이 바꾼 이름")}` +
      ` · 엇갈림 보관 ${hasSceneConflicts()}`,
  );
  const settled = await recoverSceneConflicts();
  await sleep(400);
  const withCopy = names(listScenes(null));
  log(
    `    새 탭으로 살리기: ${JSON.stringify(settled)} · "[옛 창] 옛 창도 고친 이름" 탭 ${withCopy.includes("[옛 창] 옛 창도 고친 이름")}` +
      ` · 다른 창에도 ${(await peer<string[]>({ cmd: "list" })).includes("[옛 창] 옛 창도 고친 이름")} · 남은 엇갈림 ${hasSceneConflicts()}`,
  );

  // ── 8. 전체 내보내기·가져오기 ──
  const tExport = performance.now();
  const text = await exportSceneArchiveText();
  const exportMs = performance.now() - tExport;
  const tImport = performance.now();
  const again = await importSceneArchiveText(text);
  log(
    `[8] 전체 내보내기: ${mb(new Blob([text]).size)} · ${ms(exportMs)} · 같은 파일 다시 가져오기 ${JSON.stringify(again)} · ${ms(performance.now() - tImport)}`,
  );
  log(`    끝난 뒤 밀린 저장: ${sceneStoreHasPending() ? "있음" : "없음"}`);
  log("\nDONE");
}

if (role === "peer") servePeer();
else void main().catch((error) => log(`실패: ${(error as Error).stack || error}\nDONE`));

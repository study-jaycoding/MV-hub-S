// 씬 저장소 실측 — 진짜 브라우저(IndexedDB)에서 이관·용량·지연을 잰다. 시험(jsdom)은 메모리
// 대체 경로를 타므로 '정말 IndexedDB 로 가나'와 '5MB 벽이 사라졌나'를 확인하지 못한다.
// 빌드: npx vite build --config measure/vite.probe.config.ts
import {
  absorbLegacyScenes,
  initSceneStore,
  readScenesCache,
  sceneStoreConflicts,
  writeScenesStore,
  type LegacyMark,
} from "../src/lib/sceneStore";
import type { Scene, ScenesByProject } from "../src/lib/scenes";

const MARK = "ch.scenes.migration";
const readMark = (): LegacyMark | null => {
  const raw = localStorage.getItem(MARK);
  return raw ? (JSON.parse(raw) as LegacyMark) : null;
};
const writeMark = (mark: LegacyMark): boolean => {
  localStorage.setItem(MARK, JSON.stringify(mark));
  return true;
};

const out: string[] = [];
const log = (line: string) => {
  out.push(line);
  document.getElementById("out")!.textContent = out.join("\n");
};
const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;

// 실제 씬과 비슷한 모양 — 텍스트 노드가 용량의 60%라는 실측(2026-10-07)에 맞춘다.
function bigScene(id: string, approxBytes: number): Scene {
  const body = "가".repeat(Math.max(1, Math.floor(approxBytes / 3)));
  return {
    id,
    name: `실측 ${id}`,
    created_at: Date.now(),
    cards: [{ id: `${id}-t`, kind: "text", x: 0, y: 0, text: body }],
    edges: [],
  } as Scene;
}

const sizeOf = (all: ScenesByProject) => new Blob([JSON.stringify(all)]).size;

async function main() {
  log("== 씬 저장소 실측 ==");
  log(`IndexedDB 있음: ${typeof indexedDB !== "undefined"}`);

  // ── 1. 옛 저장소에 '꽉 찬' 상태를 만든다(localStorage 한도까지) ──
  localStorage.clear();
  indexedDB.deleteDatabase("mvhub-scenes");
  await new Promise((r) => setTimeout(r, 120));

  const legacy: ScenesByProject = { "a@x.com::_none": [] };
  let filled = 0;
  try {
    for (let i = 0; i < 60; i += 1) {
      (legacy["a@x.com::_none"] as Scene[]).push(bigScene(`old${i}`, 150_000));
      localStorage.setItem("ch.scenes", JSON.stringify(legacy));
      filled = i + 1;
    }
    log(`옛 저장소: 한도에 안 닿음(씬 ${filled}개, ${mb(sizeOf(legacy))})`);
  } catch (error) {
    (legacy["a@x.com::_none"] as Scene[]).pop();
    localStorage.setItem("ch.scenes", JSON.stringify(legacy));
    log(`옛 저장소 한도 도달: 씬 ${filled}개 · ${mb(sizeOf(legacy))} 에서 ${(error as Error).name}`);
  }

  // ── 2. 이관(= 앱 부팅 게이트가 하는 일) ──
  const t0 = performance.now();
  const init = await initSceneStore(
    () => JSON.parse(localStorage.getItem("ch.scenes") || "null"),
    readMark(),
    writeMark,
  );
  const t1 = performance.now();
  log(`\n이관: ${init.kind} (migrated=${init.kind === "ready" ? init.migrated : "-"}) · ${(t1 - t0).toFixed(1)}ms`);
  const after = readScenesCache();
  const movedCount = (after["a@x.com::_none"] || []).length;
  log(`옮겨온 씬: ${movedCount}개 · ${mb(sizeOf(after))}`);
  log(`옛 저장소는 그대로 남아 있나: ${localStorage.getItem("ch.scenes") !== null}`);

  // ── 3. 큰 칸이 정말 큰가 — 옛 한도의 여러 배를 더 써 본다 ──
  const grow = after;
  let added = 0;
  const t2 = performance.now();
  try {
    for (let i = 0; i < 200; i += 1) {
      (grow["a@x.com::_none"] as Scene[]).push(bigScene(`new${i}`, 150_000));
      if (!(await writeScenesStore(grow))) throw new Error("write returned false");
      added = i + 1;
    }
  } catch (error) {
    log(`큰 칸 쓰기 멈춤: ${added}개째에서 ${(error as Error).message}`);
  }
  const t3 = performance.now();
  log(`\n큰 칸에 더 쓴 씬: ${added}개 · 총 ${mb(sizeOf(grow))} · ${(t3 - t2).toFixed(0)}ms`);

  // ── 4. 다시 열기(앱 재시작과 같은 경로) 지연 ──
  const t4 = performance.now();
  const again = await initSceneStore(
    () => JSON.parse(localStorage.getItem("ch.scenes") || "null"),
    readMark(),
    writeMark,
  );
  const t5 = performance.now();
  log(
    `재시작 열기: ${again.kind} · ${(t5 - t4).toFixed(1)}ms · 씬 ${(readScenesCache()["a@x.com::_none"] || []).length}개` +
      ` · 흡수 ${again.kind === "ready" && again.absorbed ? `적용 ${again.absorbed.adopted}·삭제 ${again.absorbed.removed}·충돌 ${again.absorbed.conflicts.length}` : "없음"}`,
  );

  // ── 5. 옛 창이 뒤늦게 쓴 것을 가져오나 ──
  const late = JSON.parse(localStorage.getItem("ch.scenes")!) as ScenesByProject;
  (late["a@x.com::_none"] as Scene[])[0].name = "옛 창이 고친 이름";
  localStorage.setItem("ch.scenes", JSON.stringify(late));
  const plan = await absorbLegacyScenes(late);
  const first = (readScenesCache()["a@x.com::_none"] || [])[0];
  log(`\n옛 창 변경 흡수: 적용 ${plan?.adopted ?? 0} · 충돌 ${plan?.conflicts.length ?? 0} · 지금 이름 "${first?.name}"`);

  // ── 6. 충돌이 다시 열어도 남아 있나(해결 전까지 보존돼야 한다) ──
  const seed = JSON.parse(localStorage.getItem("ch.scenes")!) as ScenesByProject;
  (seed["a@x.com::_none"] as Scene[])[1].name = "옛 창 수정";
  localStorage.setItem("ch.scenes", JSON.stringify(seed));
  const mine = readScenesCache();
  (mine["a@x.com::_none"] as Scene[])[1].name = "내 수정";
  await writeScenesStore(mine);
  await absorbLegacyScenes(seed);
  log(`\n충돌 만들기: ${sceneStoreConflicts().length}건`);
  const reopen = await initSceneStore(
    () => JSON.parse(localStorage.getItem("ch.scenes") || "null"),
    readMark(),
    writeMark,
  );
  log(`다시 열기 뒤에도 충돌: ${sceneStoreConflicts().length}건 (${reopen.kind})`);

  log("\nDONE");
}

void main().catch((error) => log(`실패: ${(error as Error).message}\nDONE`));

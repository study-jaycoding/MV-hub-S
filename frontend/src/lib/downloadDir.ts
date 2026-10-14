// 다운로드 폴더 자동저장 — File System Access API.
//  · 사용자가 고른 폴더의 핸들을 IndexedDB 에 보관(핸들은 JSON 직렬화 불가 → localStorage 못 씀).
//  · 다운로드 시 그 폴더에 '다른 이름으로 저장' 프롬프트 없이 직접 쓴다.
//  · 보안 컨텍스트(localhost·HTTPS)에서만 동작 — http LAN-IP 접속은 미지원(브라우저 기본 다운로드).
//
// 권한: 폴더 선택 시 readwrite 권한이 부여된다. 새로고침/재시작 후엔 권한이 'prompt' 로 풀릴 수
// 있어, 첫 저장(다운로드 클릭=사용자 제스처) 때 requestPermission 으로 1회 재허용한다(이후 세션 유지).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { flashMsg } from "./flash";

const DB_NAME = "ch-fsa";
const STORE = "handles";
const KEY = "downloadDir";

export function fsaSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === "function";
}

function _idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _idbGet(key: string): Promise<any> {
  const db = await _idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function _idbSet(key: string, val: any): Promise<void> {
  const db = await _idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _idbDel(key: string): Promise<void> {
  const db = await _idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 폴더 선택(사용자 제스처 필요) → 핸들 저장. 선택한 폴더명 반환.
export async function pickDownloadDir(): Promise<string> {
  if (!fsaSupported())
    throw new Error("이 접속(보안 컨텍스트 아님)에서는 폴더 자동저장을 쓸 수 없습니다. localhost 또는 HTTPS 로 접속하세요.");
  const handle = await (window as any).showDirectoryPicker({ mode: "readwrite", id: "ch-download" });
  await _idbSet(KEY, handle);
  return handle.name;
}

export async function clearDownloadDir(): Promise<void> {
  await _idbDel(KEY);
}

// 저장된 폴더명(표시용, 권한 재요청 없음). 없으면 null.
export async function downloadDirName(): Promise<string | null> {
  try {
    const h = await _idbGet(KEY);
    return h ? h.name : null;
  } catch {
    return null;
  }
}

// 두 파일의 내용이 같은가 — 조각으로 견준다(큰 영상을 통째로 한 벌 더 메모리에 올리지 않는다).
async function sameBytes(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  const STEP = 4 * 1024 * 1024;
  for (let at = 0; at < a.size; at += STEP) {
    const [x, y] = await Promise.all([a.slice(at, at + STEP).arrayBuffer(), b.slice(at, at + STEP).arrayBuffer()]);
    const p = new Uint8Array(x);
    const q = new Uint8Array(y);
    for (let i = 0; i < p.length; i += 1) if (p[i] !== q[i]) return false;
  }
  return true;
}

const claimed = new Set<string>(); // 지금 쓰는 중인 이름 — 잇달아 시작한 저장 둘이 같은 빈 이름을 같이 잡지 않게

async function quietly(step: () => unknown): Promise<void> {
  try {
    await step();
  } catch {
    /* 정리 실패는 원래 오류를 가리지 않는다 */
  }
}

/** 그 폴더(dir = 폴더 핸들)에 name 으로 저장한다. **같은 이름의 파일이 이미 있으면 덮지 않는다**(조작 규칙 49): 내용이 같으면(같은 것을 다시
 *  받았다) 그대로 두고, 다르면 번호를 붙인 이름("shot (1).png" — 브라우저의 기본 다운로드와 같다)으로 쓴다. 전엔 말없이 덮어, 소스 이름이
 *  같은 다른 그림을 받으면 먼저 받은 파일이 사라졌다(서로 다른 이름 `a:b`·`a?b` 도 금지 문자를 바꾸면 같은 `a_b` 다). */
export async function writeIntoDir(dir: any, name: string, blob: Blob): Promise<boolean> {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 0; n < 1000; n += 1) {
    const candidate = n ? `${stem} (${n})${ext}` : name;
    const claim = candidate.toLowerCase(); // Windows 폴더는 대소문자만 다른 이름을 같은 파일로 본다(Shot.png · shot.png)
    if (claimed.has(claim)) continue;
    claimed.add(claim); // 첫 await 전에 잡는다
    try {
      let existing: any = null;
      try {
        existing = await dir.getFileHandle(candidate);
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "NotFoundError") throw error;
      }
      if (existing) {
        if (await sameBytes(await existing.getFile(), blob)) return true; // 같은 파일이 이미 있다 — 다시 쓰지 않는다
        continue; // 다른 파일이다 — 다음 번호로
      }
      const handle = await dir.getFileHandle(candidate, { create: true }); // 여기서 빈 파일이 생긴다
      let writable: any = null;
      try {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        // 쓰다 실패하면(디스크 꽉 참·잠김·권한) 방금 만든 빈 파일을 치운다 — 남기면 그 폴더에 빈 그림이 보이고
        //  다음 저장은 그 이름을 피해 번호를 붙인다(47회차). **비어 있을 때만** 지운다: '없음'을 본 뒤 다른 창이 같은 이름으로
        //  저장을 끝냈으면 create 는 그 파일을 돌려준다 — 그것을 지우면 안 된다(Codex 47회차 검토). 치우기가 실패해도 원래 오류를 올린다.
        await quietly(() => writable?.abort?.());
        await quietly(async () => {
          if ((await handle.getFile()).size === 0) await dir.removeEntry?.(candidate);
        });
        throw error;
      }
      return true;
    } finally {
      claimed.delete(claim);
    }
  }
  return false;
}

// 지정 폴더에 직접 저장(프롬프트 없음). 성공 true. 핸들/권한 없거나 실패하면 false(호출측이 일반
// 다운로드로 폴백). 권한이 풀렸으면 requestPermission 으로 1회 재허용 시도(다운로드 클릭=제스처).
export async function saveToDownloadDir(name: string, blob: Blob): Promise<boolean> {
  let h: any = null;
  try {
    h = await _idbGet(KEY);
    if (!h) return false;
    let perm = await h.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await h.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;
    return await writeIntoDir(h, name, blob);
  } catch {
    // 핸들 무효·쓰기 실패 등 → 일반 다운로드 폴백. 폴더를 정해 둔 사람에게는 거기에 안 들어간 것을 알린다
    //  (47회차 — 전엔 말없이 다른 곳에 받았다). 폴더를 읽지도 못했으면(정한 적 없을 수 있다) 조용히 넘어간다.
    if (h) flashMsg(`다운로드 폴더에 저장하지 못해 브라우저 다운로드로 받습니다: ${name}`);
    return false;
  }
}

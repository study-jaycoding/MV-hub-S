// 다운로드 폴더 자동저장 — File System Access API.
//  · 사용자가 고른 폴더의 핸들을 IndexedDB 에 보관(핸들은 JSON 직렬화 불가 → localStorage 못 씀).
//  · 다운로드 시 그 폴더에 '다른 이름으로 저장' 프롬프트 없이 직접 쓴다.
//  · 보안 컨텍스트(localhost·HTTPS)에서만 동작 — http LAN-IP 접속은 미지원(브라우저 기본 다운로드).
//
// 권한: 폴더 선택 시 readwrite 권한이 부여된다. 새로고침/재시작 후엔 권한이 'prompt' 로 풀릴 수
// 있어, 첫 저장(다운로드 클릭=사용자 제스처) 때 requestPermission 으로 1회 재허용한다(이후 세션 유지).

/* eslint-disable @typescript-eslint/no-explicit-any */

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

// 지정 폴더에 직접 저장(프롬프트 없음). 성공 true. 핸들/권한 없거나 실패하면 false(호출측이 일반
// 다운로드로 폴백). 권한이 풀렸으면 requestPermission 으로 1회 재허용 시도(다운로드 클릭=제스처).
export async function saveToDownloadDir(name: string, blob: Blob): Promise<boolean> {
  try {
    const h = await _idbGet(KEY);
    if (!h) return false;
    let perm = await h.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await h.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;
    const fileHandle = await h.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    return false; // 권한 거부·핸들 무효 등 → 일반 다운로드 폴백
  }
}

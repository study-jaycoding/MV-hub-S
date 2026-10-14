// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";
import { postAssetsUpdated } from "./assetBroadcast";
import { chunked } from "./batching";
import { saveToDownloadDir } from "./downloadDir";
import { flashMsg } from "./flash";
import { jsonBody, jsonFetch } from "./http";
import { withQuery } from "./url";

// 다운로드 — bytes 를 받아 blob 으로 저장한다(파일명 보장 + 크롬 다운로드 목록 표시). 원격 URL
// (cloudfront 등)은 cross-origin 이라 a[download] 가 무시되지만, 힉스필드 CDN 이 CORS(*)를 허용하므로
// 브라우저가 직접 fetch 할 수 있다 → 백엔드 프록시 없이도(서버 재배포 불필요) 받아 저장된다.
// CORS 가 막힌 호스트면 같은 오리진 서버 프록시(/api/download)로, 그래도 안 되면 새 탭으로 폴백.
function _anchor(href: string, name?: string, newTab = false) {
  const a = document.createElement("a");
  a.href = href;
  if (name) a.download = name;
  if (newTab) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// bytes 를 Blob 으로 받는다(실패 시 null). 로컬(/...)은 쿠키 동봉·직접, 원격은 CDN CORS(*)로 직접
// 받고, CORS 막힌 호스트면 같은 오리진 서버 프록시(/api/download)로 재시도.
export async function fetchBlob(
  url: string,
  name: string,
  genId?: string,
  init?: { signal?: AbortSignal }, // 호출측 타임아웃/중단 — 모든 내부 fetch(폴백 포함)에 전달
): Promise<Blob | null> {
  const signal = init?.signal;
  // genId 를 아는 다운로드는 허브를 거친다 — 허브가 파일에 '이 생성물이다'를 새겨서 준다(각인).
  // 브라우저가 CDN 에서 직접 받으면 각인할 기회가 없다. 허브가 실패하면 아래 직접 받기로 폴백해
  // 다운로드 자체는 막히지 않는다(각인은 있으면 좋은 것이지 필수 조건이 아니다).
  if (genId) {
    try {
      const res = await fetch(
        withQuery("/api/download", { url, name, gen_id: genId }),
        { credentials: "include", signal },
      );
      if (res.ok) return await res.blob();
    } catch {
      /* 허브 경유 실패 → 아래 기존 경로로 폴백 */
    }
  }
  try {
    const res = await fetch(url, url.startsWith("/") ? { credentials: "include", signal } : { signal });
    if (res.ok) return await res.blob();
  } catch {
    /* 직접 실패 → 프록시 시도(로컬 제외) */
  }
  if (url.startsWith("/")) return null;
  try {
    const res = await fetch(
      withQuery("/api/download", { url, name }),
      { credentials: "include", signal },
    );
    if (res.ok) return await res.blob();
  } catch {
    /* 프록시도 실패 */
  }
  return null;
}

// 받는 중인 파일(주소·이름) — 받는 동안 같은 파일을 다시 청하면(단추 연타, 일괄이 도는 중의 단건) 받던 것을 같이 기다린다.
// 따로 받으면 브라우저가 같은 파일의 사본('이름 (1)')을 하나씩 더 만든다(조작 규칙 39). 다 받은 뒤의 다시 누름은 전처럼 새로 받는다.
// 생성물은 이름 대신 생성물로 가린다 — 이름 요청이 시간을 넘겨 옛 이름으로 받는 중에 다시 누르면 그사이 번호 이름이 와서
// 이름만 다른 같은 파일을 또 받는다(Codex 통합 검토 P2, 2026-10-13).
type DownloadResult = { ok: boolean; savedToDir: boolean };
const inFlight = new Map<string, Promise<DownloadResult>>();
const fileKey = (url: string, name: string, genId?: string) => JSON.stringify(genId ? [url, "gen", genId] : [url, name]);
function _download(url: string, name: string, genId?: string): Promise<DownloadResult> {
  const key = fileKey(url, name, genId);
  const running = inFlight.get(key);
  if (running) return running;
  const task = _downloadNow(url, name, genId).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

// 다운로드 실행 + '지정 다운로드 폴더에 직접 저장했는지'(savedToDir)까지 반환. savedToDir 는
// Assets 실시간 갱신 판단에 쓴다 — 그 폴더가 Assets 마운트와 같은 로컬 폴더면 새 파일이 곧 뜬다.
async function _downloadNow(
  url: string,
  name: string,
  genId?: string,
): Promise<DownloadResult> {
  const blob = await fetchBlob(url, name, genId);
  if (blob) {
    // 지정 다운로드 폴더가 있으면 프롬프트 없이 그곳에 직접 저장. 없거나 실패하면 일반 다운로드.
    if (await saveToDownloadDir(name, blob)) return { ok: true, savedToDir: true };
    const blobUrl = URL.createObjectURL(blob);
    _anchor(blobUrl, name);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    return { ok: true, savedToDir: false };
  }
  // bytes 를 못 받음 — 로컬(/...)은 a[download] 가 동작하므로 저장 성공, 원격은 새 탭(저장 보장
  // 안 됨)이라 '실패'로 보고해 호출측·사용자가 알게 한다.
  if (url.startsWith("/")) {
    _anchor(url, name);
    return { ok: true, savedToDir: false };
  }
  _anchor(url, undefined, true);
  flashMsg(`다운로드 직접 저장 실패 — 새 탭에서 열었습니다: ${name}`);
  return { ok: false, savedToDir: false };
}

// 지정 다운로드 폴더에 저장했으면, Assets 창이 현재 프로젝트를 다시 스캔하도록 알린다(그 폴더가
// Assets 마운트와 같은 로컬 폴더일 때만 새 파일이 실제로 보인다). FSA write flush 가 백엔드 디스크
// 스캔에 반영될 짧은 시간을 준 뒤 브로드캐스트(레이스로 낡은 목록을 받는 것 방지). 빈 배열 =
// 프로젝트 특정 없이 현재 열린 프로젝트 새로고침(useAssetBroadcastSync).
function notifyAssetsMaybeChanged(): void {
  setTimeout(() => postAssetsUpdated([]), 200);
}

// true = 파일명대로 디스크에 깔끔히 저장됨. false = 직접 저장 실패 → 새 탭 폴백(파일명 미적용·에러
// 페이지/팝업차단 가능). 예전엔 fire-and-forget 라 실패해도 사용자가 '저장됨'으로 오인했다.
export async function download(url: string, name: string, genId?: string): Promise<boolean> {
  return (await _download(url, name, genId)).ok;
}

// 단건 다운로드(카드·보드·에셋 호버 버튼 공용) — 클릭 즉시 '1개 다운로드 시작…' 토스트로
// 피드백을 준다(일괄 다운로드와 동일 문구). 원격 저장 실패 시엔 _download 가 안내 토스트를 띄운다.
// bulk 는 downloadMany 가 시작/결과 토스트를 따로 내므로 이 래퍼를 쓰지 않는다(토스트 중복 방지).
// genId 를 주면 허브가 파일에 각인해서 내려준다(나중에 캔버스에 끌어다 놓으면 복원). 폴더에서
// 고른 외부 파일처럼 생성물이 아닌 것은 genId 없이 부르면 된다.
// announced = 시작 토스트를 부르는 쪽이 이미 띄웠다(downloadGeneration — 이름을 받기 전에 먼저 알린다).
export async function downloadOne(url: string, name: string, genId?: string, announced = false): Promise<boolean> {
  const joined = inFlight.has(fileKey(url, name, genId)); // 받는 중에 다시 누른 것 — 새로 받지 않는다
  if (joined || !announced) flashMsg(joined ? "이미 받는 중입니다…" : "1개 다운로드 시작…");
  const { ok, savedToDir } = await _download(url, name, genId);
  if (savedToDir && !joined) notifyAssetsMaybeChanged();
  return ok;
}

// ── 생성물의 다운로드 이름 = 우리 파일 이름 규칙(docs/EXPORT_SYNC_DESIGN.md §7) ──────────────────────
// `<프로젝트>_<폴더>_<work|share|fin>_<작업자>_<번호>` — 공유·최종 저장, Resolve 보내기와 같은 번호다. 이름은 허브가 정한다
// (번호의 장부가 렌더 폴더에 있다). **실제로 받을 때만** 부른다 — 부르는 것만으로 번호가 생긴다(미리보기·목록에서 부르지 않는다).
// numbered=false = 번호를 받지 못해(렌더 폴더 미연결 등) 같은 꼴의 임시 이름을 받았다.
export type DownloadNameInfo = { name: string; numbered: boolean };
const DOWNLOAD_NAMES_LIMIT = 200; // 백엔드 /api/download/names 계약 상한
const noNumberNotice = (count: number, total: number) =>
  `${total > 1 ? `${count}개는 ` : ""}번호를 받지 못해 임시 이름으로 받았습니다 — 계속되면 프로젝트의 렌더 폴더 연결을 확인하세요`;

// 이름을 묻는 중인 생성물 → 그 답. 단건과 일괄이 같은 생성물을 동시에 물으면 한 답을 같이 쓴다 — 따로 물어 한쪽만 번호를 못
// 받으면 같은 파일을 두 이름으로 받는다(주소·이름으로 거르는 중복 방지를 빠져나간다, Codex 코드 리뷰).
const nameRequests = new Map<string, Promise<DownloadNameInfo | undefined>>();
// 허브(NAS)가 멎어도 다운로드는 시작한다 — 이만큼 기다려도 답이 없으면 옛 이름으로 받는다(처음 받는 이름은 건마다 NAS 에 적는다).
const namesTimeoutMs = (count: number) => Math.min(60_000, 10_000 + count * 300);

function requestDownloadNames(ids: string[]): Promise<Record<string, DownloadNameInfo>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), namesTimeoutMs(ids.length));
  return jsonFetch<{ names: Record<string, DownloadNameInfo> }>("/api/download/names", {
    method: "POST",
    body: jsonBody({ gen_ids: ids }),
    signal: controller.signal,
  })
    .then((answer) => answer.names, () => ({})) // 이름을 못 받아도 다운로드는 막지 않는다 — 부르는 쪽이 옛 이름으로 받고 알린다
    .finally(() => clearTimeout(timer));
}

export async function generationDownloadNames(genIds: string[]): Promise<Record<string, DownloadNameInfo>> {
  const ids = [...new Set(genIds)];
  let previous: Promise<unknown> | null = null;
  for (const page of chunked(ids.filter((id) => !nameRequests.has(id)), DOWNLOAD_NAMES_LIMIT)) {
    // 첫 묶음은 바로 묻고, 다음 묶음은 앞의 것이 끝난 뒤에 — 허브가 번호를 한 요청씩 준다(동시에 물으면 뒤의 것은 임시 이름을 받는다)
    const request: Promise<Record<string, DownloadNameInfo>> = previous ? previous.then(() => requestDownloadNames(page)) : requestDownloadNames(page);
    previous = request;
    for (const id of page) {
      const mine: Promise<DownloadNameInfo | undefined> = request
        .then((names) => names[id])
        .finally(() => { if (nameRequests.get(id) === mine) nameRequests.delete(id); });
      nameRequests.set(id, mine);
    }
  }
  const waiting = ids.map((id) => [id, nameRequests.get(id)] as const); // 기다리기 전에 모아 둔다(끝난 것은 지도에서 빠진다)
  const names: Record<string, DownloadNameInfo> = {};
  for (const [id, answer] of waiting) {
    const info = await answer;
    if (info) names[id] = info;
  }
  return names;
}

// 생성물 하나 받기(카드·보드·크게 보기 공용) — 허브가 정한 이름으로 받는다. fallbackName = 허브가 이름을 주지 못했을 때의 옛 이름.
// 이름을 받는 동안 다시 누르면 받던 것을 같이 기다린다(조작 규칙 39 — 이름 요청도, 번호도 하나만).
const naming = new Map<string, Promise<boolean>>();
export function downloadGeneration(url: string, genId: string, fallbackName: string): Promise<boolean> {
  const running = naming.get(genId);
  if (running) {
    flashMsg("이미 받는 중입니다…");
    return running;
  }
  flashMsg("1개 다운로드 시작…");
  const task = (async () => {
    const named = (await generationDownloadNames([genId]))[genId];
    const ok = await downloadOne(url, named?.name ?? fallbackName, genId, true);
    if (ok && !named?.numbered) flashMsg(noNumberNotice(1, 1));
    return ok;
  })().finally(() => naming.delete(genId));
  naming.set(genId, task);
  return task;
}

// 일괄 받기의 이름을 허브가 정한 것으로 바꾼다 — 이름을 못 받은 건은 옛 이름 그대로 둔다.
// notice = 번호를 받지 못한 건이 있을 때 다 받은 뒤에 띄울 안내(없으면 null).
export async function nameGenerationItems<T extends { name: string; genId: string }>(
  items: T[],
): Promise<{ items: T[]; notice: string | null }> {
  const names = await generationDownloadNames(items.map((item) => item.genId));
  const unnumbered = items.filter((item) => !names[item.genId]?.numbered).length;
  return {
    items: items.map((item) => ({ ...item, name: names[item.genId]?.name ?? item.name })),
    notice: unnumbered ? noNumberNotice(unnumbered, items.length) : null,
  };
}

// 메모리에서 만든 텍스트(예: .md 지시문)를 파일로 저장 — Blob+object URL(_anchor 재사용).
export function downloadText(filename: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
  _anchor(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 옛 다운로드 파일명 — 지금은 허브가 이름을 주지 못했을 때(downloadGeneration·nameGenerationItems 의 대체값)만 쓴다.
// 레퍼런스로 추가할 때 쓰는 이름(addRefFromGen 과 동일 규칙): 소스명(@이름) 우선, 없으면 'img-/vid-{id 앞 8자}'.
// 경로 금지문자는 _ 로. 타입별 확장자.
export function downloadName(gen: Generation, type: string): string {
  const isVid = type === "video";
  const base = (gen.source_name || `${isVid ? "vid" : "img"}-${gen.id.slice(0, 8)}`)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim();
  return `${base || gen.id}.${isVid ? "mp4" : "png"}`;
}

export function downloadItemsForGenerations(
  gens: Generation[],
): { url: string; name: string; genId: string }[] {
  return gens.flatMap((g) => {
    const asset = g.assets?.[0];
    return asset
      ? [{ url: asset.file_path, name: downloadName(g, asset.type), genId: g.id }]
      : [];
  });
}

// 여러 건 일괄 다운로드 — 순차 호출. 각 건이 fetch→blob 으로 완전히 받아 저장된 뒤 다음으로
// 넘어가고, 짧은 스태거로 브라우저의 '다중 다운로드 차단'을 회피한다. Assets 갱신 알림은 매 건마다가
// 아니라 배치 끝에 1회만(스팸·부하 방지).
export async function downloadMany(
  items: { url: string; name: string; genId?: string }[],
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  let anySaved = false;
  for (const it of items) {
    const r = await _download(it.url, it.name, it.genId);
    if (r.ok) ok++;
    else failed++;
    if (r.savedToDir) anySaved = true;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (anySaved) notifyAssetsMaybeChanged();
  return { ok, failed };
}

// 결과물 다운로드 공용 헬퍼 — 카드 그리드·히스토리 보드·에셋 셀이 똑같이 복붙하던 것.
import type { Generation } from "../types";
import { postAssetsUpdated } from "./assetBroadcast";
import { saveToDownloadDir } from "./downloadDir";
import { flashMsg } from "./flash";
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
async function _fetchBlob(url: string, name: string): Promise<Blob | null> {
  try {
    const res = await fetch(url, url.startsWith("/") ? { credentials: "include" } : {});
    if (res.ok) return await res.blob();
  } catch {
    /* 직접 실패 → 프록시 시도(로컬 제외) */
  }
  if (url.startsWith("/")) return null;
  try {
    const res = await fetch(
      withQuery("/api/download", { url, name }),
      { credentials: "include" },
    );
    if (res.ok) return await res.blob();
  } catch {
    /* 프록시도 실패 */
  }
  return null;
}

// 다운로드 실행 + '지정 다운로드 폴더에 직접 저장했는지'(savedToDir)까지 반환. savedToDir 는
// Assets 실시간 갱신 판단에 쓴다 — 그 폴더가 Assets 마운트와 같은 로컬 폴더면 새 파일이 곧 뜬다.
async function _download(
  url: string,
  name: string,
): Promise<{ ok: boolean; savedToDir: boolean }> {
  const blob = await _fetchBlob(url, name);
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
export async function download(url: string, name: string): Promise<boolean> {
  return (await _download(url, name)).ok;
}

// 단건 다운로드(카드·보드·에셋 호버 버튼 공용) — 클릭 즉시 '1개 다운로드 시작…' 토스트로
// 피드백을 준다(일괄 다운로드와 동일 문구). 원격 저장 실패 시엔 _download 가 안내 토스트를 띄운다.
// bulk 는 downloadMany 가 시작/결과 토스트를 따로 내므로 이 래퍼를 쓰지 않는다(토스트 중복 방지).
export async function downloadOne(url: string, name: string): Promise<boolean> {
  flashMsg("1개 다운로드 시작…");
  const { ok, savedToDir } = await _download(url, name);
  if (savedToDir) notifyAssetsMaybeChanged();
  return ok;
}

// 메모리에서 만든 텍스트(예: .md 지시문)를 파일로 저장 — Blob+object URL(_anchor 재사용).
export function downloadText(filename: string, text: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
  _anchor(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 다운로드 파일명 = 레퍼런스로 추가할 때 쓰는 이름(addRefFromGen 과 동일 규칙):
// 소스명(@이름) 우선, 없으면 'img-/vid-{id 앞 8자}'. 경로 금지문자는 _ 로. 타입별 확장자.
export function downloadName(gen: Generation, type: string): string {
  const isVid = type === "video";
  const base = (gen.source_name || `${isVid ? "vid" : "img"}-${gen.id.slice(0, 8)}`)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .trim();
  return `${base || gen.id}.${isVid ? "mp4" : "png"}`;
}

export function downloadItemsForGenerations(gens: Generation[]): { url: string; name: string }[] {
  return gens.flatMap((g) => {
    const asset = g.assets?.[0];
    return asset ? [{ url: asset.file_path, name: downloadName(g, asset.type) }] : [];
  });
}

// 여러 건 일괄 다운로드 — 순차 호출. 각 건이 fetch→blob 으로 완전히 받아 저장된 뒤 다음으로
// 넘어가고, 짧은 스태거로 브라우저의 '다중 다운로드 차단'을 회피한다. Assets 갱신 알림은 매 건마다가
// 아니라 배치 끝에 1회만(스팸·부하 방지).
export async function downloadMany(
  items: { url: string; name: string }[],
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  let anySaved = false;
  for (const it of items) {
    const r = await _download(it.url, it.name);
    if (r.ok) ok++;
    else failed++;
    if (r.savedToDir) anySaved = true;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (anySaved) notifyAssetsMaybeChanged();
  return { ok, failed };
}

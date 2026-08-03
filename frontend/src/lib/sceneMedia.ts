// 씬 레퍼런스/미디어 순수 헬퍼 — SceneBoard 에서 분리(React·ref 무관, 인자만으로 계산). 테스트 대상.
//  refMediaSrc 만 api(자산 URL 빌더)에 의존한다.
import { api } from "../api";
import { displayRefThumb } from "./media";
import type { SceneRef } from "./scenes";

// 레퍼런스 카드 썸네일 src — 프롬프트 계열(트레이·칩·토큰)과 동일한 공통 헬퍼(displayRefThumb)로 통일.
// asset 소스면 file_path 로 재생성해 전역 버전 표의 최신 버전을 붙인다(원본이 바뀌면 새 썸네일).
// 영상은 file_path(포스터), 오디오는 undefined(placeholder). 그 외(원격 URL 등)만 저장 thumb 폴백.
//  (SceneBoard 파일 지역 함수였다가 R2 카드 분할로 여러 카드 컴포넌트가 공유하게 되어 이동.)
export function refThumbSrc(r: SceneRef): string | undefined {
  return displayRefThumb(r, 256);
}

// 레퍼런스 카드 헤더 라벨 — 숫자 대신 어떤 레퍼런스인지(이미지/비디오/오디오)를 표시. 여러 장이면 뒤에 개수.
export function refTypeLabel(refs?: SceneRef[]): string {
  if (!refs || !refs.length) return "레퍼런스";
  const t = refs[0].type;
  const label = t === "video" ? "비디오" : t === "audio" ? "오디오" : "이미지";
  return refs.length > 1 ? `${label} ${refs.length}` : label;
}

// 레퍼런스의 재생·미리보기용 실제 파일 URL — 영상 호버재생(src)·더블클릭 큰화면(preview)에 쓴다.
//  · asset:proj|path 토큰 → 원본 파일 URL, 그 외(원격 URL 등)는 그대로.
export function refMediaSrc(r: SceneRef): string | undefined {
  const p = r.file_path;
  if (!p) return undefined;
  if (p.startsWith("asset:")) {
    const [proj, path] = p.slice(6).split("|");
    return proj && path ? api.assetFileUrl(proj, path) : undefined;
  }
  return p;
}

// SceneRef.type 을 PreviewTarget 의 좁은 유니온으로 정규화.
export function refMediaType(r: SceneRef): "image" | "video" | "audio" {
  return r.type === "video" ? "video" : r.type === "audio" ? "audio" : "image";
}

// URL/이름에서 확장자를 뽑고, 없으면 타입 기본값(png/mp4). ComfyUI 가 파일종류를 알도록 이름에 확장자를 붙인다.
export function mediaFileName(nameOrUrl: string, type: "image" | "video", idx: number): string {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(nameOrUrl);
  const ext = m ? m[1].toLowerCase() : type === "video" ? "mp4" : "png";
  return `${type}${idx}.${ext}`;
}

// 씬 레퍼런스/미디어 순수 헬퍼 — SceneBoard 에서 분리(React·ref 무관, 인자만으로 계산). 테스트 대상.
//  refMediaSrc 만 api(자산 URL 빌더)에 의존한다.
import { api } from "../api";
import type { SceneRef } from "./scenes";

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

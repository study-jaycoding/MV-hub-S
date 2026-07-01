import type {
  AssetComment,
  AssetMeta,
  AssetMount,
  AssetTree,
  ProjectsInfo,
} from "../types";
import {
  assetCommentsUrl,
  assetFileUrl as buildAssetFileUrl,
  assetMetaUrl,
  assetThumbUrl as buildAssetThumbUrl,
  assetTreeUrl,
} from "./assetUrls";
import { authFormHeaders, jsonBody, jsonFetch, throwHttpError } from "./http";
import { pathPart, withQuery } from "./url";

export const assetsApi = {
  // Assets(구성) 패널
  assetProjects: () => jsonFetch<ProjectsInfo>("/api/assets/projects"),

  // 외부 폴더 등록(마운트) — 임의 경로 폴더에 이름을 붙여 프로젝트처럼 추가
  assetMounts: () => jsonFetch<{ mounts: AssetMount[] }>("/api/assets/mounts"),
  addAssetMount: (name: string, path: string) =>
    jsonFetch<{ mounts: AssetMount[] }>("/api/assets/mounts", {
      method: "POST",
      body: jsonBody({ name, path }),
    }),
  delAssetMount: (name: string) =>
    jsonFetch<{ mounts: AssetMount[] }>(`/api/assets/mounts/${pathPart(name)}`, {
      method: "DELETE",
    }),

  assetTree: (project: string) => jsonFetch<AssetTree>(assetTreeUrl(project)),

  // 파일 URL (원본/미리보기). 프록시를 통해 백엔드가 서빙.
  assetFileUrl: buildAssetFileUrl,

  // 리사이즈 썸네일 URL(이미지 전용) — 그리드/리스트 스크롤 성능용. 디스크 캐시.
  assetThumbUrl: buildAssetThumbUrl,

  // 생성 미디어 썸네일 URL — 풀해상도 원본 대신 작은 이미지 디코딩.
  genThumbUrl: (mediaPath: string, w = 512) =>
    withQuery("/api/media-thumb", { src: mediaPath, w }),

  // raw 경로가 썸네일화 가능하면 리사이즈 URL, 아니면 원본 그대로.
  thumbOrRaw: (raw: string, w = 512) =>
    raw && (raw.startsWith("/media/") || raw.startsWith("http"))
      ? withQuery("/api/media-thumb", { src: raw, w })
      : raw,

  // 외부 파일 가져오기(드롭 업로드) → 현재 폴더(dir)에 저장. multipart 라 jsonFetch 미사용.
  uploadAssets: async (project: string, dir: string, files: File[]) => {
    const fd = new FormData();
    fd.append("project", project);
    fd.append("dir", dir);
    for (const f of files) fd.append("files", f);
    const res = await fetch("/api/assets/upload", {
      method: "POST",
      body: fd,
      headers: authFormHeaders(),
    });
    if (!res.ok) await throwHttpError(res, "/api/assets/upload");
    return res.json() as Promise<{ saved: string[]; skipped: string[] }>;
  },

  // 클립보드 캡쳐(이미지 blob)를 내장 'captures' 폴더에 저장 → 레퍼런스용 asset 정보 반환.
  uploadCapture: async (blob: Blob) => {
    const fd = new FormData();
    fd.append("file", blob, "capture.png");
    const res = await fetch("/api/assets/capture", {
      method: "POST",
      body: fd,
      headers: authFormHeaders(),
    });
    if (!res.ok) await throwHttpError(res, "/api/assets/capture", "캡쳐 업로드 실패");
    return res.json() as Promise<{ project: string; path: string; name: string; type: string }>;
  },

  // 프롬프트/레퍼런스 트레이 외부 드롭 파일 → 선택 폴더/import 또는 내장 imports 폴더에 저장.
  uploadReferenceFiles: async (files: File[], project = "", dir = "") => {
    const fd = new FormData();
    fd.append("project", project);
    fd.append("dir", dir);
    for (const f of files) fd.append("files", f);
    const res = await fetch("/api/assets/reference-import", {
      method: "POST",
      body: fd,
      headers: authFormHeaders(),
    });
    if (!res.ok) await throwHttpError(res, "/api/assets/reference-import");
    return res.json() as Promise<{
      saved: { project: string; path: string; name: string; type: string; reused?: boolean }[];
      skipped: string[];
    }>;
  },

  // 내 로컬 DB(메타데이터) 가져오기 — 통째 교체(다른 PC에서 내보낸 .db).
  importDb: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/db/import", { method: "POST", body: fd });
    if (!res.ok) await throwHttpError(res, "/api/db/import");
    return res.json() as Promise<{ ok: boolean }>;
  },

  // ☁ 서버에 백업 — 내 계정 DB(메타데이터)를 공유 서버에 올린다(계정별 보관).
  serverBackup: () =>
    jsonFetch<{ ok: boolean; name: string; size: number; count: number }>(
      "/api/db/server-backup",
      { method: "POST" },
    ),
  serverBackups: () =>
    jsonFetch<{ backups: { name: string; size: number; mtime: number }[] }>(
      "/api/db/server-backups",
    ),
  serverRestore: () =>
    jsonFetch<{ ok: boolean; relogin_required: boolean }>("/api/db/server-restore", {
      method: "POST",
    }),

  // OS 파일 탐색기에서 원본 위치 열기(해당 파일 선택)
  revealAsset: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/reveal`, {
      method: "POST",
      body: jsonBody({ project, path }),
    }),

  // 분리 창 파일별 메타데이터
  assetMeta: (project: string) => jsonFetch<Record<string, AssetMeta>>(assetMetaUrl(project)),

  // 파일 코멘트 스레드(공유)
  assetComments: (project: string, path: string) =>
    jsonFetch<AssetComment[]>(assetCommentsUrl(project, path)),
  addAssetComment: (
    project: string,
    path: string,
    text: string,
    parent_id?: string | null,
    muted = false,
  ) =>
    jsonFetch<{ id: string }>(`/api/assets/comments`, {
      method: "POST",
      body: jsonBody({ project, path, text, parent_id: parent_id ?? null, muted }),
    }),
  editAssetComment: (id: string, text: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${pathPart(id)}`, {
      method: "PUT",
      body: jsonBody({ text }),
    }),
  deleteAssetComment: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/${pathPart(id)}`, { method: "DELETE" }),
  markCommentsRead: (project: string, path: string) =>
    jsonFetch<{ ok: boolean }>(`/api/assets/comments/read`, {
      method: "POST",
      body: jsonBody({ project, path }),
    }),
  setAssetSource: (project: string, path: string, name: string | null, is_source: boolean) =>
    jsonFetch(`/api/assets/source`, {
      method: "PUT",
      body: jsonBody({ project, path, name, is_source }),
    }),
  setAssetTags: (project: string, path: string, tags: string[]) =>
    jsonFetch(`/api/assets/tags`, {
      method: "PUT",
      body: jsonBody({ project, path, tags }),
    }),
  setAssetColor: (project: string, path: string, color: string | null) =>
    jsonFetch(`/api/assets/color`, {
      method: "PUT",
      body: jsonBody({ project, path, color }),
    }),
};

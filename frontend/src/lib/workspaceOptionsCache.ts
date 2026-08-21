// #+ 워크스페이스 목록 캐시(모듈 수준) — TagEditor 피커와 전역태그 모달이 공유.
// 목록은 서버 왕복(위임 모드)이라 열 때마다 기다리면 지연이 그대로 체감된다. 한 번 받은
// 목록은 세션 동안 기억해 즉시 표시하고, 열 때마다 뒤에서 조용히 최신으로 갱신한다
// (stale-while-revalidate). 잘못 고르면 서버 resolve 가 거절하므로 stale 표시도 안전하다.
import { api } from "../api";
import type { WorkspaceCommandTarget } from "./workspaceCommand";

let cache: WorkspaceCommandTarget[] | null = null;
let inflight: Promise<WorkspaceCommandTarget[]> | null = null;

export function cachedWorkspaceOptions(): WorkspaceCommandTarget[] | null {
  return cache;
}

export function fetchWorkspaceOptions(): Promise<WorkspaceCommandTarget[]> {
  if (!inflight) {
    inflight = api
      .workspaceCommandOptions()
      .then((result) => {
        cache = result.workspaces || [];
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

import { jsonBody, jsonFetch } from "./http";

// 공유 서버 이사 공지(C안) — 관리자가 서버를 새 주소로 옮기면 릴리스 폴더의
// server-location.json 공지를 백엔드가 읽어 이 형태로 알려준다.
// reachable = 새 주소가 실제로 응답하는 MV Hub 서버인지까지 확인한 결과.
// server_name = 이사 뒤 보여줄 서버 이름(공지의 이름 → 없으면 지금 쓰던 이름 → 없으면 null).
export interface ServerRelocationInfo {
  current_url: string;
  proposed_url: string | null;
  revision: number;
  server_name: string | null;
  announced_at: string | null;
  reachable: boolean;
}

export const sharedApi = {
  // 선택 발행(로컬 허브 → 원격 공유 서버) — 로컬 우선 모델
  sharedServerStatus: () =>
    jsonFetch<{
      configured: boolean;
      url: string | null;
      // 관리자가 등록한 '서버' 표시 이름(작업자 화면은 주소 대신 이걸 쓴다).
      // 아래 name 은 로그인한 '사람' 이름 — 다른 값이다.
      server_name: string;
      url_history: string[];
      email: string | null;
      name: string | null;
      roles: string[];
      is_admin: boolean;
      has_token: boolean;
      elevated: boolean;
      elevated_as: string | null;
    }>("/api/shared-server/status"),
  sharedServerElevate: (email: string, password: string) =>
    jsonFetch<{ ok: boolean; elevated_as: string; elevated: boolean }>(
      "/api/shared-server/elevate",
      { method: "POST", body: jsonBody({ email, password }) },
    ),
  sharedServerDeElevate: () =>
    jsonFetch<{ ok: boolean; elevated: boolean }>("/api/shared-server/de-elevate", {
      method: "POST",
      body: jsonBody({}),
    }),
  // 주소만 확인(저장 없음) — 로그인 화면 '연결 테스트'. 서버가 이사해 로그인 화면에
  // 갇혔을 때 새 주소가 맞는지 로그인 전에 확인하는 탈출구.
  sharedServerProbe: (url: string) =>
    jsonFetch<{
      url: string;
      ok: boolean;
      reachable: boolean;
      server_version: string | null;
      reason: string | null;
    }>("/api/shared-server/probe", { method: "POST", body: jsonBody({ url }) }),
  // 이사 공지 조회 — 알림 센터가 주기적으로 확인한다(백그라운드 스냅샷 기반, 느린 I/O 없음).
  sharedServerRelocation: () =>
    jsonFetch<ServerRelocationInfo>("/api/shared-server/relocation"),
  // 관리자 창 '팀에 공지' — 지금 저장된 이름·주소를 릴리스 폴더의 공지 파일로 발행한다.
  // revision 은 백엔드가 기존 파일을 읽어 +1 한다(관리자가 번호를 기억하지 않아도 된다).
  publishServerRelocation: () =>
    jsonFetch<{
      ok: boolean;
      url: string;
      revision: number;
      server_name: string;
      announced_at: string;
      source: string;
    }>("/api/shared-server/relocation/publish", { method: "POST", body: jsonBody({}) }),
  // 공지된 새 주소로 전환 — 백엔드가 공지 파일을 다시 읽어 재검증한 뒤에만 바꾼다.
  // 성공하면 이 PC 는 로그아웃 상태가 되므로 호출부는 곧바로 새로고침한다.
  sharedServerRelocate: (url: string, revision: number) =>
    jsonFetch<{ ok: boolean; url: string; revision: number; has_token: boolean }>(
      "/api/shared-server/relocate",
      { method: "POST", body: jsonBody({ url, revision }) },
    ),
  sharedServerLogin: (url: string | null, email: string, password: string) =>
    jsonFetch<{ ok: boolean; account: import("../types").Account | null; has_token: boolean }>(
      "/api/shared-server/login",
      { method: "POST", body: jsonBody({ url, email, password }) },
    ),
  sharedServerRegister: (
    url: string | null,
    email: string,
    password: string,
    name: string | null,
  ) =>
    jsonFetch<{
      ok: boolean;
      account: import("../types").Account | null;
      pending: boolean;
      auto_logged_in: boolean;
      has_token: boolean;
    }>("/api/shared-server/register", {
      method: "POST",
      body: jsonBody({ url, email, password, name }),
    }),
  sharedServerLogout: () =>
    jsonFetch<{ ok: boolean; has_token: boolean }>("/api/shared-server/logout", {
      method: "POST",
      body: jsonBody({}),
    }),
  // 관리자 창 전용 — 주소와 표시 이름을 함께 등록한다(이름은 비워도 된다).
  setSharedServerUrl: (url: string, name: string) =>
    jsonFetch<{ url: string | null; server_name: string; is_admin: boolean }>(
      "/api/shared-server/url",
      { method: "POST", body: jsonBody({ url, name }) },
    ),
  publishToShared: (genIds: string[]) =>
    jsonFetch<{
      ok: boolean;
      published: number;
      blocked?: number;
      message?: string;
      mirror_pending?: boolean;
      remote: { inserted: number; updated: number; unchanged: number; skipped: number };
    }>("/api/publish-to-shared", {
      method: "POST",
      body: jsonBody({ gen_ids: genIds }),
    }),
};

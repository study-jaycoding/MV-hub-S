// 코멘트 그림의 대상·저장 문맥 — 설계 docs/status/어셋코멘트그림_설계_2026-11-05.md §3.2·§4.
//  · 대상(CommentTarget) = 생성물(genId) | 어셋(project·path). 그림 조회·겹쳐 보기가 대상을 들고 다닌다.
//  · 저장 문맥 = 이 화면이 어디에 쓰는가. auth_enabled × shared_team_server 로 세 모드를 나눈다 —
//    끔 = 허브 화면(중계 여부는 /api/shared-server/status 의 proxying) · 켬 + 본체 = 서버 직결 · 켬 + 본체 아님 = 격리 로컬.
//    어셋 comments-v2 는 이 문맥의 기대값(계정 머리글·저장 대상·서버 주소·서버 계정)을 싣고, 받는 쪽이 장부를 보기 전에 대조한다.
//  · 상태 조회 실패 = 준비 안 됨(로컬로 보지 않는다) — [편집]·전송을 막는다.
import { useEffect, useState } from "react";
import { api } from "../api";
import { getAccountNamespace } from "./accountScope";
import { APP_EVENTS } from "./appEvents";
import { hubHasFeature, setHubFeatures } from "./hubFeatures";
import { STORAGE_KEYS } from "./storageKeys";
import type { CommentTarget, PreviewItem } from "../types";
import { assetFileUrl } from "./assetUrls";

export const ASSET_DRAWING_FEATURE = "asset_comment_drawings_v1";

export interface CommentWriteContext {
  mode: "hub" | "server" | "isolated";
  expectAccount: string; // X-MVHub-Expect-Account — `acct:<email>` | `local`
  proxying: boolean; // 허브가 공유 코멘트를 서버로 중계하는가(서버 직결·격리 로컬은 거짓)
  serverUrl: string | null; // 중계 허브 = 서버 base URL · 서버 직결 = 이 페이지의 서버
  serverAccount: string | null; // 서버 계정 이메일(서버가 인증 계정과 대조한다)
  allowPrivate: boolean; // 서버 직결은 비공개를 받지 않는다
  key: string; // 문맥의 정체 — 초안을 묶고, 능력 조회 결과를 이 열쇠로 기억한다
}

export interface CommentExpectation {
  expected_target: "local" | "server";
  expected_server_url: string | null;
  expected_server_account: string | null;
}

export const normalizeServerUrl = (url: string | null | undefined) => (url || "").trim().replace(/\/+$/, "");
const emailOf = (namespace: string) => (namespace.startsWith("acct:") ? namespace.slice(5) : "");

export function sameCommentTarget(a: CommentTarget | null | undefined, b: CommentTarget | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "generation" ? a.genId === (b as typeof a).genId
    : a.project === (b as typeof a).project && a.path === (b as typeof a).path;
}

/** 크게 보기의 지금 장이 이 대상인가 — 생성물은 genId, 어셋은 경로 + 그 프로젝트의 파일 주소로 짝짓는다. */
export function previewShowsTarget(item: Pick<PreviewItem, "genId" | "assetPath" | "url">, target: CommentTarget): boolean {
  if (target.kind === "generation") return !!item.genId && item.genId === target.genId;
  return !item.genId && item.assetPath === target.path && item.url === assetFileUrl(target.project, target.path);
}

/** 이 문맥에서 이 공개 여부의 코멘트가 실제로 저장될 곳(설계 §3.2 표). */
export function expectationFor(ctx: CommentWriteContext, isPrivate: boolean): CommentExpectation {
  if (ctx.mode === "server") return { expected_target: "server", expected_server_url: null, expected_server_account: ctx.serverAccount };
  if (ctx.mode === "hub" && ctx.proxying && !isPrivate) {
    return { expected_target: "server", expected_server_url: ctx.serverUrl, expected_server_account: ctx.serverAccount };
  }
  return { expected_target: "local", expected_server_url: null, expected_server_account: null };
}

/** 저장 문맥을 읽는다 — 허브 기능 표식도 함께 맞춘다(분리 창은 App 을 거치지 않아 표식이 비어 있다). 읽지 못하면 null(준비 안 됨). */
export async function loadCommentWriteContext(signal?: AbortSignal): Promise<CommentWriteContext | null> {
  try {
    const cfg = await api.authConfig();
    if (signal?.aborted) return null;
    setHubFeatures(cfg.features);
    const expectAccount = getAccountNamespace();
    let ctx: Omit<CommentWriteContext, "key">;
    if (!cfg.auth_enabled) {
      const status = await api.sharedServerStatus(signal);
      const proxying = status.proxying ?? !!status.has_token; // 옛 허브는 칸이 없다 — 그 허브는 어셋 그림 표식도 없어 [편집]이 안 보인다
      ctx = { mode: "hub", expectAccount, proxying, serverUrl: proxying ? normalizeServerUrl(status.url) : null,
        serverAccount: proxying ? (status.email || "").trim().toLowerCase() || null : null, allowPrivate: true };
    } else if (cfg.shared_team_server) {
      ctx = { mode: "server", expectAccount, proxying: false, serverUrl: normalizeServerUrl(window.location.origin),
        serverAccount: emailOf(expectAccount) || null, allowPrivate: false };
    } else {
      ctx = { mode: "isolated", expectAccount, proxying: false, serverUrl: null, serverAccount: null, allowPrivate: true };
    }
    if (ctx.mode === "server" && !ctx.serverAccount) return null; // 로그인 전 — 기대 계정을 모른다
    return { ...ctx, key: JSON.stringify([ctx.mode, ctx.expectAccount, ctx.proxying, ctx.serverUrl, ctx.serverAccount]) };
  } catch {
    return null;
  }
}

/** 저장 문맥 — 계정이 바뀌거나 다시 로그인이 필요해지면 다시 읽는다. 읽는 동안·실패 = null(준비 안 됨). */
export function useCommentWriteContext(): CommentWriteContext | null {
  const [ctx, setCtx] = useState<CommentWriteContext | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    // 다른 창의 로그인·계정 전환·로그아웃만 본다(app/operationContext 의 감시와 같은 열쇠)
    const storage = (event: StorageEvent) => {
      if (event.key === null || [STORAGE_KEYS.authToken, STORAGE_KEYS.activeAccount, STORAGE_KEYS.hubLogoutAt].some((key) => key === event.key)) bump();
    };
    window.addEventListener(APP_EVENTS.accountUpdated, bump);
    window.addEventListener(APP_EVENTS.authRequired, bump);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(APP_EVENTS.accountUpdated, bump);
      window.removeEventListener(APP_EVENTS.authRequired, bump);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setCtx(null); // 다시 읽는 동안은 준비 안 됨 — 앞 문맥으로 보내지 않는다
    void loadCommentWriteContext(abort.signal).then((next) => {
      if (!abort.signal.aborted) setCtx(next);
    });
    return () => abort.abort();
  }, [tick]);
  return ctx;
}

// 서버가 어셋 그림을 받는가 — **지금 문맥의 '받는다' 하나만** 기억한다. 문맥이 바뀌면 버리고(A→B→A 로 돌아와도 다시 묻는다), 안 받음
//  (옛 서버의 칸 없음)·실패(경로 없음·401·403·연결·5xx)는 기억하지 않아 같은 문맥에서 서버를 업데이트한 뒤 다음 확인(작은 창을 열 때)에
//  보인다(독립 리뷰 P2 ×2). 같은 문맥에서 서버를 되돌리면 [편집]이 남지만 실제 차단은 comments-v2 의 경로 없음 409(server_update_needed — 초안 유지)다(설계 E5).
let supportedKey: string | null = null;
export async function serverAcceptsAssetDrawings(ctx: CommentWriteContext, signal?: AbortSignal): Promise<boolean> {
  if (supportedKey !== ctx.key) supportedKey = null; // 다른 문맥의 기억은 버린다
  if (!hubHasFeature(ASSET_DRAWING_FEATURE)) return false;
  if (ctx.mode === "isolated" || (ctx.mode === "hub" && !ctx.proxying)) return true; // 서버 없음 — 허브 표식만 본다
  if (supportedKey === ctx.key) return true;
  try {
    const caps = await api.shareCapabilities(signal);
    const ok = caps?.asset_comment_drawings === 1;
    if (ok && !signal?.aborted) supportedKey = ctx.key;
    return ok;
  } catch {
    return false;
  }
}

/** [편집] 을 보여도 되나 — 허브 표식 + (중계 중이면) 서버 표식. 문맥이나 recheck(열린 파일 등)가 바뀌면 다시 묻고, 다른 문맥의 늦은 답은 버린다. */
export function useAssetDrawingSupport(ctx: CommentWriteContext | null, recheck: unknown = null): boolean {
  const [state, setState] = useState<{ key: string; ok: boolean } | null>(null);
  const key = ctx?.key ?? "";
  useEffect(() => {
    // 문맥·recheck 가 바뀌면 앞 표시를 먼저 비운다 — A 받음 → B(답 전) → A 로 돌아오면 A 를 다시 묻는 동안 옛 A 의 '보임'이 남았다(독립 리뷰 P2)
    setState(null);
    if (!ctx) return;
    const abort = new AbortController();
    void serverAcceptsAssetDrawings(ctx, abort.signal).then((ok) => {
      if (!abort.signal.aborted) setState({ key: ctx.key, ok });
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, recheck]);
  return !!ctx && state?.key === ctx.key && state.ok;
}

export function clearAssetDrawingSupportCache(): void {
  supportedKey = null;
}

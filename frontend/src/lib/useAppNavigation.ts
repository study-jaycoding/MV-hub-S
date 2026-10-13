import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Filters, InfoTarget, PreviewTarget } from "../types";

type NavOverlay = "preview" | "comment" | "admin";
/** 기록에 싣는 **보는 자리**(2026-10-13 ② — 뒤로·앞으로 가기가 폴더 위치를 되살린다). `ctx` = 계정·서버·공간 범위(App 이 만든다) — 다른 문맥에서
 *  남긴 자리는 되살리지 않는다(공간을 바꾼 뒤의 뒤로 가기가 옛 공간의 폴더를 넣지 않게). 프로젝트 맨 위는 둘 다 undefined 인 **명시적** 자리다 —
 *  옛 판의 기록(`loc` 자체가 없음)과 구분된다(Codex 설계 검토). */
export type NavLocation = {
  project_id?: string;
  folder_path?: string;
  deleted_only?: boolean; // 휴지통 보기도 자리다 — 사이드바의 휴지통 줄로 들어가고 뒤로 가면 일반 목록(Codex 코드 리뷰)
  include_deleted?: boolean;
  ctx: string;
};
// edit = 편집 탭(오버레이가 아니라 '보기'). Filters["tab"] 의 값이 아니다 — 밑의 탭 상태는 그대로 둔 채 본문만 바꾼다.
type NavView = { tab: Filters["tab"]; focusId: string | null; ov: NavOverlay | null; key: number; edit?: boolean; sid?: string; loc?: NavLocation };
const sameLocation = (a: NavLocation | undefined, b: NavLocation) =>
  !!a && a.project_id === b.project_id && a.folder_path === b.folder_path &&
  !!a.deleted_only === !!b.deleted_only && !!a.include_deleted === !!b.include_deleted && a.ctx === b.ctx;
// 이 페이지를 연 때의 표식 — payload 번호(key)는 페이지를 열 때마다 1 부터 다시 세므로, 새로 고침 전의 기록(브라우저가 state 를
//  보존한다)과 번호가 겹친다. 표식이 다른 기록은 payload 가 없는 것으로 본다(미리보기는 닫힌 채로 — 다른 것이 뜨는 것보다 낫다).
const NAV_SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useAppNavigation({
  currentTab,
  lastBoardFocusRef,
  setPreview,
  setCommentGenId,
  setAdminOpen,
  setInfo,
  setBoardFocusId,
  setBoardArrange,
  setFilters,
  setEditOpen,
  previewScopeKey,
  currentLocation,
  restoreLocation,
  locationCtxFor,
}: {
  currentTab: Filters["tab"];
  lastBoardFocusRef: MutableRefObject<string | null>;
  setPreview: Dispatch<SetStateAction<PreviewTarget | null>>;
  setCommentGenId: Dispatch<SetStateAction<string | null>>;
  setAdminOpen: Dispatch<SetStateAction<boolean>>;
  setInfo: Dispatch<SetStateAction<InfoTarget | null>>;
  setBoardFocusId: Dispatch<SetStateAction<string | null>>;
  setBoardArrange: Dispatch<SetStateAction<number>>;
  setFilters: Dispatch<SetStateAction<Filters>>;
  setEditOpen?: Dispatch<SetStateAction<boolean>>;
  previewScopeKey?: string;
  /** 지금 보는 자리 — 모든 기록이 완전한 자리 스냅샷을 갖는다(없으면 자리를 싣지 않는 옛 호출자). */
  currentLocation?: NavLocation;
  /** 기록의 자리를 되살리는 표시 전용 setter(lib/useLibraryFilters restoreLocation) — 같은 문맥의 자리만 받는다. */
  restoreLocation?: (location: NavLocation) => void;
  /** 어느 탭의 자리가 **지금** 갖게 될 문맥 — 기록의 자리는 지금 탭이 아니라 **그 기록의 탭**의 문맥과 견준다(공유 탭의 폴더 → 작업 공간 탭 → 뒤로:
   *  지금 탭의 문맥("")과 견주면 공유 폴더가 안 되살아나고 effect 가 그 기록을 빈 자리로 덮었다 — Codex 코드 리뷰). 없으면 지금 자리의 문맥. */
  locationCtxFor?: (tab: Filters["tab"]) => string;
}) {
  const navPayloadsRef = useRef(new Map<number, unknown>());
  const previewScopeRef = useRef(previewScopeKey);
  const currentLocationRef = useRef(currentLocation);
  currentLocationRef.current = currentLocation;
  const restoreLocationRef = useRef(restoreLocation);
  restoreLocationRef.current = restoreLocation;
  const locationCtxForRef = useRef(locationCtxFor);
  locationCtxForRef.current = locationCtxFor;
  // 표시 공간/계정이 바뀌면 닫힌 미리보기도 뒤로가기로 복원하지 않는다.
  // 히스토리 엔트리는 그대로 두고 payload만 비워, 새 공간의 이후 기록은 정상 사용한다.
  if (previewScopeRef.current !== previewScopeKey) {
    previewScopeRef.current = previewScopeKey;
    navPayloadsRef.current.clear();
  }
  const navSeqRef = useRef(0);
  const viewRef = useRef<NavView>({ tab: currentTab, focusId: null, ov: null, key: 0, ...(currentLocation ? { loc: currentLocation } : {}) });

  useEffect(() => {
    viewRef.current = { ...viewRef.current, tab: currentTab };
  }, [currentTab]);

  const applyView = useCallback(
    (v: NavView) => {
      viewRef.current = v;
      const payload = v.key && v.sid === NAV_SESSION ? navPayloadsRef.current.get(v.key) : undefined;
      setPreview(v.ov === "preview" ? ((payload as PreviewTarget) ?? null) : null);
      // 코멘트 패널은 nav 뷰(탭 전환)에 묶지 않는다 — 태그창처럼 X 로 닫을 때까지 유지(독립 상태).
      setAdminOpen(v.ov === "admin");
      setEditOpen?.(!!v.edit); // 옛 기록(칸 없음)은 편집이 아니다
      setInfo(null);
      if (v.tab === "compose") {
        setBoardFocusId(v.focusId);
        setBoardArrange((x) => x + 1);
      } else {
        setBoardFocusId(null);
      }
      // 기록의 자리 — 같은 문맥(계정·서버·공간 범위 — **그 기록의 탭**이 지금 갖게 될 문맥)일 때만 되살린다. 자리가 없는 옛 기록·다른 문맥의
      //  기록은 지금 자리를 둔다. 탭보다 먼저 넣는다(아래 setFilters 의 갱신 함수가 최신 상태 위에서 탭만 바꾼다).
      const ctxNow = locationCtxForRef.current ? locationCtxForRef.current(v.tab) : currentLocationRef.current?.ctx;
      if (v.loc && ctxNow !== undefined && v.loc.ctx === ctxNow) restoreLocationRef.current?.(v.loc);
      setFilters((f) => (f.tab === v.tab ? f : { ...f, tab: v.tab }));
    },
    [
      setAdminOpen,
      setBoardArrange,
      setBoardFocusId,
      setCommentGenId,
      setEditOpen,
      setFilters,
      setInfo,
      setPreview,
    ],
  );

  const navigate = useCallback(
    (next: NavView) => {
      window.history.pushState({ chv: next }, "");
      applyView(next);
    },
    [applyView],
  );

  const openOverlay = useCallback(
    (ov: NavOverlay, payload?: unknown) => {
      // 이미 떠 있는 관리자 창을 또 열지 않는다 — 기록이 한 겹 더 쌓이면 Esc(뒤로 한 번)에 창이 안 닫힌다. 로고를 눌러 연 뒤 초점이
      //  로고에 남은 채 Space 를 누르면 그랬다(2026-10-10 편집 탭 재실측 3/3: 두 번째 Esc 에야 닫힘).
      if (ov === "admin" && viewRef.current.ov === "admin") return;
      const key = ov === "admin" ? 0 : (navSeqRef.current += 1);
      if (key) {
        const m = navPayloadsRef.current;
        m.set(key, payload);
        // 세션 내내 오버레이(미리보기 등)를 여닫을 때마다 payload 가 무한 누적되던 것을 막는다.
        // 키는 단조 증가(삽입순=오래된 순)라 가장 오래된 것부터 잘라 최근 N개만 유지한다. 아주 깊은
        // 뒤로가기(20단계+)에서는 payload 가 없어 오버레이가 빈 상태로 열리지만(applyView 가 null 처리),
        // 실사용 뒤로가기 깊이를 훨씬 넘는 값이라 무해.
        const MAX_PAYLOADS = 20;
        if (m.size > MAX_PAYLOADS) {
          const keys = [...m.keys()];
          for (let i = 0; i < keys.length - MAX_PAYLOADS; i++) m.delete(keys[i]);
        }
      }
      const cur = viewRef.current;
      // 편집 위에 뜬 창을 닫으면 편집으로 돌아온다 · 겹을 열 때도 지금 자리를 싣는다
      navigate({ tab: cur.tab, focusId: cur.focusId, ov, key, edit: cur.edit, sid: NAV_SESSION, loc: cur.loc });
    },
    [navigate],
  );

  const closeOverlay = useCallback(() => {
    if (viewRef.current.ov) window.history.back();
  }, []);

  const navTab = useCallback(
    (tab: Filters["tab"]) =>
      navigate({
        tab,
        focusId: tab === "compose" ? viewRef.current.focusId || lastBoardFocusRef.current : null,
        ov: null,
        key: 0,
        loc: viewRef.current.loc, // 탭을 누른 뒤 App 이 자리를 지우거나 되살리면 아래 syncLocation 이 이 기록의 자리를 고쳐 적는다
      }),
    [lastBoardFocusRef, navigate],
  );

  const enterBoard = useCallback(
    (genId: string) => navigate({ tab: "compose", focusId: genId, ov: null, key: 0, loc: viewRef.current.loc }),
    [navigate],
  );

  const openEdit = useCallback(() => {
    const cur = viewRef.current;
    if (!cur.edit) navigate({ tab: cur.tab, focusId: cur.focusId, ov: null, key: 0, edit: true, loc: cur.loc }); // 편집 기록도 지금 자리를 싣는다
  }, [navigate]);

  // 보는 자리가 바뀌었다(App 의 effect — 렌더마다) — 명시적 이동(컷 카드·사이드바 폴더를 눌러 들어감)이면 기록을 한 칸 **쌓고**, 그 밖(따라가기·
  //  탭을 누른 뒤의 지움·되살림·지워진 프로젝트 정리·공간 전환)은 지금 기록의 자리를 **고쳐 적는다** — 모든 기록이 완전한 자리를 갖는다. 같은
  //  자리면 아무 일도 없다(되살린 뒤의 렌더, 겹을 여닫은 뒤). 겹·초점은 그대로 둔다.
  const syncLocation = useCallback((location: NavLocation, push: boolean) => {
    const cur = viewRef.current;
    if (sameLocation(cur.loc, location)) return;
    const next = { ...cur, loc: location };
    if (push) window.history.pushState({ chv: next }, "");
    else window.history.replaceState({ chv: next }, "");
    viewRef.current = next;
  }, []);

  const openPreview = useCallback((target: PreviewTarget) => openOverlay("preview", target), [openOverlay]);
  // 코멘트는 nav 오버레이가 아니라 독립 상태 — 열면 그대로 두고(탭 전환에도 유지) X 로만 닫는다.
  const openComment = useCallback((genId: string) => setCommentGenId(genId), [setCommentGenId]);
  const openAdmin = useCallback(() => openOverlay("admin"), [openOverlay]);

  useEffect(() => {
    window.history.replaceState({ chv: viewRef.current }, "");
    const onPop = (e: PopStateEvent) => {
      const st = e.state as { chv?: NavView } | null;
      applyView(st?.chv ?? { tab: "my", focusId: null, ov: null, key: 0 });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyView]);

  return {
    openOverlay,
    closeOverlay,
    navTab,
    enterBoard,
    openEdit,
    openPreview,
    openComment,
    openAdmin,
    syncLocation,
  };
}

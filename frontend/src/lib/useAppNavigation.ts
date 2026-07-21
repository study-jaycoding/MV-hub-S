import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Filters, History, InfoTarget, PreviewTarget } from "../types";

type NavOverlay = "preview" | "comment" | "admin" | "history";
type NavView = { tab: Filters["tab"]; focusId: string | null; ov: NavOverlay | null; key: number };

export function useAppNavigation({
  currentTab,
  lastBoardFocusRef,
  setPreview,
  setCommentGenId,
  setHistory,
  setAdminOpen,
  setInfo,
  setBoardFocusId,
  setBoardArrange,
  setFilters,
}: {
  currentTab: Filters["tab"];
  lastBoardFocusRef: MutableRefObject<string | null>;
  setPreview: Dispatch<SetStateAction<PreviewTarget | null>>;
  setCommentGenId: Dispatch<SetStateAction<string | null>>;
  setHistory: Dispatch<SetStateAction<History | null>>;
  setAdminOpen: Dispatch<SetStateAction<boolean>>;
  setInfo: Dispatch<SetStateAction<InfoTarget | null>>;
  setBoardFocusId: Dispatch<SetStateAction<string | null>>;
  setBoardArrange: Dispatch<SetStateAction<number>>;
  setFilters: Dispatch<SetStateAction<Filters>>;
}) {
  const navPayloadsRef = useRef(new Map<number, unknown>());
  const navSeqRef = useRef(0);
  const viewRef = useRef<NavView>({ tab: currentTab, focusId: null, ov: null, key: 0 });

  useEffect(() => {
    viewRef.current = { ...viewRef.current, tab: currentTab };
  }, [currentTab]);

  const applyView = useCallback(
    (v: NavView) => {
      viewRef.current = v;
      const payload = v.key ? navPayloadsRef.current.get(v.key) : undefined;
      setPreview(v.ov === "preview" ? ((payload as PreviewTarget) ?? null) : null);
      // 코멘트 패널은 nav 뷰(탭 전환)에 묶지 않는다 — 태그창처럼 X 로 닫을 때까지 유지(독립 상태).
      setHistory(v.ov === "history" ? ((payload as History) ?? null) : null);
      setAdminOpen(v.ov === "admin");
      setInfo(null);
      if (v.tab === "compose") {
        setBoardFocusId(v.focusId);
        setBoardArrange((x) => x + 1);
      } else {
        setBoardFocusId(null);
      }
      setFilters((f) => (f.tab === v.tab ? f : { ...f, tab: v.tab }));
    },
    [
      setAdminOpen,
      setBoardArrange,
      setBoardFocusId,
      setCommentGenId,
      setFilters,
      setHistory,
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
      const key = ov === "admin" ? 0 : (navSeqRef.current += 1);
      if (key) navPayloadsRef.current.set(key, payload);
      const cur = viewRef.current;
      navigate({ tab: cur.tab, focusId: cur.focusId, ov, key });
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
      }),
    [lastBoardFocusRef, navigate],
  );

  const enterBoard = useCallback(
    (genId: string) => navigate({ tab: "compose", focusId: genId, ov: null, key: 0 }),
    [navigate],
  );

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
    openPreview,
    openComment,
    openAdmin,
  };
}

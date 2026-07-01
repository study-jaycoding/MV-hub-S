import { useEffect, useRef, useState, type RefObject } from "react";

const PAGE_SIZE = 60;
const INITIAL_VISIBLE = 120;

export function useIncrementalGenerationRender<T>({
  items,
  resetKey,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: T[];
  resetKey?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}): {
  visible: T[];
  hasMoreToRender: boolean;
  sentinelRef: RefObject<HTMLDivElement>;
} {
  const [shown, setShown] = useState(INITIAL_VISIBLE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const moreToShow = shown < items.length;
  const showSentinel = moreToShow || !!hasMore;

  useEffect(() => {
    setShown(INITIAL_VISIBLE);
  }, [resetKey]);

  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (shown < items.length) {
      setShown((s) => Math.min(items.length, s + PAGE_SIZE));
    } else if (hasMore && !loadingMore) {
      onLoadMore?.();
    }
  };

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !showSentinel) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [showSentinel, shown, items.length, hasMore, loadingMore]);

  return {
    visible: items.slice(0, shown),
    hasMoreToRender: showSentinel,
    sentinelRef,
  };
}

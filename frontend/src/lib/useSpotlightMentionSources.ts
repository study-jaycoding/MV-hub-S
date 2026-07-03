import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Generation } from "../types";

export type SpotlightMention = { kind: "@" | "#"; query: string } | null;

export function useSpotlightMentionSources(mention: SpotlightMention, project: string | null) {
  const [allSources, setAllSources] = useState<Generation[]>([]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  // 피커가 열리면 현재 에셋 프로젝트의 모든 S 소스를 로드한다.
  // ★의존성은 '열림 여부'만 — mention 객체는 키 입력마다 새로 만들어지므로(query 변화)
  // 그대로 걸면 타이핑마다 목록을 비우고 전량 재요청해 깜빡임+하이라이트 리셋을 유발했다.
  // 질의어 필터는 어차피 아래 sourceList/tagList 가 클라이언트에서 처리한다.
  const pickerOpen = !!mention;
  useEffect(() => {
    if (!pickerOpen) return;
    let alive = true;
    // 프로젝트 전환 시 이전 프로젝트 소스를 즉시 비운다.
    setAllSources([]);
    api
      .searchSources(undefined, undefined, project ?? undefined)
      .then((result) => alive && setAllSources(result))
      .catch(() => alive && setAllSources([]));
    return () => {
      alive = false;
    };
  }, [pickerOpen, project]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of allSources) {
      for (const tag of source.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return counts;
  }, [allSources]);

  const tagList = useMemo(() => {
    let tags = [...tagCounts.keys()];
    const query = mention?.kind === "#" ? mention.query.toLowerCase() : "";
    if (query) tags = tags.filter((tag) => tag.toLowerCase().includes(query));
    return tags.sort((a, b) => a.localeCompare(b));
  }, [tagCounts, mention]);

  const sourceList = useMemo(() => {
    let base = allSources;
    if (tagFilter) base = base.filter((source) => source.tags.includes(tagFilter));
    const query = mention?.kind === "@" ? mention.query.toLowerCase() : "";
    if (query) base = base.filter((source) => (source.source_name || "").toLowerCase().includes(query));
    return base;
  }, [allSources, tagFilter, mention]);

  return { allSources, sourceList, tagCounts, tagFilter, tagList, setTagFilter };
}

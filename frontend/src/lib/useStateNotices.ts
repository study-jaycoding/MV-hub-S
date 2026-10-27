// 상황이 이어지는 동안 남는 안내 줄(편집 탭 경고 — Jay 2026-10-24) — 화면 위 가운데의 Resolve 결과 알림 줄(components/app/ResolveNotices)에
//  같은 모양으로 선다. 막대에 긴 알약으로 붙어 닫을 수도 없던 것을 옮겼다.
//  열쇠 = 상황. ✕ 로 닫으면 그 상황이 이어지는 동안은 다시 안 뜨고, 상황이 풀리면(목록에서 빠지면) 줄도 사라지고 닫은 표시도 잊는다 —
//  다시 생기면 다시 뜬다. 올리는 쪽(onNotices)은 보이는 줄이 바뀔 때만 부르고, 떠날 때(언마운트) 빈 목록으로 거둔다.
import { useEffect, useRef, useState } from "react";
import type { ResolveNotice } from "./useResolveTransferActions";

export interface StateNotice {
  key: string; // 상황 — 다른 상황(예: 백업 충돌 → 실패)은 다른 열쇠라 새 줄이다
  text: string; // 첫 마디( — 나 · 앞)가 굵게 보인다
  title?: string;
  action?: { label: string; run: () => void }; // 알림 안 글자 단추
}

/** 알림 줄 한 줄 — Resolve 결과(숫자 id, 닫기는 받는 쪽) 또는 상황 경고(글자 id, 닫기는 스스로). */
export type NoticeLine = ResolveNotice | (Omit<StateNotice, "key"> & { id: string; onDismiss: () => void });

export function useStateNotices(notices: readonly StateNotice[], onNotices?: (lines: readonly NoticeLine[]) => void): void {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef(notices);
  latest.current = notices;
  const report = useRef(onNotices);
  report.current = onNotices;
  const keys = notices.map((item) => item.key).join("\n");
  useEffect(() => {
    const live = new Set(keys.split("\n"));
    setClosed((old) => ([...old].every((key) => live.has(key)) ? old : new Set([...old].filter((key) => live.has(key)))));
  }, [keys]);
  const shown = notices.filter((item) => !closed.has(item.key));
  // 단추의 동작은 올린 뒤 바뀌어도(새 함수) 그때의 것을 부른다 — 글이 같으면 다시 올리지 않는다
  const lines = useRef<NoticeLine[]>([]);
  lines.current = shown.map((item) => ({
    id: `state:${item.key}`, text: item.text, title: item.title,
    action: item.action && { label: item.action.label, run: () => latest.current.find((now) => now.key === item.key)?.action?.run() },
    onDismiss: () => setClosed((old) => new Set(old).add(item.key)),
  }));
  const signature = JSON.stringify(shown.map((item) => [item.key, item.text, item.title ?? "", item.action?.label ?? ""]));
  useEffect(() => {
    report.current?.(lines.current);
  }, [signature]);
  useEffect(() => () => report.current?.([]), []);
}

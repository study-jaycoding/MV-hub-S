// SceneBoard 의 'genId → 실제 생성물' 바인딩·폴링·계보(레퍼런스 부모)·비활성/삭제 상태를 컴포넌트에서 추출.
//  · 카드의 모든 변형(genIds) 생성물을 조회하고, 진행 중이면 그것만 재폴링(N+1 폴링 제거).
//  · 외부에서 삭제(404/410)된 id 는 missingIds 로 표시, deactivated(회색)는 disabledIds 로.
//  · 각 생성물의 레퍼런스 부모(materials)는 새 id 만 1회 조회(계보는 생성 시 확정·불변).
// 미러 ref(genDataRef)는 렌더 중 대입해야 한다(useEffect 로 옮기면 한 렌더 늦음).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { APP_EVENTS } from "./appEvents";
import { onLibraryChanged } from "./libraryBroadcast";
import { DISABLED_EVENT, loadDisabledFolders, loadDisabledGen } from "./deactivated";
import { expandDisabledGenerationIds } from "./generationDisplay";
import { useCustomEvent } from "./useCustomEvent";
import { variantIds, type SceneCard } from "./scenes";
import {
  putGen,
  putParents,
  markGenMissing,
  hydrateGen,
  hydrateParents,
  hydrateMissing,
} from "./sceneGenDataStore";
import { observeStatus } from "./sceneRecentDoneStore";
import { reconcileRecordState } from "./stateReconciliation";
import type { Generation } from "../types";
import { getAuthToken } from "./http";
import { getAccountNamespace } from "./accountScope";
import { ColorScopeChangedError } from "./generationColorState";

export interface SceneColorScope {
  sceneKey: string; // SceneBoard의 cardsSceneId: passive 씬 동기화 전에는 실제 카드의 옛 씬
  authKey: string;
  authReady: boolean;
}
interface ColorLedgerGeneration {
  id: string;
  authEpoch: number;
  revision: number;
  revisions: Map<string, number>;
  pending: Map<string, number>;
}
export interface SceneColorTicket {
  gen: ColorLedgerGeneration;
  authEpoch: number;
  token: string | null;
  ns: string;
  ids: string[];
  revisions: Record<string, number>;
}
export interface SceneColorLedger {
  begin(ids: string[], color: string | null): SceneColorTicket | null;
  end(ticket: SceneColorTicket): void;
  isLive(ticket: SceneColorTicket, requireGeneration?: boolean): boolean;
  currentIds(): string[];
  applyRecovered(ticket: SceneColorTicket, colors: Record<string, string | null>): string[];
}
const DEFAULT_COLOR_SCOPE: SceneColorScope = { sceneKey: "", authKey: "", authReady: true };
const newColorGeneration = (id: string, authEpoch: number): ColorLedgerGeneration =>
  ({ id, authEpoch, revision: 0, revisions: new Map(), pending: new Map() });
function readStamp(gen: ColorLedgerGeneration, authEpoch: number, ids: string[]) {
  const stamp: SceneColorTicket = { gen, authEpoch, token: getAuthToken(), ns: getAccountNamespace(), ids,
    revisions: Object.fromEntries(ids.map(id => [id, gen.revisions.get(id) ?? 0])) };
  const pending = new Set(ids.filter(id => (gen.pending.get(id) ?? 0) > 0));
  const keepColor = (id: string) => pending.has(id) || (gen.pending.get(id) ?? 0) > 0
    || stamp.revisions[id] !== (gen.revisions.get(id) ?? 0);
  return { stamp, keepColor };
}

export interface SceneGenDataApi {
  genData: Record<string, Generation>; // 바인딩된 genId → 실제 생성물
  setGenData: React.Dispatch<React.SetStateAction<Record<string, Generation>>>;
  genDataRef: React.MutableRefObject<Record<string, Generation>>; // 명령형 로직이 최신값을 읽는 미러(반환)
  missingIds: Set<string>; // 외부 삭제(404/410)로 사라진 id — '삭제됨' 표시
  disabledIds: Set<string>; // 비활성(회색) — deactivated 로컬 소스
  refParents: Record<string, string[]>; // genId → 레퍼런스 부모(materials) id들
}

export function useSceneGenData(cards: SceneCard[], scope = DEFAULT_COLOR_SCOPE): SceneGenDataApi & {
  colors: SceneColorLedger;
  refreshGenerationAfter(gid: string, settled: unknown): void;
} {
  // 마운트 초기값 = 캐시(sceneGenDataStore)에서 즉시 복원 — 탭 왕복(언마운트→재마운트) 시 빈 화면 없이 바로 표시.
  const initialGenIds = (): string[] =>
    cards
      .filter((c) => c.kind === "generation" || (c.kind === "comfy" && (c.genIds?.length || c.genId)))
      .flatMap((c) => variantIds(c));
  const [genData, setGenData] = useState<Record<string, Generation>>(() => hydrateGen(initialGenIds()));
  const genDataRef = useRef(genData);
  genDataRef.current = genData;
  // 외부(라이브러리)에서 삭제(휴지통 이동)돼 404 로 사라진 생성물 id — 카드가 무한 'Generating' 대신 '삭제됨' 표시.
  const [missingIds, setMissingIds] = useState<Set<string>>(() => hydrateMissing(initialGenIds()));
  const [refParents, setRefParents] = useState<Record<string, string[]>>(() => hydrateParents(initialGenIds()));
  // 비활성(회색) 표시 — 라이브러리/계보와 같은 로컬 소스(deactivated). 어디서 토글해도 즉시 반영.
  const [disabledTick, setDisabledTick] = useState(0);
  useCustomEvent(DISABLED_EVENT, () => setDisabledTick((t) => t + 1));
  const disabledIds = useMemo(
    () => expandDisabledGenerationIds(Object.values(genData), loadDisabledGen(), loadDisabledFolders()),
    [genData, disabledTick],
  );
  const genIdSig = cards
    // 생성 카드 + Comfy 노드(출력을 생성물로 저장해 genIds 를 가진 것) 모두 생성물 데이터를 조회한다.
    .filter((c) => c.kind === "generation" || (c.kind === "comfy" && (c.genIds?.length || c.genId)))
    .flatMap((c) => variantIds(c))
    .join(",");
  const pendingAttemptSig = cards
    .flatMap((card) => card.pendingGenerationAttempts || [])
    .map((attempt) => attempt.generationId)
    .join(",");
  const authId = JSON.stringify([scope.authKey, scope.authReady]);
  const ledgerId = JSON.stringify([authId, scope.sceneKey]);
  const authRef = useRef({ epoch: 0, mounted: false, ready: scope.authReady });
  const ledgerRef = useRef(newColorGeneration(ledgerId, 0));
  const liveIdsRef = useRef(new Set<string>());
  useLayoutEffect(() => {
    authRef.current = { ...authRef.current, mounted: true, ready: scope.authReady };
    return () => {
      authRef.current = { ...authRef.current, mounted: false, epoch: authRef.current.epoch + 1 };
    };
  }, [authId, scope.authReady]);
  useLayoutEffect(() => {
    ledgerRef.current = newColorGeneration(ledgerId, authRef.current.epoch);
  }, [ledgerId]);
  useLayoutEffect(() => { liveIdsRef.current = new Set(genIdSig.split(",").filter(Boolean)); }, [genIdSig]);

  // 장부·ref·캐시의 단일 소유자. UI 명령은 현재 선택을 동기적으로 전달한다.
  // 티켓은 자신의 세대를 소유하므로 같은 씬/계정 문자열로 돌아와도 옛 end가 새 pending을 내리지 않는다.
  const colors = useMemo<SceneColorLedger>(() => {
    const isLive = (ticket: SceneColorTicket, requireGeneration = false) =>
      authRef.current.mounted && authRef.current.ready && authRef.current.epoch === ticket.authEpoch
      && getAuthToken() === ticket.token && getAccountNamespace() === ticket.ns
      && (!requireGeneration || ticket.gen === ledgerRef.current);
    const writeColors = (ticket: SceneColorTicket, values: Record<string, string | null>) => {
      if (!isLive(ticket, true)) return [];
      const canWrite = (id: string) => liveIdsRef.current.has(id)
        && ticket.gen.revisions.get(id) === ticket.revisions[id];
      const next = { ...genDataRef.current };
      const written: string[] = [];
      for (const [id, color] of Object.entries(values)) {
        if (!canWrite(id) || !next[id]) continue;
        next[id] = { ...next[id], color };
        putGen(next[id], id);
        written.push(id);
      }
      if (!written.length) return written;
      genDataRef.current = next; // 동일 event의 다음 토글도 즉시 최신 색을 읽는다.
      setGenData(prev => {
        if (!isLive(ticket, true)) return prev;
        const updated = { ...prev };
        for (const id of written) if (prev[id] && canWrite(id)) updated[id] = { ...prev[id], color: values[id] };
        return reconcileRecordState(prev, updated);
      });
      return written;
    };
    return {
      isLive,
      currentIds: () => [...liveIdsRef.current],
      begin(gids, color) {
        if (!authRef.current.mounted || !authRef.current.ready) return null;
        const ids = [...new Set(gids)].filter(id => liveIdsRef.current.has(id) && !!genDataRef.current[id]);
        if (!ids.length) return null;
        const gen = ledgerRef.current;
        const ticket: SceneColorTicket = { gen, ids, authEpoch: authRef.current.epoch,
          token: getAuthToken(), ns: getAccountNamespace(), revisions: {} };
        for (const id of ids) {
          // prune 후 같은 gid가 돌아와도 과거 복구 revision과 다시 같아지지 않는다.
          const revision = ++gen.revision;
          gen.revisions.set(id, revision);
          gen.pending.set(id, (gen.pending.get(id) ?? 0) + 1);
          ticket.revisions[id] = revision;
        }
        writeColors(ticket, Object.fromEntries(ids.map(id => [id, color])));
        return ticket;
      },
      end(ticket) {
        for (const id of ticket.ids) {
          const pending = (ticket.gen.pending.get(id) ?? 0) - 1;
          if (pending > 0) ticket.gen.pending.set(id, pending);
          else {
            ticket.gen.pending.delete(id);
            if (ticket.gen !== ledgerRef.current || !liveIdsRef.current.has(id)) ticket.gen.revisions.delete(id);
          }
        }
      },
      applyRecovered: writeColors,
    };
  }, []);
  const refreshGenerationAfter = useCallback((gid: string, settled: unknown) => {
    // 현재 공유 콜백 호출 직후, 첫 await 양보 전에 동기 포획한다. finally 안에서 새 범위를 읽지 않는다.
    const { stamp: actionScope } = readStamp(ledgerRef.current, authRef.current.epoch, [gid]);
    const current = () => colors.isLive(actionScope, true)
      && liveIdsRef.current.has(gid) && !!genDataRef.current[gid];
    void Promise.resolve(settled).catch(() => {}).then(async () => {
      if (!current()) return;
      // action 대기 중 완료된 색 저장은 잠그지 않는다. 실제 GET 출발 시점이 읽기 기준이다.
      const { stamp, keepColor } = readStamp(ledgerRef.current, authRef.current.epoch, [gid]);
      try {
        const fresh = await api.getGeneration(gid);
        if (!fresh || !current() || !colors.isLive(stamp, true)) return;
        const record = keepColor(gid) ? { ...fresh, color: genDataRef.current[gid].color } : fresh;
        putGen(record, gid);
        genDataRef.current = { ...genDataRef.current, [gid]: record };
        setGenData(prev => {
          if (!current() || !colors.isLive(stamp, true) || !prev[gid]) return prev;
          const next = keepColor(gid) ? { ...fresh, color: prev[gid].color } : fresh;
          return reconcileRecordState(prev, { ...prev, [gid]: next });
        });
      } catch {
        // 단건 조회는 삭제 판정을 소유하지 않는다. 기존처럼 실패는 다음 일반 poll에 맡긴다.
      }
    });
    // 색 외 필드는 이 응답값을 수용한다. 별도 공유 동작/일반 poll 사이의 메타 최신 순서는 보장하지 않는다.
  }, [colors]);
  // 생성물 변경 브로드캐스트(담기/폴더이동/미분류/삭제 등)를 구독 → 현재 카드들의 생성물을 즉시
  // 재조회한다. 완료 카드는 평소 재폴링을 안 해 folder_path/project_id 가 stale 이었고,
  // 그래서 캔버스에서 폴더로 담은 직후 그 폴더를 눌러도(탭 왕복 전) 딤이 옛 값으로 잘못 표시되던 버그.
  // 라이브러리 변경이 연속으로(배치 태깅·담기 등) 오면 매번 전 variant 재조회는 과하다 →
  // 트레일링 300ms 디바운스로 버스트를 1회로 합친다(마지막 이벤트 후 실행이라 folder 신선도 유지).
  // 화면에 보이는 상태가 아닌 재조회 트리거를 setState로 만들면 응답이 같아도 큰 SceneBoard가 먼저
  // 한 번 렌더된다. 실제 요청 함수는 ref로 직접 호출하고, 아래 state는 응답 내용이 달라질 때만 바꾼다.
  const refreshSceneDataRef = useRef<() => void>(() => {});
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const bumpRefresh = () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => refreshSceneDataRef.current(), 300);
  };
  useEffect(() => onLibraryChanged(bumpRefresh), []); // 창 간
  useCustomEvent(APP_EVENTS.libraryChanged, bumpRefresh); // 같은 창(내 담기·생성 즉시)
  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);
  useEffect(() => {
    const ids = Array.from(new Set(genIdSig.split(",").filter(Boolean)));
    const pendingAttemptIds = new Set(pendingAttemptSig.split(",").filter(Boolean));
    if (!ids.length || !scope.authReady) {
      refreshSceneDataRef.current = () => {};
      return;
    }
    let alive = true;
    let timer: number | undefined;
    let requestSeq = 0;
    const tick = async (pollIds: string[]) => {
      const seq = ++requestSeq;
      const { stamp, keepColor } = readStamp(ledgerRef.current, authRef.current.epoch, pollIds);
      const gen = stamp.gen;
      const current = () => alive && seq === requestSeq && colors.isLive(stamp, true);
      const assertCurrent = () => { if (!current()) throw new ColorScopeChangedError(); };
      // 숨겨진 탭에서는 활성 씬도 보이지 않는다. 서버 조회를 쉬고 복귀 뒤 기존 주기 안에 재개한다.
      if (document.visibilityState === "hidden") {
        if (alive && seq === requestSeq) timer = window.setTimeout(() => tick(pollIds), 2500);
        return;
      }
      // 생성물 상태와 직접 레퍼런스 부모를 한 번에 조회 — 카드별 generation/history N+1 제거.
      let batch: Awaited<ReturnType<typeof api.getGenerationsBatch>>;
      try {
        batch = await api.getGenerationsBatch(pollIds, assertCurrent);
      } catch (error) {
        if (error instanceof ColorScopeChangedError || !current()) return;
        // 일시 오류는 기존 캐시를 유지하고 같은 묶음을 다시 시도한다. 캔버스가 열려 있는 동안은
        // 중복 방지를 위해 App 보조 watcher가 쉬므로 여기서 재시도 책임을 가진다.
        if (alive && seq === requestSeq) timer = window.setTimeout(() => tick(pollIds), 2500);
        return;
      }
      const missing = new Set(batch.missing || []);
      const rs = pollIds.map((id) => ({
        id,
        gen: batch.items[id] || null,
        gone: missing.has(id),
      }));
      // 새 변경 신호가 와서 전량 요청을 다시 시작했으면 그보다 먼저 출발한 응답은 폐기한다.
      if (!current()) return;
      // 캐시에도 기록 — 탭 왕복·씬 전환 시 재조회 없이 즉시 복원되게(성공=저장/재등장, 삭제=missing 표시).
      for (const r of rs) {
        if (r.gen) {
          if (keepColor(r.id) && genDataRef.current[r.id]) r.gen = { ...r.gen, color: genDataRef.current[r.id].color };
          putGen(r.gen, r.id);
          markGenMissing(r.id, false);
          observeStatus(r.id, r.gen.status);
        } else if (r.gone) {
          gen.revisions.delete(r.id); // 삭제 우선. 살아 있는 티켓의 pending은 자신의 end에서만 감소한다.
          if (!pendingAttemptIds.has(r.id)) markGenMissing(r.id, true);
        }
      }
      for (const id of pollIds) {
        const parents = batch.materials[id];
        if (Array.isArray(parents)) putParents(id, parents);
        else if (missing.has(id)) putParents(id, []);
      }
      setRefParents((prev) => {
        if (!current()) return prev;
        const next = { ...prev };
        for (const id of pollIds) {
          const parents = batch.materials[id];
          if (Array.isArray(parents)) next[id] = parents;
          else if (missing.has(id)) next[id] = [];
        }
        return reconcileRecordState(prev, next);
      });
      setGenData((prev) => {
        if (!current()) return prev;
        const next = { ...prev };
        for (const r of rs) {
          if (r.gen) next[r.id] = keepColor(r.id) && prev[r.id] ? { ...r.gen, color: prev[r.id].color } : r.gen;
          else if (r.gone) delete next[r.id]; // 삭제 확정 → stale 결과 제거(캐시서도 제거됨) → '삭제됨' 표시가 드러나게
        }
        return reconcileRecordState(prev, next);
      });
      setMissingIds((prev) => {
        if (!current()) return prev;
        let changed = false;
        const next = new Set(prev);
        for (const r of rs) {
          if (r.gen && next.delete(r.id)) changed = true; // 되살아나면(복원) 해제
          else if (r.gone && !pendingAttemptIds.has(r.id) && !next.has(r.id)) {
            next.add(r.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // 재폴은 '아직 진행 중'인 id 만 — 완료 카드를 매 2.5초 다시 조회하던 N+1 폴링 제거.
      const stillPending = rs
        .filter((r) =>
          (r.gen && ["pending", "queued", "running", "processing"].includes(String(r.gen.status))) ||
          (!r.gen && pendingAttemptIds.has(r.id)),
        )
        .map((r) => r.id);
      if (stillPending.length) timer = window.setTimeout(() => tick(stillPending), 2500);
    };
    refreshSceneDataRef.current = () => {
      if (!alive) return;
      // 진행 중 카드의 다음 부분 폴링보다 외부 변경 전량 조회를 우선한다.
      if (timer) clearTimeout(timer);
      timer = undefined;
      void tick(ids);
    };
    void tick(ids); // 1회차만 전체 조회(상태 파악), 이후엔 진행 중인 것만
    return () => {
      alive = false;
      requestSeq += 1;
      refreshSceneDataRef.current = () => {};
      if (timer) clearTimeout(timer);
    };
  }, [genIdSig, pendingAttemptSig, ledgerId, scope.authReady, colors]);

  // 씬 전환(genIdSig 변경) 시 새 씬 카드들의 생성물을 캐시에서 즉시 복원 — tick 서버조회를 기다리는 빈 화면 제거.
  //  (prev 우선 병합이라 이미 최신인 값은 덮지 않는다. 아래 prune 이 현재 카드 밖 id 를 곧 정리한다.)
  useEffect(() => {
    const ids = genIdSig.split(",").filter(Boolean);
    if (!ids.length) return;
    const g = hydrateGen(ids);
    const p = hydrateParents(ids);
    const m = hydrateMissing(ids);
    if (Object.keys(g).length) {
      setGenData((prev) => reconcileRecordState(prev, { ...g, ...prev }));
    }
    if (Object.keys(p).length) {
      setRefParents((prev) => reconcileRecordState(prev, { ...p, ...prev }));
    }
    if (m.size)
      setMissingIds((prev) => {
        // id 단위 병합 — 이전 씬 missing 이 남아있어도 새 씬 캐시 missing 을 누락 없이 반영(아래 prune 이 live 밖 제거).
        let changed = false;
        const next = new Set(prev);
        for (const id of m) if (!next.has(id)) { next.add(id); changed = true; }
        return changed ? next : prev;
      });
  }, [genIdSig]);

  // 장기 누적 방지 — 현재 카드가 더 이상 참조하지 않는 id 의 캐시(genData/refParents/missingIds)를 정리.
  // 카드 삭제·씬 전환을 반복하는 긴 세션에서 옛 생성물 데이터가 무한 쌓이지 않게(옛 forward-merge 만 함).
  // (진행 중 폴은 genIdSig 변경 시 위 effect cleanup 이 alive=false 로 무효화 → 지운 id 를 되살리는 레이스 없음)
  useEffect(() => {
    const live = new Set(genIdSig.split(",").filter(Boolean));
    const ledger = ledgerRef.current;
    for (const id of ledger.revisions.keys()) {
      if (!live.has(id) && !ledger.pending.has(id)) ledger.revisions.delete(id);
    }
    const pruned = <T,>(obj: Record<string, T>): Record<string, T> | null => {
      const keys = Object.keys(obj);
      if (keys.every((k) => live.has(k))) return null; // 지울 것 없음 → 참조 유지(불필요 리렌더 방지)
      const next: Record<string, T> = {};
      for (const k of keys) if (live.has(k)) next[k] = obj[k];
      return next;
    };
    setGenData((prev) => pruned(prev) ?? prev);
    setRefParents((prev) => pruned(prev) ?? prev);
    setMissingIds((prev) =>
      [...prev].every((id) => live.has(id)) ? prev : new Set([...prev].filter((id) => live.has(id))),
    );
  }, [genIdSig]);

  return { genData, setGenData, genDataRef, missingIds, disabledIds, refParents, colors, refreshGenerationAfter };
}

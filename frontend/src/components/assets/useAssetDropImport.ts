import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../../api";
import { dataTransferHasFiles, filesFromDataTransfer, referenceMediaTypeFromName, type ReferenceMediaType } from "../../lib/media";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { flashMsg } from "../../lib/flash";
import { captureSubmissionScope } from "../../app/operationContext";
import { APP_EVENTS } from "../../lib/appEvents";

export interface LocalAssetImport {
  id: string;
  syncId?: string;
  project: string;
  dir: string;
  localPath: string;
  name: string;
  type: ReferenceMediaType;
  assetContentId: string;
  state: string;
  current: () => boolean;
}

export function useAssetDropImport({
  dir,
  project,
  onImported,
}: {
  dir: string;
  project: string;
  // 업로드 후 새로고침 — 가드·캐시가 있는 refreshProjectData 로 위임(전환 중이면 화면 대신 캐시만 갱신).
  onImported: (project: string) => boolean | void | Promise<boolean | void>;
}) {
  const [dropActive, setDropActive] = useState(false);
  // 돌고 있는 반입의 수 — 참/거짓으로 두면 겹친 반입 가운데 먼저 끝난 쪽이 '가져오는 중' 표시를 지운다.
  const [importing, setImporting] = useState(0);
  const [localImports, setLocalImports] = useState<LocalAssetImport[]>([]);
  useEffect(() => {
    const prune = () => setLocalImports(previous => previous.filter(item => item.current()));
    window.addEventListener(APP_EVENTS.accountUpdated, prune);
    window.addEventListener(APP_EVENTS.authRequired, prune);
    window.addEventListener("storage", prune);
    return () => {
      window.removeEventListener(APP_EVENTS.accountUpdated, prune);
      window.removeEventListener(APP_EVENTS.authRequired, prune);
      window.removeEventListener("storage", prune);
    };
  }, []);
  const [pending, setPending] = useState<{ ids: string[]; project: string; current: () => boolean }[]>([]);
  useEffect(() => {
    if (!pending.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (pending.some(group => !group.current())) {
        setPending(previous => previous.filter(group => group.current()));
        return;
      }
      try {
        const result = await api.assetSyncStatus();
        if (cancelled) return;
        const rows = result.destinations ?? [];
        setLocalImports(previous => previous.filter(item => item.current()).map(item => {
          const row = rows.find(row => row.sync_id === item.syncId);
          return row && row.state !== item.state ? { ...item, state: row.state } : item;
        }));
        const ready = new Set(rows.filter(row => row.state === "ready").map(row => row.sync_id));
        const completed = new Set<string>();
        for (const group of pending) {
          if (!group.current()) continue;
          const ids = group.ids.filter(id => ready.has(id));
          if (!ids.length) continue;
          const refreshed = await onImported(group.project);
          if (cancelled) return;
          if (!group.current()) continue;
          if (refreshed === false) continue;
          flashMsg(`${ids.length}건 선택한 폴더에 보관 완료`);
          ids.forEach(id => completed.add(id));
        }
        if (completed.size) {
          setLocalImports(previous => previous.filter(item => item.current() && (!item.syncId || !completed.has(item.syncId))));
          setPending(previous => previous.flatMap(group => {
            if (!group.current()) return [];
            const ids = group.ids.filter(id => !completed.has(id));
            return ids.length ? [{ ...group, ids }] : [];
          }));
          return;
        }
      } catch { /* Keep local files and retry transient connection failures. */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending, onImported]);
  // 올리는 중인 파일(자리·이름·크기·수정 시각) — 올라가는 동안 같은 파일을 다시 놓으면 서버가 이름을 _2 로 피해 사본이 생긴다(조작 규칙 39).
  //  내용이 아니라 파일 정보로 가린다. 다 올라간 뒤에 다시 놓는 것은 전처럼 받는다.
  const uploading = useRef(new Set<string>());
  const dropDepth = useRef(0);

  // 외부 파일 가져오기 대상만 감지한다. 내부 에셋 드래그는 원본을 '진짜 File' 로 실어(대화창 첨부용)
  //  dataTransfer 에 "Files" 가 잡히지만, 같은 폴더로 되-업로드(중복 생성)하면 안 되므로 제외한다.
  //  들일 폴더가 없으면(등록한 폴더가 없는 팀) 받지 않는다 — '현재 폴더로 가져오기'를 띄워 놓고 놓으면 아무 일도 없었다.
  const hasFiles = (event: DragEvent) =>
    !!project &&
    !event.dataTransfer.types.includes(DRAG_TYPES.asset) &&
    dataTransferHasFiles(event.dataTransfer);

  const importFiles = async (incoming: File[]) => {
    if (!project || !incoming.length) return;
    const scope = captureSubmissionScope({ scope: "unknown", id: null, name: null });
    const keyOf = (file: File) => JSON.stringify([project, dir, file.name, file.size, file.lastModified]);
    const fresh: File[] = [];
    const keys: string[] = [];
    for (const file of incoming) { // 첫 await 전에 가리고 적는다 — 같은 묶음 안의 겹친 파일도 여기서 걸린다
      const key = keyOf(file);
      if (uploading.current.has(key)) continue;
      uploading.current.add(key);
      keys.push(key);
      fresh.push(file);
    }
    if (!fresh.length) {
      alert("이미 가져오는 중인 파일입니다.");
      return;
    }
    setImporting((count) => count + 1);
    try {
      const result = await api.uploadAssets(project, dir, fresh);
      if (!scope.isCurrent?.()) return;
      const queued = result.queued ?? [];
      const local = queued.flatMap((item): LocalAssetImport[] => {
        const match = /^asset:imports\|([^/\\|]+)$/.exec(item.file_path);
        const type = match && referenceMediaTypeFromName(match[1]);
        if (!match || !type) return [];
        return [{ id: item.sync_id || `${project}|${dir}|${item.file_path}`, syncId: item.sync_id,
          project, dir, localPath: match[1], name: item.name, type,
          assetContentId: item.asset_content_id, state: item.sync_state, current: scope.isCurrent! }];
      });
      if (local.length) setLocalImports(previous => [...new Map([
        ...previous.filter(item => item.current()), ...local,
      ].map(item => [item.id, item] as const)).values()]);
      await onImported(project); // 트리·메타 새로고침을 가드된 경로로 위임(직접 setter 로 stale 반영/캐시 오염 방지)
      if (!scope.isCurrent?.()) return;
      const ids = queued.filter(item => item.sync_id && item.sync_state !== "registration_failed").map(item => item.sync_id!);
      if (ids.length && scope.isCurrent?.()) setPending(previous => {
        const groups = previous.filter(group => group.current());
        const existing = groups.find(group => group.project === project);
        return existing ? groups.map(group => group === existing ? { ...group, ids: [...new Set([...group.ids, ...ids])] } : group)
          : [...groups, { ids, project, current: scope.isCurrent! }];
      });
      const failed = queued.filter(item => item.sync_state === "registration_failed");
      if (failed.length) flashMsg(`${failed.length}건 로컬 저장됨 · 폴더 보관 예약 실패`);
      else if (queued.length) flashMsg(`${queued.length}건 로컬 저장됨 · 선택한 폴더 보관 대기`);
      if (result.skipped.length) {
        alert(
          `${result.saved.length}개 추가됨.\n미디어가 아니어서 제외: ${result.skipped.join(", ")}`,
        );
      }
    } catch (error) {
      if (!scope.isCurrent?.()) return;
      // 여러 개 중 뒤의 것이 실패해도 앞의 것은 이미 폴더에 있다 — 목록은 새로 본다(47회차).
      await Promise.resolve(onImported(project)).catch(() => undefined);
      if (!scope.isCurrent?.()) return;
      alert(`가져오기 실패: ${error}\n앞의 파일은 저장됐을 수 있습니다 — 목록을 새로 고쳤습니다.`);
    } finally {
      for (const key of keys) uploading.current.delete(key);
      setImporting((count) => count - 1);
    }
  };

  const onZoneDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth.current++;
    setDropActive(true);
  };

  const onZoneDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onZoneDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dropDepth.current--;
    if (dropDepth.current <= 0) {
      dropDepth.current = 0;
      setDropActive(false);
    }
  };

  const onZoneDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropDepth.current = 0;
    setDropActive(false);
    const incoming = filesFromDataTransfer(event.dataTransfer);
    if (incoming.length) void importFiles(incoming);
  };

  return {
    dropActive,
    importing: importing > 0,
    localImports: localImports.filter(item => item.current()),
    onZoneDragEnter,
    onZoneDragLeave,
    onZoneDragOver,
    onZoneDrop,
  };
}

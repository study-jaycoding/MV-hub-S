// 툴바 워크스페이스 필터가 쓸 목록 — 컨테이너 훅(상태·IO). 화면은 LibraryWorkspaceFilter 가 그린다.
//
// 목록 자체는 `workspaceOptionsCache`(모듈 캐시, stale-while-revalidate)를 그대로 쓴다 —
// `#+` 피커·씬 우클릭 메뉴와 같은 출처라 따로 캐시를 두면 서로 달라 보인다.
//
// ★조회 실패와 '목록이 비었다'를 구분한다. 실패했다고 지금 걸린 필터를 풀면, 잠깐 끊긴 사이에
//  사용자가 보던 화면이 말없이 전체로 되돌아간다. 실패는 실패라고 알리고 선택은 그대로 둔다.
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkspaceCommandTarget } from "./workspaceCommand";
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "./workspaceOptionsCache";

export interface WorkspaceFilterOptions {
  options: WorkspaceCommandTarget[];
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

export function useWorkspaceFilterOptions(active: boolean): WorkspaceFilterOptions {
  const [options, setOptions] = useState<WorkspaceCommandTarget[]>(
    () => cachedWorkspaceOptions() ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    // 공용 캐시가 이미 있으면 먼저 보여주고 뒤에서 갱신한다(#+ 피커와 같은 즉시 표시).
    const cached = cachedWorkspaceOptions();
    if (cached) setOptions(cached);
    setLoading(true);
    fetchWorkspaceOptions()
      .then((items) => {
        if (!alive.current) return;
        setOptions(items);
        setFailed(false);
      })
      .catch(() => {
        if (alive.current) setFailed(true);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, []);

  // 필터가 걸린 채로 앱을 열면 칩에 보여줄 **이름**이 필요하다.
  // (걸려 있지 않으면 굳이 미리 받지 않는다. 버튼을 누를 때 받아도 늦지 않다.)
  // ★캐시가 있어도 **화면 상태로 옮겨야** 한다 — 마운트 뒤에 `#+` 피커 등이 공용 캐시를 채운
  //  경우, 건너뛰기만 하면 이름을 영영 못 가져와 칩이 계속 '…' 로 남는다(코덱스 P2).
  useEffect(() => {
    if (!active) return;
    const cached = cachedWorkspaceOptions();
    if (cached) setOptions(cached);
    else reload();
  }, [active, reload]);

  return { options, loading, failed, reload };
}

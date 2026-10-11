import { useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import type { AssetNode } from "../../types";
import type { AssetSortDir, AssetSortField, AssetTypeFilter } from "./assetsViewModel";

interface UseAssetSelectionPersistenceArgs {
  activeColors: Set<string>;
  activeTags: Set<string>;
  commentOnly: boolean;
  dir: string;
  files: AssetNode[];
  groupByDate: boolean;
  project: string;
  query: string;
  selected: Set<number>;
  setFocusIdx: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  sortDir: AssetSortDir;
  sortField: AssetSortField;
  sourceOnly: boolean;
  typeFilter: AssetTypeFilter;
}

export function useAssetSelectionPersistence({
  activeColors,
  activeTags,
  commentOnly,
  dir,
  files,
  groupByDate,
  project,
  query,
  selected,
  setFocusIdx,
  setSelected,
  sortDir,
  sortField,
  sourceOnly,
  typeFilter,
}: UseAssetSelectionPersistenceArgs) {
  // 아래 둘(초기화·다시 찾기)은 **그리기 전에** 끝낸다(useLayoutEffect — 조작 규칙 45): 그린 뒤에 돌면 새 목록은 그려졌는데 선택·초점은
  //  아직 옛 번호인 한 박자가 생기고, 그때 누르면 끌기가 그 번호의 다른 파일을 시작 선택·기준으로 굳혔다(Codex 코드 리뷰).
  useLayoutEffect(() => {
    // 정렬(sortField/sortDir)이 바뀌면 files 순서가 재배치돼 인덱스 기반 focusIdx 가 엉뚱한 파일을
    // 가리키므로, 날짜구분 토글과 동일하게 선택·포커스를 초기화한다(포커스 stale 방지).
    setSelected(new Set());
    setFocusIdx(-1);
  }, [dir, project, query, activeColors, sourceOnly, commentOnly, activeTags, typeFilter, groupByDate, sortField, sortDir, setFocusIdx, setSelected]);

  const selFilesRef = useRef(files);
  useLayoutEffect(() => {
    const prev = selFilesRef.current;
    selFilesRef.current = files;
    if (prev === files) return;
    setSelected((sel) => {
      if (!sel.size) return sel;
      const paths = new Set<string>();
      sel.forEach((index) => {
        const path = prev[index]?.path;
        if (path) paths.add(path);
      });
      const next = new Set<number>();
      files.forEach((file, index) => {
        if (paths.has(file.path)) next.add(index);
      });
      return next;
    });
    // 초점(Enter·#·c 가 가리키는 파일, Shift 클릭·방향키의 기준)도 '몇 번째'로 들고 있다 — 선택처럼 그 파일을 따라간다(조작 규칙 45).
    //  안 옮기면 목록이 바뀐 뒤(비활성 숨기기·자동 새로 고침) 선택은 고른 파일인데 초점은 그 자리에 온 다른 파일이라, Enter 가 고르지 않은
    //  파일을 열고 태그·코멘트도 그 파일에 열렸다. 사라진 파일이면 초점을 내려놓는다.
    setFocusIdx((focus) => {
      const path = prev[focus]?.path;
      return path ? files.findIndex((file) => file.path === path) : -1;
    });
  }, [files, setFocusIdx, setSelected]);

  // 마퀴 드래그는 mousemove 마다 선택이 바뀌어 매번 동기 직렬화+localStorage 쓰기가 일어난다.
  // 스크롤 위치 저장과 같은 150ms 지연으로 마지막 선택만 저장(pendingSaveRef = 언마운트 시 마무리).
  const pendingSaveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const save = () => {
      pendingSaveRef.current = null;
      try {
        const items = [...selected]
          .sort((a, b) => a - b)
          .map((index) => files[index])
          .filter((file) => file && (file.type === "image" || file.type === "video"))
          .map((file) => ({ project, path: file.path, name: file.name, type: file.type }));
        saveJSON(STORAGE_KEYS.assetsSelection, items);
      } catch {
        /* localStorage 불가 시 무시(드래그 페이로드 폴백) */
      }
    };
    pendingSaveRef.current = save;
    const timer = window.setTimeout(save, 150);
    return () => window.clearTimeout(timer);
  }, [selected, files, project]);
  // 언마운트로 타이머가 취소돼도 마지막 선택은 반드시 저장한다(다른 창의 드래그 페이로드 소스).
  useEffect(() => () => pendingSaveRef.current?.(), []);
}

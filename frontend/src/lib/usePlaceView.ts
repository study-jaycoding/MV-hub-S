// 자리(폴더)마다 본 모양 — 리스트/그리드와 '리스트 한 번 더'(Jay 2026-10-13 저녁: "각 폴더별로 내가 봤던 게 리스트인지 그리드인지도 기억하게
//  한다"). 규칙과 저장 모양은 lib/placeViews. 이 훅은 **보는 폴더가 정해진 뒤**에 부른다(App) — 폴더 창이 떠 있으면 그 창의 폴더가 '보는 폴더'라,
//  필터 상태만 아는 useLibraryFilters 안에서는 정할 수 없다(창 안에서 바꾼 모양이 뒤 화면의 폴더에 적혔다 — Codex 코드 리뷰).
//   · 화면의 값은 **렌더에서** 정한다: 그 자리에 적힌 것이 있으면 그것, 없으면 방금 보던 것. effect 로 맞추면 자리를 옮긴 첫 렌더가 옛 자리의
//     모양으로 한 번 그려진다(줄 ↔ 카드가 번쩍인다).
//   · 방금 보던 모양(lastLayout·lastGroup)은 전의 layout·groupByDate 저장 키 그대로다(`layout`·`groupByDate`) — 처음 들어가는 자리가 물려받는다.
//   · 적을 때는 **저장된 것을 그 자리에서 다시 읽고 이 자리만 고친다** — 창마다 자기 사본을 통째로 저장하면 다른 창이 그사이 적은 다른 폴더의
//     기억을 덮는다(Codex 코드 리뷰).
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { PLACE_VIEWS_KEY, parsePlaceViews, withPlaceView, type PlaceView, type PlaceViews } from "./placeViews";
import type { Store } from "./storage";

const sameViews = (a: PlaceViews, b: PlaceViews) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** place = 지금 보는 폴더의 열쇠(lib/placeViews 의 placeViewKey). */
export function usePlaceView(store: Store, place: string, defaults?: Partial<PlaceView>) {
  const defaultFolders = useRef(defaults?.folders).current;
  const [lastView, setLastView] = useState<PlaceView>(() => parsePlaceViews({ initial: {
    layout: defaults?.layout ?? (store.get("layout", "grid") === "list" ? "list" : "grid"),
    group: defaults?.group ?? (store.get("groupByDate", "0") === "1"),
    scale: defaults?.scale, fill: defaults?.fill, folders: defaults?.folders,
  } }).initial);
  const [views, setViews] = useState<PlaceViews>(() => parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)));
  // 자리를 옮긴 렌더에서 저장된 것을 다시 읽는다 — 다른 창이 그사이 그 자리에 적어 둔 모양이 있으면 첫 렌더부터 그 모양이고, 아래의 '처음 본
  //  자리 적기'가 그것을 덮지 않는다(낡은 사본으로 '처음 본 자리'라 여겨 다른 창의 리스트를 그리드로 덮었다 — Codex 코드 리뷰). 렌더 중의
  //  setState 는 앞 렌더의 값에 맞춰 상태를 고치는 React 의 그 방식이다(이 렌더는 버리고 곧바로 다시 그린다). 저장에 실패한(용량) 이 창만의
  //  기억은 남긴다 — **적지 못한 자리(unsaved)는 저장된 옛 값보다 이 창의 것이 앞선다**: 그냥 합치면 저장소의 옛 모양이 방금 바꾼 모양을
  //  덮는다(Codex 재검토 P3). 순서를 통째로 뒤집지는 않는다 — 그러면 다른 창이 적은 자리를 이 창의 낡은 사본이 덮는다.
  const unsaved = useRef(new Set<string>());
  const [placeRead, setPlaceRead] = useState(place);
  if (placeRead !== place) {
    setPlaceRead(place);
    const stored = { ...views, ...parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)) };
    for (const key of unsaved.current) if (views[key]) stored[key] = views[key];
    if (!sameViews(views, stored)) setViews(stored);
  }
  const viewsRef = useRef(views);
  viewsRef.current = views;
  // 전체 보기는 새 부모 폴더에도 이어간다. 폴더 묶음(true)까지 물려 적으면
  // 직계 파일이 섞인 새 폴더의 기본 보기까지 사용자의 명시 선택으로 오인한다.
  const current: PlaceView = { ...lastView, folders: lastView.folders === false ? false : defaultFolders, ...views[place] };
  const { layout, group: groupByDate } = current;
  const scale = current.scale ?? 1;
  const fill = current.fill ?? true;
  const folders = current.folders ?? true;
  const now = useRef({ place, view: current });
  now.current = { place, view: current };

  const pin = useCallback((key: string, patch: Partial<PlaceView>) => {
    const stored = parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)); // 다른 창이 그사이 적은 것까지
    const merged = { ...stored };
    for (const dirty of unsaved.current) if (viewsRef.current[dirty]) merged[dirty] = viewsRef.current[dirty];
    const view = { ...now.current.view, ...merged[key], ...patch };
    const next = withPlaceView(merged, key, view);
    if (!sameViews(next, stored)) store.setJSON(PLACE_VIEWS_KEY, next);
    // 적혔는지 다시 읽어 본다(저장은 실패를 알리지 않는다 — 용량 부족). 못 적은 자리는 이 창이 기억해 둔다(위).
    const kept = parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY));
    for (const dirty of new Set([...unsaved.current, key])) {
      if (kept[dirty] && JSON.stringify(kept[dirty]) === JSON.stringify(next[dirty])) unsaved.current.delete(dirty);
      else unsaved.current.add(dirty);
    }
    now.current = { place: key, view: next[key] };
    setLastView(next[key]);
    if (sameViews(viewsRef.current, next)) return;
    viewsRef.current = next;
    setViews(next);
  }, [store]);

  // 모양을 바꾸면 지금 자리 것만 바뀐다(그리고 '방금 보던 모양'이 된다).
  const setLayout = useCallback((next: "grid" | "list") => {
    pin(now.current.place, { layout: next });
  }, [pin]);
  const setGroupByDate = useCallback<Dispatch<SetStateAction<boolean>>>((action) => {
    const next = typeof action === "function" ? action(now.current.view.group) : action;
    pin(now.current.place, { group: next });
  }, [pin]);
  const setScale = useCallback<Dispatch<SetStateAction<number>>>((action) => {
    const next = typeof action === "function" ? action(now.current.view.scale ?? 1) : action;
    if (Number.isFinite(next)) pin(now.current.place, { scale: Math.max(0.7, Math.min(1.7, next)) });
  }, [pin]);
  const setFill = useCallback<Dispatch<SetStateAction<boolean>>>((action) => {
    pin(now.current.place, { fill: typeof action === "function" ? action(now.current.view.fill ?? true) : action });
  }, [pin]);
  const setFolders = useCallback<Dispatch<SetStateAction<boolean>>>((action) => {
    pin(now.current.place, { folders: typeof action === "function" ? action(now.current.view.folders ?? true) : action });
  }, [pin]);

  // 자리를 옮긴 뒤: 적혀 있던 자리면 그 모양이 '방금 보던 모양'이 되고(다음에 처음 들어가는 폴더가 물려받는다), 처음 본 자리면 지금 보이는
  //  모양(= 방금 보던 것)을 그 자리 것으로 적는다 — 나중에 다른 폴더에서 모양을 바꿔도 이 자리는 본 그대로다.
  useEffect(() => {
    const seen = viewsRef.current[place];
    if (seen) {
      setLastView(now.current.view);
      if (JSON.stringify(seen) !== JSON.stringify(now.current.view)) pin(place, {});
    } else pin(place, {});
  }, [place, pin]);

  // 방금 보던 모양 — 전과 같은 저장 키(다시 켠 앱이 처음 들어가는 자리에 물려준다)
  useEffect(() => store.set("layout", layout), [layout, store]);
  useEffect(() => store.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate, store]);

  return { layout, setLayout, groupByDate, setGroupByDate, scale, setScale, fill, setFill, folders, setFolders };
}

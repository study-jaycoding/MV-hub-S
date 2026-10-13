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
export function usePlaceView(store: Store, place: string) {
  const [lastLayout, rawSetLayout] = useState<"grid" | "list">(() => (store.get("layout", "grid") === "list" ? "list" : "grid"));
  const [lastGroup, rawSetGroupByDate] = useState(() => store.get("groupByDate", "0") === "1");
  const [views, setViews] = useState<PlaceViews>(() => parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)));
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const layout = views[place]?.layout ?? lastLayout;
  const groupByDate = views[place]?.group ?? lastGroup;
  const now = useRef({ place, layout, groupByDate });
  now.current = { place, layout, groupByDate };

  const pin = useCallback((key: string, view: PlaceView) => {
    const stored = parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)); // 다른 창이 그사이 적은 것까지
    const next = withPlaceView(stored, key, view);
    if (next !== stored) store.setJSON(PLACE_VIEWS_KEY, next);
    if (sameViews(viewsRef.current, next)) return;
    viewsRef.current = next;
    setViews(next);
  }, [store]);

  // 모양을 바꾸면 지금 자리 것만 바뀐다(그리고 '방금 보던 모양'이 된다).
  const setLayout = useCallback((next: "grid" | "list") => {
    rawSetLayout(next);
    pin(now.current.place, { layout: next, group: now.current.groupByDate });
  }, [pin]);
  const setGroupByDate = useCallback<Dispatch<SetStateAction<boolean>>>((action) => {
    const next = typeof action === "function" ? action(now.current.groupByDate) : action;
    rawSetGroupByDate(next);
    pin(now.current.place, { layout: now.current.layout, group: next });
  }, [pin]);

  // 자리를 옮긴 뒤: 적혀 있던 자리면 그 모양이 '방금 보던 모양'이 되고(다음에 처음 들어가는 폴더가 물려받는다), 처음 본 자리면 지금 보이는
  //  모양(= 방금 보던 것)을 그 자리 것으로 적는다 — 나중에 다른 폴더에서 모양을 바꿔도 이 자리는 본 그대로다.
  useEffect(() => {
    const seen = viewsRef.current[place];
    if (seen) {
      rawSetLayout(seen.layout);
      rawSetGroupByDate(seen.group);
    } else pin(place, { layout: now.current.layout, group: now.current.groupByDate });
  }, [place, pin]);

  // 방금 보던 모양 — 전과 같은 저장 키(다시 켠 앱이 처음 들어가는 자리에 물려준다)
  useEffect(() => store.set("layout", layout), [layout, store]);
  useEffect(() => store.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate, store]);

  return { layout, setLayout, groupByDate, setGroupByDate };
}

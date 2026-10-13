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
  const layout = views[place]?.layout ?? lastLayout;
  const groupByDate = views[place]?.group ?? lastGroup;
  const now = useRef({ place, layout, groupByDate });
  now.current = { place, layout, groupByDate };

  const pin = useCallback((key: string, view: PlaceView) => {
    const stored = parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY)); // 다른 창이 그사이 적은 것까지
    const next = withPlaceView(stored, key, view);
    if (next !== stored) store.setJSON(PLACE_VIEWS_KEY, next);
    // 적혔는지 다시 읽어 본다(저장은 실패를 알리지 않는다 — 용량 부족). 못 적은 자리는 이 창이 기억해 둔다(위).
    const kept = parsePlaceViews(store.loadJSON<unknown>(PLACE_VIEWS_KEY))[key];
    if (kept && kept.layout === view.layout && kept.group === view.group) unsaved.current.delete(key);
    else unsaved.current.add(key);
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

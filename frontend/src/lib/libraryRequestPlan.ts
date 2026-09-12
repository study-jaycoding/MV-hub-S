// 목록(그리드)과 메타(통계·태그·폴더)를 **같은 순간에 시작**한다.
//
// ★왜(2026-09-12 실측): 종전에는 목록을 `await` 한 **뒤에야** 메타 세 개를 시작했다.
//  로컬에서 목록 `/api/generations?limit=200` 이 47ms·3.38MB, `/api/projects` 가 61ms 다.
//  직렬이면 모든 데이터가 갖춰지는 데 47+61 ≈ 108ms, 함께 시작하면 ≈61ms 다.
//  그리드가 보이는 시각은 어느 쪽이든 목록이 오는 때다 — 빨라지는 것은 **왼쪽 폴더·태그·배지**다.
//
// ★그리드는 메타를 기다리지 않는다. 호출자가 `list` 를 먼저 `await` 해 화면에 그리고,
//  `meta` 는 그 뒤에 받는다. 메타가 실패해도 그리드 표시에는 영향이 없다(각 요청이 스스로 삼킨다).
//
// ★없는 요청은 `null` 로 넘긴다 — `light` 로드의 태그·폴더 생략, 통계 10초 스로틀이 그렇다.
//  자리를 비워 두지 않고 `null` 을 채워 돌려주므로 호출자의 구조분해가 그대로 유지된다.

export type LibraryRequests<L, S, F, P> = {
  list: Promise<L>;
  meta: Promise<[S | null, F | null, P | null]>;
};

export function startLibraryRequests<L, S, F, P>(
  fetchList: () => Promise<L>,
  fetchStats: (() => Promise<S>) | null,
  fetchFacets: (() => Promise<F>) | null,
  fetchProjects: (() => Promise<P>) | null,
): LibraryRequests<L, S, F, P> {
  // 네 개를 여기서 **동시에** 띄운다. 아래 Promise.all 은 이미 떠 있는 것을 모으기만 한다.
  const list = fetchList();
  const stats = fetchStats ? fetchStats().catch(() => null) : Promise.resolve(null);
  const facets = fetchFacets ? fetchFacets().catch(() => null) : Promise.resolve(null);
  const projects = fetchProjects ? fetchProjects().catch(() => null) : Promise.resolve(null);
  return { list, meta: Promise.all([stats, facets, projects]) };
}

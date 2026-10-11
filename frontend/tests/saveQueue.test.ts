// 한 줄로 서는 저장(lib/saveQueue — 조작 규칙 39). 역할 저장은 목록 전체를 덮어쓴다 — 겹치면 뒤의 것이 앞의 것을 지운다.
//  화면에서의 쓰임(잠금 표시·지금 값에서 다시 계산)은 tests/adminWindowTabs.test.tsx 가 본다.
import { expect, it, vi } from "vitest";
import { createSaveQueue, rebaseRoles, sameRoles } from "../src/lib/saveQueue";

const held = () => {
  let finish!: (value: string) => void, fail!: (reason: Error) => void;
  const promise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

it("앞의 저장이 끝난 뒤에 다음 것을 돌린다 — 앞의 것이 실패해도 줄은 이어지고, 각자의 결과·실패를 그대로 돌려준다", async () => {
  const queue = createSaveQueue();
  const first = held(), second = held();
  const order: string[] = [];
  const a = queue.run(() => { order.push("a 시작"); return first.promise; });
  const b = queue.run(() => { order.push("b 시작"); return second.promise; });
  const c = queue.run(async () => { order.push("c 시작"); return "c"; });
  await settle();
  expect(order).toEqual(["a 시작"]); // b·c 는 줄을 서 있다
  first.fail(new Error("a 실패"));
  await expect(a).rejects.toThrow("a 실패");
  await settle();
  expect(order).toEqual(["a 시작", "b 시작"]);
  second.finish("b");
  expect(await b).toBe("b");
  expect(await c).toBe("c");
  expect(order).toEqual(["a 시작", "b 시작", "c 시작"]);
});

it("줄에 서 있거나 도는 것이 있는 동안 busy 이고, 바뀔 때마다 알린다 — 듣기를 끊으면 더 알리지 않는다", async () => {
  const queue = createSaveQueue();
  const watcher = vi.fn();
  const stop = queue.subscribe(watcher);
  expect(queue.busy()).toBe(false);
  const first = held();
  const a = queue.run(() => first.promise);
  const b = queue.run(async () => "b");
  expect(queue.busy()).toBe(true);
  expect(watcher).toHaveBeenCalledTimes(2);
  first.finish("a");
  await Promise.all([a, b]);
  await settle();
  expect(queue.busy()).toBe(false);
  expect(watcher).toHaveBeenCalledTimes(4);
  stop();
  await queue.run(async () => "c");
  expect(watcher).toHaveBeenCalledTimes(4);
});

it("rebaseRoles — 화면에서 바꾼 것만 서버의 지금 값에 얹는다(그사이 저장된 다른 역할을 지우지 않는다)", () => {
  // 화면은 [creator] 를 보여 주고 supervisor 를 더 눌렀다 — 그사이 서버에는 project_manager 가 저장돼 있었다
  expect(rebaseRoles(["creator", "project_manager"], ["creator"], ["creator", "supervisor"])).toEqual(["creator", "project_manager", "supervisor"]);
  // 뺀 것은 뺀다 — 화면에 없던(그사이 생긴) 역할은 그대로 둔다
  expect(rebaseRoles(["creator", "project_manager"], ["creator"], [])).toEqual(["project_manager"]);
  // 더하려던 것이 이미 있으면 다시 넣지 않는다 · 빼려던 것이 이미 없으면 그대로다
  expect(rebaseRoles(["creator", "supervisor"], ["creator"], ["creator", "supervisor"])).toEqual(["creator", "supervisor"]);
  expect(rebaseRoles([], ["creator"], [])).toEqual([]);
  // 화면이 맞았으면 누른 그대로다
  expect(rebaseRoles(["creator"], ["creator"], ["creator", "supervisor"])).toEqual(["creator", "supervisor"]);
  expect(sameRoles(["a", "b"], ["b", "a"])).toBe(true);
  expect(sameRoles(["a"], ["a", "b"])).toBe(false);
});

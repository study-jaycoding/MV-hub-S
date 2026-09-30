import { describe, expect, it } from "vitest";
import { getSceneZoomPct, setSceneZoomPct, subscribeSceneZoomPct } from "../src/lib/sceneZoomStore";

describe("sceneZoomStore", () => {
  it("같은 %는 알리지 않고 바뀐 %만 알린다", () => {
    const seen: number[] = [];
    const stop = subscribeSceneZoomPct(() => seen.push(getSceneZoomPct()));
    setSceneZoomPct(getSceneZoomPct());
    setSceneZoomPct(37);
    setSceneZoomPct(37);
    setSceneZoomPct(40);
    stop();
    setSceneZoomPct(50);
    expect(seen).toEqual([37, 40]);
  });
});

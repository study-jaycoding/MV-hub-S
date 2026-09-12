import { describe, expect, it } from "vitest";
import {
  commentBadgeTargets,
  decideCommentBadgeUpdate,
  type CommentCount,
  type PanelSeen,
} from "../src/lib/commentBadgeTargets";
import type { Generation } from "../src/types";

// 코멘트 배지 폴링의 판정 로직.
// ★왜(2026-09-12): 이 폴은 10초마다 **로드된 공유 카드 전부**를 POST 한다(200건/페이지로 상한
//  없이 누적). 그리고 열린 코멘트 패널의 생성물이 목록에 없으면(알림에서 연 경우) 새 코멘트를
//  영영 못 잡았다 — 목록만 돌며 판정했기 때문이다.

function gen(id: string, over: Partial<Generation> = {}): Generation {
  return {
    id,
    shared: true,
    has_unread: false,
    comment_count: 0,
    ...over,
  } as unknown as Generation;
}

const count = (comment_count: number, has_unread = false): CommentCount => ({
  comment_count,
  has_unread,
});

describe("물어볼 대상 고르기", () => {
  it("공유 카드만 고른다 — 로컬 전용 카드는 서버에 스레드가 없다", () => {
    const ids = commentBadgeTargets([gen("a"), gen("b", { shared: false }), gen("c")], null);
    expect(ids).toEqual(["a", "c"]);
  });

  it("★열린 패널이 목록에 없어도 넣는다 — 알림에서 연 생성물이 그렇다", () => {
    expect(commentBadgeTargets([gen("a")], "zzz")).toEqual(["a", "zzz"]);
  });

  it("패널이 목록에 있으면 한 번만 묻는다", () => {
    expect(commentBadgeTargets([gen("a"), gen("b")], "b")).toEqual(["a", "b"]);
  });

  it("중복 id 는 한 번만 묻는다", () => {
    expect(commentBadgeTargets([gen("a"), gen("a")], null)).toEqual(["a"]);
  });

  it("대상이 없으면 빈 목록 — 호출부가 요청 자체를 건너뛴다", () => {
    expect(commentBadgeTargets([], null)).toEqual([]);
    expect(commentBadgeTargets([gen("a", { shared: false })], null)).toEqual([]);
  });
});

describe("무엇이 바뀌었는지 판정", () => {
  it("값이 그대로면 아무것도 안 한다 — 헛 리렌더를 막는다", () => {
    const d = decideCommentBadgeUpdate([gen("a", { comment_count: 2 })], { a: count(2) }, null, null);
    expect(d).toEqual({ anyChange: false, notifyPanel: false, nextPanelSeen: null });
  });

  it("코멘트 수가 줄어도 화면은 갱신한다(삭제 반영)", () => {
    const d = decideCommentBadgeUpdate([gen("a", { comment_count: 3 })], { a: count(1) }, null, null);
    expect(d.anyChange).toBe(true);
    expect(d.notifyPanel).toBe(false); // 새 코멘트가 온 건 아니다
  });

  it("새 코멘트가 오면 열린 패널을 깨운다", () => {
    const d = decideCommentBadgeUpdate([gen("a", { comment_count: 1 })], { a: count(2) }, null, null);
    expect(d.notifyPanel).toBe(true);
  });

  it("미확인으로 바뀌어도 깨운다", () => {
    const d = decideCommentBadgeUpdate(
      [gen("a", { comment_count: 2, has_unread: false })],
      { a: count(2, true) },
      null,
      null,
    );
    expect(d.notifyPanel).toBe(true);
  });

  it("응답에 없는 카드는 건드리지 않는다", () => {
    const d = decideCommentBadgeUpdate([gen("a", { comment_count: 5 })], {}, null, null);
    expect(d.anyChange).toBe(false);
  });

  describe("목록에 없는 열린 패널", () => {
    const OUTSIDE = "panel-only";

    it("첫 주기엔 기준이 없어 깨우지 않는다 — 헛알림 방지", () => {
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(3) }, OUTSIDE, null);
      expect(d.notifyPanel).toBe(false);
      expect(d.nextPanelSeen).toEqual({ id: OUTSIDE, comment_count: 3, has_unread: false });
    });

    it("★다음 주기에 코멘트가 늘면 깨운다 — 종전엔 이 경로가 없었다", () => {
      const seen: PanelSeen = { id: OUTSIDE, comment_count: 3, has_unread: false };
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(4) }, OUTSIDE, seen);
      expect(d.notifyPanel).toBe(true);
    });

    it("미확인으로 바뀌어도 깨운다", () => {
      const seen: PanelSeen = { id: OUTSIDE, comment_count: 3, has_unread: false };
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(3, true) }, OUTSIDE, seen);
      expect(d.notifyPanel).toBe(true);
    });

    it("다른 생성물의 패널로 바꾸면 기준을 버린다 — 남의 값과 비교하면 헛알림이 난다", () => {
      // ★기준을 **일부러 낮게** 둔다. id 확인 없이 비교하면 `5 > 0` 이 되어 헛알림이 난다
      //  (기준이 더 높은 값이면 비교가 어차피 false 라 이 함정을 못 잡는다).
      const seen: PanelSeen = { id: "other", comment_count: 0, has_unread: false };
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(5) }, OUTSIDE, seen);
      expect(d.notifyPanel).toBe(false);
      expect(d.nextPanelSeen).toEqual({ id: OUTSIDE, comment_count: 5, has_unread: false });
    });

    it("다른 패널의 미확인 기준도 새 패널에 쓰지 않는다", () => {
      const seen: PanelSeen = { id: "other", comment_count: 5, has_unread: false };
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(5, true) }, OUTSIDE, seen);
      expect(d.notifyPanel).toBe(false);
    });

    it("값이 그대로면 깨우지 않는다", () => {
      const seen: PanelSeen = { id: OUTSIDE, comment_count: 3, has_unread: true };
      const d = decideCommentBadgeUpdate([], { [OUTSIDE]: count(3, true) }, OUTSIDE, seen);
      expect(d.notifyPanel).toBe(false);
    });

    it("패널이 닫히면 기준을 남기지 않는다", () => {
      const seen: PanelSeen = { id: OUTSIDE, comment_count: 3, has_unread: false };
      const d = decideCommentBadgeUpdate([], {}, null, seen);
      expect(d.nextPanelSeen).toBeNull();
    });

    it("패널이 목록에도 있으면 한 번만 깨운다(두 경로가 겹쳐도 부작용 없음)", () => {
      const d = decideCommentBadgeUpdate(
        [gen("a", { comment_count: 1 })],
        { a: count(2) },
        "a",
        { id: "a", comment_count: 1, has_unread: false },
      );
      expect(d.notifyPanel).toBe(true);
      expect(d.anyChange).toBe(true);
    });
  });
});

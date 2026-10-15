// @vitest-environment jsdom
// Jay 결정 5A(10-15) — Assets 코멘트 창은 파일마다 다시 그려져, 보내지 않은 글이 있는 채 다른 파일·프로젝트로 가면 묻지 않고 사라졌다
//  (65회차 실측). 창이 '보내지 않은 글'을 알리고(onUnsentChange), Assets 는 옮기기 전에 묻는다(canLeaveComment — 프로젝트 선택 상자도 같은 함수).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: {
  assetComments: vi.fn(async () => []), markCommentsRead: vi.fn(async () => {}),
} }));

import { CommentPanel } from "../src/components/common/CommentPanel";
import { useAssetCommentActions } from "../src/components/assets/useAssetCommentActions";
import type { AssetComment } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

it("코멘트 창은 보내지 않은 글이 생기고 없어질 때 알리고, 닫히면 '없음'으로 알린다", () => {
  const onUnsentChange = vi.fn();
  const panel = (shown: boolean) => act(() => root.render(shown ? (
    <CommentPanel comments={[]} label="shot_0010.png" myId="me" panelRef={() => {}} pos={null} onHeadMouseDown={() => {}}
      onClose={() => {}} onSend={async () => true} onEdit={async () => true} onDelete={() => {}} onUnsentChange={onUnsentChange} />
  ) : <></>));
  panel(true);
  const input = host.querySelector<HTMLInputElement>('input[name="c"]')!;
  type(input, "손 위치 다시");
  expect(onUnsentChange).toHaveBeenLastCalledWith(true);
  type(input, "   "); // 공백만은 보내지 않은 글이 아니다
  expect(onUnsentChange).toHaveBeenLastCalledWith(false);
  type(input, "다시 씀");
  expect(onUnsentChange).toHaveBeenLastCalledWith(true);
  panel(false); // 창이 사라지면 글도 없다
  expect(onUnsentChange).toHaveBeenLastCalledWith(false);
});

it("다른 파일의 코멘트로 옮기기 전에 묻는다 — 머무르면 그 파일 그대로, 같은 파일을 다시 열면 묻지 않는다", () => {
  let actions!: ReturnType<typeof useAssetCommentActions>;
  let path!: string | null;
  const canLeave = vi.fn(() => false);
  function Host() {
    const [commentPath, setCommentPath] = useState<string | null>(null);
    const [, setComments] = useState<AssetComment[]>([]);
    path = commentPath;
    actions = useAssetCommentActions({
      project: "P", commentPath, setCommentPath, setComments, reconcile: async () => {}, canLeaveComment: canLeave,
    });
    return null;
  }
  act(() => root.render(<Host />));
  act(() => actions.openComments("shots/shot_0010.png")); // 처음 여는 것은 묻지 않는다(쓰던 글이 없다)
  expect([path, canLeave.mock.calls.length]).toEqual(["shots/shot_0010.png", 0]);
  act(() => actions.openComments("shots/shot_0010.png")); // 같은 파일 — 창이 다시 그려지지 않는다
  expect(canLeave).not.toHaveBeenCalled();
  act(() => actions.openComments("shots/shot_0020.png")); // 머무르기
  expect([path, canLeave.mock.calls.length]).toEqual(["shots/shot_0010.png", 1]);
  canLeave.mockReturnValue(true); // 버리고 이동
  act(() => actions.openComments("shots/shot_0020.png"));
  expect(path).toBe("shots/shot_0020.png");
});

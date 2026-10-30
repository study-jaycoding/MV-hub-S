// S 선택 창의 항목과 아이콘 — ReviewPicker(S 옆에 뜨는 창)와 GenerationReviewOverlay(공유 탭 여러 장)가 같이 쓴다.
import type { KeyboardEvent } from "react";
import type { ReviewAction } from "../../lib/generationReview";

export const REVIEW_OPTIONS: { state: ReviewAction; label: string; question: string }[] = [
  { state: "unshared", label: "해제", question: "공유 해제 할까요?" },
  { state: "shared", label: "공유", question: "공유로 복귀할까요?" },
  { state: "held", label: "보류", question: "보류할까요?" },
  { state: "final", label: "최종", question: "최종(골드)으로 지정할까요?" },
];

// 글자 ★·− 는 글꼴 기준선 때문에 아래로 처지고 PC 마다 글꼴도 달라 그림으로 그린다. 별은 도형 경계를 viewBox 에 맞췄다.
export function FinalStar() {
  return (
    <svg className="card-final-star" viewBox="2 0 96 91" aria-hidden="true" focusable="false">
      <polygon points="50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35" />
    </svg>
  );
}

export function ReviewIcon({ state }: { state: ReviewAction }) {
  if (state === "final") return <FinalStar />;
  if (state === "unshared") {
    return (
      <svg className="review-bar" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect x="1" y="7.75" width="16" height="2.5" rx="1.25" />
      </svg>
    );
  }
  return <>S</>;
}

// 창의 키 — Tab 은 켜진 항목들 안에서 돌고, Space 는 놓인 항목의 것이다(뒤 격자까지 올라가면 격자가 기본 동작을 막아 눌리지 않는다).
//  판에 놓인 초점(연 직후)에는 누를 항목이 없다 — 격자의 스크롤 막기에 닿지 않으니 여기서 기본 동작(뒤 목록 스크롤)을 막는다.
export function onReviewMenuKey(event: KeyboardEvent<HTMLDivElement>, itemSelector: string) {
  if (event.key === "Tab") {
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(`${itemSelector}:not(:disabled)`)];
    const at = items.indexOf(event.target as HTMLButtonElement); // 판에 놓인 초점은 -1 — 앞으로면 첫 항목, 뒤로면 끝 항목
    items[event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length]?.focus();
  } else if (event.key === " ") {
    event.stopPropagation();
    if (event.target === event.currentTarget) event.preventDefault();
  }
}

// 폴더 창 → 캔버스 끌어 놓기(Jay 2026-10-22, Codex 설계 검토). 창 안의 생성물 카드 끌기가 시작되면 알리고(카드 본문과 ⠿ 손잡이 둘 다 —
//  손잡이는 전파를 멈춰 창의 onDragStart 로는 못 받는다), 보드가 생성물 카드를 넣었으면 알린다. 창을 비키게 하고 닫는 것은 App 몫이다.
type Listener = () => void;

const dragStarts = new Set<Listener>();
const added = new Set<Listener>();

export function onPeekGenerationDragStart(listener: Listener): () => void {
  dragStarts.add(listener);
  return () => dragStarts.delete(listener);
}

/** 생성물 카드의 dragstart 에서 부른다 — 폴더 창 안에서 시작한 끌기만 알린다. */
export function notifyGenerationDragStart(source: Element): void {
  if (!source.closest(".folder-peek")) return;
  dragStarts.forEach((listener) => listener());
}

export function onPeekDropAdded(listener: Listener): () => void {
  added.add(listener);
  return () => added.delete(listener);
}

/** 보드가 놓인 생성물을 카드로 넣었다. */
export function notifyPeekDropAdded(): void {
  added.forEach((listener) => listener());
}

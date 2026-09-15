import { buildChipEl, buildRefTokenEl, type PromptPart } from "./promptEditor";
import { SEEDANCE_TOKEN_SRC, seedanceAtTokenKind, seedanceCanonToken, type SeedanceImageTokenKind } from "./seedancePrompt";

type Point = { node: Node; offset: number };
type Unit = { start: Point; end: Point; size: number; token?: { raw: string; n: number }; node: Node };
export type EditorBookmark = { anchor: number; focus: number; fingerprint: string };
type ResolveMedia = (kind: string, n: number) => string | undefined;

// 토큰은 표기 길이와 무관하게 한 칸. <<<image_1>>> → 알약 @image1 교체 후에도 위치가 같다.
// 인라인 첨부와 BR도 한 칸이며, 텍스트/알약 내부의 DOM 경로를 저장하지 않는다.
function units(editor: HTMLElement): Unit[] {
  const result: Unit[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      const re = new RegExp(SEEDANCE_TOKEN_SRC, "gi");
      let from = 0;
      const addText = (to: number) => {
        if (to > from) result.push({ node, start: { node, offset: from }, end: { node, offset: to }, size: to - from });
      };
      for (const match of text.matchAll(re)) {
        addText(match.index!);
        from = match.index! + match[0].length;
        result.push({ node, start: { node, offset: match.index! }, end: { node, offset: from }, size: 1,
          token: { raw: (match[1] || match[3]).toLowerCase(), n: Number(match[2] || match[4]) } });
      }
      addText(text.length);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(".inline-ref, .sl-tok, br")) {
      const parent = node.parentNode!;
      const index = Array.prototype.indexOf.call(parent.childNodes, node) as number;
      const match = node.matches(".sl-tok") ? new RegExp(SEEDANCE_TOKEN_SRC, "i").exec(node.textContent || "") : null;
      result.push({ node, start: { node: parent, offset: index }, end: { node: parent, offset: index + 1 }, size: 1,
        ...(match ? { token: { raw: (match[1] || match[3]).toLowerCase(), n: Number(match[2] || match[4]) } } : {}) });
      return;
    }
    node.childNodes.forEach(visit);
  };
  editor.childNodes.forEach(visit);
  return result;
}

// 래퍼 분할 수에는 의존하지 않는다. 다른 본문 복원·일반 입력 뒤 오래된 선택/Undo를 재사용하지 않는다.
export function roleEditorFingerprint(editor: HTMLElement): string {
  return JSON.stringify(units(editor).map((unit) => unit.token
    ? seedanceCanonToken(unit.token.raw, unit.token.n)
    : unit.node instanceof HTMLElement
      ? unit.node.matches(".inline-ref") ? unit.node.dataset.ref : "\n"
      : unit.node.textContent!.slice(unit.start.offset, unit.end.offset)).join(""));
}

function compare(a: Point, b: Point): number {
  const first = document.createRange();
  first.setStart(a.node, a.offset); first.collapse(true);
  const second = document.createRange();
  second.setStart(b.node, b.offset); second.collapse(true);
  return first.compareBoundaryPoints(Range.START_TO_START, second);
}

function offsetOf(editor: HTMLElement, point: Point): number {
  let offset = 0;
  for (const unit of units(editor)) {
    if (compare(point, unit.start) <= 0) return offset;
    if (compare(point, unit.end) < 0) {
      return offset + (unit.token || unit.node.nodeType !== Node.TEXT_NODE ? 1 : point.offset - unit.start.offset);
    }
    offset += unit.size;
  }
  return offset;
}

export function captureRoleSelection(editor: HTMLElement): EditorBookmark | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return null;
  return { anchor: offsetOf(editor, { node: selection.anchorNode, offset: selection.anchorOffset }),
    focus: offsetOf(editor, { node: selection.focusNode, offset: selection.focusOffset }), fingerprint: roleEditorFingerprint(editor) };
}

function pointAt(editor: HTMLElement, offset: number): Point {
  for (const unit of units(editor)) {
    if (offset <= 0) return unit.start;
    if (offset < unit.size) return { node: unit.node, offset: unit.start.offset + offset };
    if (offset === unit.size) return unit.end;
    offset -= unit.size;
  }
  return { node: editor, offset: editor.childNodes.length };
}

export function restoreRoleSelection(editor: HTMLElement, bookmark: Pick<EditorBookmark, "anchor" | "focus"> | null): void {
  const anchor = pointAt(editor, bookmark?.anchor ?? Infinity);
  const focus = pointAt(editor, bookmark?.focus ?? Infinity);
  window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

export function restoreRoleSnapshot(editor: HTMLElement, parts: PromptPart[]): void {
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (part.t === "chip") fragment.append(buildChipEl(part.ref));
    else part.v.split("\n").forEach((text, index) => {
      if (index) fragment.append(document.createElement("br"));
      fragment.append(document.createTextNode(text));
    });
  }
  // 일반 restoreParts는 칩 뒤 편집용 공백을 추가한다. Undo는 스냅샷의 공백까지 그대로 복원한다.
  editor.replaceChildren(fragment);
}

// 멘션 삽입과 분리: @query를 삭제하지 않는다. 이전 담당 해제와 새 지정은 동기적인 단일 편집.
// 본문을 재직렬화하지 않고 각 토큰 범위만 교체하므로 인라인 칩의 이벤트/BR/일반 텍스트는 보존한다.
export function editSeedanceImageRole(
  editor: HTMLElement, n: number, role: SeedanceImageTokenKind,
  bookmark: EditorBookmark | null, resolveMedia: ResolveMedia,
): void {
  const before = units(editor);
  const targetExists = before.some((unit) => unit.token?.n === n && ["image", "start", "end"].includes(seedanceAtTokenKind(unit.token.raw)));
  const raw = role === "start" ? "simage" : role === "end" ? "eimage" : "image";
  // 뒤에서부터 교체해 같은 텍스트 노드의 앞쪽 범위가 바뀌지 않게 한다.
  for (const unit of before.reverse()) {
    if (!unit.token) continue;
    const kind = seedanceAtTokenKind(unit.token.raw);
    if (!["image", "start", "end"].includes(kind)) continue;
    const replacement = unit.token.n === n ? raw : role !== "image" && kind === role ? "image" : null;
    if (!replacement) continue;
    const nextKind = seedanceAtTokenKind(replacement);
    const media = resolveMedia(nextKind, unit.token.n);
    const pill = buildRefTokenEl(seedanceCanonToken(replacement, unit.token.n), nextKind, media, media === undefined);
    if (unit.node instanceof HTMLElement) unit.node.replaceWith(pill);
    else {
      const range = document.createRange();
      range.setStart(unit.start.node, unit.start.offset);
      range.setEnd(unit.end.node, unit.end.offset);
      range.deleteContents(); range.insertNode(pill);
    }
  }
  if (targetExists) {
    restoreRoleSelection(editor, bookmark);
    return;
  }
  // 선택 영역도 지우지 않고 마지막 커서(focus)에 삽입한다. 유효한 기록이 없으면 끝.
  const point = pointAt(editor, bookmark?.focus ?? Infinity);
  const range = document.createRange();
  range.setStart(point.node, point.offset); range.collapse(true);
  const media = resolveMedia(role, n);
  const pill = buildRefTokenEl(seedanceCanonToken(raw, n), role, media, media === undefined);
  // 양옆 공백은 작성 중 @query와 새 토큰이 붙어 제출 정규식에서 누락되는 것을 막는다.
  const fragment = document.createDocumentFragment();
  fragment.append(document.createTextNode(" "), pill, document.createTextNode(" "));
  range.insertNode(fragment);
  range.setStartAfter(pill.nextSibling!); range.collapse(true);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}

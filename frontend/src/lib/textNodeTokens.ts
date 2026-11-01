// 캔버스 텍스트 노드의 @레퍼런스 토큰 — 보기 모드 알약과 편집칸(contentEditable, Jay 2026-10-29) 이 같이 쓴다.
//  생성창 편집기(promptEditor)와 달리 이어진 번호만 알약으로 감싸고, 알약 안에 원래 글자(@image1·<<<image1>>>)를 그대로 둔다 —
//  텍스트 노드 글은 생성 카드·Comfy 로 그대로 가므로 저장하는 글이 친 것과 같아야 한다(정규화·없는 번호 경고 없음).

// @image1 형식 + comfy 프롬프트의 <<<image1>>> 형식. 시작·끝 이미지(@simage2·@eimage2)는 이미지 2번을 가리킨다.
export const TEXT_TOKEN_SRC = "@(simage|eimage|image|video|audio)(\\d+)|<<<(simage|eimage|image|video|audio)(\\d+)>>>";

export type TextTokenKind = "image" | "start" | "end" | "video" | "audio";
export interface TextTokenInfo {
  label: string; // 원래 글자 그대로
  kind: TextTokenKind; // 알약 색
  key: string; // 레퍼런스 번호 열쇠(@image2 — 시작·끝도 이미지 번호)
}

export function textTokenInfo(m: RegExpExecArray): TextTokenInfo {
  const word = (m[1] || m[3] || "").toLowerCase();
  const n = m[2] || m[4] || "";
  const kind = (word === "simage" ? "start" : word === "eimage" ? "end" : word) as TextTokenKind;
  return { label: m[0], kind, key: `@${kind === "start" || kind === "end" ? "image" : word}${n}` };
}

const TOKEN_ATTR = "data-tok"; // 편집칸 알약 표시 — 감싼 것은 다시 감싸지 않고, 그 안 글자는 @ 목록을 띄우지 않는다

// 노드의 글 — 알약은 원래 글자, 그림 자리 표시(음표 등)는 빼고, <br> 은 줄바꿈.
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (el.classList.contains("scene-inlinetok-ph")) return "";
  if (el.tagName === "BR") return "\n";
  let out = "";
  el.childNodes.forEach((child) => { out += textOf(child); });
  return out;
}

// 편집칸(또는 그 일부를 떠 낸 조각)의 글. 다 지우면 크롬이 남기는 <br> 하나는 빈 글이다.
export function editorText(root: Node): string {
  let out = "";
  root.childNodes.forEach((child) => { out += textOf(child); });
  return out === "\n" ? "" : out;
}

// 편집칸 알약 — 보기 모드 알약(scene-inlinetok)과 같은 모양. 원자 카드(contentEditable=false)라 Backspace 한 번에 통째로 지워진다.
export function buildTextTokenPill(info: TextTokenInfo, thumb: string | undefined): HTMLElement {
  const el = document.createElement("span");
  el.className = "scene-inlinetok k-" + info.kind;
  el.setAttribute("contenteditable", "false");
  el.setAttribute(TOKEN_ATTR, "");
  el.title = info.label;
  if (info.kind === "audio" || !thumb) {
    const ph = document.createElement("span");
    ph.className = "scene-inlinetok-ph" + (info.kind === "audio" ? " tok-audio" : "");
    if (info.kind === "audio") ph.textContent = "🎵";
    el.append(ph);
  } else {
    const img = document.createElement("img");
    img.src = thumb;
    img.alt = "";
    img.draggable = false;
    img.onerror = () => { img.style.visibility = "hidden"; };
    el.append(img);
  }
  el.append(document.createTextNode(info.label));
  return el;
}

// 붙여 넣은 글자·푼 알약은 따로 된 Text 노드다 — 이어 보지 않으면 @image1+2 가 저장(@image12)과 다른 알약이 된다. 캐럿이 합쳐진 노드를 따라오지 못했으면 글자 자리로 되돌린다.
function mergeSplitText(editor: HTMLElement): void {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let split = false;
  for (let node = walker.nextNode(); node && !split; node = walker.nextNode()) split = node.nextSibling?.nodeType === Node.TEXT_NODE;
  if (!split) return;
  const sel = window.getSelection();
  const at = sel?.isCollapsed && sel.anchorNode?.nodeType === Node.TEXT_NODE ? caretTextOffset(editor) : null; // 요소 경계의 캐럿은 합쳐도 그대로다
  editor.normalize();
  const anchor = sel?.anchorNode;
  if (at !== null && !(anchor?.isConnected && anchor.nodeType === Node.TEXT_NODE)) placeCaretAtTextOffset(editor, at);
}

// 이어진 번호(refs 에 있는 열쇠)만 알약으로 감싼다. protectCaret 이면 캐럿이 걸친 토큰(경계 포함)은 치는 중이라 글자로 두고,
//  캐럿은 같은 글자 자리로 되돌린다. 감쌀 것이 없으면 DOM 을 건드리지 않는다(캐럿·되돌리기 안정).
export function wrapTextTokens(editor: HTMLElement, refs: ReadonlyMap<string, string | undefined>, protectCaret: boolean): void {
  const sel = window.getSelection();
  // 고른 글이 있으면 미룬다 — 글자 칸을 알약으로 바꾸면 선택이 무너져 다음 입력이 고른 글을 덮어쓰지 못한다
  if (protectCaret && sel?.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) return;
  // 캐럿이 든 빈 Text 는 합치면 사라져 캐럿 보호가 풀린다
  if (!(sel?.isCollapsed && sel.anchorNode?.nodeType === Node.TEXT_NODE && !(sel.anchorNode as Text).length)) mergeSplitText(editor);
  const anchor = sel && sel.rangeCount && sel.isCollapsed ? sel.anchorNode : null;
  const caretNode = protectCaret && anchor?.nodeType === Node.TEXT_NODE && editor.contains(anchor) ? (anchor as Text) : null;
  const caretOffset = caretNode ? sel!.anchorOffset : -1;
  const targets: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (!n.parentElement?.closest(`[${TOKEN_ATTR}]`)) targets.push(n as Text);
  let restore: { node: Node; offset: number } | null = null;
  for (const textNode of targets) {
    const text = textNode.data;
    const re = new RegExp(TEXT_TOKEN_SRC, "gi");
    const frag = document.createDocumentFragment();
    const isCaret = textNode === caretNode;
    const caret: { at: { node: Node; offset: number } | null } = { at: null }; // pushText 안에서 채운다(상자라 타입 좁히기에 안 걸림)
    let last = 0;
    let wrapped = 0;
    const pushText = (s: string, start: number) => {
      const t = document.createTextNode(s);
      frag.append(t);
      if (isCaret && !caret.at && caretOffset >= start && caretOffset <= start + s.length) caret.at = { node: t, offset: caretOffset - start };
    };
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const info = textTokenInfo(m);
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) pushText(text.slice(last, start), last);
      if (!refs.has(info.key) || (isCaret && caretOffset >= start && caretOffset <= end)) pushText(m[0], start);
      else {
        frag.append(buildTextTokenPill(info, refs.get(info.key)));
        wrapped++;
      }
      last = end;
    }
    if (!wrapped) continue;
    if (last < text.length) pushText(text.slice(last), last);
    textNode.replaceWith(frag);
    if (caret.at) restore = caret.at;
  }
  if (restore && sel) {
    const r = document.createRange();
    r.setStart(restore.node, restore.offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

// 캐럿의 글자 위치(editorText 기준) — 편집을 다시 열 때 그 자리로 돌아오게 기억한다.
export function caretTextOffset(editor: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!editor.contains(r.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(r.startContainer, r.startOffset);
  return editorText(before.cloneContents()).length;
}

// 글자 위치에 캐럿을 둔다 — 알약 안쪽이면 그 알약 뒤로. 넘치면 끝.
export function placeCaretAtTextOffset(editor: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  let left = offset;
  let placed = false;
  for (const node of Array.from(editor.childNodes)) {
    const len = textOf(node).length;
    if (node.nodeType === Node.TEXT_NODE && left <= len) {
      r.setStart(node, left);
      placed = true;
      break;
    }
    if (node.nodeType !== Node.TEXT_NODE && left < len) {
      r.setStartAfter(node);
      placed = true;
      break;
    }
    left -= len;
  }
  if (!placed) {
    r.selectNodeContents(editor);
    r.collapse(false);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

// 캐럿 바로 앞의 @ 고르기 — @ 앞은 글 처음이거나 단어 글자가 아님(foo@image 같은 메일 주소는 아님), @ 뒤는 영문·숫자만.
//  알약 안 글자에서는 띄우지 않는다.
export function caretMention(editor: HTMLElement): { node: Text; start: number; query: string } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node) || node.parentElement?.closest(`[${TOKEN_ATTR}]`)) return null;
  const before = (node as Text).data.slice(0, sel.anchorOffset);
  const m = /(?:^|[^\w@])@(\w*)$/.exec(before);
  return m ? { node: node as Text, start: sel.anchorOffset - m[1].length - 1, query: m[1].toLowerCase() } : null;
}

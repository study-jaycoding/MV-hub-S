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

// ── 보기 칸에 넣는 글 줄이기(2026-11-10) — 글 카드는 위쪽만 보이는데 원문(실제 씬에서 평균 1.7만 자)을 다 넣으면 줌할 때마다 그 글을
//  모두 다시 그렸다(격리 실측: 본문을 빼면 휠 줌 긴 프레임 약 70%↓). 보기 칸에만 줄인 글을 넣고 원문은 편집·복사·연결 입력에 그대로 쓴다.
/** 보기 칸에 넣을 글의 후보 길이 — 글꼴 12px·줄 1.7(scene.css `.scene-textview-inline`)로 보이는 줄 + 여유, 한 줄은 좁은 글자
 *  기준(6px)으로 넉넉히. 후보일 뿐이다 — TextCard 가 넣은 뒤 보기 칸을 다 채우는지 재서 모자라면 늘린다. */
export function textViewBudget(width: number, height: number): number {
  const lines = Math.ceil(Math.max(0, height) / 20.4) + 4;
  const perLine = Math.ceil(Math.max(0, width) / 6);
  return Math.max(400, lines * perLine);
}

// Intl.Segmenter — 이 프로젝트의 TS lib 에 타입이 없어 필요한 모양만 적는다(크롬·Electron 은 있다, 없으면 아래 대체 규칙)
type GraphemeSegmenter = { segment(text: string): Iterable<{ index: number }> };
const SegmenterCtor = (typeof Intl !== "undefined"
  ? (Intl as unknown as { Segmenter?: new (locale: undefined, options: { granularity: "grapheme" }) => GraphemeSegmenter }).Segmenter
  : undefined);
const GRAPHEMES = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : null;
const TOKEN_AT_START = new RegExp(`^(?:${TEXT_TOKEN_SRC})`, "i");

/** 보기 칸용으로 글을 limit 근처에서 자른다 — 토큰(@image12·<<<image1>>>)과 글자 덩어리(이모지·결합 문자·서로게이트) 한가운데가
 *  아니게, 줄임표 없이(Jay 규칙: UI 글 끝에 ... 금지). limit 보다 짧으면 그대로. */
export function cutTextForView(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = Math.max(0, Math.floor(limit));
  // 토큰이 자르는 자리를 걸치면 그 토큰 앞에서(토큰은 32자 안쪽)
  for (let i = Math.max(0, cut - 32); i < cut; i++) {
    const ch = text.charCodeAt(i);
    if (ch !== 64 && ch !== 60) continue; // '@' · '<'
    const m = TOKEN_AT_START.exec(text.slice(i, i + 40));
    if (m && i + m[0].length > cut) {
      cut = i;
      break;
    }
  }
  // 글자 덩어리 경계로 — 자르는 자리가 든 덩어리의 시작. 경계는 **원문 처음부터** 나눠야 맞다: 중간 자리에서 나누기 시작하면
  //  이음 문자로 길게 이은 이모지·결합 문자가 수백 개 붙은 글자를 경계로 잘못 봤다(독립 리뷰 P2 재현 둘). 길이 = 자르는 자리 + 여유
  //  (그 뒤는 경계 판정에 영향 없음). 비용은 글자 수만큼이라 TextCard 가 글·길이가 바뀔 때만 부른다(useMemo).
  if (GRAPHEMES) {
    let boundary = 0;
    for (const part of GRAPHEMES.segment(text.slice(0, cut + 64))) {
      if (part.index > cut) break;
      boundary = part.index;
    }
    cut = boundary;
  } else {
    while (cut > 0 && /[̀-ͯ‍️\udc00-\udfff]/.test(text[cut])) cut--;
  }
  return text.slice(0, cut);
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

function childrenText(root: Node): string {
  let out = "";
  root.childNodes.forEach((child) => { out += textOf(child); });
  return out;
}

// 편집칸의 글. 다 지우면 크롬이 남기는 <br> 하나는 빈 글이다.
export function editorText(root: Node): string {
  const out = childrenText(root);
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

// 이 조각 뒤로 이어진 글 조각들의 글
function textAfter(node: Text): string {
  let out = "";
  for (let next = node.nextSibling; next?.nodeType === Node.TEXT_NODE; next = next.nextSibling) out += (next as Text).data;
  return out;
}

// 두 글의 경계에 토큰이 걸치는가
function tokenAcross(left: string, right: string): boolean {
  const re = new RegExp(TEXT_TOKEN_SRC, "gi");
  const joined = left + right;
  for (let m = re.exec(joined); m; m = re.exec(joined)) {
    if (m.index < left.length && m.index + m[0].length > left.length) return true;
  }
  return false;
}

// 붙여 넣은 글자·푼 알약은 따로 된 Text 노드다 — 이어 보지 않으면 @image1+2 가 저장(@image12)과 다른 알약이 된다. 캐럿이 합쳐진 노드를 따라오지 못했으면 글자 자리로 되돌린다.
//  ★토큰이 걸친 두 조각만 합친다 — 칸 전체를 normalize 하면 브라우저 되돌리기 기록이 가리키는 조각이 사라져, 글 중간 줄바꿈 뒤 Ctrl+Z 가 글을 통째로 지운다(2026-11-01 실제 크롬).
function mergeSplitText(editor: HTMLElement): void {
  const sel = window.getSelection();
  let at: number | null | undefined; // 합치기 전의 글자 자리 — 합칠 때만 잰다
  let inText = false;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let next = node.nextSibling; next?.nodeType === Node.TEXT_NODE && tokenAcross(node.data, textAfter(node)); next = node.nextSibling) {
      if (at === undefined) {
        at = sel?.isCollapsed ? caretTextOffset(editor) : null;
        inText = sel?.anchorNode?.nodeType === Node.TEXT_NODE;
      }
      node.appendData((next as Text).data);
      next.remove();
    }
  }
  if (at == null) return;
  const anchor = sel?.anchorNode;
  // 글자 자리가 밀렸거나, 글 조각에 있던 캐럿이 지운 조각과 함께 사라졌을 때만 되돌린다 — 요소 경계의 캐럿은 그 자리에 둔다
  if (caretTextOffset(editor) !== at || (inText && !(anchor?.isConnected && anchor.nodeType === Node.TEXT_NODE))) placeCaretAtTextOffset(editor, at);
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
  return childrenText(before.cloneContents()).length; // 빈 칸 처리를 하지 않는다 — 앞쪽 빈 줄의 캐럿이 첫 줄로 간다
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

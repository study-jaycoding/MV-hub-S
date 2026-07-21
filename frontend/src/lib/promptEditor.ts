import { DRAG_TYPES } from "./dragTypes";
import { displayThumb } from "./media";
import { SEEDANCE_TOKEN_SRC, seedanceAtTokenKind, seedanceCanonToken } from "./seedancePrompt";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export interface ChipRef {
  file_path: string; // 레퍼런스 값(asset:proj|path 토큰 또는 원격 URL) — 백엔드가 resolve
  type: "image" | "video" | "audio";
  role: string; // @Image1 / @Video …
  name: string; // 칩 표시 이름(@소스명)
  thumb: string; // 칩 썸네일 URL
  source_gen_id?: string; // 이 @소스가 온 generation id → 히스토리 reference 엣지 기록(없으면 에셋/업로드)
}

// ── contentEditable DOM 헬퍼(React 밖에서 명령형으로 관리) ──
export function getCaretRange(editor: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;
  return range;
}

// 캐럿 직전의 @/# 트리거 토큰(공백 전까지)을 찾음.
export function triggerInfo(editor: HTMLElement, char: string, skipNode?: Node | null): { node: Text; idx: number; query: string } | null {
  const range = getCaretRange(editor);
  if (!range || !range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  // 토큰 알약(@image1) 내부 텍스트를 편집(@image1→@simage1 등) 중이면 멘션 피커를 띄우지 않는다.
  if ((node as Text).parentElement?.closest(".sl-tok")) return null;
  // 알약을 클릭해 텍스트로 풀어 편집 중인 노드도 마찬가지(순수 Text 라 위 .sl-tok 보호가 안 걸린다).
  if (skipNode && node === skipNode) return null;
  const before = (node.textContent || "").substring(0, range.startOffset);
  const idx = before.lastIndexOf(char);
  if (idx < 0) return null;
  const query = before.substring(idx + 1);
  if (/\s/.test(query)) return null;
  return { node: node as Text, idx, query };
}

// 활성 멘션: @/# 둘 다 있으면 캐럿에 더 가까운(idx 큰) 쪽.
export function detectMention(editor: HTMLElement, skipNode?: Node | null): { kind: "@" | "#"; query: string } | null {
  const at = triggerInfo(editor, "@", skipNode);
  const hash = triggerInfo(editor, "#", skipNode);
  if (at && hash) {
    return at.idx >= hash.idx ? { kind: "@", query: at.query } : { kind: "#", query: hash.query };
  }
  if (at) return { kind: "@", query: at.query };
  if (hash) return { kind: "#", query: hash.query };
  return null;
}

export function stripQuery(editor: HTMLElement, char: string) {
  const t = triggerInfo(editor, char);
  if (!t) return;
  const r = document.createRange();
  r.setStart(t.node, t.idx);
  r.setEnd(t.node, t.idx + 1 + t.query.length);
  r.deleteContents();
}

export function placeCaretAtEnd(editor: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(editor);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function insertTextAtCaret(editor: HTMLElement, text: string) {
  editor.focus();
  let range = getCaretRange(editor);
  if (!range) {
    placeCaretAtEnd(editor);
    range = getCaretRange(editor);
    if (!range) return;
  }
  const tn = document.createTextNode(text);
  range.insertNode(tn);
  const nr = document.createRange();
  nr.setStart(tn, tn.length);
  nr.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(nr);
}

// 에디터 내에서 재배치(드래그) 중인 칩 — 모듈 스코프로 추적(드롭 시 moveChipToPoint 가 사용).
let _draggingChip: HTMLElement | null = null;
export function buildChipEl(ref: ChipRef): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "inline-ref";
  chip.contentEditable = "false";
  chip.dataset.ref = JSON.stringify(ref);
  chip.draggable = true; // 글자 사이로 끌어 재배치
  // 썸네일 있으면 img, 없으면(오디오 등) 플레이스홀더 — 빈 src img 의 재요청/깨진이미지 방지.
  let media: HTMLElement;
  if (ref.thumb) {
    const img = document.createElement("img");
    img.src = displayThumb(ref.thumb) || ref.thumb; // display=캐시 썸네일(원격 깨짐 방지), 실패 시 원본
    img.alt = "";
    img.draggable = false; // 이미지 자체 네이티브 드래그 방지(칩 단위로만 드래그)
    media = img;
  } else {
    const ph = document.createElement("span");
    ph.className = "inline-ref-ph";
    ph.textContent = ref.type === "audio" ? "🎵" : "▦";
    media = ph;
  }
  const nm = document.createElement("span");
  nm.className = "inline-ref-name";
  nm.textContent = ref.name;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "inline-ref-remove";
  rm.tabIndex = -1;
  rm.textContent = "×";
  rm.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chip.remove();
  });
  // 칩 재배치 드래그 — 커스텀 타입(x-ch-chip)으로 격리해 카드/에셋 드롭 핸들러와 안 섞이게.
  chip.addEventListener("dragstart", (e) => {
    _draggingChip = chip;
    chip.classList.add("ref-dragging");
    try {
      e.dataTransfer?.setData(DRAG_TYPES.chip, "1");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    } catch {
      /* ignore */
    }
  });
  chip.addEventListener("dragend", () => {
    chip.classList.remove("ref-dragging");
    _draggingChip = null;
    hideChipDropBar();
  });
  chip.append(media, nm, rm);
  return chip;
}

function chipRefOf(el: Element): ChipRef | null {
  try {
    const raw = (el as HTMLElement).dataset.ref;
    return raw ? (JSON.parse(raw) as ChipRef) : null;
  } catch {
    return null;
  }
}

// 드롭 지점(x,y)의 글자 사이 캐럿 위치 → Range. Chromium=caretRangeFromPoint, FF=caretPositionFromPoint.
function caretRangeAtPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

// node 에서 위로 올라가며 가장 가까운 .inline-ref 칩(editor 안). 없으면 null.
function closestChip(node: Node | null, editor: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== editor) {
    if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList?.contains("inline-ref"))
      return n as HTMLElement;
    n = n.parentNode;
  }
  return null;
}

// 드래그 중인 칩을 드롭 지점의 글자 사이로 이동. editor 밖·자기 자신 위면 무시(true=이동함).
export function moveChipToPoint(editor: HTMLElement, x: number, y: number): boolean {
  const chip = _draggingChip;
  if (!chip || !editor.contains(chip)) return false;
  const range = caretRangeAtPoint(x, y);
  if (!range || !editor.contains(range.startContainer)) return false;
  if (chip.contains(range.startContainer) || range.startContainer === chip) return false; // 제자리
  const host = closestChip(range.startContainer, editor); // 다른 칩 위면 그 뒤로
  chip.remove();
  if (host && host !== chip) host.parentNode!.insertBefore(chip, host.nextSibling);
  else range.insertNode(chip);
  // 칩 뒤에 공백 보장(다음 글자와 붙지 않게) + 캐럿을 칩 뒤로.
  const after = chip.nextSibling;
  if (!(after && after.nodeType === Node.TEXT_NODE && /^\s/.test(after.textContent || ""))) {
    chip.parentNode!.insertBefore(document.createTextNode(" "), chip.nextSibling);
  }
  const nr = document.createRange();
  nr.setStartAfter(chip.nextSibling || chip);
  nr.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(nr);
  return true;
}

// 드롭 위치 표시 막대(세로선) — body 에 fixed 로 1개 재사용.
let _dropBar: HTMLElement | null = null;
export function showChipDropBar(x: number, y: number): void {
  const range = caretRangeAtPoint(x, y);
  if (!range) return;
  const rect = range.getBoundingClientRect();
  if (!_dropBar) {
    _dropBar = document.createElement("div");
    _dropBar.className = "ch-chip-dropbar";
    document.body.appendChild(_dropBar);
  }
  _dropBar.style.left = `${rect.left}px`;
  _dropBar.style.top = `${rect.top}px`;
  _dropBar.style.height = `${rect.height || 22}px`;
  _dropBar.style.display = "block";
}
export function hideChipDropBar(): void {
  if (_dropBar) _dropBar.style.display = "none";
}

// @query 를 칩으로 치환 + 뒤에 공백 + 캐럿 이동.
export function insertChip(editor: HTMLElement, ref: ChipRef) {
  editor.focus();
  const t = triggerInfo(editor, "@");
  let range: Range;
  if (t) {
    range = document.createRange();
    range.setStart(t.node, t.idx);
    range.setEnd(t.node, t.idx + 1 + t.query.length);
    range.deleteContents();
  } else {
    const cr = getCaretRange(editor);
    if (cr) range = cr;
    else {
      placeCaretAtEnd(editor);
      range = getCaretRange(editor)!;
    }
  }
  const chip = buildChipEl(ref);
  range.insertNode(chip);
  const space = document.createTextNode(" ");
  chip.parentNode!.insertBefore(space, chip.nextSibling);
  const nr = document.createRange();
  nr.setStart(space, 1);
  nr.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(nr);
}

// 트레이 레퍼런스 토큰(@image1 등)을 '썸네일 + 색 있는 알약'으로 만든다. 텍스트로는 정확히 "@image1"
// 그대로라 serialize 가 읽어 파싱한다(새 레퍼런스가 아니라 기존 트레이 항목을 가리킴).
//  · ★기본은 '원자 카드'(contenteditable=false) — 다른 곳 클릭해도 카드로 유지, 백스페이스 한 번에 삭제.
//    이름 변경(@image1→@simage1)은 알약을 클릭했을 때만 unwrapTokenPill 로 텍스트로 풀어 편집한다.
//  · 썸네일 없으면 타입 아이콘을 CSS ::before(텍스트 노드 아님 → 직렬화 오염 없음)로 표시.
export function buildRefTokenEl(token: string, kind: string, media?: string, missing = false): HTMLElement {
  const el = document.createElement("span");
  el.contentEditable = "false"; // 원자 카드 — 소스 칩(.inline-ref)과 동일. 클릭 시에만 편집 전환.
  // 비디오는 썸네일(이미지)이 없어 파일 URL 이 오므로 <img> 로는 깨진다 → <video> 로 첫 프레임을 보여준다
  // (트레이와 동일). 오디오는 썸네일이 없어 아이콘. 이미지/시작/끝은 <img>.
  // missing = 트레이에 그 번호의 레퍼런스가 없음(@image3 인데 3번이 없음) → 경고 스타일로 시인성 있게.
  const hasMedia = !!media && kind !== "audio" && !missing;
  el.className = "sl-tok sl-tok-" + kind + (hasMedia ? " sl-tok-has-thumb" : "") + (missing ? " sl-tok-missing" : "");
  if (missing) el.title = "이 번호의 레퍼런스가 트레이에 없습니다";
  if (hasMedia) {
    let m: HTMLElement;
    if (kind === "video") {
      const v = document.createElement("video");
      v.src = media!;
      v.muted = true; // 자동재생은 무음이어야 브라우저가 허용
      v.autoplay = true; // 첫 프레임 정지 대신 움직이게(무음 루프)
      v.loop = true;
      v.preload = "auto";
      v.setAttribute("playsinline", "");
      m = v;
    } else {
      const img = document.createElement("img");
      img.src = displayThumb(media!) || media!; // display=캐시 썸네일, 실패 시 원본
      img.alt = "";
      img.draggable = false;
      m = img;
    }
    m.className = "sl-tok-thumb";
    m.contentEditable = "false";
    el.appendChild(m);
  }
  el.appendChild(document.createTextNode(token)); // 토큰 텍스트(@image1) — 편집 모드에서만 고칠 수 있음
  return el;
}

// 알약(원자 카드)을 클릭했을 때 → 원본 토큰 텍스트(@image1)로 '풀어서' 편집 가능하게 하고 캐럿을 끝에 둔다.
// 이름을 @simage1/@eimage1 등으로 고친 뒤 다른 곳으로 이동하거나 에디터를 벗어나면 wrapRefTokens 가 다시
// 알약으로 감싼다(색/아이콘/썸네일 갱신). 편집 호스트가 에디터 하나뿐이라 중첩 contentEditable 포커스 꼬임이 없다.
export function unwrapTokenPill(pill: HTMLElement): Text | null {
  const parent = pill.parentNode;
  if (!parent) return null;
  const token = (pill.textContent || "").trim(); // 알약 안 텍스트만(미디어 img/video 는 textContent 없음)
  const textNode = document.createTextNode(token);
  parent.replaceChild(textNode, pill);
  const sel = window.getSelection();
  if (!sel) return textNode;
  const range = document.createRange();
  range.setStart(textNode, token.length); // 캐럿을 토큰 끝에
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return textNode; // 편집 중 노드 — 호출부가 멘션 감지 제외용으로 기억한다
}

// @query 를 지우고 토큰 알약을 삽입(피커에서 트레이 항목 선택 시). insertChip 과 동일한 자리잡기.
export function insertRefToken(editor: HTMLElement, token: string, kind: string, thumb?: string) {
  editor.focus();
  const t = triggerInfo(editor, "@");
  let range: Range;
  if (t) {
    range = document.createRange();
    range.setStart(t.node, t.idx);
    range.setEnd(t.node, t.idx + 1 + t.query.length); // '@' + query 제거
    range.deleteContents();
  } else {
    const cr = getCaretRange(editor);
    if (cr) range = cr;
    else {
      placeCaretAtEnd(editor);
      range = getCaretRange(editor)!;
    }
  }
  const el = buildRefTokenEl(token, kind, thumb);
  range.insertNode(el);
  const space = document.createTextNode(" ");
  el.parentNode!.insertBefore(space, el.nextSibling);
  const nr = document.createRange();
  nr.setStart(space, 1); // 알약 뒤 공백 다음으로 캐럿 이동
  nr.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(nr);
}

// 한 텍스트 노드 안의 토큰을 알약으로 감싼다. caretOffset 이 주어지면(=이 노드에 캐럿) 그 캐럿이 '걸친'
// 토큰 하나만 텍스트로 남기고(입력·이름편집 중), 나머지는 감싼다. 캐럿이 있던 텍스트 조각의 새 위치를 반환.
function wrapTokensInTextNode(
  textNode: Text,
  resolveMedia: ((kind: string, n: number) => string | undefined) | undefined,
  caretOffset: number | null,
): { node: Node; offset: number } | null {
  const text = textNode.textContent || "";
  const frag = document.createDocumentFragment();
  const re = new RegExp(SEEDANCE_TOKEN_SRC, "gi");
  let last = 0;
  let m: RegExpExecArray | null;
  let wrapped = 0; // 실제로 알약으로 바꾼 토큰 수 — 0 이면 DOM/selection 건드리지 않는다(불필요한 교체·캐럿충격 방지)
  let restore: { node: Node; offset: number } | null = null;
  // 텍스트 조각을 넣으며, 캐럿(원본 offset)이 이 조각 범위에 들면 복원 위치를 기록.
  const pushText = (s: string, origStart: number) => {
    const tn = document.createTextNode(s);
    frag.appendChild(tn);
    if (caretOffset !== null && restore === null && caretOffset >= origStart && caretOffset <= origStart + s.length) {
      restore = { node: tn, offset: caretOffset - origStart };
    }
  };
  while ((m = re.exec(text))) {
    const mStart = m.index;
    const mEnd = m.index + m[0].length;
    if (mStart > last) pushText(text.slice(last, mStart), last);
    // 캐럿이 이 토큰에 걸쳐 있으면(경계 포함) 텍스트로 남긴다 — 입력 중이거나 이름 편집(unwrap) 중.
    const caretOnToken = caretOffset !== null && caretOffset >= mStart && caretOffset <= mEnd;
    if (caretOnToken) {
      pushText(text.slice(mStart, mEnd), mStart);
    } else {
      const raw = m[1] || m[3]; // <<<>>> 형(그룹1) 또는 @ 형(그룹3)
      const num = m[2] || m[4];
      const kind = seedanceAtTokenKind(raw);
      // resolveMedia 가 undefined 를 주면 = 트레이에 그 번호 항목이 아예 없음(missing). ""(존재하나 썸네일 없음)
      // 과 구분해야 하므로 resolveTokenMedia 는 존재 항목엔 최소 "" 를 돌려준다. resolveMedia 자체가 없으면(정규화만)
      // 존재 여부를 알 수 없으니 missing 판단 안 함.
      const media = resolveMedia?.(kind, Number(num));
      const missing = !!resolveMedia && media === undefined;
      frag.appendChild(buildRefTokenEl(seedanceCanonToken(raw, num), kind, media || undefined, missing));
      wrapped++;
    }
    last = mEnd;
  }
  if (last < text.length) pushText(text.slice(last), last);
  if (wrapped === 0) return null; // 감쌀 토큰이 하나도 없음(전부 캐럿 보호) → 원본 그대로 두어 캐럿·undo 안정
  textNode.parentNode?.replaceChild(frag, textNode);
  return restore;
}

// 에디터 텍스트 속 토큰(@image1 · <<<video1>>> · 언더바 변형)을 알약으로 감싼다(blur·복원·라이브). 두 형태
// 모두 @kindN 알약으로 통일(<<<>>> 도 @처럼 보이게). resolveMedia(kind, n) 로 썸네일/비디오 URL 을 얻어
// 알약에 넣는다(없으면 아이콘). 이미 알약/칩 안의 텍스트는 건너뜀. skipCaretNode 면 캐럿이 걸친 토큰만 남기고
// 캐럿을 보존한다(입력 중인 토큰만 두고 나머지는 즉시 알약 → blur 까지 안 기다림).
export function wrapRefTokens(
  editor: HTMLElement,
  resolveMedia?: (kind: string, n: number) => string | undefined,
  opts?: { skipCaretNode?: boolean },
) {
  const sel = opts?.skipCaretNode ? window.getSelection() : null;
  // 라이브랩 중 사용자가 드래그로 텍스트를 '선택'한 상태면 건드리지 않는다(선택이 접힘). 다음 입력/blur 때 처리.
  if (sel && sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) return;
  const caretNode =
    sel && sel.rangeCount && editor.contains(sel.anchorNode) && sel.anchorNode?.nodeType === Node.TEXT_NODE
      ? sel.anchorNode
      : null;
  const caretOffset = caretNode ? sel!.anchorOffset : null;
  const targets: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest(".sl-tok, .inline-ref")) continue; // 이미 감싼 것 제외
    if (new RegExp(SEEDANCE_TOKEN_SRC, "gi").test(node.textContent || "")) targets.push(node as Text);
  }
  let restore: { node: Node; offset: number } | null = null;
  for (const textNode of targets) {
    const isCaret = textNode === caretNode;
    const r = wrapTokensInTextNode(textNode, resolveMedia, isCaret ? caretOffset : null);
    if (isCaret && r) restore = r;
  }
  if (restore && sel) {
    const range = document.createRange();
    const len = (restore.node.textContent || "").length;
    range.setStart(restore.node, Math.min(restore.offset, len));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export function countImageChips(editor: HTMLElement): number {
  let n = 0;
  editor.querySelectorAll(".inline-ref").forEach((el) => {
    if (chipRefOf(el)?.type === "image") n++;
  });
  return n;
}

// 본문 텍스트(칩 제외) + 칩 references 직렬화.
export function serialize(editor: HTMLElement): { text: string; refs: ChipRef[] } {
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList?.contains("inline-ref")) return;
      if (el.tagName === "BR") text += "\n";
      else el.childNodes.forEach(walk);
    }
  };
  editor.childNodes.forEach(walk);
  const refs: ChipRef[] = [];
  editor.querySelectorAll(".inline-ref").forEach((el) => {
    const ref = chipRefOf(el);
    if (ref) refs.push(ref);
  });
  return { text: text.replace(/ /g, " ").replace(/​/g, "").trim(), refs };
}

export function hasContent(editor: HTMLElement): boolean {
  if (editor.querySelector(".inline-ref")) return true;
  return (editor.textContent || "").replace(/[​ \s]/g, "").length > 0;
}

// ── 프롬프트 기록(쉘식 ↑↓) — 제출한 프롬프트를 텍스트+칩 구조로 localStorage 에 보관 ──
export const HIST_KEY = STORAGE_KEYS.promptHistory;
export const HIST_MAX = 20; // 최근 20개만 기억
export type PromptPart = { t: "text"; v: string } | { t: "chip"; ref: ChipRef };
export interface HistEntry {
  parts: PromptPart[];
  text: string;
  trayRefs?: ChipRef[]; // 확장 트레이 레퍼런스(uid 제외) — ↑↓ 히스토리 복원 시 트레이도 되살린다. 옛 항목엔 없을 수 있음.
}

export function loadHistory(): HistEntry[] {
  try {
    const r = loadJSON<HistEntry[]>(HIST_KEY) || [];
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}
export function saveHistory(h: HistEntry[]) {
  saveJSON(HIST_KEY, h.slice(-HIST_MAX));
}
// 에디터 → 순서 보존 파트 목록(텍스트/칩) — 복원 시 칩 위치까지 그대로.
export function serializeParts(editor: HTMLElement): PromptPart[] {
  const parts: PromptPart[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.textContent || "";
      if (v) parts.push({ t: "text", v });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList?.contains("inline-ref")) {
        const ref = chipRefOf(el);
        if (ref) parts.push({ t: "chip", ref });
        return;
      }
      if (el.tagName === "BR") parts.push({ t: "text", v: "\n" });
      else el.childNodes.forEach(walk);
    }
  };
  editor.childNodes.forEach(walk);
  return parts;
}
export function partsText(parts: PromptPart[]): string {
  return parts
    .map((p) => (p.t === "text" ? p.v : `@${p.ref?.name || ""}`))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
// display_prompt 용 — 칩은 @이름, 텍스트는 '줄바꿈 그대로' 보존한다(재사용 시 줄바꿈 복원).
// partsText 는 dedup·토큰스캔용이라 \s+ 를 공백으로 접지만, display_prompt 까지 접으면 Shift+Enter
// 줄바꿈이 재사용에서 한 줄로 사라진다. 여기서는 줄 끝 공백만 다듬고 줄바꿈은 남긴다.
export function partsDisplay(parts: PromptPart[]): string {
  return parts
    .map((p) => (p.t === "text" ? p.v : `@${p.ref?.name || ""}`))
    .join("")
    .replace(/[ \t]+$/gm, "") // 각 줄 끝 공백 정리(줄바꿈은 보존)
    .trim();
}
export function restoreParts(editor: HTMLElement, parts: PromptPart[]) {
  editor.innerHTML = "";
  const appendText = (v: string) => {
    // 텍스트 안의 줄바꿈(\n)은 contentEditable 에서 그냥 text node 면 공백으로 접힌다 → <br> 로 넣어야
    // 실제 줄바꿈으로 보이고 serialize 가 다시 \n 으로 읽는다(Shift+Enter 로 친 것과 동일 취급).
    const segs = v.split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) editor.appendChild(document.createElement("br"));
      if (seg) editor.appendChild(document.createTextNode(seg));
    });
  };
  for (const p of parts) {
    if (p.t === "text") appendText(p.v);
    else if (p.ref) {
      editor.appendChild(buildChipEl(p.ref));
      editor.appendChild(document.createTextNode(" "));
    }
  }
  placeCaretAtEnd(editor);
}

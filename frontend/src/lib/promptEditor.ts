export interface ChipRef {
  file_path: string; // 레퍼런스 값(asset:proj|path 토큰 또는 원격 URL) — 백엔드가 resolve
  type: "image" | "video";
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
export function triggerInfo(editor: HTMLElement, char: string): { node: Text; idx: number; query: string } | null {
  const range = getCaretRange(editor);
  if (!range || !range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const before = (node.textContent || "").substring(0, range.startOffset);
  const idx = before.lastIndexOf(char);
  if (idx < 0) return null;
  const query = before.substring(idx + 1);
  if (/\s/.test(query)) return null;
  return { node: node as Text, idx, query };
}

// 활성 멘션: @/# 둘 다 있으면 캐럿에 더 가까운(idx 큰) 쪽.
export function detectMention(editor: HTMLElement): { kind: "@" | "#"; query: string } | null {
  const at = triggerInfo(editor, "@");
  const hash = triggerInfo(editor, "#");
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

export function buildChipEl(ref: ChipRef): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "inline-ref";
  chip.contentEditable = "false";
  chip.dataset.ref = JSON.stringify(ref);
  const img = document.createElement("img");
  img.src = ref.thumb;
  img.alt = "";
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
  chip.append(img, nm, rm);
  return chip;
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

export function countImageChips(editor: HTMLElement): number {
  let n = 0;
  editor.querySelectorAll(".inline-ref").forEach((el) => {
    try {
      if (JSON.parse((el as HTMLElement).dataset.ref || "{}").type === "image") n++;
    } catch {
      /* ignore */
    }
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
    try {
      refs.push(JSON.parse((el as HTMLElement).dataset.ref || "{}"));
    } catch {
      /* ignore */
    }
  });
  return { text: text.replace(/ /g, " ").replace(/​/g, "").trim(), refs };
}

export function hasContent(editor: HTMLElement): boolean {
  if (editor.querySelector(".inline-ref")) return true;
  return (editor.textContent || "").replace(/[​ \s]/g, "").length > 0;
}

// ── 프롬프트 기록(쉘식 ↑↓) — 제출한 프롬프트를 텍스트+칩 구조로 localStorage 에 보관 ──
export const HIST_KEY = "ch.promptHistory";
export const HIST_MAX = 20; // 최근 20개만 기억
export type PromptPart = { t: "text"; v: string } | { t: "chip"; ref: ChipRef };
export interface HistEntry {
  parts: PromptPart[];
  text: string;
}

export function loadHistory(): HistEntry[] {
  try {
    const r = JSON.parse(localStorage.getItem(HIST_KEY) || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}
export function saveHistory(h: HistEntry[]) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-HIST_MAX)));
  } catch {
    /* ignore */
  }
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
        try {
          parts.push({ t: "chip", ref: JSON.parse(el.dataset.ref || "{}") });
        } catch {
          /* ignore */
        }
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
export function restoreParts(editor: HTMLElement, parts: PromptPart[]) {
  editor.innerHTML = "";
  for (const p of parts) {
    if (p.t === "text") editor.appendChild(document.createTextNode(p.v));
    else if (p.ref) {
      editor.appendChild(buildChipEl(p.ref));
      editor.appendChild(document.createTextNode(" "));
    }
  }
  placeCaretAtEnd(editor);
}

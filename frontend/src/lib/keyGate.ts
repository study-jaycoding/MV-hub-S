// 떠 있는 것이 키의 주인이다 — 창·메뉴·확인 창이 떠 있는 동안 뒤 화면(라이브러리 격자·캔버스·계보 보드·프롬프트 도크)의
// 단축키는 쉰다. 뒤 화면의 키 리스너는 앱이 뜰 때 window 에 먼저 걸려 있어, 창 쪽에서 전파를 막아서는 못 세운다(같은 window·
// 같은 단계의 리스너는 등록 순서대로 돈다 — 먼저 돈 쪽이 이미 실행했다). 그래서 '떠 있음'을 여기에 올리고, 뒤 화면의 키 처리가
// 첫 줄에서 본다(2026-10-10 실측: 크게 보기·정보 창 뒤로 방향키·Ctrl+A·r/d·# 가 먹고, 캔버스는 Delete·Ctrl+Z 까지 먹었다).
//  · 올라가는 것 ①: Esc 로 닫히는 겹 전부(lib/useEscapeClose) — 따로 등록할 것이 없다.
//  · 올라가는 것 ②: Esc 가 없는 덮개(업데이트 진행·로그인 화면)는 useKeyOwner 로.
//  · 올리지 않는 것: 라이브러리 격자를 **안에 품은** 창(폴더 창·캔버스 '생성 결과' 창 — 그 격자가 곧 지금의 라이브러리다),
//    떠 있는 채 뒤를 조작하는 코멘트 패널. 이들의 Esc 는 겹이 아니라 '뒤 화면의 Esc'(useBackgroundEscape)다.
//  창 자신의 키(크게 보기의 ←/→, 모아보기의 ↑↓ …)는 그 창의 리스너라 여기와 무관하다.
import { useEffect, useRef, type RefObject } from "react";
import { isKeyHandled, markKeyHandled } from "./keyHandled";

let lastSeq = 0;
const layers = new Map<object, number>(); // 켜진 Esc 겹 → 켜진 렌더의 번호(클수록 위)
let owners = 0; // Esc 없이 키만 가진 덮개 수

/** 겹이 켜지는 **렌더**에서 받는 번호 — 부모가 자식보다 먼저 그려지므로 같이 뜬 겹도 안쪽이 위가 된다. */
export function nextLayerSeq(): number {
  lastSeq += 1;
  return lastSeq;
}

export function openLayer(token: object, seq: number): void {
  layers.set(token, seq);
}

export function closeLayer(token: object): void {
  layers.delete(token);
}

export function isTopLayer(token: object): boolean {
  const mine = layers.get(token);
  if (mine === undefined) return false;
  for (const seq of layers.values()) if (seq > mine) return false;
  return true;
}

/** Esc 가 없는 덮개가 떠 있는 동안(active) 뒤 화면의 단축키를 쉬게 한다. 늘 마운트돼 있는 컴포넌트는 열림 상태를 넘긴다. */
export function useKeyOwner(active = true): void {
  useEffect(() => {
    if (!active) return;
    owners += 1;
    return () => {
      owners -= 1;
    };
  }, [active]);
}

const NON_TEXT_INPUT = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** 글자를 치는 자리인가 — 단축키가 양보할 대상. 체크박스·슬라이더처럼 글자 없는 입력은 아니다(초점이 남아도 단축키는 먹는다). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT") return !NON_TEXT_INPUT.has(((el as HTMLInputElement).type || "").toLowerCase());
  return tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
}

/** 뒤 화면의 키 처리가 첫 줄에서 본다 — 참이면 아무것도 하지 않는다. */
export function backgroundKeysBlocked(): boolean {
  return owners > 0 || layers.size > 0;
}

// ── 초점 잃은 키 ──
//  창·입력을 닫으면 초점이 BODY 로 떨어지고, 탭·툴바 단추를 누르면 초점이 그 단추에 남는다 — 카드를 다시 누르기 전까지 격자의
//  방향키·Ctrl+A·#·c 가 죽고 Ctrl+A 는 화면 글자를 긁었다(2026-10-10 실측: 태그 입력 Esc·크게 보기·코멘트·정보 닫기·탭 전환 뒤).
//  그런 키는 지금 보이는 격자가 받고, 받으면 초점도 격자로 데려온다.
//  · 받는 초점: 없음(BODY) · 격자를 품은 창 자체(막 연 폴더 창) · 상단바/툴바/선택 막대의 단추(Enter·Space 는 그 단추를 누르는 키라 제외)
//  · 안 받는 경우: 격자가 가려져 있다(inert — 폴더 창 뒤의 본 목록) · 캔버스의 보드 위(초점 없는 키는 보드의 것)
//  · 캔버스에서도 **창 안의 격자**(폴더 창·'생성 결과' 창)는 받는다 — 초점이 없거나(BODY) 그 창 안에 있을 때. 창에서 연 크게 보기·정보·
//    코멘트를 닫으면 초점이 BODY 로 떨어지는데, 창이 떠 있는 동안 보드는 가려져 있어 그 키의 주인은 창이다(보드 쪽은
//    useSceneKeyboardShortcuts 가 스스로 쉰다).
//  · Esc 는 받지 않는다 — 선택 해제·창 닫기는 뒤 화면의 Esc 처리(lib/useEscapeClose)가 한 번만 한다.
//  · Tab(초점 이동)·Alt 조합(브라우저의 뒤로/앞으로)도 받지 않는다. 그 밖의 키는 격자에 보여 주되, 격자가 **쓴 키일 때만**
//    (기본 동작을 막았다) 초점을 데려온다 — 안 쓰는 키(Shift 만 누름 등)에 초점이 격자로 튀면 Tab 순서가 격자에서 다시 시작한다.
function takesLooseKey(grid: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key === "Tab" || e.altKey) return false;
  if (grid.closest("[inert]")) return false;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) {
    if (active === grid || grid.contains(active)) return false; // 격자 안 — 격자의 onKeyDown 이 이미 받았다
    if (active.contains(grid)) return !isTypingTarget(active); // 격자를 품은 창(폴더 창·결과 창)에 초점
    if (e.key === "Enter" || e.key === " ") return false;
    if (!active.matches("button, a") || !active.closest(".topbar, .lib-toolbar, .select-bar")) return false;
  }
  if (!document.querySelector(".scene-board")) return true;
  const win = grid.closest(".folder-peek, .scene-varwin");
  return !!win && (!active || active === document.body || win.contains(active));
}

/** 초점 잃은 키를 이 격자의 키 처리로 넘긴다(위 주석). onKey 는 격자의 onKeyDown 과 같은 함수. */
export function useLooseKeys(gridRef: RefObject<HTMLElement | null>, onKey: (e: KeyboardEvent) => void): void {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const onLoose = (e: KeyboardEvent) => {
      const grid = gridRef.current;
      if (!grid || e.key === "Escape" || isKeyHandled(e) || backgroundKeysBlocked() || !takesLooseKey(grid, e)) return;
      markKeyHandled(e); // 격자가 둘이어도 한 번만
      const active = document.activeElement;
      onKeyRef.current(e);
      // 격자가 쓴 키일 때만, 그리고 그 키가 초점을 다른 데로 옮기지 않았을 때만(태그 입력을 연 경우 등) 격자로 데려온다.
      if (e.defaultPrevented && document.activeElement === active) grid.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onLoose);
    return () => window.removeEventListener("keydown", onLoose);
  }, [gridRef]);
}

/** 앱이 한 번 거는 키 지킴이 둘 — ① 조합 중 Enter ② 입력칸 밖 Ctrl/⌘+A.
 *  글자 입력칸 밖의 Ctrl/⌘+A 는 브라우저가 화면 글자를 통째로 긁는다 — 언제나 막는다(전체 선택은 격자·보드가 직접 한다).
 *  뒤 화면의 키 처리가 쉬는 동안(위에 창이 떠 있을 때)에도 막아야 한다: 긁힌 글자는 창을 닫아도 남고, 그 위에서 시작한 카드 끌기를
 *  브라우저가 '글자 끌기'로 가로채 끌기가 멈춘다(2026-10-10 재실측 3/3). 앱이 한 번 건다. 재지정과 무관하게 브라우저의 키(A)를 본다. */
export function usePageSelectAllGuard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 조합 중의 Enter(한글 등 — 브라우저가 조합을 확정하는 키)는 앱의 키 처리에 보내지 않는다. 그 키를 'Enter' 로 주는 환경에서는
      //  입력칸의 Enter(저장·확정·제출·칸 벗어나기)가 덜 친 글자로 나간다(입력칸 20여 곳이 e.key === "Enter" 만 본다). 전파만 멈춘다 —
      //  조합 확정이라는 기본 동작은 그대로다. 확정 뒤에 오는 진짜 Enter 는 조합 중이 아니라 통과한다.
      if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) {
        e.stopPropagation();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "a" && !isTypingTarget(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

// ── 누르는 순간 위에 무엇이 떠 있었나 ──
//  위에 창·메뉴가 떠 있을 때의 클릭은 그것의 몫이다(바깥을 눌러 닫는 클릭 포함) — 뒤 화면의 '빈 곳 클릭 = 선택 해제'·범위 선택이
//  받지 않는다. 그런데 닫기는 누름의 **앞쪽**에서 일어난다: 어떤 메뉴는 pointerdown 에, 어떤 것은 mousedown 캡처에 닫혀, 뒤 화면의
//  mousedown 처리가 볼 때는 이미 떠 있지 않다(Codex 코드 리뷰·2026-10-10 재실측: 검토 메뉴·카드 확인 덮개·담기 메뉴의 바깥을 누르면
//  메뉴가 닫히며 선택도 풀렸다). 그래서 누름의 첫 이벤트(pointerdown)의 캡처에서 적어 두고, 뒤 화면의 누름 처리들이 이것을 본다.
let coveredAtPress = false;
let focusByTab = false; // 마지막 초점 이동이 Tab 이었나 — 누르면(pointerdown) 꺼진다
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => { if (e.key === "Tab") focusByTab = true; }, true);
  document.addEventListener("pointerdown", () => { coveredAtPress = backgroundKeysBlocked(); focusByTab = false; }, true);
  const release = () => { coveredAtPress = false; }; // 그 누름의 것만 — 다음 누름으로 넘기지 않는다
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
}

/** 이 누름이 시작될 때(또는 지금) 위에 창·메뉴가 떠 있었나 — 뒤 화면의 mousedown 처리가 첫 줄에서 본다. */
export function pressStartedCovered(): boolean {
  return coveredAtPress || backgroundKeysBlocked();
}

/** 지금의 초점이 Tab 으로 옮겨 온 것인가(마우스로 눌러 남은 초점이 아니라). `:focus-visible` 은 못 쓴다 — 마우스로 누른 단추도 그 뒤에
 *  아무 키(Esc 등)나 누르면 focus-visible 로 바뀐다(2026-10-10 재실측: S 를 마우스로 누르고 Esc 로 닫은 뒤 Space 가 S 를 또 눌렀다). */
export function focusCameByTab(): boolean {
  return focusByTab;
}

/** 마우스로 누른 조작 요소(툴바 슬라이더)가 초점을 쥐고 있지 않게 한다 — `onPointerDown` 에서 부르면 그 누름이 끝날 때 초점을 내려놓는다.
 *  남으면 → 가 격자가 아니라 그 눈금을 바꾸고 Ctrl+A 도 격자에 안 간다(2026-10-10 최종 재실측).
 *  격자를 품은 창(폴더 창·'생성 결과' 창) 안이면 BODY 가 아니라 **그 창**으로 옮긴다 — 캔버스에서는 초점이 BODY 로 떨어지면
 *  r·g·b·d·Ctrl+A·Delete 가 창에 가려진 뒤의 보드로 간다(Codex 코드 리뷰). 창 안의 격자가 아니라 창인 까닭: 타입 눈금을 바꾸면 목록을
 *  다시 받는 동안 격자가 사라져 초점이 다시 BODY 로 떨어진다(캔버스 재실측 7/7 — Delete 에 뒤 보드의 카드가 지워졌다). 창에 초점이면
 *  격자 키는 그 창의 격자가 받는다(useLooseKeys).
 *  놓는 자리가 요소 밖이어도 듣도록 window 에서 본다. Tab 으로 와서 방향키로 조절하는 길은 그대로다(누름이 없다). */
export function dropFocusAfterPress(el: HTMLElement): void {
  const release = () => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    if (document.activeElement !== el) return;
    const win = el.closest<HTMLElement>(".folder-peek, .scene-varwin");
    if (win) win.focus({ preventScroll: true });
    else el.blur();
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

// ── 한글 입력 상태의 글자 키 ──
// 입력기가 켜져 있으면 글자 키의 e.key 가 글자가 아니다 — 윈도는 "Process", 맥·리눅스의 한글 자판은 자모("ㄱ"). 앱의 글자 단축키
// (r·g·b·d·c·h·f·y·…)는 e.key 를 보므로 그런 키에는 하나도 안 먹는다(격리 실측의 흉내로 확인 — 실제 윈도 크롬이 입력칸 밖에서 어느 쪽을
// 보내는지는 재지 못했다. 그래서 어느 쪽이 와도 먹게 한다). 그런 키만 물리 키(e.code = "KeyR")의 글자로 읽게, 이벤트의 key 를 그 글자로
// 덮는다. 손대지 않는 것: 라틴 글자가 온 키(영문 상태·AZERTY 같은 다른 자판 — e.key 가 맞다), 글자 입력칸에서 난 키(조합 중인 글자),
// 글자 키가 아닌 것(숫자·기호·기능 키). 모듈을 읽을 때 window 의 잡는 단계에 건다 — 앱이 effect 에서 거는 키 리스너보다 먼저 돈다.
// keydown 만 덮는다. keyup 에서 글자를 보는 곳은 캔버스의 가위(Y) 하나고 그쪽이 e.code 를 같이 본다 — 입력칸으로 초점이 옮겨 간 뒤의
// keyup 은 여기서 덮이지 않아, 여기에만 기대면 가위가 붙은 채 남는다(Codex 상의).
// 이 코드가 실제로 필요한지는 실기 확인 전이다: 윈도 크롬이 입력칸 밖에서 입력기를 꺼 주면 한 번도 돌지 않는다(해는 없다).
const HANGUL_KEY = /^[ㄱ-ㆎ가-힣ᄀ-ᇿ]$/;
/** 한글 입력 상태로 온 글자 키면 물리 키의 글자(소문자), 아니면 null. */
export function letterFromPhysicalKey(e: { key: string; code?: string; isComposing?: boolean; target?: EventTarget | null }): string | null {
  if (e.key !== "Process" && !HANGUL_KEY.test(e.key)) return null;
  if (e.isComposing || !e.code || !/^Key[A-Z]$/.test(e.code) || isTypingTarget(e.target ?? null)) return null;
  return e.code.slice(3).toLowerCase();
}
if (typeof window !== "undefined") {
  const readPhysicalLetter = (e: KeyboardEvent) => {
    const letter = letterFromPhysicalKey(e);
    if (letter) Object.defineProperty(e, "key", { value: e.shiftKey ? letter.toUpperCase() : letter, configurable: true });
  };
  window.addEventListener("keydown", readPhysicalLetter, true);
}

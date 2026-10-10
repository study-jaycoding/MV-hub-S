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
//  · 안 받는 경우: 격자가 가려져 있다(inert — 폴더 창 뒤의 본 목록) · 캔버스(초점 없는 키는 보드의 것 — 창 자체에 초점일 때만 받는다)
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
  return !document.querySelector(".scene-board");
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
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => { coveredAtPress = backgroundKeysBlocked(); }, true);
  const release = () => { coveredAtPress = false; }; // 그 누름의 것만 — 다음 누름으로 넘기지 않는다
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
}

/** 이 누름이 시작될 때(또는 지금) 위에 창·메뉴가 떠 있었나 — 뒤 화면의 mousedown 처리가 첫 줄에서 본다. */
export function pressStartedCovered(): boolean {
  return coveredAtPress || backgroundKeysBlocked();
}

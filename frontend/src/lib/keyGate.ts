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
//  · 툴바의 태그 패널은 body 에 그려진다(창의 쌓임 맥락을 벗어나려고 — LibraryToolbar). 그 안의 단추에 남은 초점은 패널을 연
//    툴바(와 그 툴바를 품은 창) 안의 초점으로 본다(floatHost).

/** body 로 옮겨 그린 패널(data-float-of) 안의 요소면 그 패널을 연 자리(같은 값의 data-float-owner 를 단 툴바)를, 아니면 요소 자신을
 *  돌려준다. '어디 안에 있나'를 DOM 포함으로 묻는 판정이 쓴다 — 패널은 그려지는 자리만 body 고, 쓰임은 그 툴바의 것이다. 폴더 창 안의
 *  툴바가 연 패널과 창 밖 툴바가 연 패널이 이것으로 갈린다. 주인이 사라졌으면(닫히는 중) 요소 자신. */
export function floatHost(el: HTMLElement): HTMLElement {
  const id = el.closest?.<HTMLElement>("[data-float-of]")?.dataset.floatOf;
  if (!id) return el;
  for (const owner of document.querySelectorAll<HTMLElement>("[data-float-owner]")) if (owner.dataset.floatOwner === id) return owner;
  return el;
}

function takesLooseKey(grid: HTMLElement, e: KeyboardEvent): boolean {
  if (e.key === "Tab" || e.altKey) return false;
  if (grid.closest("[inert]")) return false;
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) {
    if (active === grid || grid.contains(active)) return false; // 격자 안 — 격자의 onKeyDown 이 이미 받았다
    if (active.contains(grid)) return !isTypingTarget(active); // 격자를 품은 창(폴더 창·결과 창)에 초점
    if (e.key === "Enter" || e.key === " ") return false;
    if (!active.matches("button, a") || !floatHost(active).closest(".topbar, .lib-toolbar, .select-bar")) return false;
  }
  if (!document.querySelector(".scene-board")) return true;
  const win = grid.closest(".folder-peek, .scene-varwin");
  return !!win && (!active || active === document.body || win.contains(floatHost(active)));
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

  // ── 기본 조작부를 쓴 뒤의 키 ──
  //  영상·오디오의 기본 조작부(재생·시간 줄·음량…) 안에 초점이 있으면 크롬은 키 이벤트를 페이지로 보내지 않는다 — 잡는 단계에도 안 온다
  //  (2026-10-11 실측: 조작부 6칸 × 8키 48/48 이 0건. 그동안 activeElement 는 그 매체다). 마우스로 조작부를 눌러도 초점이 그 칸으로 가서,
  //  재생 단추를 누른 뒤에는 Esc·방향키가 죽었다(전부터). 조작부의 누름도 페이지에 오지 않아 '조작부를 썼다'는 것은 매체 이벤트로만 안다 →
  //  조작부를 쓴 흔적(재생·일시정지·탐색·음량)이 났고 초점이 그 매체면 초점을 매체 **자체**로 옮긴다(같은 요소에 focus() — 안쪽 초점이
  //  요소로 돌아와 키가 다시 온다). 시간 줄·음량을 끄는 도중에 불려도 끌기는 끊기지 않는다(실측: 걸음마다의 값이 같다).
  //   · 시간 줄·음량을 만진 뒤의 방향키는 브라우저의 미세 이동이 아니라 **창의 키**가 된다(크게 보기의 ←/→ = 앞·뒤 장, Space = 재생,
  //     Esc = 닫기 — 창이 약속한 키가 조작부를 만진 뒤에 죽는 것이 결함이다). 속도(ratechange)에는 걸지 않는다 — 더보기 메뉴에서
  //     고른 뒤에는 초점이 스스로 풀린다.
  //   · 반복 재생이 **도는 중에** 처음으로 돌아가는 탐색은 사용자의 조작이 아니다 — 그때 옮기면 조작부에서 연 메뉴(더보기)가 닫힌다.
  //     멈춘 영상의 처음 언저리 탐색은 조작이다(크게 보기의 영상은 늘 loop 라, 멈춤을 안 보면 그 탐색 뒤의 Esc 가 다시 죽는다).
  //     시간값만으로 둘을 완전히 가를 수는 없다 — 도는 중에 사용자가 0.25초 안으로 옮긴 탐색은 놓친다(크롬은 끄는 동안 영상을 멈추므로 드물다).
  //   · 키보드로 조작부를 쓰는 중(마지막으로 본 초점 이동이 Tab)이면 둔다 — 초점을 빼면 다음 키가 엉뚱한 곳으로 간다.
  //     남는 구멍: Tab 을 누른 뒤 마우스로 조작부를 누르면 옮기지 못한다(조작부 위의 누름이 페이지에 오지 않아 Tab 기록이 안 꺼진다).
  //     매체 위의 마우스 움직임으로 가르지 않는다 — 움직임은 누를 뜻이 아니고, 키보드로 쓰는 중에 스친 마우스가 보호를 풀게 된다(Codex 리뷰).
  //   · 전체화면·PIP 중에는 건드리지 않는다.
  const LOOP_WRAP_SECONDS = 0.25; // 반복 재생의 되감기는 0초 언저리에 내린다 — 이보다 앞의 탐색은 되감기로 본다
  const focusMediaItself = (e: Event) => {
    const media = e.target;
    if (!(media instanceof HTMLMediaElement) || !media.controls || document.activeElement !== media) return;
    if (focusByTab) return;
    if (document.fullscreenElement || document.pictureInPictureElement) return;
    if (e.type === "seeked" && media.loop && !media.paused && media.currentTime < LOOP_WRAP_SECONDS) return;
    media.focus({ preventScroll: true });
  };
  for (const type of ["play", "pause", "seeked", "volumechange"]) document.addEventListener(type, focusMediaItself, true);
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

// ── 모달의 초점 ──
//  막이 있는 창(모달)이 떠 있어도 Tab 은 뒤 화면으로 나갔고, 그 자리의 Enter·Space 가 뒤 단추를 눌렀다(2026-10-11 실측: 정보·비교·관리자·
//  설정·단축키 창. 정보·비교·관리자 창은 연 직후의 초점부터 뒤에 있었다). 모달이 자기 영역(뿌리 요소)을 여기에 올리면(useModalFocus)
//  **맨 위 모달**(겹 번호가 가장 큰 것) 하나에 대해:
//   ① 열릴 때 초점이 영역 밖이면 **뿌리**로 옮긴다. 첫 단추가 아니라 뿌리다 — 연 직후의 Enter·Space 가 아무 단추도 누르지 않게
//      (정보 창의 첫 단추는 '부분 수정', 크게 보기의 Space 는 재생이다). 창이 스스로 초점을 준 칸(autoFocus)이 있으면 그대로 둔다.
//   ② Tab·Shift+Tab 은 영역의 끝에서 반대쪽 끝으로 돈다. 초점이 영역 밖에 있으면 안으로 들인다. 영역 안에서의 이동은 브라우저에
//      맡긴다(영상 조작부·날짜 칸처럼 요소 안에서 도는 Tab 이 제 순서대로 간다). 맡긴 Tab 이 초점을 영역 밖에 내려놓으면
//      focusin 에서 되돌린다 — 끝 자리를 잘못 짚은 경우의 보루다(아래 returnStrayTab).
//   ③ 닫힐 때 열기 전의 자리로 돌려준다 — 그 자리가 문서에 붙어 있고 inert 가 아니고 보일 때만. 아니면 둔다(초점 잃은 키는 위 useLooseKeys).
//  뒤 화면에 inert 를 걸지 않는다 — 뒤 화면이 한 덩이가 아니다(선택 막대·코멘트 패널·알림이 따로 뜬다).
//  조합 중(한글)의 Tab 도 같은 규칙이다: 끝에서 초점을 옮기면 브라우저가 조합을 확정한다. 입력기가 삼켜 key 가 "Process" 로 온
//  Tab 은 알아볼 수 없어 지나간다 — 그렇게 밖으로 나간 초점은 다음 Tab 에 안으로 돌아온다.
type ModalRoots = () => Array<HTMLElement | null | undefined>;
interface ModalRegion { seq: number; roots: ModalRoots }
const modals = new Map<object, ModalRegion>(); // 떠 있는 모달 → 겹 번호(lib/useEscapeClose 와 같은 줄)·뿌리들

function topModal(): ModalRegion | null {
  let top: ModalRegion | null = null;
  for (const modal of modals.values()) if (!top || modal.seq > top.seq) top = modal;
  return top;
}
const rootsOf = (modal: ModalRegion): HTMLElement[] => modal.roots().filter((root): root is HTMLElement => !!root);
// 보이는지는 브라우저에 묻는다 — 없는 환경(jsdom)에서는 보이는 것으로 친다.
const shown = (el: HTMLElement): boolean => typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true });

const TAB_STOP = "a[href], button, input:not([type=hidden]), select, textarea, summary, video[controls], audio[controls], [tabindex], [contenteditable]";
// 조작부가 있는 영상·오디오 — 그 자체가 Tab 자리이고, 안쪽 조작부(재생·탐색·음량)를 Tab 으로 도는 동안 초점(activeElement)은 줄곧 그 요소다.
const MEDIA = "video[controls], audio[controls]";
// ponytail: 영역의 양 끝 자리만 찾는다(Tab 마다 영역 전체를 거르지 않는다 — 크게 보기는 아주 자주 열리고 관리자 창은 칸이 수백이다).
//  라디오 묶음·tabindex 양수의 순서는 보지 않는다 — 모달의 끝에 그런 것이 놓이면 여기서 다룬다.
function edgeStop(root: HTMLElement, last: boolean): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(TAB_STOP);
  for (let i = last ? all.length - 1 : 0; i >= 0 && i < all.length; i += last ? -1 : 1) {
    const el = all[i];
    // 매체는 tabIndex 읽기에 기대지 않는다 — 환경마다 다르게 읽힌다(jsdom 은 -1). 그 값으로 거르면 매체 앞의 단추가 끝 자리가 되어
    //  Tab 이 매체에 닿지 못한다(2026-10-11 Codex 리뷰). 스스로 tabindex="-1" 을 단 것만 뺀다.
    const stop = el.matches(MEDIA) ? el.getAttribute("tabindex") !== "-1" : el.tabIndex >= 0;
    if (stop && !el.matches(":disabled") && !el.closest("[inert]") && shown(el)) return el;
  }
  return null;
}

function focusRoot(root: HTMLElement): void {
  if (!root.hasAttribute("tabindex")) {
    root.tabIndex = -1;
    root.style.outline = "none"; // 뿌리는 조작 요소가 아니다 — 창 둘레에 초점 테두리를 그리지 않는다
  }
  root.focus({ preventScroll: true });
}

/** 영역의 다음 자리로. at = 초점이 있던 뿌리(밖이면 -1). 앞으로면 다음 뿌리의 첫 자리, 뒤로면 앞 뿌리의 끝 자리 — 뿌리가 하나면 제 반대쪽 끝이다. */
function focusNextStop(roots: HTMLElement[], at: number, back: boolean): void {
  const from = at >= 0 ? at : back ? 0 : -1;
  for (let step = 1; step <= roots.length; step++) {
    const stop = edgeStop(roots[(((from + (back ? -step : step)) % roots.length) + roots.length) % roots.length], back);
    if (stop) {
      stop.focus();
      return;
    }
  }
  if (at < 0) focusRoot(roots[0]); // 설 자리가 하나도 없는 창 — 뿌리에 둔다
}

// 방금 브라우저에 맡긴 Tab — 그 Tab 의 **기본 이동 한 번**(그 keydown 직후의 첫 focusin)이 이 뿌리들 밖이면 되돌린다(returnStrayTab).
//  기록은 그 이동에만 쓴다. 문서의 초점이 안 움직이는 Tab(영상의 안쪽 조작부)도 있어, 남겨 두면 그 뒤에 프로그램이 옮긴 초점(새로 뜬
//  창의 뿌리·autoFocus)을 '밖으로 나간 Tab'으로 보고 이전 창으로 끌고 갔다(2026-10-11 Codex 재검토). 그래서
//   · 그 키와 같은 작업이 끝나면 지운다 — 브라우저의 기본 이동은 keydown 전달 직후, 같은 작업 안에서 일어난다
//   · 그때의 맨 위 모달과 겹 번호를 같이 적는다 — 그사이 무엇이 새로 떴거나(번호가 늘었다) 그 모달이 닫혔으면 무효다
//   · 키가 아직 전달되는 중(event.eventPhase)의 초점 이동은 같은 키를 듣는 다른 리스너가 옮긴 것이다 — 무효다
let handedTab: { event: KeyboardEvent; modal: ModalRegion; seq: number; roots: HTMLElement[]; back: boolean } | null = null;

function keepTabInModal(e: KeyboardEvent): void {
  handedTab = null;
  if (e.key !== "Tab") return;
  focusByTab = true; // 창이 이 키의 전파를 막아도(비교 창의 잡는 단계 리스너) 'Tab 으로 온 초점'은 적힌다
  if (e.ctrlKey || e.metaKey || e.altKey) return; // 브라우저의 탭 전환
  const top = topModal();
  if (!top) return;
  let roots = rootsOf(top);
  if (!roots.length) return;
  const active = document.activeElement as HTMLElement | null;
  // 초점이 다른 모달 대화상자(aria-modal) 안에 있다 — 영역 밖의 것(업데이트 진행 덮개)은 스스로 가두니 손대지 않고,
  //  영역 안의 것(관리자 창 안의 동시 수정 확인 등)은 그 대화상자 안에서 돈다. 뿌리 자신이거나 뿌리를 감싼 겉 요소면 이 영역이다.
  const dialog = active?.closest<HTMLElement>('[aria-modal="true"]');
  if (dialog && !roots.some((root) => dialog.contains(root))) {
    if (!roots.some((root) => root.contains(dialog))) return;
    roots = [dialog];
  }
  const back = e.shiftKey;
  const at = roots.findIndex((root) => root.contains(active));
  if (active && at >= 0) {
    // 이 뿌리 안에 더 갈 자리가 남았으면(초점이 끝 자리보다 앞이면) 브라우저에 맡긴다. 뿌리 자체에 놓인 초점은 첫 자리보다 앞이다.
    //  매체에 놓인 초점은 늘 맡긴다 — 안쪽 조작부를 다 돌았는지 여기서는 알 수 없다(끝 자리로 보고 돌리면 조작부에 Tab 이 닿지 못한다).
    const edge = edgeStop(roots[at], !back);
    const past = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    if (active.matches(MEDIA) || (edge && active !== edge && !(edge.compareDocumentPosition(active) & past))) {
      const handed = (handedTab = { event: e, modal: top, seq: lastSeq, roots, back });
      setTimeout(() => { if (handedTab === handed) handedTab = null; }, 0);
      return;
    }
  }
  // 끝에서(또는 영역 밖에서) 가로챈다.
  e.preventDefault();
  focusNextStop(roots, at, back);
}

/** 브라우저에 맡긴 Tab 의 뒤처리 — 그 Tab 이 초점을 영역 밖에 내려놓았으면 안으로 되돌린다(앞으로면 첫 자리, 뒤로면 끝 자리).
 *  매체의 조작부 끝에서 나간 Tab, 그리고 위에서 끝 자리를 잘못 짚은 모든 경우(라디오 묶음·tabindex 양수 …)의 보루다.
 *  Tab 이 아닌 이동(누름·프로그램이 준 초점)은 건드리지 않는다. 영역 밖의 다른 모달 대화상자(aria-modal)에 내려앉은 초점은 그쪽 몫이다. */
function returnStrayTab(e: FocusEvent): void {
  const handed = handedTab;
  handedTab = null; // 첫 focusin 한 번에만 쓴다
  const target = e.target as HTMLElement | null;
  if (!handed || !target) return;
  // 그 Tab 의 기본 이동인가(위 handedTab 주석) — 키 전달이 끝난 뒤이고, 그사이 새로 뜬 것이 없고, 그 모달이 아직 맨 위일 때만.
  if (handed.event.eventPhase !== Event.NONE || handed.seq !== lastSeq || handed.modal !== topModal()) return;
  if (handed.roots.some((root) => root.contains(target))) return;
  const dialog = target.closest?.('[aria-modal="true"]');
  if (dialog && !rootsOf(handed.modal).some((root) => root.contains(dialog) || dialog.contains(root))) return; // 맨 위 영역 밖의 모달 대화상자
  focusNextStop(handed.roots, -1, handed.back);
}

// ── 뿌리에 놓인 초점의 스크롤 키 ──
//  창을 연 직후 초점은 뿌리에 있다(위 ①). 그때의 Space·PageUp/Down·Home/End·방향키에 브라우저는 뿌리의 **조상**을 스크롤한다 —
//  분리 관리 창의 본문, 관리자 창의 본문처럼 창 뒤의 화면이다. 전엔 초점이 뒤 격자에 남아 있어 격자가 막았지만(ThumbnailGrid) 이제
//  그 키는 격자에 닿지 않는다. 뿌리가 스스로 스크롤하는 창(설정 창)은 그 창이 스크롤하니 둔다. 창 안의 단추·입력칸에 놓인 초점의
//  키(Space = 그 단추 누르기)와 창이 window 에서 직접 쓰는 키(크게 보기의 Space = 재생)는 그대로다 — 기본 동작만 막는다.
const SCROLL_KEYS = new Set([" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
function holdScrollOnModalRoot(e: KeyboardEvent): void {
  if (!SCROLL_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
  const top = topModal();
  const root = top && rootsOf(top).find((item) => item === e.target); // 뿌리 자체에서 난 키만 — 창 안의 단추·입력칸에서 난 키는 그것의 것이다
  if (!root) return;
  if (root.scrollHeight > root.clientHeight && /auto|scroll/.test(getComputedStyle(root).overflowY)) return;
  e.preventDefault();
}

// ── 모달 안의 휠(가운데) 누름 ──
//  스크롤되는 곳을 가운데 단추로 누르면 브라우저가 자동 스크롤 모드에 들어간다. 그 모드에서 누른 키는 모드를 푸는 데 쓰이고 페이지에는
//  오지 않는다 — 창을 닫으려면 Esc 를 두 번 눌러야 했다(2026-10-11 실측: 비교 창의 그림, 5/5. 모드가 키를 가져간다는 것은 추정).
//  맨 위 모달 안에서는 그 기본 동작을 막는다 — 격자·카드가 이미 하는 것과 같다(ThumbnailGrid). 전파는 막지 않는다: 휠 클릭의 기능
//  (auxclick — 카드의 정보 창 등)은 그대로 돈다. 모달이 아닌 곳(보드의 휠 끌기 등)은 손대지 않는다.
function blockAutoscrollInModal(e: MouseEvent): void {
  if (e.button !== 1) return;
  const top = topModal();
  if (top && rootsOf(top).some((root) => root.contains(e.target as Node | null))) e.preventDefault();
}
// window 의 잡는 단계, 모듈을 읽을 때 건다 — 창들이 effect 에서 거는 키 리스너보다 먼저 돈다(비교 창은 잡는 단계에서 전파를 막는다).
if (typeof window !== "undefined") {
  window.addEventListener("keydown", keepTabInModal, true);
  window.addEventListener("focusin", returnStrayTab, true);
  window.addEventListener("keydown", holdScrollOnModalRoot, true);
  window.addEventListener("mousedown", blockAutoscrollInModal, true);
}

/** 이 모달이 맨 위이고 초점이 그 영역 밖(BODY 포함)이면 뿌리로 옮긴다(위 ①). */
export function focusModal(token: object): void {
  const top = topModal();
  if (!top || top !== modals.get(token)) return;
  const roots = rootsOf(top);
  if (roots.length && !roots.some((root) => root.contains(document.activeElement))) focusRoot(roots[0]);
}

/** keep = 같은 창의 effect 가 다시 돌기 직전에 영역 안에서 초점이 있던 자리(useModalFocus) — 붙어 있으면 뿌리 대신 그 자리로 돌려준다. */
export function openModal(token: object, seq: number, roots: ModalRoots, keep: Element | null = null): void {
  const modal = { seq, roots };
  modals.set(token, modal);
  if (keep instanceof HTMLElement && topModal() === modal) keep.focus({ preventScroll: true }); // 그사이 사라진 자리면 아무 일도 없다 — 아래에서 뿌리로
  focusModal(token);
}

/** from = 열기 전에 초점이 있던 자리(위 ③). */
export function closeModal(token: object, from: Element | null): void {
  const closing = modals.get(token);
  modals.delete(token);
  if (!closing) return;
  // 초점이 이 창 안에 있었을 때만 돌려준다(창과 함께 사라진 초점은 BODY 에 있다) — 닫히는 사이 다른 데로 간 초점은 뺏지 않는다.
  const active = document.activeElement;
  if (active && active !== document.body && !rootsOf(closing).some((root) => root.contains(active))) return;
  // 아래에 모달이 남아 있으면 그 영역 안의 자리로만 돌려준다 — 초점을 모달 뒤에 놓지 않는다.
  const below = topModal();
  const belowRoots = below ? rootsOf(below) : [];
  const back = from instanceof HTMLElement && from !== document.body && from.isConnected && !from.closest("[inert]") && shown(from)
    && (!below || belowRoots.some((root) => root.contains(from))) ? from : null;
  if (back) back.focus({ preventScroll: true });
  else if (belowRoots.length) focusRoot(belowRoots[0]);
}

/** 모달 창이 자기 영역을 올린다(위 '모달의 초점'). root = 뿌리 요소의 ref — 한 조작 영역이 여러 뿌리면(설정 창 + 옆 패널) 그것들을
 *  돌려주는 함수. 늘 마운트돼 있는 컴포넌트는 open 에 열림 상태를 넘긴다(useEscapeClose 와 같다).
 *  돌려주는 함수 = '맨 위 모달이면 초점을 영역으로' — 뿌리 요소가 통째로 바뀐 뒤(지연 로딩 창의 빈 틀 → 본문)에 부른다. */
export function useModalFocus(root: RefObject<HTMLElement | null> | ModalRoots, open = true): () => void {
  const rootRef = useRef(root);
  rootRef.current = root;
  const token = useRef({}).current;
  const seqRef = useRef<number | null>(null);
  const fromRef = useRef<Element | null>(null);
  // 개발 화면(StrictMode)은 처음 뜬 창의 effect 를 한 번 걷었다가 다시 돌린다 — 걷을 때 초점을 연 자리로 돌려주니, 다시 돌 때는
  //  영역 밖에 있는 초점을 뿌리로 옮겨 창이 스스로 준 초점(autoFocus — React 는 다시 주지 않는다)이 사라졌다(폴더 등록 창을 열고 바로
  //  친 글자가 안 들어갔다). 걷기 직전에 영역 안에 있던 초점을 그때의 번호와 함께 적어 두었다가, **같은 번호로** 다시 돌 때만 돌려준다 —
  //  정말 닫았다가 다시 연 창은 번호를 새로 받으니 뿌리에서 시작한다.
  const keepRef = useRef<{ seq: number | null; at: Element } | null>(null);
  if (!open) seqRef.current = null;
  else if (seqRef.current === null) {
    seqRef.current = nextLayerSeq(); // 켜지는 렌더에서 받는다 — 같은 렌더에서 켜진 Esc 겹과 위아래가 같다(lib/useEscapeClose)
    fromRef.current = document.activeElement; // 열기 전의 자리. effect 에서 읽으면 늦다 — 창의 autoFocus 가 이미 초점을 옮겼다
  }
  useEffect(() => {
    if (!open) return;
    const from = fromRef.current;
    const roots: ModalRoots = () => {
      const source = rootRef.current;
      return typeof source === "function" ? source() : [source.current];
    };
    const kept = keepRef.current;
    openModal(token, seqRef.current ?? nextLayerSeq(), roots, kept && kept.seq === seqRef.current ? kept.at : null);
    return () => {
      const active = document.activeElement;
      keepRef.current = active && roots().some((root) => root?.contains(active)) ? { seq: seqRef.current, at: active } : null;
      closeModal(token, from);
    };
  }, [open, token]);
  return useRef(() => focusModal(token)).current;
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

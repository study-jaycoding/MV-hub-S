import { backgroundKeysBlocked } from "../../lib/keyGate";
import { markKeyHandled } from "../../lib/keyHandled";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { holdUnload } from "../../lib/unloadGuard";
import {
  claimCommentPip, commentPipSupported, openCommentPip, prefersCommentPip, releaseCommentPip, returnCommentPip, useCommentPipWindow,
} from "../../lib/commentPip";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";
import { buildCommentTree } from "../../lib/commentTree";
import { COMMENT_HIGHLIGHT_EVENT, takeCommentHighlightRequest, type CommentHighlight } from "../../lib/commentHighlight";
import { fmtWhen } from "../../lib/format";
import { loadString } from "../../lib/storage";
import { MediaThumbnail } from "../MediaThumbnail";

// 코멘트 본문 글씨 크기(px) — 사용자별 localStorage 저장, 패널마다 공통 적용.
const FS_KEY = "ch.cmt.fontPx";
const FS_MIN = 11;
const FS_MAX = 24;
const FS_DEF = 13;
function loadFontPx(): number {
  const v = Number(loadString(FS_KEY)); // 저장소 접근이 막힌 환경(사이트 데이터 차단 등)에서도 렌더가 죽지 않게
  return v >= FS_MIN && v <= FS_MAX ? v : FS_DEF;
}

// 비공개 작성 상태·같이 보기 — 패널 공통(에셋·생성), localStorage 로 유지.
//  같이 보기 기본 켬: 방금 쓴 비공개가 바로 안 보이면 "전송이 안 됐나?" 로 읽힌다.
const PRIV_KEY = "ch.cmt.private"; // 다음 코멘트를 비공개로 쓸지
const SHOW_KEY = "ch.cmt.showPrivate"; // 목록에 내 비공개를 섞어 보여줄지
const loadFlag = (key: string, def: boolean): boolean => {
  let v: string | null = null;
  try {
    v = localStorage.getItem(key);
  } catch {
    /* localStorage 불가 환경 → 기본값 */
  }
  return v === null ? def : v === "1";
};
const saveFlag = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* localStorage 불가 환경 무시 */
  }
};

// 입력칸 안 아이콘(Jay 11-09 시안 C) — 편집 = 펜, 전송 = 종이비행기
const PEN_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const SEND_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" />
  </svg>
);

// 창 밖으로(네모에서 오른쪽 위로 나가는 화살표) · 앱 안으로(네모로 들어오는 화살표) — Jay 11-10 떠 있는 창
const PIP_OUT_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);
const PIP_IN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 14H4v6" /><path d="M4 20l8-8" /><path d="M14 4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5" />
  </svg>
);

// 그림 창 오른쪽 칸의 새 코멘트 입력 — 글·비공개 체크·보내는 중의 주인은 그림 창 하나다(설계 어셋코멘트그림 §4).
//  보내면 그린 그림이 그 코멘트에 붙는다. 답글·수정은 이 패널의 onSend·onEdit(지금 경로) 그대로.
export interface CommentComposer {
  text: string;
  setText: (text: string) => void;
  writePrivate: boolean;
  setWritePrivate: (on: boolean) => void;
  sending: boolean;
  canSend: boolean;
  onSubmit: () => void;
}

// 떠 있는 창 왼쪽 썸네일 칸(Jay 11-09 시안 C-2) — 어떤 생성물·파일의 코멘트인지 보인다. 누르면 크게 보기, 마우스를 올리면 title(프롬프트·파일 이름)
export interface CommentMedia {
  thumb: string | null;
  type: "image" | "video" | "audio";
  title: string;
  onOpen?: () => void;
  videoUrl?: string; // 영상 원본 — 생성 카드처럼 포스터를 깔고 마우스를 올리면 재생(Jay 11-09)
}

export interface CommentPanelItem {
  id: string;
  author: string;
  author_name: string | null;
  text: string;
  created_at: string;
  parent_id: string | null;
  unread?: boolean;
  private?: boolean; // 비공개 — 팀 공유 스레드·발행·통계에는 안 보임(글씨색 구분)
}

export function CommentPanel<T extends CommentPanelItem>({
  comments,
  label,
  myId,
  panelRef,
  pos,
  size,
  fallbackPos = { x: 240, y: 160 },
  onHeadMouseDown,
  onClose,
  onSend,
  onEdit,
  onDelete,
  onSeen,
  targetKey,
  onUnsentChange,
  embedded = false,
  renderExtra,
  composer,
  allowPrivate = true,
  onEditDraw,
  media,
  pipId,
}: {
  comments: T[];
  label: string;
  myId: string;
  panelRef: Ref<HTMLDivElement>; // useFloatingPanel 의 콜백 ref — 리마운트 감지용
  pos: { x: number; y: number } | null;
  size?: { w: number; h: number } | null;
  fallbackPos?: { x: number; y: number };
  onHeadMouseDown: (e: ReactMouseEvent, fallback?: { x: number; y: number }) => void;
  onClose: () => void;
  // 둘 다 '저장됐는가'를 돌려준다 — 저장된 뒤에야 입력을 비우고 칸을 닫는다(실패하면 쓴 글이 남는다)
  onSend: (text: string, parentId: string | null | undefined, isPrivate: boolean) => Promise<boolean>;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onSeen?: (comment: T) => void;
  // 패널이 보고 있는 대상 — 패널을 다시 만들지 않고 대상만 바꾸는 쪽(생성물 패널은 고른 카드를 따라간다)이 준다
  targetKey?: string;
  // 보내지 않은 글이 생기거나 없어질 때 — 패널을 대상마다 다시 만드는 쪽(Assets)이 대상을 바꾸기 전에 묻는다(Jay 결정 5A)
  onUnsentChange?: (unsent: boolean) => void;
  // 끼워 쓰기(코멘트 그림 창의 오른쪽 '지난 코멘트') — 떠 있는 창의 자리·끌기·닫기·아래 입력칸 없이 목록만(답글·수정·삭제는 그대로)
  embedded?: boolean;
  // 글 아래 덧붙일 것(코멘트의 그림 줄)
  renderExtra?: (comment: T) => ReactNode;
  // 끼워 쓰기의 새 코멘트 입력(그림 창이 쥔다) — 있으면 목록 아래에 한 줄 입력·[전송]·비공개 쓰기를 그린다
  composer?: CommentComposer;
  // 비공개를 쓸 수 있나 — 서버 직결 화면은 거짓: 새 글·답글 모두 저장된 선택과 상관없이 공개로 보낸다(Codex 4차 P2)
  allowPrivate?: boolean;
  // 작은 창의 [편집](입력칸과 [전송] 사이) — 쓰던 글을 넘기고 그림 창을 연다. 넘겼으면 참(그때 입력칸을 비운다)
  onEditDraw?: (text: string) => boolean;
  // 왼쪽 썸네일 칸 — 떠 있는 창에만. 있으면 머리줄의 label 글자는 빼고 썸네일의 title 로 보인다
  media?: CommentMedia | null;
  // [창 밖으로] 묶음 — 주면 떠 있는 창(lib/commentPip)으로 옮길 수 있다. 같은 묶음의 새 패널이 그 창을 이어받는다(Assets 는 파일마다 새 패널)
  pipId?: string;
}) {
  const showMedia = !embedded && !!media;
  // 떠 있는 창(Jay 11-10) — 그 창의 문서에 같은 부품을 그린다. 입력칸이 글을 쥐고 있어(state 아님) 옮길 때 글을 들고 간다(draftRef)
  const canPip = !embedded && !!pipId && commentPipSupported();
  const pipWin = useCommentPipWindow(canPip ? pipId : undefined);
  const pipWinRef = useRef(pipWin);
  pipWinRef.current = pipWin;
  const panelDoc = () => pipWinRef.current?.document ?? document;
  const draftRef = useRef<Record<string, string>>({});
  // 영상 썸네일 — 생성 카드와 같다(GenerationCard onEnter/onLeave): 올리면 무음 재생, 떼면 멈추고 처음으로
  const mediaVideoRef = useRef<HTMLVideoElement>(null);
  const playMedia = () => {
    const video = mediaVideoRef.current;
    if (!video) return;
    video.muted = true; // React 의 muted 속성은 DOM 프로퍼티로 안 붙는다 — 재생 직전에 강제(카드와 같다)
    Promise.resolve(video.play()).catch(() => {});
  };
  const stopMedia = () => {
    const video = mediaVideoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  };
  // 크게 보기 위에서 열었으면(어셋 Ctrl 카드 C) 그 위 겹에 띄운다 — 열 때 한 번만 본다(먼저 연 창은 나중에 연 크게 보기 아래 그대로, 11-09 Jay)
  const [overPreview] = useState(() => !embedded && !!document.querySelector(".media-preview"));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  // 답글·수정 칸을 연 회차 — 보내는 중 칸의 열쇠에 넣는다. 창 옮기기는 회차를 잇고, 닫았다 다시 연 칸은 같은 코멘트라도 새 회차다(독립 리뷰 M1 재확인).
  //  이미 열린 칸의 단추를 다시 눌러서는 올리지 않는다 — 같은 입력칸의 열쇠만 바뀌어 창을 옮기면 잠금을 못 이어받았다(독립 리뷰 M2)
  const [openRound, setOpenRound] = useState(0);
  const [fontPx, setFontPx] = useState<number>(loadFontPx);
  // 비공개로 쓰기 + 같이 보기(내 비공개를 목록에 섞어 표시) — 패널 공통 설정.
  const [writePrivate, setWritePrivate] = useState<boolean>(() => loadFlag(PRIV_KEY, false));
  const [showPrivate, setShowPrivate] = useState<boolean>(() => loadFlag(SHOW_KEY, true));
  const togglePrivate = () => setWritePrivate((v) => (saveFlag(PRIV_KEY, !v), !v));
  const toggleShow = () => setShowPrivate((v) => (saveFlag(SHOW_KEY, !v), !v));
  const setFs = (px: number) => {
    const n = Math.max(FS_MIN, Math.min(FS_MAX, px));
    setFontPx(n);
    try {
      localStorage.setItem(FS_KEY, String(n));
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  };
  // 같이 보기 끔 = 팀이 보는 그대로(공유만). 켬 = 내 비공개를 시간순으로 섞어 표시.
  const visible = useMemo(
    () => (showPrivate ? comments : comments.filter((c) => !c.private)),
    [comments, showPrivate],
  );
  const { byId, roots, descendantsOf } = useMemo(
    () => buildCommentTree(visible),
    [visible],
  );
  // 수정·삭제 잠금 판정은 '같이 보기'로 숨긴 비공개 답글까지 포함한 전체 목록 기준 —
  // 표시 목록(visible)으로 판정하면 숨겨둔 내 비공개 답글이 있는 부모를 지울 수 있게 되고,
  // 공유 부모는 서버에서 지워지는데 비공개 답글은 로컬에 남아 부모 없는 고아가 된다(적대 리뷰 P2).
  const fullTree = useMemo(() => buildCommentTree(comments), [comments]);

  // Slack 알림 링크로 열고 온 코멘트 — 그 코멘트로 스크롤하고 연두 배경이 3번 깜빡인 뒤 멈춘다(Jay 2026-11-05 시안 v4).
  //  열기 요청이 창보다 먼저 올 수 있어 코멘트를 그릴 때마다 가져갈 것이 있는지 본다(lib/commentHighlight).
  const holdName = `comment:${useId()}`;
  const [flash, setFlash] = useState<CommentHighlight | null>(null);
  useEffect(() => {
    const take = () => {
      const request = takeCommentHighlightRequest(visible.map((c) => c.id));
      if (request) setFlash(request);
    };
    take();
    window.addEventListener(COMMENT_HIGHLIGHT_EVENT, take);
    return () => window.removeEventListener(COMMENT_HIGHLIGHT_EVENT, take);
  }, [visible]);
  useEffect(() => {
    if (!flash) return;
    const panel = panelDoc().querySelector(`[data-cmt-hold="${CSS.escape(holdName)}"]`);
    const row = panel?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(flash.id)}"]`);
    if (row) {
      // Restart even for the same comment, without remounting its unsaved input.
      row.style.animation = 'none';
      void row.offsetWidth;
      row.style.removeProperty('animation');
      row.scrollIntoView({ block: "center" });
    }
    const timer = window.setTimeout(() => setFlash(null), 2000); // 깜빡임(0.6초 × 3) 뒤 강조를 걷는다
    return () => window.clearTimeout(timer);
  }, [flash, holdName]);

  // 쓴 글은 **저장된 뒤에** 비운다(조작 규칙 41). 전엔 보내자마자 입력을 비우고 답글·수정 칸을 닫아, 서버가 실패하면 "전송 실패"만 뜨고
  //  쓴 글이 사라졌다 — 다시 시도하려면 다시 써야 했다. 보내는 동안은 그 칸을 읽기 전용으로 두고 다시 보내지 않는다(전엔 바로 비우는 것이
  //  Enter 연타를 막았다). 성공하면 비우고 done(답글·수정 칸 닫기), 실패하면 글과 칸을 그대로 둔다.
  const sendingRef = useRef(new WeakSet<HTMLInputElement>());
  // 보내는 중인 칸(새 글 c · 답글 r:<코멘트> · 수정 e:<코멘트>) → 그 칸을 지금 그린 입력 요소. 떠 있는 창 ↔ 앱 안 옮기기는 입력 요소를
  //  새로 만들고 글만 옮겨, 요소 단위 잠금만으로는 이어지지 않았다 — 옮긴 칸에서 다시 보내 같은 코멘트가 두 번 저장되고 보낸 글이 남았다
  //  (배포 전 리뷰 L4-02). 답글·수정은 어느 코멘트의 칸인지까지 본다 — 이름만 보면 A 답글을 보내는 사이 닫고 연 B 답글 칸을 이어받은 칸으로
  //  잘못 보아 A 가 끝날 때 B 초안을 지웠다(독립 리뷰 M1).
  const sendingFieldRef = useRef(new Map<string, HTMLInputElement>());
  const fieldKey = (input: HTMLInputElement) => input.dataset.cmtKey || input.name;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  // 보내지 못한 글이 있는 동안 창을 닫거나 새로고침하면 브라우저가 묻는다(Jay 결정 6A, 10-15) — 새 글·답글은 비어 있지 않으면, 고치는 글은
  //  원문(data-original)과 달라졌으면. 입력칸이 글을 쥐고 있어(state 가 아니다) 칠 때·그린 뒤·보낸 뒤에 이 패널의 칸들을 다시 센다.
  const syncUnsent = () => {
    const panel = panelDoc().querySelector(`[data-cmt-hold="${holdName}"]`);
    // 사라진 패널(늦게 끝난 전송)은 부모에게 알리지 않는다 — 그사이 다음 파일의 패널이 알린 '보내지 않은 글 있음'을 지웠다(Codex 5A 리뷰)
    if (!panel) {
      holdUnload(holdName, false);
      return;
    }
    const inputs = [...panel.querySelectorAll<HTMLInputElement>('input[name="c"], input[name="r"], input[name="e"]')];
    draftRef.current = Object.fromEntries(inputs.map((input) => [input.name, input.value])); // 떠 있는 창 ↔ 앱 안으로 옮길 때 들고 갈 글
    // 고치는 칸(data-original 있음)은 다 지운 것도 고친 것이다
    const unsent = inputs.some((input) => input.dataset.original !== undefined ? input.value !== input.dataset.original : input.value.trim() !== "");
    holdUnload(holdName, unsent);
    onUnsentChange?.(unsent);
  };
  useEffect(syncUnsent); // 답글·수정 칸이 열리고 닫힐 때(그린 뒤)
  useEffect(() => () => {
    holdUnload(holdName, false);
    onUnsentChange?.(false);
  }, [holdName, onUnsentChange]);
  // 떠 있는 창 ↔ 앱 안으로 옮겨 그린 직후 — 쓰던 글을 새 칸에 넣는다. 위 syncUnsent(그린 뒤 효과)가 빈 새 칸을 읽기 전에(layout)
  const placedRef = useRef<Window | null>(pipWin);
  useLayoutEffect(() => {
    if (placedRef.current === pipWin) return;
    placedRef.current = pipWin;
    const panel = (pipWin?.document ?? document).querySelector(`[data-cmt-hold="${holdName}"]`);
    panel?.querySelectorAll<HTMLInputElement>('input[name="c"], input[name="r"], input[name="e"]').forEach((input) => {
      const kept = draftRef.current[input.name];
      if (kept !== undefined) input.value = kept;
      if (sendingFieldRef.current.has(fieldKey(input))) { // 보내는 중에 옮겼다 — 새 칸이 그 전송을 이어받는다(잠금·성공 뒤 비우기)
        sendingFieldRef.current.set(fieldKey(input), input);
        sendingRef.current.add(input);
        input.readOnly = true;
      }
    });
  }, [pipWin, holdName]);
  // 같은 묶음의 떠 있는 창이 있으면 이어받고(Assets 의 파일 전환), '띄워서 보기'면 연 누름으로 바로 띄운다. 사라질 때 닫기를 예약한다
  const panelSize = () => {
    const el = document.querySelector<HTMLElement>(`[data-cmt-hold="${holdName}"]`);
    return el ? { width: el.offsetWidth || 644, height: el.offsetHeight || 380 } : { width: 644, height: 380 };
  };
  useEffect(() => {
    if (!canPip || !pipId) return;
    if (!claimCommentPip(pipId) && prefersCommentPip()) void openCommentPip(pipId, panelSize());
    return () => releaseCommentPip(pipId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPip, pipId]);
  const submitFrom = async (input: HTMLInputElement, send: (text: string) => Promise<boolean>, done?: () => void) => {
    const text = input.value;
    const field = fieldKey(input);
    if (!text.trim() || sendingRef.current.has(input) || sendingFieldRef.current.has(field)) return;
    const sentFor = targetRef.current;
    sendingRef.current.add(input);
    sendingFieldRef.current.set(field, input);
    input.readOnly = true;
    const saved = await send(text).catch(() => false);
    const current = sendingFieldRef.current.get(field) ?? input; // 기다리는 사이 창을 옮겼으면 이어받은 칸
    sendingFieldRef.current.delete(field);
    const fields = new Set([input, current]);
    fields.forEach((el) => { sendingRef.current.delete(el); el.readOnly = false; });
    // 실패한 글과 칸은 남긴다. 다만 기다리는 사이 패널이 다른 대상으로 넘어갔으면 치운다 — 남겨 두면 다시 보낼 때 새 대상에 달린다.
    if (!saved && targetRef.current === sentFor) return;
    fields.forEach((el) => { el.value = ""; });
    syncUnsent(); // 값을 바꿔도 input 이벤트는 오지 않는다
    // 칸을 닫는 것은 보낸 그 칸(옮겼으면 이어받은 칸)이 아직 떠 있을 때만 — 기다리는 사이 닫았다 다시 열었거나 다른 글의 칸을 열었으면 지금 칸은 새 칸이다.
    if (current.isConnected) done?.();
  };
  const submitComment = (input: HTMLInputElement, parentId?: string | null) => {
    // 비공개 코멘트에 단 답글은 무조건 비공개 — 공유로 나가면 팀에겐 부모 없는 답글이 된다.
    const parentPrivate = !!(parentId && byId[parentId]?.private);
    // 그림 창에서는 보이는 체크(composer)가 답글에도 쓰인다 — 패널이 따로 쥔 저장값을 쓰면 체크와 다르게 나갔다(독립 리뷰 확인 불가 항목 — 실제로 어긋남)
    const isPrivate = allowPrivate && (parentPrivate || (composer ? composer.writePrivate : writePrivate));
    return submitFrom(input, (text) => onSend(text, parentId, isPrivate), parentId ? () => setReplyingId(null) : undefined);
  };
  // [편집] — 쓰던 글을 그림 창으로 넘긴다. 넘긴 뒤에만 비운다(두 번 보내기 방지 — 그림 창이 그 글의 주인이 된다)
  const handOff = (form: HTMLFormElement | null) => {
    const input = form?.elements.namedItem("c") as HTMLInputElement | null;
    if (!input || !onEditDraw || sendingRef.current.has(input) || sendingFieldRef.current.has(fieldKey(input))) return;
    if (!onEditDraw(input.value)) return;
    input.value = "";
    syncUnsent();
  };

  const submitEdit = (id: string, input: HTMLInputElement) =>
    submitFrom(input, (text) => onEdit(id, text), () => setEditingId(null));

  const renderRow = (c: T, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === myId;
    // 깊은 후손까지 본다 — 중간 답글을 지워도 그 아래(남의 답글·내 비공개)가 고아가 되는 건 같다.
    const deepChildren = fullTree.descendantsOf(c.id);
    const lockedByReply = deepChildren.some((ch) => ch.author !== myId);
    // 공유 코멘트 아래 내 비공개 답글 — 부모만 서버에서 지워지면 비공개가 로컬 고아로 남는다.
    const lockedByPrivateChild = !c.private && deepChildren.some((ch) => ch.private);
    return (
      <div
        key={c.id}
        data-comment-id={c.id}
        className={
          "cmt-item" +
          (isReply ? " reply" : "") +
          (c.unread ? " unread" : "") +
          (c.private ? " private" : "") +
          (c.id === flash?.id ? " is-target" : "")
        }
        title={
          c.private
            ? "비공개 — 팀 공유 스레드·발행·통계에 표시되지 않음"
            : c.unread
              ? "클릭해 확인 (새 코멘트)"
              : undefined
        }
        onClick={
          c.unread && onSeen
            ? (e) => {
                if ((e.target as HTMLElement).closest("button, input, form")) return;
                onSeen(c);
              }
            : undefined
        }
      >
        <div className="cmt-meta">
          {c.unread && <span className="cmt-new">NEW</span>}
          {c.private && <span className="cmt-priv-tag">비공개</span>}
          <span className="cmt-author">{c.author_name || "팀원"}</span>
          {replyToName && <span className="cmt-replyto">↳ {replyToName}</span>}
          <span className="cmt-when">{fmtWhen(c.created_at)}</span>
          <div className="cmt-acts">
            <button onClick={() => { if (replyingId !== c.id) setOpenRound((n) => n + 1); setReplyingId(c.id); setEditingId(null); }}>답글</button>
            {mine && !lockedByReply && (
              <>
                <button onClick={() => { if (editingId !== c.id) setOpenRound((n) => n + 1); setEditingId(c.id); setReplyingId(null); }}>수정</button>
                {!lockedByPrivateChild && (
                  <button onClick={() => onDelete(c.id)}>삭제</button>
                )}
              </>
            )}
            {mine && (lockedByReply || lockedByPrivateChild) && (
              <span
                className="cmt-lock"
                title={
                  lockedByReply
                    ? "답글이 달려 수정·삭제 불가"
                    : "비공개 답글이 달려 있어 삭제 불가 — 비공개 답글을 먼저 지우세요"
                }
              >
                🔒
              </span>
            )}
          </div>
        </div>

        {editingId === c.id ? (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              void submitEdit(c.id, e.currentTarget.elements.namedItem("e") as HTMLInputElement);
            }}
          >
            <input
              name="e"
              data-cmt-key={`e:${c.id}:${openRound}`}
              defaultValue={c.text}
              data-original={c.text}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }}
            />
            <button type="submit">저장</button>
          </form>
        ) : (
          <div className="cmt-text">{c.text}</div>
        )}
        {renderExtra?.(c)}

        {replyingId === c.id && (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              void submitComment(e.currentTarget.elements.namedItem("r") as HTMLInputElement, c.id);
            }}
          >
            <input
              name="r"
              data-cmt-key={`r:${c.id}:${openRound}`}
              placeholder="답글 작성 ⏎"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setReplyingId(null); }}
            />
            <button type="submit">답글</button>
          </form>
        )}
      </div>
    );
  };

  const renderThread = (root: T) => (
    <div key={root.id} className="cmt-group">
      {renderRow(root, false, null)}
      {descendantsOf(root.id).map((d) => {
        const parent = d.parent_id ? byId[d.parent_id] : undefined;
        const toName =
          parent && d.parent_id !== root.id ? `${parent.author_name || "팀원"}` : null;
        return renderRow(d, true, toName);
      })}
    </div>
  );

  const panel = (
    <div
      className={"cmt-panel" + (embedded ? " cmt-embedded" : "") + (overPreview && !pipWin ? " over-preview" : "") + (showMedia ? " cmt-with-media" : "")
        + (pipWin ? " cmt-pip" : "")}
      // 떠 있는 창에서는 앱 안 자리·크기 기억(useFloatingPanel)에 잇지 않는다 — 그 창의 크기가 앱 안 크기로 저장되지 않게
      ref={pipWin ? undefined : panelRef}
      data-cmt-hold={holdName}
      onInput={syncUnsent}
      // 패널 안에서 난 Esc 는 패널이 쓴다(고치던 것·답글 접기는 그 입력칸이 한다) — '쓴 것'으로 표시해 뒤 화면으로 새지 않게 한다.
      //  2026-10-10 실측: 코멘트 입력칸의 Esc 에 뒤의 폴더 창만 닫히고 패널이 남았다. 맨 아래 입력칸은 초점을 내려놓는다 —
      //  다음 Esc 부터는 뒤 화면(선택 해제·폴더 창)의 몫이다.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (backgroundKeysBlocked()) return; // 위에 창(정보·크게 보기…)이 떠 있으면 그 Esc 는 그 창의 것 — 패널이 먼저 쓰면 창이 안 닫힌다
        markKeyHandled(e.nativeEvent);
        const from = e.target as HTMLElement;
        if (from.matches?.('.cmt-input input')) from.blur();
      }}
      style={
        (embedded || pipWin
          ? { "--cmt-fs": `${fontPx}px` }
          : {
              left: (pos || fallbackPos).x,
              top: (pos || fallbackPos).y,
              width: size?.w,
              height: size?.h,
              "--cmt-fs": `${fontPx}px`,
            }) as unknown as CSSProperties
      }
    >
      {showMedia && media && (
        <button type="button" className="cmt-media" title={media.title} aria-label="크게 보기" disabled={!media.onOpen} onClick={media.onOpen}
          onMouseEnter={playMedia} onMouseLeave={stopMedia}>
          {/* 생성 카드와 같은 부품·같은 ▶(가운데 흰 삼각형, 올리면 숨김 — Jay 11-09 "기존 생성카드처럼") */}
          <MediaThumbnail thumb={media.thumb} isVideo={media.type === "video"} src={media.type === "video" ? media.videoUrl : null}
            videoRef={mediaVideoRef} fallback={<span className="cmt-media-ph">{media.type === "audio" ? "♪" : ""}</span>} />
          {media.type === "video" && <span className="play-badge">▶</span>}
          {media.onOpen && <span className="cmt-media-zoom">⤢ 크게 보기</span>}
        </button>
      )}
      {/* 썸네일 칸이 없으면 없는 상자(display: contents) — 칸이 있을 때만 오른쪽 세로 칸이 된다. 늘 두어 칸이 생겨도 입력칸이 다시 만들어지지 않게 */}
      <div className="cmt-col">
      <div className="cmt-head" onMouseDown={embedded || pipWin ? undefined : (e) => onHeadMouseDown(e, fallbackPos)}>
        <span className="cmt-title">
          💬 {embedded && !composer ? "지난 코멘트" : "코멘트"} <span className="muted">({visible.length})</span>
        </span>
        {!embedded && !showMedia && <span className="cmt-file">{label}</span>}
        <div className="cmt-fs" onMouseDown={(e) => e.stopPropagation()}>
          <button title="글씨 작게" onClick={() => setFs(fontPx - 1)} disabled={fontPx <= FS_MIN}>
            A−
          </button>
          <button title="글씨 크게" onClick={() => setFs(fontPx + 1)} disabled={fontPx >= FS_MAX}>
            A+
          </button>
        </div>
        {canPip && pipId && (
          <button type="button" className="cmt-pip-btn" onMouseDown={(e) => e.stopPropagation()}
            aria-label={pipWin ? "앱 안으로" : "창 밖으로"}
            title={pipWin ? "앱 안으로 — 코멘트 창을 앱 화면 안으로 돌려놓기" : "창 밖으로 — 브라우저 밖 어디로든 옮기는 떠 있는 창으로(늘 다른 창 위)"}
            onClick={() => (pipWin ? returnCommentPip(pipId) : void openCommentPip(pipId, panelSize()))}>
            {pipWin ? PIP_IN_ICON : PIP_OUT_ICON}
          </button>
        )}
        {!embedded && (
          <button className="cmt-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="cmt-thread">
        {visible.length === 0 && <div className="cmt-empty">아직 코멘트가 없습니다.</div>}
        {roots.map((root) => renderThread(root))}
      </div>

      {/* 끼워 쓰기(그림 창)는 새 코멘트 입력을 그 창이 쥔다 — 보내면 그린 그림이 붙는다 */}
      {!embedded && (
        <form
          className="cmt-input"
          onSubmit={(e) => {
            e.preventDefault();
            void submitComment(e.currentTarget.elements.namedItem("c") as HTMLInputElement);
          }}
        >
          <input
            name="c"
            autoComplete="off"
            placeholder={allowPrivate && writePrivate ? "비공개 코멘트 작성 ⏎ (팀에게 안 보임)" : "코멘트 작성 ⏎"}
            autoFocus
          />
          {/* 입력칸 안 오른쪽 아이콘 — 편집(펜)·전송(종이비행기, 라임). Jay 11-09 시안 C */}
          <div className="cmt-inside">
            {onEditDraw && (
              <button type="button" className="cmt-draw-btn" aria-label="편집" title="편집 — 그림을 그려 코멘트에 붙이기(쓰던 글은 그림 창으로 옮겨 갑니다)"
                onClick={(e) => handOff(e.currentTarget.form)}>
                {PEN_ICON}
              </button>
            )}
            <button type="submit" className="cmt-send-btn" aria-label="전송" title="전송 (Enter)">{SEND_ICON}</button>
          </div>
        </form>
      )}
      {embedded && composer && (
        <form
          className="cmt-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (composer.canSend && !composer.sending) composer.onSubmit();
          }}
        >
          <input
            name="cd"
            aria-label="코멘트"
            autoComplete="off"
            value={composer.text}
            readOnly={composer.sending}
            placeholder={allowPrivate && composer.writePrivate ? "비공개 코멘트 작성 ⏎ (팀에게 안 보임)" : "코멘트 작성 ⏎ — 그린 그림이 함께 붙습니다"}
            onChange={(e) => composer.setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); // 한글 조합 중 Enter 는 보내기가 아니다
            }}
          />
          <div className="cmt-inside">
            <button type="submit" className="cmt-send-btn" aria-label="전송" title={composer.sending ? "보내는 중" : "전송 (Enter) — 그린 그림이 함께 붙습니다"}
              disabled={!composer.canSend || composer.sending}>{SEND_ICON}</button>
          </div>
        </form>
      )}

      <div className="cmt-opt">
        {allowPrivate && !embedded && (
          <label title="개인 기록으로 저장 — 팀 공유 스레드·발행·통계에 표시되지 않습니다">
            <input type="checkbox" checked={writePrivate} onChange={togglePrivate} />
            비공개 코멘트(쓰기)
          </label>
        )}
        {allowPrivate && embedded && composer && (
          <label title="개인 기록으로 저장 — 팀 공유 스레드·발행·통계에 표시되지 않습니다">
            <input type="checkbox" checked={composer.writePrivate} disabled={composer.sending}
              onChange={() => composer.setWritePrivate(!composer.writePrivate)} />
            비공개 코멘트(쓰기)
          </label>
        )}
        <label title="끄면 팀이 보는 그대로(공유 코멘트만) 표시">
          <input type="checkbox" checked={showPrivate} onChange={toggleShow} />
          비공개 코멘트(읽기)
        </label>
      </div>
      </div>
    </div>
  );
  // 떠 있는 창이면 그 창의 문서에 그린다(같은 앱 상태 — 고른 카드를 따라가고 [편집]·크게 보기는 앱 창에 열린다)
  return pipWin ? createPortal(panel, pipWin.document.body) : panel;
}

import { useModalFocus } from "../../lib/keyGate";
import { ModalShellContext, useEscapeClose } from "../../lib/useEscapeClose";
import { lazy, Suspense, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { GenCommentPanel } from "../GenCommentPanel";
import { InfoPopup } from "../InfoPopup";
import { MediaPreview } from "../MediaPreview";
import type { CompareVideo } from "../VideoCompareModal";
import type {
  Account,
  Generation,
  InfoTarget,
  PreviewTarget,
  Project,
} from "../../types";

const AdminWindow = lazy(() =>
  import("../AdminWindow").then((module) => ({ default: module.AdminWindow })),
);
const CompareModal = lazy(() =>
  import("../CompareModal").then((module) => ({ default: module.CompareModal })),
);
const VideoCompareModal = lazy(() =>
  import("../VideoCompareModal").then((module) => ({ default: module.VideoCompareModal })),
);

// ── 지연 로딩 창의 틀(lib/useEscapeClose '지연 로딩 창의 틀') ──
//  코드가 오기 전에도 그 창은 떠 있는 것이다: 막과 빈 창을 바로 그리고(Esc·막 누름으로 닫힌다), Esc 겹과 모달 영역을 **연 순간에** 쥔다.
//  전엔 코드가 온 뒤에야 겹이 켜져, 그 틈에 연 다른 창보다 위 겹이 됐다(화면에서는 아래인데 Esc 에 먼저 닫혔다).
//  본문이 오면 본문의 Esc 처리(안의 확인 창·라이트박스부터 닫기)가 이 겹을 넘겨받는다 — 겹은 그대로 하나다.
/** 코드가 오기 전의 빈 틀 — 그 창의 막·뿌리 클래스 그대로다(새 모양을 만들지 않는다). 걷힐 때(본문 도착) onGone. */
function ShellFrame({ backdrop, frame, label, onClose, onGone }: {
  backdrop: string;
  frame: string;
  label: string;
  onClose: () => void;
  onGone: () => void;
}) {
  useEffect(() => onGone, [onGone]);
  return (
    <>
      <div className={backdrop} onMouseDown={onClose} />
      <div className={frame} role="dialog" aria-label={label} />
    </>
  );
}

/** backdrop·frame·label = 그 창(본문)의 막 클래스·뿌리 클래스·뿌리의 aria-label 과 같아야 한다 — 빈 틀과 본문의 뿌리를 같은 이름으로 찾는다.
 *  capture = 본문의 Esc 가 잡는 단계에서 삼키는 것이면(비교 창). */
function LazyModalShell({ backdrop, frame, label, capture = false, onClose, children }: {
  backdrop: string;
  frame: string;
  label: string;
  capture?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const escape = useRef<(() => void) | null>(null); // 본문이 넘긴 Esc 처리(useWindowEscape) — 오기 전에는 창을 닫는다
  useEscapeClose(() => (escape.current ?? onClose)(), true, capture, capture);
  // 빈 틀이 본문으로 바뀌면 초점이 놓였던 뿌리가 사라진다(BODY) — 본문의 뿌리로 다시 들인다.
  const refocus = useModalFocus(() => [document.querySelector<HTMLElement>(`.${frame.split(" ")[0]}[aria-label="${label}"]`)]);
  return (
    <ModalShellContext.Provider value={escape}>
      <Suspense fallback={<ShellFrame backdrop={backdrop} frame={frame} label={label} onClose={onClose} onGone={refocus} />}>
        {children}
      </Suspense>
    </ModalShellContext.Provider>
  );
}

/** 미디어 비교 창(지연 로딩) — App 이 컷 정보·모아보기 뒤에 따로 그린다. */
export function VideoCompareOverlay({ videos, onClose }: { videos: CompareVideo[]; onClose: () => void }) {
  return (
    <LazyModalShell backdrop="cmp-backdrop" frame="cmp-modal" label="미디어 비교" capture onClose={onClose}>
      <VideoCompareModal videos={videos} onClose={onClose} />
    </LazyModalShell>
  );
}

export function AppOverlays({
  account,
  adminOpen,
  localHub,
  commentGenId,
  commentLabel,
  compareGens,
  info,
  myId,
  preview,
  projects,
  syncTick,
  toast,
  onAdminClose,
  onCloseOverlay,
  onCommentClose,
  onCompareClose,
  onHistoryChanged,
  onInfoClose,
  onInfoOpenInBoard,
  onInfoOpenCanvas,
  onRecoveryRequeue,
  onOpenInBoardFromPreview,
  onPreview,
}: {
  account?: Account | null;
  adminOpen: boolean;
  localHub: boolean;
  commentGenId: string | null;
  commentLabel: string;
  compareGens: Generation[] | null;
  info: InfoTarget | null;
  myId: string;
  preview: PreviewTarget | null;
  projects: Project[];
  syncTick: number;
  toast: ReactNode; // 문자열 또는 일부 강조된 JSX(useAppToast 참고)
  onAdminClose: () => void;
  onCloseOverlay: () => void;
  onCommentClose: () => void;
  onCompareClose: () => void;
  onHistoryChanged: () => void;
  onInfoClose: () => void;
  onInfoOpenInBoard: (generation: Generation) => void;
  onInfoOpenCanvas: (generation: Generation) => void;
  onRecoveryRequeue: (generation: Generation) => Promise<boolean>;
  onOpenInBoardFromPreview: (generationId: string) => void;
  onPreview: (target: PreviewTarget) => void;
}) {
  return (
    <>
      {commentGenId && (
        <GenCommentPanel
          genId={commentGenId}
          label={commentLabel}
          myId={myId}
          syncTick={syncTick}
          onClose={onCommentClose}
          onChanged={onHistoryChanged}
        />
      )}
      {info && (
        <InfoPopup
          target={info}
          onClose={onInfoClose}
          onPreview={onPreview}
          projects={projects}
          onOpenInBoard={onInfoOpenInBoard}
          onOpenCanvas={onInfoOpenCanvas}
          onRecoveryRequeue={onRecoveryRequeue}
        />
      )}
      {preview && (
        <MediaPreview
          target={preview}
          onClose={onCloseOverlay}
          onOpenInBoard={onOpenInBoardFromPreview}
        />
      )}
      {adminOpen && (
        <LazyModalShell backdrop="admin-backdrop" frame="admin-window" label="관리자" onClose={onAdminClose}>
          <AdminWindow account={account} localHub={localHub} onClose={onAdminClose} />
        </LazyModalShell>
      )}
      {compareGens && (
        <LazyModalShell backdrop="cmp-backdrop" frame="cmp-modal cmp-window" label="버전 비교" capture onClose={onCompareClose}>
          <CompareModal gens={compareGens} onClose={onCompareClose} />
        </LazyModalShell>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

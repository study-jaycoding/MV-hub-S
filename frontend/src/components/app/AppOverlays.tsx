import { useKeyOwner } from "../../lib/keyGate";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { GenCommentPanel } from "../GenCommentPanel";
import { InfoPopup } from "../InfoPopup";
import { MediaPreview } from "../MediaPreview";
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
  // 지연 로딩 창(관리자·비교)은 코드가 도착하기 전에도 '떠 있는 것'이다 — 그 틈에 뒤 화면의 단축키가 먹지 않게 여기서 올린다.
  useKeyOwner(adminOpen || !!compareGens);
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
        <Suspense fallback={null}>
          <AdminWindow account={account} localHub={localHub} onClose={onAdminClose} />
        </Suspense>
      )}
      {compareGens && (
        <Suspense fallback={null}>
          <CompareModal gens={compareGens} onClose={onCompareClose} />
        </Suspense>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

import { lazy, Suspense } from "react";
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
  commentGenId: string | null;
  commentLabel: string;
  compareGens: Generation[] | null;
  info: InfoTarget | null;
  myId: string;
  preview: PreviewTarget | null;
  projects: Project[];
  syncTick: number;
  toast: string | null;
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
        <Suspense fallback={null}>
          <AdminWindow account={account} onClose={onAdminClose} />
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

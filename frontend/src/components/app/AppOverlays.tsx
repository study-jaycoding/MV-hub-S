import { lazy, Suspense } from "react";
import { GenCommentPanel } from "../GenCommentPanel";
import { HistoryPanel } from "../HistoryPanel";
import { InfoPopup } from "../InfoPopup";
import { MediaPreview } from "../MediaPreview";
import type {
  Account,
  Generation,
  History,
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
  history,
  info,
  myId,
  preview,
  projects,
  syncTick,
  toast,
  onAdminClose,
  onCloseOverlay,
  onCompare,
  onCompareClose,
  onHistoryChanged,
  onInfo,
  onInfoClose,
  onInfoOpenInBoard,
  onOpenInBoard,
  onOpenInBoardFromPreview,
  onPreview,
}: {
  account?: Account | null;
  adminOpen: boolean;
  commentGenId: string | null;
  commentLabel: string;
  compareGens: Generation[] | null;
  history: History | null;
  info: InfoTarget | null;
  myId: string;
  preview: PreviewTarget | null;
  projects: Project[];
  syncTick: number;
  toast: string | null;
  onAdminClose: () => void;
  onCloseOverlay: () => void;
  onCompare: (generations: Generation[] | null) => void;
  onCompareClose: () => void;
  onHistoryChanged: () => void;
  onInfo: (target: InfoTarget) => void;
  onInfoClose: () => void;
  onInfoOpenInBoard: (generation: Generation) => void;
  onOpenInBoard: (generation: Generation) => void;
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
          onClose={onCloseOverlay}
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
      {history && (
        <HistoryPanel
          history={history}
          onClose={onCloseOverlay}
          onPreview={onPreview}
          onInfo={onInfo}
          onCompare={(generations) => onCompare(generations)}
          onChanged={onHistoryChanged}
          onOpenInBoard={onOpenInBoard}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

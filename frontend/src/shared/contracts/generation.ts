import type { Generation, WorkspaceContext } from "../../types";
import type { AssetReferenceIdentity } from "./assets";

export interface GenerationCreateBody {
  prompt: string;
  display_prompt?: string;
  model: string;
  params?: Record<string, unknown>;
  color?: string | null;
  tags?: string[];
  auto_tags?: string[];
  references?: (AssetReferenceIdentity & {
    file_path: string; type: string; role: string; name?: string;
    thumbnail?: string; source_url?: string; source_gen_id?: string;
  })[];
  project_id?: string;
  folder_path?: string;
}

export interface RegenerateBody {
  prompt?: string;
  color?: string | null;
  auto_tags?: string[];
  finish_draft?: boolean;
}

export interface SubmissionCanvasLink {
  attempt_id: string;
  generation_id: string;
  scene_id: string;
  card_id: string;
}

// P1 only captures the inputs this submission uses; authentication remains in HTTP.
export interface SubmissionContext {
  readonly workspace: Readonly<WorkspaceContext>;
  readonly canvasLink?: Readonly<SubmissionCanvasLink>;
  readonly operation?: OperationContext;
  readonly isCurrent?: () => boolean;
}

export interface OperationContext {
  readonly accountNamespace: string;
  readonly serverOrigin: string;
  readonly authority: "local" | "team";
  readonly workspaceId: string | null;
  readonly sessionEpoch: number;
}

export interface PreparedSubmission {
  readonly operationId: string;
  readonly context: SubmissionContext;
  readonly send: () => Promise<Generation>;
}

export type SubmissionOutcome =
  | { kind: "prepare_failed"; reasonCode: string }
  | { kind: "rejected"; reasonCode: string }
  | { kind: "acceptance_unknown"; operationId: string }
  | { kind: "accepted"; operationId: string; generationId: string; requestId?: string }
  | { kind: "accepted_local_pending"; operationId: string; generationId: string; requestId?: string };

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  generation?: Generation;
  error?: unknown;
}

export interface SubmissionDestination {
  // Recheck the already reserved, durable marks; never create another attempt here.
  confirm(prepared: PreparedSubmission): boolean | Promise<boolean>;
  apply(generation: Generation, prepared: PreparedSubmission): void | Promise<void>;
}

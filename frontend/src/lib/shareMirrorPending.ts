export const MIRROR_PENDING_NOTICE = "일부 로컬 반영은 잠시 후 자동 동기화됩니다";

export interface MirrorPendingResult {
  mirror_pending?: boolean;
}

export function withMirrorPendingNotice(
  message: string,
  result: MirrorPendingResult | null | undefined,
): string {
  return result?.mirror_pending ? `${message} ${MIRROR_PENDING_NOTICE}` : message;
}

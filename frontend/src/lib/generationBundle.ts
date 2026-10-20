import { captureSubmissionScope, OperationContextChangedError } from "../app/operationContext";
import { authFormHeaders, throwHttpError } from "./http";
import { saveToDownloadDir } from "./downloadDir";

export class IncompleteGenerationBundle extends Error {
  constructor(readonly count: number) { super(`원본 ${count}건을 확인할 수 없습니다.`); }
}

export async function downloadGenerationBundle(id: string, allowIncomplete = false, signal?: AbortSignal): Promise<void> {
  const scope = captureSubmissionScope({ scope: "unknown", id: null, name: null });
  const assertCurrent = () => {
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    if (!scope.isCurrent?.()) throw new OperationContextChangedError();
  };
  assertCurrent();
  const url = `/api/local-asset-sync/generations/${encodeURIComponent(id)}/bundle?allow_incomplete=${allowIncomplete}`;
  const response = await fetch(url, { headers: authFormHeaders(), credentials: "same-origin", signal });
  assertCurrent();
  if (response.status === 409) {
    const data = await response.clone().json().catch(() => null);
    if (Array.isArray(data?.detail?.missing)) throw new IncompleteGenerationBundle(data.detail.missing.length);
  }
  if (!response.ok) await throwHttpError(response, url);
  const blob = await response.blob();
  assertCurrent();
  const name = `generation-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}${allowIncomplete ? "-incomplete" : ""}.zip`;
  const saved = await saveToDownloadDir(name, blob, assertCurrent);
  assertCurrent();
  if (saved) return;
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

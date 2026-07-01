import type { MutableRefObject } from "react";
import {
  ELEMENT_RE,
  ELEMENT_SPLIT_RE,
  compareParamDiffers,
  compareParamValue,
  refKey,
  tokenizePrompt,
} from "../../lib/compareDiff";
import { thumbUrl } from "../../lib/media";
import { refSrc } from "../../lib/promptParts";
import type { Generation, Reference } from "../../types";
import type { CompareSourcePreview } from "./CompareSourceLightbox";

function renderPrompt(text: string, common: Set<string>, commonElems: Set<string>) {
  const parts = text.split(ELEMENT_SPLIT_RE);
  return parts.map((part, partIndex) => {
    if (!part) return null;
    if (ELEMENT_RE.test(part)) {
      const changed = !commonElems.has(part.toLowerCase());
      return (
        <span key={partIndex} className={changed ? "cmp-diff-g" : undefined}>
          {part}{" "}
        </span>
      );
    }
    return tokenizePrompt(part).map((token, tokenIndex) => {
      const diff = !common.has(token.toLowerCase());
      return (
        <span key={partIndex + "-" + tokenIndex} className={diff ? "cmp-diff" : undefined}>
          {token}{" "}
        </span>
      );
    });
  });
}

function mediaThumb(path: string | null | undefined, width: number): string | null {
  return thumbUrl(path, width);
}

function refThumb(reference: Reference) {
  return mediaThumb(reference.thumbnail_path || reference.file_path, 128);
}

export function CompareGenerationColumn({
  common,
  commonElems,
  commonRefs,
  generation,
  generations,
  index,
  keys,
  modelName,
  onlyDiff,
  onSourcePreview,
  prompt,
  promptOnly,
  videoRefs,
}: {
  common: Set<string>;
  commonElems: Set<string>;
  commonRefs: Set<string>;
  generation: Generation;
  generations: Generation[];
  index: number;
  keys: string[];
  modelName: (model: string | null) => string;
  onlyDiff: boolean;
  onSourcePreview: (preview: CompareSourcePreview) => void;
  prompt: string;
  promptOnly: boolean;
  videoRefs: MutableRefObject<(HTMLVideoElement | null)[]>;
}) {
  const asset = generation.assets[0];
  const isVideo = asset?.type === "video";
  const rawThumb = asset?.thumbnail_path || (asset?.type !== "video" ? asset?.file_path : null);
  const thumb = mediaThumb(rawThumb, 512);

  return (
    <div className={"cmp-col" + (generation.is_final ? " final" : "")}>
      {!promptOnly && (
        <>
          <div className="cmp-thumb">
            {isVideo && asset ? (
              <video
                ref={(el) => {
                  videoRefs.current[index] = el;
                }}
                src={asset.file_path}
                poster={thumb || undefined}
                controls
                muted
                playsInline
                preload="metadata"
              />
            ) : thumb ? (
              <img src={thumb} alt={generation.prompt} loading="lazy" decoding="async" />
            ) : (
              <div className="cmp-thumb-empty">{generation.status}</div>
            )}
            {generation.is_final && <span className="cmp-final-badge">★ 최종</span>}
          </div>
          <div className="cmp-model">{modelName(generation.model)}</div>
        </>
      )}

      {generation.references.length > 0 && (
        <div className="cmp-refs">
          {generation.references.map((reference) => {
            const thumbUrlValue = refThumb(reference);
            if (!thumbUrlValue) return null;
            const isDiff = !commonRefs.has(refKey(reference));
            const full = refSrc(reference.file_path) || reference.source_url || thumbUrlValue;
            return (
              <button
                key={reference.id}
                type="button"
                className={"cmp-ref-btn" + (isDiff ? " diff" : "")}
                title={
                  (isDiff ? "다른 소스 — " : "") +
                  (reference.role || "참조") +
                  " · 클릭하면 원본 보기"
                }
                onClick={() =>
                  onSourcePreview({
                    url: full,
                    type: reference.type,
                    name: reference.role || "소스",
                  })
                }
              >
                <img src={thumbUrlValue} className="cmp-ref" alt={reference.role || "reference"} />
              </button>
            );
          })}
        </div>
      )}

      <div className={"cmp-prompt" + (promptOnly ? " full" : "")}>
        {renderPrompt(prompt, common, commonElems)}
      </div>

      {!promptOnly &&
        (keys.length > 0 ? (
          <div className="cmp-info">
            {keys.map((key) => (
              <div key={key} className="cmp-info-row">
                <span className="cmp-info-label">{key}</span>
                <span
                  className={
                    "cmp-info-value" +
                    (compareParamDiffers(generations, key) ? " cmp-diff" : "")
                  }
                >
                  {compareParamValue(generation, key)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="cmp-empty">
            {onlyDiff ? "다른 파라미터 없음" : "파라미터 없음"}
          </div>
        ))}
    </div>
  );
}

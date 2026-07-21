import { displayThumb } from "../../lib/media";
import { buildPromptParts, refSrc } from "../../lib/promptParts";
import type { PreviewTarget, Reference } from "../../types";

type InlinePromptElement = "span" | "div";

export function InlinePromptRefs({
  as = "span",
  displayPrompt,
  prompt,
  references,
  onPreview,
  className = "info-prompt",
  stopPropagation = false,
}: {
  as?: InlinePromptElement;
  displayPrompt: string | null | undefined;
  prompt: string;
  references: Reference[];
  onPreview: (target: PreviewTarget) => void;
  className?: string;
  stopPropagation?: boolean;
}) {
  const Element = as;
  const parts = displayPrompt ? buildPromptParts(displayPrompt, references) : [];
  if (!parts.some((part) => part.t === "chip")) {
    return <Element className={className}>{displayPrompt || prompt}</Element>;
  }

  return (
    <Element className={className}>
      {parts.map((part, index) =>
        part.t === "text" ? (
          <span key={index}>{part.v}</span>
        ) : (
          <button
            key={index}
            type="button"
            className="inline-ref inline-ref-static inline-ref-btn"
            title={`${part.ref.name} — 크게 보기`}
            onClick={(event) => {
              if (stopPropagation) event.stopPropagation();
              onPreview({
                url: refSrc(part.ref.file_path) || part.ref.thumb,
                type: part.ref.type,
                name: part.ref.name,
              });
            }}
          >
            {part.ref.thumb && <img src={displayThumb(part.ref.thumb) || undefined} alt="" />}
            <span className="inline-ref-name">{part.ref.name}</span>
          </button>
        ),
      )}
    </Element>
  );
}

export function hasInlinePromptRefs(
  displayPrompt: string | null | undefined,
  references: Reference[],
): boolean {
  return displayPrompt ? buildPromptParts(displayPrompt, references).some((part) => part.t === "chip") : false;
}

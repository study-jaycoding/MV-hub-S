import type { Generation } from "../../types";
import { TagEditor } from "../TagEditor";

interface Props {
  gen: Generation;
  isList: boolean;
  selected: boolean;
  editingField?: "source" | "tag" | null;
  selectedCount?: number;
  tagEditing?: boolean;
  tagGlobalMode?: boolean;
  autoTagOptions?: string[];
  onSetSource: (generation: Generation, name: string | null, isSource: boolean) => void;
  onSetTags: (generation: Generation, tags: string[]) => void;
  onSetAutoTags?: (generation: Generation, names: string[]) => void;
  onBulkAddTags?: (generation: Generation, names: string[]) => void;
  onBulkRemoveTags?: (generation: Generation, names: string[]) => void;
  onBulkAddAutoTags?: (generation: Generation, names: string[]) => void;
  onBulkRemoveAutoTags?: (generation: Generation, names: string[]) => void;
  onGlobalModeChange?: (on: boolean) => void;
  onEditDone: () => void;
}

export function GenerationCardStatusBar({
  gen,
  isList,
  selected,
  editingField,
  selectedCount,
  tagEditing,
  tagGlobalMode,
  autoTagOptions,
  onSetSource,
  onSetTags,
  onSetAutoTags,
  onBulkAddTags,
  onBulkRemoveTags,
  onBulkAddAutoTags,
  onBulkRemoveAutoTags,
  onGlobalModeChange,
  onEditDone,
}: Props) {
  if (editingField === "tag") {
    return (
      <div
        className="card-status"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <TagEditor
          tags={gen.tags}
          onChange={(next) => onSetTags(gen, next)}
          onBulkAdd={(names) => onBulkAddTags?.(gen, names)}
          onBulkRemove={(names) => onBulkRemoveTags?.(gen, names)}
          selectedCount={selectedCount}
          onGlobalModeChange={onGlobalModeChange}
          global={
            onSetAutoTags
              ? {
                  all: autoTagOptions ?? [],
                  assigned: gen.auto_tags ?? [],
                  onChange: (next) => onSetAutoTags(gen, next),
                  onBulkAdd: (names) => onBulkAddAutoTags?.(gen, names),
                  onBulkRemove: (names) => onBulkRemoveAutoTags?.(gen, names),
                }
              : null
          }
          onClose={onEditDone}
        />
      </div>
    );
  }

  if (editingField === "source") {
    return (
      <div
        className="card-status"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <input
          className="cs-tag-input"
          autoFocus
          defaultValue={gen.source_name || ""}
          placeholder="소스 이름 @이름 ⏎"
          onKeyDown={(e) => {
            e.stopPropagation();
            const value = (e.target as HTMLInputElement).value;
            if (e.key === "Enter") {
              onSetSource(gen, value.trim() || null, true);
              onEditDone();
            } else if (e.key === "Escape") {
              onEditDone();
            }
          }}
          onBlur={onEditDone}
        />
      </div>
    );
  }

  if (tagEditing && selected) {
    return (
      <div
        className="card-status"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <TagEditor
          tags={gen.tags}
          onChange={(next) => onSetTags(gen, next)}
          selectedCount={selectedCount}
          showInput={false}
          forcedGlobalMode={tagGlobalMode}
          global={
            onSetAutoTags
              ? {
                  all: autoTagOptions ?? [],
                  assigned: gen.auto_tags ?? [],
                  onChange: (next) => onSetAutoTags(gen, next),
                }
              : null
          }
        />
      </div>
    );
  }

  if (!isList && (gen.color || gen.is_final)) {
    return (
      <div
        className={"card-colorbar" + (gen.is_final ? " final" : "")}
        style={gen.is_final ? undefined : { background: gen.color || undefined }}
        title={gen.is_final ? "최종(골드)" : "카드 컬러 마커"}
      />
    );
  }

  return null;
}

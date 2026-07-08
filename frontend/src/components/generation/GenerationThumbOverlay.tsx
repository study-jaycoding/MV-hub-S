import { downloadName, downloadOne } from "../../lib/download";
import { APP_EVENTS, dispatchAppEvent } from "../../lib/appEvents";
import type { Asset, Generation, InfoTarget } from "../../types";
import { BranchIcon } from "./GenerationCardIcons";

export function GenerationThumbOverlay({
  asset,
  gen,
  isList,
  myCreatorUid,
  selected,
  tab,
  onInfo,
  onImport,
  onRegenerate,
  onRestore,
  onShowHistory,
  onToggleSelect,
}: {
  asset: Asset | undefined;
  gen: Generation;
  isList: boolean;
  myCreatorUid?: string | null;
  selected: boolean;
  tab: "my" | "team";
  onInfo: (target: InfoTarget) => void;
  onImport: (generation: Generation) => void;
  onRegenerate: (generation: Generation) => void;
  onRestore: (generation: Generation) => void;
  onShowHistory?: (generation: Generation) => void;
  onToggleSelect?: (id: string) => void;
}) {
  return (
    <div className="thumb-overlay" onClick={(event) => event.stopPropagation()}>
      <div className="ov-top">
        {onToggleSelect && isList && (
          <label className="ov-check" title="선택">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(gen.id)}
            />
          </label>
        )}
        <button
          className="ov-icon"
          style={{ marginLeft: "auto" }}
          title="정보"
          onClick={(event) =>
            onInfo({ kind: "generation", gen, x: event.clientX, y: event.clientY })
          }
        >
          ⓘ
        </button>
      </div>
      <div className="ov-bottom">
        {gen.deleted ? (
          <button
            className="ov-icon ov-icon-on"
            title="휴지통에서 복구"
            onClick={() => onRestore(gen)}
          >
            ↺
          </button>
        ) : null}
        {asset && (
          <button
            className="ov-icon"
            title="다운로드"
            onClick={() => downloadOne(asset.file_path, downloadName(gen, asset.type))}
          >
            ⤓
          </button>
        )}
        <button
          className="ov-icon"
          title="레퍼런스로 사용 — 이 생성물을 @레퍼런스로 추가 (끌어내리면 프롬프트 재사용)"
          onClick={(event) => {
            event.stopPropagation();
            dispatchAppEvent(APP_EVENTS.addReference, gen.id);
          }}
        >
          @
        </button>
        {tab === "team" ? (
          gen.creator_uid !== myCreatorUid ? (
            <button
              className="ov-icon"
              title="내 워크스페이스로 가져오기"
              onClick={() => onImport(gen)}
            >
              ⬇
            </button>
          ) : null
        ) : (
          <button className="ov-icon" title="재생성" onClick={() => onRegenerate(gen)}>
            ↻
          </button>
        )}
        {onShowHistory && (
          <button
            className="ov-icon ov-icon-on ov-lineage"
            title={
              (gen.child_count || 0) > 0
                ? `가계 보기 · 이 결과물에서 파생·사용 ${gen.child_count}개`
                : "가계 보기 (히스토리)"
            }
            onClick={(event) => {
              event.stopPropagation();
              onShowHistory(gen);
            }}
          >
            <BranchIcon />
            {(gen.child_count || 0) > 0 && (
              <span className="lineage-count">{gen.child_count}</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

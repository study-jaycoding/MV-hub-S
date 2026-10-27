import { useRef, type ReactNode } from "react";
import type { Generation, PreviewTarget } from "../../types";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useModelDisplayName } from "../../lib/modelCatalog";
import { generationListMeta, formatGenerationDateTime } from "../../lib/generationDisplay";
import { thumbOf } from "../../lib/media";
import { InlinePromptRefs } from "../common/InlinePromptRefs";
import { ClockIcon, FrameIcon, GemIcon, ModelIcon } from "../generation/GenerationCardIcons";
import { RECOVERY_PAGE, type useSceneCardRecovery } from "../../lib/useSceneCardRecovery";

type Props = Omit<ReturnType<typeof useSceneCardRecovery>, "openCanvasRecovery"> & { onPreview?: (target: PreviewTarget) => void };
export function SceneRecoveryPanel({ canvasRecovery, setCanvasRecovery, loadMoreDetached, claimCanvasRecovery, claimDetachedGeneration, onPreview }: Props) {
  const recoveryModelName = useModelDisplayName();
  const recoveryRef = useRef<HTMLDivElement>(null);
  useModalFocus(recoveryRef, !!canvasRecovery);
  useEscapeClose(() => { if (!canvasRecovery?.claimingId) setCanvasRecovery(null); }, !!canvasRecovery);
  // 아래 칸은 목록이 길다 — 검색으로 좁히고 '더 보기'로 늘린다(옛 30개 고정에는 찾을 길이 없었다).
  const recoveryQuery = (canvasRecovery?.query || "").trim().toLowerCase();
  const recoveryFiltered = !canvasRecovery
    ? []
    : recoveryQuery
      ? canvasRecovery.items.filter((generation) =>
          [generation.prompt, generation.display_prompt, recoveryModelName(generation.model, generation.params), generation.model]
            .some((text) => (text || "").toLowerCase().includes(recoveryQuery)),
        )
      : canvasRecovery.items;
  const recoveryVisible = canvasRecovery
    ? recoveryFiltered.slice(0, canvasRecovery.shown)
    : [];
  // 두 칸이 같은 모양으로 항목을 그린다 — 라이브러리 리스트 카드 축소판.
  // 프롬프트 칩이 자체 <button> 이라 겹침(중첩 버튼)이 안 되게 항목은 div+role=button 이다.
  const renderRecoveryItem = (
    generation: Generation,
    badge: ReactNode,
    pick: (generation: Generation) => void,
  ) => {
    const meta = generationListMeta((generation.params || {}) as Record<string, unknown>);
    const thumb = thumbOf(generation, 256);
    const busy = !!canvasRecovery?.claimingId;
    return (
      <div
        key={generation.id}
        className={"scene-recovery-item" + (busy ? " busy" : "")}
        role="button"
        tabIndex={busy ? -1 : 0}
        onClick={() => !busy && void pick(generation)}
        onKeyDown={(event) => {
          // 항목 안의 참조칩(단추)에서 올라온 키는 그 단추의 것 — 크게 보려는 Enter 로 그 후보가 카드에 붙었다(조작 규칙 51)
          if (event.target !== event.currentTarget) return;
          if (!busy && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            void pick(generation);
          }
        }}
      >
        {thumb ? (
          <img className="scene-recovery-thumb" src={thumb} alt="" loading="lazy" />
        ) : (
          <span className="scene-recovery-thumb scene-recovery-thumb-empty" />
        )}
        <span className="scene-recovery-detail">
          <span className="scene-recovery-model">
            <ModelIcon /> {recoveryModelName(generation.model, generation.params) || generation.model || "모델 미상"}
          </span>
          <InlinePromptRefs
            displayPrompt={generation.display_prompt}
            prompt={generation.prompt || "(프롬프트 없음)"}
            references={generation.references}
            onPreview={(target) => onPreview?.(target)}
            className="scene-recovery-prompt"
            stopPropagation
          />
          <span className="scene-recovery-sub">
            {badge}
            {meta.resolution && (
              <span className="cd-chip">
                <GemIcon /> {meta.resolution}
              </span>
            )}
            {meta.duration && (
              <span className="cd-chip">
                <ClockIcon /> {meta.duration}
              </span>
            )}
            {meta.aspect && (
              <span className="cd-chip">
                <FrameIcon /> {meta.aspect}
              </span>
            )}
            <span className="scene-recovery-date">
              {formatGenerationDateTime(generation.created_at)}
            </span>
            {canvasRecovery?.claimingId === generation.id && <i>붙이는 중…</i>}
          </span>
        </span>
      </div>
    );
  };
  return <>
      {canvasRecovery && (
        <div
          className="scene-modelmodal-backdrop"
          onMouseDown={() => !canvasRecovery.claimingId && setCanvasRecovery(null)}
        >
          <div ref={recoveryRef} className="scene-modelmodal scene-recoverymodal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="scene-modelmodal-hd">
              <b>이 카드에 생성물 붙이기</b>
              <button
                className="scene-modelmodal-x"
                disabled={!!canvasRecovery.claimingId}
                onClick={() => setCanvasRecovery(null)}
              >
                ✕
              </button>
            </div>
            <div className="scene-comfymodal-body scene-recovery-list">
              {canvasRecovery.error ? (
                <div className="scene-recovery-error">{canvasRecovery.error}</div>
              ) : (
                <>
                  {/* ── 위 칸 '카드 생성물 복구' — 어느 카드에 있었는지 기록이 남아 있는 것 ── */}
                  <div className="scene-recovery-sect">
                    <div className="scene-recovery-sect-hd">
                      <span className="scene-recovery-sect-title lime">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 12a9 9 0 1 0 3-6.7" />
                          <path d="M3 4v5h5" />
                        </svg>
                        카드 생성물 복구
                      </span>
                      <span className="scene-recovery-count">{canvasRecovery.detached.length}</span>
                    </div>
                    <p className="scene-recovery-sect-sub">
                      어느 카드에 있었는지가 기록에 남아 있습니다. 가까운 순 — 이 카드 → 이 캔버스 → 다른 캔버스.
                    </p>
                    {canvasRecovery.loadingDetached ? (
                      <div className="scene-recovery-empty">이 캔버스 기록을 확인하는 중입니다…</div>
                    ) : canvasRecovery.detachedStatus === "unreadable" ? (
                      // ★로컬을 못 읽었으면 목록을 만들지 않는다 — 읽기 실패를 '전부 떨어짐'으로
                      //  바꾸면 멀쩡한 생성물이 전부 미아로 보인다(코덱스 P1).
                      <div className="scene-recovery-note">
                        <b>지금은 판정할 수 없습니다.</b> 이 브라우저의 캔버스 목록을 읽지 못해,
                        무엇이 떨어졌는지 가릴 수 없습니다. 창을 닫았다 다시 열어 보세요.
                      </div>
                    ) : canvasRecovery.detached.length ? (
                      canvasRecovery.detached.map((candidate) => {
                        const generation = canvasRecovery.detachedGens[candidate.generationId];
                        if (!generation) return null;
                        const tone =
                          candidate.origin === "this-card"
                            ? "this-card"
                            : candidate.origin === "other-scene"
                              ? "other-scene"
                              : "this-scene";
                        return renderRecoveryItem(
                          generation,
                          <span className={`scene-recovery-from ${tone}`}>
                            {tone === "other-scene" && <i aria-hidden="true" />}
                            {candidate.label}
                          </span>,
                          claimDetachedGeneration,
                        );
                      })
                    ) : (
                      <div className="scene-recovery-empty">
                        이 캔버스에서 떨어진 생성물은 없습니다.
                      </div>
                    )}
                    {/* 아직 다 못 본 자리가 있으면 반드시 길을 남긴다 — 쪽 상한에서 멈춘
                        채 '없습니다'로 끝내면 오래된 복구 대상에 영영 못 닿는다(코덱스 P1).
                        다른 캔버스는 훑어야 하는 범위라 누를 때만 읽는다. */}
                    {!canvasRecovery.loadingDetached &&
                      canvasRecovery.detachedStatus === "ok" &&
                      (canvasRecovery.detachedTotal > canvasRecovery.detachedShown ||
                        canvasRecovery.detachedNext ||
                        canvasRecovery.otherScenes !== "done") && (
                        <button
                          type="button"
                          className="scene-recovery-more"
                          disabled={canvasRecovery.otherScenes === "loading" || canvasRecovery.detachedExpanding}
                          aria-busy={canvasRecovery.otherScenes === "loading" || canvasRecovery.detachedExpanding || undefined}
                          onClick={() => void loadMoreDetached()}
                        >
                          {(canvasRecovery.otherScenes === "loading" || canvasRecovery.detachedExpanding) && (
                            <i className="busy-ring" aria-hidden="true" />
                          )}
                          {canvasRecovery.otherScenes === "loading"
                            ? "찾는 중…"
                            : canvasRecovery.detachedExpanding
                              ? `불러오는 중… (${canvasRecovery.detachedShown} / ${canvasRecovery.detachedTotal})`
                            : canvasRecovery.detachedTotal > canvasRecovery.detachedShown
                              ? `더 보기 (${canvasRecovery.detachedTotal - canvasRecovery.detachedShown}개 남음)`
                              : canvasRecovery.detachedNext
                                ? "더 찾기 (여기까지만 확인했습니다)"
                                : "다른 캔버스에서도 찾기"}
                        </button>
                      )}
                  </div>

                  <div className="scene-recovery-sep" />

                  {/* ── 아래 칸 '카드 생성물 담기' — 어느 카드에서 나왔는지 기록이 원래 없는 것 ── */}
                  <div className="scene-recovery-sect">
                    <div className="scene-recovery-sect-hd">
                      <span className="scene-recovery-sect-title">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        카드 생성물 담기
                      </span>
                      <span className="scene-recovery-count">{recoveryFiltered.length}</span>
                      <input
                        className="scene-recovery-search"
                        value={canvasRecovery.query}
                        placeholder="프롬프트·모델로 찾기"
                        aria-label="안 담긴 생성물 검색"
                        onChange={(event) =>
                          setCanvasRecovery((current) =>
                            current
                              ? { ...current, query: event.target.value, shown: RECOVERY_PAGE }
                              : current,
                          )
                        }
                      />
                    </div>
                    <p className="scene-recovery-sect-sub">
                      힉스필드 웹·다른 PC·카드 없이 만든 생성물입니다. 어느 카드에서 나왔는지는 기록이 없어 최신순입니다.
                    </p>
                    {canvasRecovery.loadingItems ? (
                      <div className="scene-recovery-empty">내 생성물을 확인하는 중입니다…</div>
                    ) : recoveryVisible.length ? (
                      <>
                        {recoveryVisible.map((generation) =>
                          renderRecoveryItem(generation, null, claimCanvasRecovery),
                        )}
                        {recoveryFiltered.length > recoveryVisible.length && (
                          <button
                            type="button"
                            className="scene-recovery-more"
                            onClick={() =>
                              setCanvasRecovery((current) =>
                                current
                                  ? { ...current, shown: current.shown + RECOVERY_PAGE }
                                  : current,
                              )
                            }
                          >
                            더 보기 ({recoveryFiltered.length - recoveryVisible.length})
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="scene-recovery-empty">
                        {recoveryQuery ? "찾는 말과 맞는 것이 없습니다." : "아직 어디에도 안 담긴 생성물이 없습니다."}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="scene-modelmodal-ft">
              <button disabled={!!canvasRecovery.claimingId} onClick={() => setCanvasRecovery(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

  </>;
}

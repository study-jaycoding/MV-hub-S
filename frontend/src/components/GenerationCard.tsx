// 결과 카드 — Higgsfield식 상호작용:
//  · 영상 썸네일 호버 시 자동 재생(음소거 루프), 벗어나면 정지
//  · 미디어 위 호버 오버레이 액션(정보·다운로드·미리보기·재생성·공유/가져오기)
//  · 좌상단 선택 체크박스(다중 선택 → 상단 일괄 작업 바)
// 그리드 모드 = 세로 카드, 리스트 모드 = 좌측 큰 썸네일 + 우측 상세 패널.
import { memo, useRef, useState } from "react";
import { api } from "../api";
import type { Generation, InfoTarget, PreviewTarget } from "../types";
import { DRAG_TYPES } from "../lib/dragTypes";
import { thumbUrl } from "../lib/media";
import { useClickSeparation } from "../lib/useClickSeparation";
import { MediaThumbnail } from "./MediaThumbnail";
import { useModelDisplayName } from "../lib/modelCatalog";
import {
  formatGenerationDate,
  generationListMeta,
  generationStatusLabel,
  generationStatusTitle,
} from "../lib/generationDisplay";
import { InlinePromptRefs, hasInlinePromptRefs } from "./common/InlinePromptRefs";
import { GenerationConfirmOverlay } from "./generation/GenerationConfirmOverlay";
import { GenerationCardStatusBar } from "./generation/GenerationCardStatusBar";
import { ClockIcon, FrameIcon, GemIcon, ModelIcon } from "./generation/GenerationCardIcons";
import { GenerationThumbOverlay } from "./generation/GenerationThumbOverlay";

interface Props {
  gen: Generation;
  tab: "my" | "team";
  myCreatorUid?: string | null; // 내 creator_uid — 팀 탭 '내 것/남의 것' 판별(worker_id 는 서버에서 항상 'me')
  layout?: "grid" | "list";
  fill?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onSetSource: (g: Generation, name: string | null, isSource: boolean) => void; // 인라인 소스 등록
  onSetTags: (g: Generation, tags: string[]) => void; // 인라인 태그 저장
  onOpenComments: (g: Generation) => void; // C → 공유 코멘트 스레드 패널 열기
  // 인라인 편집 — 그리드가 소유(버튼·단축키 공통). 이 카드가 편집 대상이면 field, 아니면 null.
  editingField?: "source" | "tag" | null;
  onRequestEdit: (g: Generation, field: "source" | "tag") => void;
  onEditDone: () => void;
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onFinalize: (g: Generation) => void; // v02 CMS: Supervisor 최종(골드) 지정
  onUnfinalize: (g: Generation) => void; // 최종 해제
  canFinalize?: (g: Generation) => boolean; // 그 프로젝트 supervisor/PM 일 때만 최종 가능(없으면 허용)
  onImport: (g: Generation) => void;
  onRestore: (g: Generation) => void; // 휴지통 복구
  dimDeleted?: boolean; // 지운 카드 흐림('함께 보기'만 true)
  onColor: (g: Generation, color: string | null) => void;
  onTags: (g: Generation) => void;
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
  onShowHistory?: (g: Generation) => void; // 히스토리 뱃지 클릭 → 가계 패널
  autoTagOptions?: string[]; // 내 전역(auto) 태그 목록 — 태그 에디터에서 # 한 번 더로 카드에 부여/해제
  onSetAutoTags?: (g: Generation, names: string[]) => void;
  onBulkAddTags?: (g: Generation, names: string[]) => void; // 다중선택 시 추가를 선택 전체에 적용
  onBulkRemoveTags?: (g: Generation, names: string[]) => void; // 다중선택 시 ×해제를 선택 전체에(공통 삭제)
  onBulkAddAutoTags?: (g: Generation, names: string[]) => void; // 다중선택 시 전역 부여를 선택 전체에
  onBulkRemoveAutoTags?: (g: Generation, names: string[]) => void; // 다중선택 시 전역 해제를 선택 전체에
  selectedCount?: number; // 이 카드가 다중선택에 포함될 때 N(에디터에 '선택 N개에 적용' 표시)
  tagEditing?: boolean; // 다중선택 태그 편집 활성(편집 카드가 선택에 포함). 선택된 비포커스 카드에 스트립 표시
  tagGlobalMode?: boolean; // 포커스 에디터가 전역 모드인지 — 스트립 배지를 '전역 적용'으로
  onGlobalModeChange?: (on: boolean) => void; // 포커스 에디터의 전역모드 토글 보고
}

function GenerationCardImpl({
  gen,
  tab,
  myCreatorUid,
  layout,
  fill = true,
  selected = false,
  onToggleSelect,
  onSetSource, // (생성탭 S는 공유로 전환 — 소스 편집 경로는 사용 안 함, 에디터 호환용으로만 유지)
  onSetTags,
  autoTagOptions,
  onSetAutoTags,
  onBulkAddTags,
  onBulkRemoveTags,
  onBulkAddAutoTags,
  onBulkRemoveAutoTags,
  selectedCount,
  tagEditing,
  tagGlobalMode,
  onGlobalModeChange,
  onOpenComments,
  editingField,
  onEditDone,
  onRegenerate,
  onPublish,
  onUnpublish,
  onFinalize,
  onUnfinalize,
  canFinalize,
  onImport,
  onRestore,
  dimDeleted = true,
  onInfo,
  onPreview,
  onShowHistory,
}: Props) {
  const modelName = useModelDisplayName();
  const asset = gen.assets[0];
  const isVideo = asset?.type === "video";
  const rawThumb = asset?.thumbnail_path || (!isVideo ? asset?.file_path : null);
  // 리사이즈 썸네일(작은 이미지 디코딩 → 그리드 즉시 표시). 로컬 /media·공유받은 원격 URL 모두 적용.
  const thumb = thumbUrl(rawThumb, 512);
  const isList = layout === "list";
  const videoRef = useRef<HTMLVideoElement>(null);
  // T 버튼 → 적용된 태그 목록 팝업(보기/✕삭제). 태그 '입력'은 # 키(editingField) 로만 — 에셋과 동일.
  // v02 CMS — S 더블클릭 → 최종(골드) 확인 플로팅. 단일클릭(공유 토글)과 충돌 방지용 타이머.
  const [confirmFinal, setConfirmFinal] = useState(false);
  const [confirmShare, setConfirmShare] = useState(false); // S 단일클릭 → 공유/해제 확인(최종과 동일 UX)
  const sClick = useClickSeparation(220); // 단일(공유)/더블(최종) 분리
  const onSClick = () => {
    if (!gen.is_mine) return; // 공유/해제는 본인 생성물만 — 다른 사람은 S 를 눌러도 무반응
    sClick.onClick(() => {
      if (gen.is_final) return; // 최종(골드)은 공유 잠금 — 해제는 더블클릭으로만
      setConfirmShare(true); // 즉시 토글하지 않고 확인 플로팅을 띄운다("공유 하시겠습니까?")
    });
  };
  const confirmShareYes = () => {
    setConfirmShare(false);
    gen.shared ? onUnpublish(gen) : onPublish(gen);
  };
  const onSDouble = () =>
    sClick.onDouble(() => {
      setConfirmShare(false); // 더블클릭(최종)이면 공유 확인은 닫는다
      // 최종(골드) 지정/해제는 그 프로젝트 supervisor/PM 만 — 권한 없으면 확인창을 띄우지 않는다.
      const mayFinalize = canFinalize ? canFinalize(gen) : true;
      if (!mayFinalize) {
        // 권한 없음: 본인 미공유면 더블클릭으로 공유만 켜고, 그 외엔 무반응.
        if (gen.is_mine && !gen.shared && !gen.is_final) onPublish(gen);
        return;
      }
      // 최종 지정/해제는 S 활성(공유)된 상태에서만. 비활성이면 더블클릭은 공유만 켠다.
      if (gen.shared || gen.is_final) {
        setConfirmFinal(true);
      } else {
        onPublish(gen);
      }
    });
  const confirmFinalYes = () => {
    setConfirmFinal(false);
    gen.is_final ? onUnfinalize(gen) : onFinalize(gen);
  };

  // S/★ 버튼 노출 판정 — 본인 카드뿐 아니라:
  //  · 최종 권한자(그 프로젝트 supervisor/global admin)는 '공유된' 남의 카드에도 S 가 보여 최종 지정 가능
  //  · 최종(골드) 카드는 누구에게나 ★ 가 보인다(권한 없으면 읽기전용 표식 — 더블클릭은 무반응)
  const mayFinalize = canFinalize ? canFinalize(gen) : true;
  const showSF = gen.is_mine || gen.is_final || (gen.shared && mayFinalize);

  const params = (gen.params || {}) as Record<string, unknown>;

  const previewName = gen.prompt.slice(0, 50) || "(제목 없음)";
  const openPreview = () => {
    if (asset)
      onPreview({ url: asset.file_path, type: asset.type, name: previewName, genId: gen.id });
  };
  // 카드를 프롬프트로 드래그 → 그 프롬프트+옵션 재사용(SpotlightPrompt 드롭). gen id 만 실음.
  const onCardDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPES.generation, gen.id);
    e.dataTransfer.effectAllowed = "copy";
  };
  const onEnter = () => {
    const v = videoRef.current;
    if (v) v.play().catch(() => {});
    // 코멘트가 있는 카드면 호버 시 미리 불러둔다 → 클릭하면 즉시 표시(체감 딜레이 제거).
    if (gen.comment_count) api.prefetchGenComments(gen.id);
  };
  const onLeave = () => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
  };

  const thumbBox = (
    <div
      className="card-thumb"
      // 리스트: 미디어 종횡비와 무관하게 행 높이를 꽉 채우는 정사각(에셋 리스트와 동일 — 이미지·영상 동일 크기)
      style={isList ? { aspectRatio: "1 / 1" } : undefined}
      title={isList ? "클릭 = 미리보기 · 휠클릭 = 정보" : "클릭 = 선택 · 더블클릭 = 미리보기 · 휠클릭 = 정보"}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={isList ? openPreview : undefined}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onInfo({ kind: "generation", gen, x: e.clientX, y: e.clientY });
        }
      }}
    >
      <MediaThumbnail
        thumb={thumb}
        isVideo={isVideo}
        src={asset?.file_path}
        alt={gen.prompt}
        videoRef={videoRef}
        fallback={
          <div
            className={`thumb-placeholder status-${gen.status}`}
            title={
              generationStatusTitle(gen.status, gen.error)
            }
          >
            {gen.status === "running" || gen.status === "pending" ? (
              // 생성중(대기·실행 모두) — 글씨 대신 스피너 아이콘 + '생성중' 캡션.
              <span className="gen-generating">
                <span className="gen-spinner" aria-hidden />
                <span className="gen-generating-label">생성중</span>
              </span>
            ) : (
              generationStatusLabel(gen.status)
            )}
          </div>
        }
      />

      {gen.is_source && (
        <span className="source-badge" title="소스로 등록됨">
          @{gen.source_name || "source"}
        </span>
      )}
      {/* 다른 작업자가 만든 결과물 — 카드 우측 상단 뱃지(상시 표시). */}
      {!gen.is_mine && (
        <span
          className="creator-badge"
          title={`다른 작업자가 생성: ${gen.creator_name || gen.creator_uid || ""}`}
        >
          👤 {gen.creator_name || "팀원"}
        </span>
      )}
      {/* 좌상단 액션 — S(공유/최종)·C(코멘트). 비활성=호버 시에만 보임.
          S: 본인 카드는 공유/최종 토글, 최종 권한자(supervisor/admin)는 남의 공유본도 최종 지정.
          ★: 최종(골드)이면 누구에게나 표시. C: 미확인 코멘트가 있으면 항상 떠 있다가 확인하면 숨김. */}
      <div className="card-tl">
        {showSF && (
          <button
            className={"card-sf" + (gen.shared ? " on" : "") + (gen.is_final ? " final" : "")}
            title={
              gen.is_final
                ? mayFinalize
                  ? "최종(골드) — 더블클릭=최종 해제 (공유 잠금)"
                  : "최종(골드)"
                : gen.is_mine
                  ? gen.shared
                    ? "팀에 공유됨 · 클릭=공유 해제 · 더블클릭=최종 지정(Supervisor)"
                    : "팀에 공유 (클릭) · 최종 지정은 공유 후 더블클릭"
                  : "더블클릭=최종 지정(Supervisor)"
            }
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSClick();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onSDouble();
            }}
          >
            {gen.is_final ? "★" : "S"}
          </button>
        )}
        <button
          className={"card-cm" + (gen.has_unread ? " alert" : "")}
          title={
            gen.has_unread
              ? `새 코멘트 · 총 ${gen.comment_count}개 (열어서 확인)`
              : gen.comment_count
                ? `코멘트 ${gen.comment_count}개 (c)`
                : "코멘트 스레드 열기 (c)"
          }
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpenComments(gen);
          }}
        >
          C
        </button>
      </div>
      {/* 좌상단 드래그 그립(S 버튼 밑) — 끌어내려 프롬프트 재사용(불러오기). 레퍼런스로 쓰려면 @ 버튼. */}
      <span
        className="card-drag-grip"
        draggable
        title="프롬프트로 끌어내려 재사용(프롬프트·옵션 불러오기) · 레퍼런스로는 @ 버튼"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(DRAG_TYPES.generation, gen.id);
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        ⠿
      </span>
      {/* 가계(히스토리)는 좌상단 뱃지 대신 호버 오버레이의 '가계 보기' 버튼(공유 자리)으로 연다. */}
      {isVideo && <span className="play-badge">▶</span>}
      {/* 미디어가 있을 때만 하단 상태 라벨 — 미디어 없으면 placeholder가 이미 표시(중복 방지) */}
      {gen.status !== "done" && (!!thumb || (isVideo && !!asset)) && (
        <span
          className={`status-pill status-${gen.status}`}
          title={
            generationStatusTitle(gen.status, gen.error)
          }
        >
          {generationStatusLabel(gen.status)}
        </span>
      )}

      <GenerationThumbOverlay
        asset={asset}
        gen={gen}
        isList={isList}
        myCreatorUid={myCreatorUid}
        selected={selected}
        tab={tab}
        onInfo={onInfo}
        onImport={onImport}
        onRegenerate={onRegenerate}
        onRestore={onRestore}
        onShowHistory={onShowHistory}
        onToggleSelect={onToggleSelect}
      />
    </div>
  );

  // 하단 영역: 모든 버튼(S·T·C)·작업자 표시가 카드 위(좌상단 card-tl / 우상단 creator-badge)로 이전됨.
  //  → 평소엔 하단 바를 두지 않고, (1) 소스/태그 인라인 편집 중이거나 (2) r/g/b 컬러가 있을 때만 표시.
  //  편집 중 = 입력 바, 컬러만 = 얇은 컬러 마커 스트립(그리드). 리스트는 자체 list-color-bar 가 색 담당.
  const statusBar = (
    <GenerationCardStatusBar
      gen={gen}
      isList={isList}
      selected={selected}
      editingField={editingField}
      selectedCount={selectedCount}
      tagEditing={tagEditing}
      tagGlobalMode={tagGlobalMode}
      autoTagOptions={autoTagOptions}
      onSetSource={onSetSource}
      onSetTags={onSetTags}
      onSetAutoTags={onSetAutoTags}
      onBulkAddTags={onBulkAddTags}
      onBulkRemoveTags={onBulkRemoveTags}
      onBulkAddAutoTags={onBulkAddAutoTags}
      onBulkRemoveAutoTags={onBulkRemoveAutoTags}
      onGlobalModeChange={onGlobalModeChange}
      onEditDone={onEditDone}
    />
  );

  // 공유/최종 확인 — 카드 '전체'를 덮는 오버레이(보드 노드와 동일한 .sconfirm 모양으로 통일).
  const cardConfirm = (confirmShare || confirmFinal) && (
    <GenerationConfirmOverlay
      mode={confirmFinal ? "final" : "share"}
      shared={gen.shared}
      isFinal={!!gen.is_final}
      onYes={confirmFinal ? confirmFinalYes : confirmShareYes}
      onNo={() => {
        setConfirmFinal(false);
        setConfirmShare(false);
      }}
    />
  );

  // ── 리스트 모드 ──
  if (isList) {
    const { resolution, duration, aspect } = generationListMeta(params);
    const ref = gen.references[0];
    const rawRefThumb = ref?.thumbnail_path || ref?.file_path;
    const refThumb = thumbUrl(rawRefThumb, 256);
    // 프롬프트의 @소스 토큰을 레퍼런스 썸네일 칩으로 치환(InfoPopup 과 동일 로직)
    const promptHasInlineRefs = hasInlinePromptRefs(gen.display_prompt, gen.references);

    return (
      <div
        className={
          "card list" +
          (fill ? "" : " contain") +
          (selected ? " selected" : "") +
          (gen.is_final ? " final" : "") +
          (gen.deleted && dimDeleted ? " deleted" : "")
        }
        draggable
        onDragStart={onCardDragStart}
      >
        {cardConfirm}
        {thumbBox}
        {gen.color && <div className="list-color-bar" style={{ background: gen.color }} />}
        <div className="card-detail">
          <div className="cd-model">
            <ModelIcon />
            {modelName(gen.model)}
          </div>
          {promptHasInlineRefs ? (
            // 프롬프트의 @소스 자리를 실제 레퍼런스 썸네일로 인라인 표시(어떤 이미지가 어디 들어갔는지)
            <div className="cd-prompt cd-prompt-rich" title={gen.display_prompt || gen.prompt}>
              <InlinePromptRefs
                displayPrompt={gen.display_prompt}
                prompt={gen.prompt}
                references={gen.references}
                onPreview={onPreview}
                className="cd-prompt-inline"
                stopPropagation
              />
            </div>
          ) : (
            <>
              <div className="cd-prompt" title={gen.display_prompt || gen.prompt}>
                {gen.display_prompt || gen.prompt || "(프롬프트 없음)"}
              </div>
              {refThumb && (
                <div className="cd-refs">
                  <img src={refThumb} className="cd-ref-thumb" title={ref?.role || "레퍼런스"} alt="reference" />
                </div>
              )}
            </>
          )}
          <div className="cd-meta">
            {resolution && (
              <span className="cd-chip">
                <GemIcon /> {resolution}
              </span>
            )}
            {duration && (
              <span className="cd-chip">
                <ClockIcon /> {duration}
              </span>
            )}
            {aspect && (
              <span className="cd-chip">
                <FrameIcon /> {aspect}
              </span>
            )}
          </div>
          <div className="cd-foot">
            <span className="cd-date">{formatGenerationDate(gen.created_at)}</span>
          </div>
          {statusBar}
        </div>
      </div>
    );
  }

  // ── 그리드 모드 ── 정사각 썸네일 + 하단 컬러/S·T·C 바(에셋 파트와 동일). 액션은 호버 오버레이.
  return (
    <div
      className={
        "card card-grid" +
        (fill ? "" : " contain") +
        (selected ? " selected" : "") +
        (gen.is_final ? " final" : "") +
        (gen.deleted && dimDeleted ? " deleted" : "")
      }
      draggable
      onDragStart={onCardDragStart}
    >
      {cardConfirm}
      {thumbBox}
      {statusBar}
    </div>
  );
}

// (모델 표시명은 lib/modelCatalog 의 공유 헬퍼로 일원화 — 카드·비교·정보팝업이 같은 이름을 쓴다)

// React.memo — 콜백을 ThumbnailGrid 가 안정 참조로 넘기므로(props 스프레드 제거), 선택/포커스/편집
// 등 '다른 카드' 상태 변경 때 이 카드의 props(gen·selected·editingField…)가 안 바뀌면 재렌더를
// 건너뛴다. gen 객체가 새로 오면(reload) 재렌더되는 건 정상(데이터 변경).
export const GenerationCard = memo(GenerationCardImpl);

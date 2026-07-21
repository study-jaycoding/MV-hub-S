// 정보 팝업 — 이미지/동영상 휠(중간)클릭 시 뜨는 플로팅 글래스 창.
// (예전 Assets 플로팅 패널의 '구성'을 이 정보 팝업에 재사용)
// 헤더를 잡고 드래그해 옮긴다. Esc/바깥 클릭으로 닫음.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useModelDisplayName } from "../lib/modelCatalog";
import { displayThumb } from "../lib/media";
import { refSrc } from "../lib/promptParts";
import { useEscapeClose } from "../lib/useEscapeClose";
import { addWindowPointerDrag, removeWindowPointerDrag } from "../lib/windowDrag";
import type { Generation, InfoTarget, PreviewTarget, Project, Reference } from "../types";
import { InlinePromptRefs } from "./common/InlinePromptRefs";

interface Props {
  target: InfoTarget;
  onClose: () => void;
  onPreview: (t: PreviewTarget) => void; // 소스/칩 클릭 → 크게 보기
  projects?: Project[]; // 프로젝트 이름 표시용(목록에서 uuid→이름 매핑)
  onOpenInBoard?: (g: Generation) => void; // 구성탭에서 원본→파생 트리로 보기
}

const POP_W = 380;

function clampStart(x: number, y: number) {
  const left = Math.min(Math.max(8, x + 8), window.innerWidth - POP_W - 8);
  const top = Math.min(Math.max(8, y + 8), window.innerHeight - 200);
  return { x: left, y: top };
}

function formatElapsed(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}분 ${rem}초` : `${m}분`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

export function InfoPopup({ target, onClose, onPreview, projects, onOpenInBoard }: Props) {
  // 레퍼런스(소스) → 크게 보기. 원본(asset 토큰/URL/로컬) 우선, 없으면 썸네일.
  const openSource = (r: Reference) => {
    const url = refSrc(r.file_path) || refSrc(r.thumbnail_path) || refSrc(r.source_url);
    if (url) onPreview({ url, type: r.type, name: r.role || "source" });
  };
  const [pos, setPos] = useState(() => clampStart(target.x, target.y));
  const [dim, setDim] = useState<string>("");
  const [credits, setCredits] = useState<number | null>(null); // 견적(폴백)
  const [metrics, setMetrics] = useState<{
    est_credits: number | null;
    real_credits: number | null;
    credit_source: string | null;
    elapsed_seconds: number | null;
  } | null>(null); // 실제 크레딧·소요시간(있으면 우선)
  const modelName = useModelDisplayName();
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEscapeClose(onClose);

  // 크레딧 — 실제 사용값(generation_metrics.real_credits) 우선, 없으면 모델+옵션 견적(/api/cost) 폴백.
  // 소요시간(elapsed_seconds)도 metrics 에서 함께 받는다.
  useEffect(() => {
    if (target.kind !== "generation") return;
    setCredits(null);
    setMetrics(null);
    const g = target.gen;
    api
      .estimateCost(g.model || "", (g.params || {}) as Record<string, unknown>, g.prompt)
      .then((r) => setCredits(r.credits))
      .catch(() => setCredits(null));
    api.generationMetrics(g.id).then(setMetrics).catch(() => setMetrics(null));
  }, [target]);

  const onDragStart = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    addWindowPointerDrag(onDragMove, onDragEnd);
  };
  const onDragMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  };
  const onDragEnd = () => {
    drag.current = null;
    removeWindowPointerDrag(onDragMove, onDragEnd);
  };

  // ── 대상별 미리보기 URL / 제목 / 정보 행 ──
  let title = "";
  let previewUrl: string | null = null;
  let posterUrl: string | null = null; // 영상 포스터(CLI 정적 썸네일) — <video poster> 용
  let isVideo = false;
  let rows: React.ReactNode = null;
  let sources: React.ReactNode = null;

  if (target.kind === "generation") {
    const g = target.gen;
    const asset = g.assets[0];
    isVideo = asset?.type === "video";
    // 영상: 실제 영상이 <video> src, thumbnail_path(CLI 정적 포스터)는 poster 로 분리(포스터를 src 로
    // 쓰면 영상이 안 나온다). 이미지: 상세 뷰는 원본(file_path) 우선 — thumbnail_path 가 경량 min-url
    // 이면 확대 시 흐려지므로. 브라우저가 CDN 에서 직접 로드(서버 캐시 안 함), 없을 때만 썸네일 폴백.
    if (isVideo) {
      previewUrl = asset ? asset.file_path : null;
      posterUrl = asset?.thumbnail_path || null;
    } else {
      previewUrl = asset ? asset.file_path || asset.thumbnail_path : null;
    }
    title = g.prompt.slice(0, 60) || "(제목 없음)";
    const params = (g.params || {}) as Record<string, unknown>;
    rows = (
      <>
        <Row label="모델" value={modelName(g.model)} />
        {g.status === "failed" && (
          <div className="info-error">
            <span className="info-error-label">⚠ 실패 사유</span>
            <span className="info-error-text">{g.error || "사유 정보 없음 (옛 생성)"}</span>
          </div>
        )}
        <Row label="비율" value={params.aspect_ratio as string} />
        <Row label="해상도" value={params.resolution as string} />
        <Row label="생성일" value={g.created_at} />
        <Row
          label={metrics?.real_credits != null ? "크레딧(실제)" : "크레딧(견적)"}
          value={
            metrics?.real_credits != null
              ? `${metrics.real_credits} credits`
              : credits != null
                ? `${credits} credits`
                : "조회 중…"
          }
        />
        {metrics?.elapsed_seconds != null && (
          <Row label="생성 시간" value={formatElapsed(metrics.elapsed_seconds)} />
        )}
        <Row
          label="생성자"
          // 표시이름만 노출(uid·이메일·worker 식별자는 절대 안 보임). 이름 미정이면 나/팀원.
          value={g.creator_name || (g.is_mine ? "나" : "팀원")}
        />
        {/* 이 생성물이 실제 속한 프로젝트만 표시(전체 목록 드롭다운 제거) */}
        <Row
          label="프로젝트"
          value={
            g.project_id
              ? (projects || []).find((p) => p.id === g.project_id)?.name ||
                g.project_name ||
                "(이름 없음)" // 내부 식별자(uuid)는 절대 노출하지 않는다
              : "미분류"
          }
        />
        {/* 적용된 태그(#) · 전역 태그 — 이 생성물에 붙은 것만 */}
        <Row
          label="태그"
          value={g.tags.length ? g.tags.map((t) => `#${t}`).join("  ") : null}
        />
        <Row
          label="전역 태그"
          value={g.auto_tags?.length ? g.auto_tags.map((t) => `#${t}`).join("  ") : null}
        />
        <Row
          label="프롬프트"
          value={
            <InlinePromptRefs
              displayPrompt={g.display_prompt}
              prompt={g.prompt}
              references={g.references}
              onPreview={onPreview}
            />
          }
        />
      </>
    );
    // 사용된 소스(레퍼런스) — 출처를 한눈에. 재사용·변형의 핵심.
    if (g.references.length) {
      sources = (
        <div className="info-sources">
          <div className="info-sources-head">
            사용된 소스 {g.references.length}개
          </div>
          <div className="info-sources-grid">
            {g.references.map((r) => (
              <button
                type="button"
                className="info-source"
                key={r.id}
                title={`${r.role || "소스"} — 크게 보기`}
                onClick={() => openSource(r)}
              >
                {r.type === "video" ? (
                  <video
                    src={refSrc(r.file_path)}
                    poster={displayThumb(r.thumbnail_path || r.file_path) || undefined}
                    muted
                    preload="metadata"
                  />
                ) : (
                  <img
                    src={displayThumb(r.thumbnail_path || r.file_path) || undefined}
                    alt={r.role || "source"}
                  />
                )}
                <span className="info-source-role">{r.role || "@"}</span>
                {r.cached && <span className="info-source-dot" title="로컬 보관됨" />}
              </button>
            ))}
          </div>
        </div>
      );
    }
  } else {
    const { project, node, meta } = target;
    previewUrl = api.assetFileUrl(project, node.path);
    isVideo = node.type === "video";
    title = node.name;
    const typeLabel = node.type === "video" ? "영상" : node.type === "audio" ? "오디오" : "이미지";
    rows = (
      <>
        <Row label="프로젝트" value={project} />
        <Row label="타입" value={typeLabel} />
        <Row
          label="경로"
          value={
            <button
              className="info-path-btn"
              title="원본 위치 열기 (탐색기)"
              onClick={() => {
                api.revealAsset(project, node.path).catch((e) => alert(`원본 위치 열기 실패: ${e}`));
              }}
            >
              <span className="info-path">{node.path}</span>
              <span className="info-path-icon">↗</span>
            </button>
          }
        />
        <Row label="해상도" value={dim || null} />
        <Row
          label="소스"
          value={meta?.is_source ? `@${meta.source_name || node.name.replace(/\.[^.]+$/, "")}` : null}
        />
        <Row label="태그" value={meta?.tags?.length ? meta.tags.join(", ") : null} />
        <Row
          label="컬러"
          value={
            meta?.color ? (
              <span className="info-color">
                <span className="info-swatch" style={{ background: meta.color }} />
                {meta.color}
              </span>
            ) : null
          }
        />
      </>
    );
  }

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="info-popup" style={{ left: pos.x, top: pos.y, width: POP_W }}>
        <header className="info-head" onPointerDown={onDragStart}>
          <span className="info-title" title={title}>
            {target.kind === "generation" ? "ℹ 생성 정보" : "ℹ 파일 정보"}
          </span>
          {target.kind === "generation" && onOpenInBoard && (
            <button
              className="info-board-btn"
              title="구성탭에서 원본 → 파생 트리로 보기"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpenInBoard(target.gen)}
            >
              ⧉ 히스토리 보기
            </button>
          )}
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>
        <div className="info-body">
          {previewUrl && (
            <div className="info-preview">
              {isVideo ? (
                <video src={previewUrl} poster={posterUrl || undefined} muted controls preload="metadata" />
              ) : (
                <img
                  src={previewUrl}
                  alt={title}
                  onLoad={(e) => {
                    const im = e.currentTarget;
                    if (im.naturalWidth) setDim(`${im.naturalWidth}×${im.naturalHeight}`);
                  }}
                />
              )}
            </div>
          )}
          <div className="info-rows">{rows}</div>
          {sources}
        </div>
      </div>
    </>
  );
}

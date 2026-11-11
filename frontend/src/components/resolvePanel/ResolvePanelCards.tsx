// 리졸브 안 MV 창의 카드 — 다빈치 미디어 풀처럼 보기 셋(썸네일·메타데이터·목록). 누르기 = 준비, dragstart = 패널 끌기(useResolvePanel.drag).
//  썸네일 칸은 편집 탭 카드(EditCard → 라이브러리 카드)를 그대로 써서 색 띠·★·보류·태그와 S·T 단추가 앱과 같이 동작한다(C·ⓘ 는 CSS 로 숨김).
import type { DragEvent, PointerEvent } from "react";
import type { Generation } from "../../types";
import type { PoolView } from "../../lib/editTimelineStore";
import { useT } from "../../lib/i18n";
import { MediaThumbnail } from "../MediaThumbnail";
import { EditCard, type PoolCardActions } from "../timeline/EditCard";

export interface PanelCardState { message?: string; retry?: boolean }

const duration = (gen: Generation) => (gen.params?.duration ? `${String(gen.params.duration)}s` : "");

export function ResolvePanelCard({ gen, view, size, state, bridge, actions, tagging, onTagging, onPrepare, onDrag, onRetry }: {
  gen: Generation;
  view: PoolView;
  size: number;
  state?: PanelCardState;
  bridge: boolean; // 리졸브 안 창(끌기 다리 있음) — 밖이면 상태 줄을 그리지 않는다(읽기 전용)
  actions: PoolCardActions;
  tagging: boolean;
  onTagging: (on: boolean) => void;
  onPrepare: () => void;
  onDrag: (event: DragEvent) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const asset = gen.assets[0];
  const who = gen.creator_name || gen.worker_name || t("작성자 미상");
  const marks = <>{gen.is_final && <b className="resolve-panel-final">★ {t("최종")}</b>}{gen.is_held && <b className="rp-held">{t("보류")}</b>}</>;
  const status = bridge && (
    <div className="resolve-panel-card-state" role="status">{state?.message || t("카드를 누르면 준비합니다")}
      {state?.retry && <button onPointerDown={event => event.stopPropagation()} onClick={onRetry}>{t("다시 확인")}</button>}
    </div>
  );
  // 단추·입력칸(T 편집·S 창) 누름은 준비가 아니다. 끌기는 잡는 단계에서 받아 라이브러리 카드의 HTML 끌기(프롬프트 재사용)로 가지 않게 한다.
  const grab = {
    draggable: true,
    onPointerDownCapture: (event: PointerEvent) => { if (!(event.target as HTMLElement).closest("button, input, textarea")) onPrepare(); },
    onDragStartCapture: (event: DragEvent) => { event.stopPropagation(); onDrag(event); },
  };
  const thumb = (className: string) => (
    <MediaThumbnail className={className} thumb={asset?.thumbnail_path || (asset?.type === "image" ? asset.file_path : null)}
      src={asset?.file_path} isVideo={asset?.type === "video"} alt={gen.model || t("공유물")} fallback={<span>◇</span>} />
  );
  const color = (gen.is_final || gen.color) && (
    <span className={"ed-pcolor" + (gen.is_final ? " ed-pgold" : "")} style={gen.is_final ? undefined : { background: gen.color! }} />
  );

  if (view === "list") return (
    <article className="rp-list" {...grab}>
      {color || <span />}
      <span>{who} {marks}</span><span>{gen.model || "—"}</span><span>{duration(gen)}</span>
      <span>{status || new Date(gen.created_at).toLocaleDateString()}</span>
    </article>
  );
  if (view === "meta") return (
    <article className="rp-meta" {...grab}>
      <div className="ed-pthumb" style={{ width: size }}>{thumb("rp-meta-img")}{color}</div>
      <div className="ed-pinfo">
        <b><span className="ed-pline">{who}</span>{marks}</b>
        <span className="ed-pline">{gen.model || "—"}{duration(gen) && ` · ${duration(gen)}`}</span>
        <span className="ed-pline">{new Date(gen.created_at).toLocaleString()}</span>
        <span className="ed-pprompt">{gen.prompt.slice(0, 400)}</span>
        {status}
      </div>
    </article>
  );
  return (
    <article className="rp-tile" style={{ width: size }} {...grab}>
      <EditCard item={{ gen, track: null, showing: false }} picked={false} handlers={{ title: t("끌어서 리졸브 타임라인에 넣기") }}
        actions={actions} tagging={tagging} onTagging={onTagging} />
      <div className="rp-tile-name">{who} · {gen.model || "—"} {duration(gen)} {marks}</div>
      {status}
    </article>
  );
}

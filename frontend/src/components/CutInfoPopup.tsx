// 컷 정보 — 컷 카드에서 휠 클릭하면 뜨는 창(정보 창 InfoPopup 과 같은 틀·같은 클래스). Jay 2026-10-08.
//  위 = 표지(팀이 정한 대표, 없으면 가장 최근 것). 가운데 = 그 폴더의 생성물을 **모두** 받아 센 집계(건수·작업자·크레딧·생성일·
//  길이·모델·검토). 아래 = 그 생성물들(누르면 크게 보기, ★ 로 대표 정하기).
//  목록은 폴더 창과 같은 조회(folderPeekQuery)를 끝까지 넘겨 받는다 — 첫 쪽만 세면 카드의 건수와 어긋난다(Codex 설계 검토).
//  ponytail: 크레딧은 건마다 metrics 요청 — 컷이 수백 건이면 묶음 조회 API 로.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { askMetrics } from "../lib/coverCredits";
import { inFolder, summarizeCut, type CutMetrics } from "../lib/cutSummary";
import { FETCH_ALL_MAX, fetchAllGenerations } from "../lib/fetchAllGenerations";
import { formatCredits } from "../lib/formatCredits";
import { formatGenerationDateTime } from "../lib/generationDisplay";
import { useT } from "../lib/i18n";
import { thumbOf } from "../lib/media";
import { useModalFocus } from "../lib/keyGate";
import { useModelDisplayName } from "../lib/modelCatalog";
import { useEscapeClose } from "../lib/useEscapeClose";
import { addWindowPointerDrag, keepHeadReachable, removeWindowPointerDrag } from "../lib/windowDrag";
import type { FolderCard, GenQuery, Generation, PreviewItem, PreviewTarget } from "../types";
import { CloseIcon } from "./common/ViewIcons";
import { MediaThumbnail } from "./MediaThumbnail";

interface Props {
  folder: FolderCard;
  x: number;
  y: number;
  query: GenQuery; // 그 폴더의 목록 조회(폴더 창과 같은 것) — 호출하는 쪽이 메모해 둔다
  savingRep: boolean; // 대표를 저장하는 동안 ★ 를 잠근다
  previewOpen: boolean; // 크게 보기가 위에 떠 있으면 Esc 는 그쪽 몫
  onClose: () => void;
  onOpen: (folder: FolderCard) => void; // [폴더 열기]
  onPreview: (target: PreviewTarget) => void;
  // 돌려주는 값이 false(저장 실패)면 이 창의 목록을 다시 받는다 — 그사이 남이 옮기거나 지운 생성물이 남아 같은 실패를 되풀이하지 않게(50회차)
  onPickCover: (folder: FolderCard, g: Generation) => void | Promise<boolean | undefined>;
}

const POP_W = 420;
const MAX = FETCH_ALL_MAX; // 목록은 이만큼까지(4쪽) — 넘으면 '최근 N건 기준'. 프로젝트만 골랐을 때의 카드는 에피소드라 수천 건일 수 있다
const METRICS_MAX = 200; // 크레딧은 건마다 요청이라 이보다 많으면 집계하지 않는다
const METRICS_AT_ONCE = 4; // 그 요청을 한꺼번에 보내는 수
const STRIP_MAX = 200; // 아래 생성물 줄도 이만큼만(그 뒤는 '외 N건') — 수천 장의 썸네일을 한 창에 그리지 않는다

function clampStart(x: number, y: number) {
  return { x: Math.min(Math.max(8, x + 8), window.innerWidth - POP_W - 8), y: Math.min(Math.max(8, y + 8), window.innerHeight - 200) };
}

// 폴더 창과 같은 조회를 커서로 끝까지(상한 MAX). 대소문자가 다른 폴더가 섞여 오므로(서버 LIKE) 경로로 다시 거른다.
//  alive() 가 거짓이면(창을 닫았거나 다른 폴더로) 다음 쪽을 받지 않는다.
async function fetchFolder(query: GenQuery, path: string, alive: () => boolean): Promise<{ gens: Generation[]; truncated: boolean } | null> {
  const got = await fetchAllGenerations(query, alive); // 끝까지 받기는 '목록에서 직접 묶는 폴더 카드'와 같이 쓴다
  return got && { gens: inFolder(got.gens, path), truncated: got.truncated };
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

export function CutInfoPopup({ folder, x, y, query, savingRep, previewOpen, onClose, onOpen, onPreview, onPickCover }: Props) {
  const t = useT();
  const modelName = useModelDisplayName();
  useEscapeClose(onClose, !previewOpen);
  const [pos, setPos] = useState(() => clampStart(x, y));
  const [gens, setGens] = useState<Generation[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [metrics, setMetrics] = useState<Map<string, CutMetrics | null> | null>(null); // null = 아직 받는 중
  const [refetch, setRefetch] = useState(0); // 대표 지정이 실패하면 올린다 — 목록을 다시 받는다
  const [error, setError] = useState<string | null>(null);

  // 머리 끌기 — 리스너는 창 전역, 언마운트 때 반드시 뗀다.
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const movedRef = useRef(false);
  const onDragMove = useRef((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    movedRef.current = true;
    setPos(keepHeadReachable(e.clientX - d.dx, e.clientY - d.dy, popRef.current?.offsetWidth ?? 0));
  }).current;
  const onDragEnd = useRef(() => {
    drag.current = null;
    removeWindowPointerDrag(onDragMove, onDragEnd);
  }).current;
  useEffect(() => () => removeWindowPointerDrag(onDragMove, onDragEnd), [onDragMove, onDragEnd]);
  const onDragStart = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    addWindowPointerDrag(onDragMove, onDragEnd);
  };
  // 화면 아래로 나가지 않게(InfoPopup 과 같은 보정). 사용자가 옮긴 뒤에는 건드리지 않는다.
  const popRef = useRef<HTMLDivElement>(null);
  useModalFocus(popRef); // 막이 있는 창 — 초점을 창 안에 둔다(lib/keyGate '모달의 초점'). 위에 크게 보기가 뜨면 그쪽이 맨 위다
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const fit = () => {
      if (movedRef.current) return;
      const maxY = Math.max(8, window.innerHeight - 8 - el.offsetHeight);
      setPos((p) => (p.y > maxY ? { x: p.x, y: maxY } : p));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 목록 → 집계 → 크레딧. 폴더가 바뀌면 마지막 것의 응답만 받는다(순번). 창을 닫으면(언마운트) 순번을 올려 남은 쪽·크레딧 요청을
  //  보내지 않는다 — 닫은 뒤에도 건마다 요청이 나가던 것(Codex 코드 검토 10-09).
  const seqRef = useRef(0);
  useEffect(() => {
    const my = ++seqRef.current;
    const alive = () => my === seqRef.current;
    const stop = new AbortController(); // 닫거나 다른 폴더로 — 받는 중인 크레딧 요청도 끊는다(멎은 요청을 남긴 채 새 요청이 쌓이지 않게)
    setGens(null);
    setMetrics(null);
    setTruncated(false);
    setError(null);
    (async () => {
      try {
        const got = await fetchFolder(query, folder.path, alive);
        if (!got || !alive()) return;
        setGens(got.gens);
        setTruncated(got.truncated);
        if (got.gens.length > METRICS_MAX) {
          setMetrics(new Map());
          return;
        }
        // 넷씩 보낸다 — 한꺼번에 보내면 다른 조회(목록·폴더 카드)가 그 뒤에 선다. 닫으면 아직 안 보낸 것은 보내지 않는다(Codex 코드 리뷰).
        //  멎은 요청은 시간이 지나면 끊고 미상으로 둔 채 다음으로 간다(lib/coverCredits 의 askMetrics — 카드의 크레딧 줄과 같은 규칙).
        const results: (CutMetrics | null)[] = got.gens.map(() => null);
        let at = 0;
        await Promise.all(Array.from({ length: METRICS_AT_ONCE }, async () => {
          while (alive() && at < got.gens.length) {
            const i = at++;
            results[i] = await askMetrics(got.gens[i].id, stop.signal);
          }
        }));
        if (!alive()) return;
        setMetrics(new Map(got.gens.map((g, i) => [g.id, results[i]])));
      } catch (e) {
        if (alive()) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      seqRef.current += 1;
      stop.abort();
    };
  }, [folder.path, query, refetch]);

  const cover = folder.cover;
  const coverAsset = cover.assets?.[0];
  const coverIsVideo = coverAsset?.type === "video";
  const summary = gens ? summarizeCut(gens, metrics ?? new Map()) : null;
  const strip = (gens ?? []).slice(0, STRIP_MAX);
  const items: PreviewItem[] = strip.flatMap((g) => {
    const asset = g.assets?.[0];
    return asset ? [{ url: asset.file_path, type: asset.type, name: g.prompt?.slice(0, 60) || folder.name, genId: g.id, thumb: thumbOf(g, 256) }] : [];
  });
  const preview = (g: Generation) => {
    const index = items.findIndex((item) => item.genId === g.id);
    if (index >= 0) onPreview({ ...items[index], items, index });
  };
  const creditsText = !summary
    ? null
    : summary.total > METRICS_MAX
      ? t("건수가 많아 집계하지 않음")
      : metrics === null
        ? t("집계 중…")
        : summary.credits.known > 0
          ? `${formatCredits(summary.credits.real)} credits${summary.credits.unknown ? ` · ${summary.credits.unknown}${t("건 미상")}` : ""}`
          : t("미상");
  const dateText = summary?.first && summary.last
    ? summary.first === summary.last
      ? formatGenerationDateTime(summary.first)
      : `${formatGenerationDateTime(summary.first)} ~ ${formatGenerationDateTime(summary.last)}`
    : null;

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="info-popup cutinfo" ref={popRef} style={{ left: pos.x, top: pos.y, width: POP_W }}>
        <header className="info-head" onPointerDown={onDragStart}>
          <span className="info-title" title={folder.path}>ℹ {t("컷 정보")}</span>
          <div className="info-head-actions">
            <button
              type="button"
              className="info-board-btn"
              title={t("이 폴더의 창을 연다")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onOpen(folder)}
            >
              📂 {t("폴더 열기")}
            </button>
          </div>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            <CloseIcon />
          </button>
        </header>
        <div className="info-body">
          {coverAsset && (
            <div className="info-preview cutinfo-cover">
              {coverIsVideo ? (
                <video src={coverAsset.file_path} poster={coverAsset.thumbnail_path || undefined} muted controls preload="metadata" />
              ) : (
                <img src={coverAsset.file_path || coverAsset.thumbnail_path || undefined} alt="" />
              )}
              <span className={"cutinfo-tag" + (folder.rep ? " rep" : "")}>{folder.rep ? t("썸네일") : `${t("썸네일 미정")} · ${t("최신 것")}`}</span>
            </div>
          )}
          <div className="info-rows">
            <Row label={t("컷")} value={`${cover.project_name ? cover.project_name + " / " : ""}${folder.path}`} />
            {error ? (
              <Row label={t("건수")} value={<span className="info-error-text">{t("목록을 받지 못했습니다")} — {error}</span>} />
            ) : !summary ? (
              <Row label={t("건수")} value={`${folder.count} · ${t("받는 중…")}`} />
            ) : (
              <>
                <Row
                  label={t("건수")}
                  value={<>{summary.total}<span className="cutinfo-m">{[summary.videos ? `${t("영상")} ${summary.videos}` : "", summary.images ? `${t("이미지")} ${summary.images}` : "", truncated ? `${t("최근")} ${MAX}${t("건 기준")}` : ""].filter(Boolean).join(" · ")}</span></>}
                />
                <Row label={t("작업자")} value={summary.workers.map((w) => `${w.name} ${w.count}`).join(" · ") || null} />
                <Row label={t("크레딧(실제)")} value={creditsText} />
                <Row label={t("생성일")} value={dateText} />
                <Row label={t("총 길이")} value={summary.videos > 0 ? `${summary.seconds.toFixed(1)}s` : null} />
                <Row label={t("모델")} value={summary.models.map((code) => modelName(code)).join(" · ") || null} />
                <Row
                  label={t("검토")}
                  value={<><b className="cutinfo-shared">{t("공유")} {summary.review.shared}</b><span className="cutinfo-m">{t("보류")} {summary.review.held} · {t("최종")} {summary.review.final}</span></>}
                />
              </>
            )}
          </div>
          {gens && gens.length > 0 && (
            <div className="info-sources">
              <div className="info-sources-head">
                {t("이 컷의 생성물")} {gens.length}{t("개")}
                {gens.length > strip.length && <span className="cutinfo-m">{t("최근")} {strip.length}{t("개만")} · {t("외")} {gens.length - strip.length}{t("건")}</span>}
              </div>
              <div className="info-sources-grid cutinfo-strip">
                {strip.map((g) => {
                  const asset = g.assets?.[0];
                  if (!asset) return null;
                  const isCover = g.id === cover.id;
                  return (
                    <div key={g.id} className={"cutinfo-item" + (isCover ? " cur" : "")}>
                      <button type="button" className="info-source" title={t("크게 보기")} onClick={() => preview(g)}>
                        <MediaThumbnail thumb={thumbOf(g, 256)} isVideo={asset.type === "video"} src={asset.file_path} alt="" fallback={<span className="info-source-ph">🎞</span>} />
                      </button>
                      {/* ★ = 이 생성물을 이 폴더의 대표로(폴더 창의 [대표] 와 같은 저장). 이미 대표면 표시만 */}
                      <button
                        type="button"
                        className={"cutinfo-rep" + (isCover && folder.rep ? " on" : "")}
                        title={isCover && folder.rep ? t("지금 썸네일") : t("썸네일로")}
                        disabled={savingRep || (isCover && folder.rep) || g.deleted}
                        onClick={() => void Promise.resolve(onPickCover(folder, g)).then((saved) => { if (saved === false) setRefetch((n) => n + 1); })}
                      >
                        {t("썸네일")}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

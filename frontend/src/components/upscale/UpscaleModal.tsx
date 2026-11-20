// 업스케일 창 — 크게 보기 [⤢ Upscale] 로 열린다(시안 v3, Jay 2026-11-20 "이 배치로", docs/status/업스케일_크게보기_2026-11-20.md).
//  원본 썸네일 · 원본 크기 → 결과 · 모델 칩(아이콘) · 고른 모델의 옵션 칩 · [Upscale ✦]. 결과는 새 카드(같은 프로젝트·폴더).
//  제출은 수정 창과 같은 길(api.prepareCreate 클로저 = 제출 1회의 idempotency key).
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";
import { sharedCostEstimate, useModels } from "../../lib/useModels";
import { useModelPolicy } from "../../lib/modelPolicy";
import { modelAllowed, submitBlockMessage } from "../../lib/modelPolicyCore";
import { formatCredits } from "../../lib/formatCredits";
import { HttpError } from "../../lib/http";
import { newGenerationRequestKey } from "../../features/generation/api";
import { captureOperationContext, isOperationContextCurrent } from "../../app/operationContext";
import { thumbOf } from "../../lib/media";
import {
  UPSCALE_NO_COST_MODELS, UPSCALE_VIDEO_COST_MODELS, choiceLabel, initialValues, upscaleModel, upscaleModelsFor,
  upscaleParams, upscaleRequestBody, upscaleTarget, type UpscaleValue,
} from "../../lib/upscaleModels";
import { CloseIcon } from "../common/ViewIcons";
import { ModelFamilyIcon, modelFamily } from "../spotlight/ModelFamilyIcon";
import type { Generation, WorkspaceContext } from "../../types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // 힉스필드 작업 id(서버 video_ref 검사와 같은 꼴)
// 접수됐는지 모르는 제출(응답 유실·5xx·시간 초과)의 요청 키 — 계정·서버·공간·몸통이 같으면 다시 눌러도, 창을 닫았다 다시 열어도,
//  다른 계정에 갔다 돌아와도 같은 키를 **지금 유효한 문맥으로** 다시 보낸다(서버가 같은 키를 한 번만 받는다 → 두 번 과금되지 않음,
//  Codex 독립 리뷰 1·2차). 준비한 send 를 들고 있으면 문맥이 바뀐 뒤 영영 못 보낸다(2차). 확정 거절(400/422)만 지운다.
//  shortcut: 페이지를 새로 고치면 잊는다 — 그때는 라이브러리 카드로 접수 여부를 본다.
const pendingKeys = new Map<string, string>();

type Source = { w: number; h: number; duration?: number };

export function UpscaleModal({ gen, mode, workspace, onQueued, onClose }: {
  gen: Generation;
  mode: "image" | "video";
  workspace: WorkspaceContext;
  onQueued: (g: Generation) => void;
  onClose: () => void;
}) {
  const isVideo = mode === "video";
  const asset = gen.assets[0];
  const models = upscaleModelsFor(mode);
  const [error, setError] = useState("");
  const modelPolicy = useModelPolicy();
  const openingContext = useRef(captureOperationContext(workspace));
  const openingWorkspace = useRef(JSON.stringify([workspace.scope, workspace.id]));
  // 처음 모델 = 그룹에서 쓸 수 있는 첫 모델(제한 그룹이 Topaz 만 허용했으면 Topaz 로 연다)
  const firstModel = (models.find((row) => modelAllowed(modelPolicy, row.id)) ?? models[0]).id;
  const m = useModels(setError, { allowed: modelPolicy.allowed, ready: false, initialType: mode, initialModel: firstModel, costEnabled: false });
  const spec = upscaleModel(m.model) ?? upscaleModel(firstModel)!;
  const paramsReady = !m.paramsLoading && m.paramsModel === m.model && m.params.length > 0;

  // 원본 크기(·영상 길이) — Topaz 이미지는 이 픽셀에 배율을 곱해 보낸다. 크게 보기가 막 띄운 파일이라 대개 캐시에서 온다.
  const [src, setSrc] = useState<Source | null>(null);
  const [srcFailed, setSrcFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const url = asset?.file_path;
    if (!url) return;
    if (isVideo) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => { if (alive) setSrc({ w: video.videoWidth, h: video.videoHeight, duration: video.duration }); };
      video.onerror = () => { if (alive) setSrcFailed(true); };
      video.src = url;
      return () => { alive = false; video.removeAttribute("src"); video.load(); };
    }
    const image = new Image();
    image.onload = () => { if (alive) setSrc({ w: image.naturalWidth, h: image.naturalHeight }); };
    image.onerror = () => { if (alive) setSrcFailed(true); };
    image.src = url;
    return () => { alive = false; image.onload = null; image.onerror = null; };
  }, [asset?.file_path, isVideo]);

  const [valuesByModel, setValuesByModel] = useState<Record<string, Record<string, UpscaleValue>>>({});
  const values = valuesByModel[spec.id] ?? initialValues(spec);
  const setValue = (key: string, value: UpscaleValue) =>
    setValuesByModel((prev) => ({ ...prev, [spec.id]: { ...(prev[spec.id] ?? initialValues(spec)), [key]: value } }));
  const params = useMemo(() => upscaleParams(spec.id, values, src), [spec.id, values, src]);
  // 이 PC 의 CLI 가 이 모델·값을 받는지 — 스키마에 없는 이름이거나 목록 밖 값이면 보내지 않는다(옛 CLI 등)
  const schemaMismatch = paramsReady && !!params && Object.entries(params).some(([key, value]) => {
    const param = m.params.find((p) => p.name === key);
    return !param || (!!param.enum?.length && !param.enum.includes(String(value)));
  });

  // 견적 — 영상 업스케일은 원본의 힉스필드 작업 id 로(길이·해상도대로 값이 나온다), Topaz 셋은 CLI 가 견적을 주지 않는다
  const noCost = UPSCALE_NO_COST_MODELS.has(spec.id);
  const videoRef = UPSCALE_VIDEO_COST_MODELS.has(spec.id) && UUID_RE.test(gen.job_id ?? "") ? gen.job_id! : "";
  const costKey = JSON.stringify([spec.id, params, videoRef]);
  const [cost, setCost] = useState<{ key: string; credits: number } | null>(null);
  const [costLoading, setCostLoading] = useState(false);
  useEffect(() => {
    if (noCost || !params || !paramsReady || schemaMismatch || (UPSCALE_VIDEO_COST_MODELS.has(spec.id) && !videoRef)) {
      setCostLoading(false);
      return;
    }
    let alive = true;
    setCostLoading(true);
    sharedCostEstimate(spec.id, params, "", false, videoRef)
      .then(async (r) => {
        if (alive) setCost({ key: costKey, credits: r.credits });
        if (r.stale) {
          const fresh = await sharedCostEstimate(spec.id, params, "", true, videoRef);
          if (alive) setCost({ key: costKey, credits: fresh.credits });
        }
      })
      .catch(() => {})
      .finally(() => { if (alive) setCostLoading(false); });
    return () => { alive = false; };
    // costKey 가 모델·값·영상 id 를 모두 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costKey, paramsReady, schemaMismatch, noCost]);
  const credits = cost?.key === costKey ? cost.credits : null;

  const [menu, setMenu] = useState<string | null>(null); // "model" 또는 옵션 key
  const chipsRef = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(chipsRef, () => setMenu(null), menu !== null);
  const [submitting, setSubmitting] = useState(false);
  // Esc = 열린 목록 → 창 순서로 하나씩. 보내는 중엔 닫지 않는다(닫고 다시 열면 새 key 로 이중 제출).
  useEscapeClose(() => {
    if (menu) setMenu(null);
    else if (!submitting) onClose();
  }, true, true, true);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef);

  const blockedMessage = submitBlockMessage(modelPolicy, spec.id, spec.label);
  const canSubmit = !submitting && !!asset?.file_path && paramsReady && !!params && !schemaMismatch && !blockedMessage;
  const submit = async () => {
    if (!canSubmit || !params || !asset) return;
    // 연 뒤 계정·서버·작업 공간이 바뀌었으면 보내지 않는다(수정 창과 같은 검사) — 다른 공간에 과금되지 않게
    if (!isOperationContextCurrent(openingContext.current) || openingWorkspace.current !== JSON.stringify([workspace.scope, workspace.id])) {
      setError("작업 공간이 바뀌었습니다 — 창을 닫고 다시 여세요.");
      return;
    }
    setError("");
    setSubmitting(true);
    const body = upscaleRequestBody(gen, asset.file_path, mode, spec.id, params);
    const { accountNamespace, serverOrigin } = openingContext.current;
    const key = JSON.stringify([accountNamespace, serverOrigin, workspace.scope, workspace.id, body]);
    let requestKey = pendingKeys.get(key);
    if (!requestKey) {
      requestKey = newGenerationRequestKey();
      pendingKeys.set(key, requestKey);
    }
    try {
      const created = await api.create(body, workspace, undefined, requestKey); // 문맥은 보낼 때마다 새로 잡는다
      pendingKeys.delete(key);
      onQueued(created);
      onClose();
    } catch (e) {
      setSubmitting(false);
      // 4xx 확정 거절은 서버에 남지 않았다 — 다음 누름은 새 요청. 그 밖에는 접수됐을 수 있어 같은 요청으로만 다시 보낸다
      if (e instanceof HttpError && (e.status === 400 || e.status === 422)) {
        pendingKeys.delete(key);
        setError(`업스케일 요청 실패: ${String(e)}`);
      } else {
        setError(`접수됐는지 확인하지 못했습니다(${String(e)}) — 다시 누르면 같은 요청으로 확인합니다(두 번 생성되지 않음).`);
      }
    }
  };

  const family = modelFamily(spec.id);
  const srcText = src ? `${src.w}×${src.h}` : srcFailed ? "크기 확인 안 됨" : "크기 확인 중";
  const target = upscaleTarget(spec.id, values, src);
  const sub = isVideo
    ? src?.duration && Number.isFinite(src.duration) ? `${Math.round(src.duration)}초` : ""
    : spec.options.some((o) => o.key === "scale") ? "세로·가로 비율 그대로" : "";
  const hint = blockedMessage
    ?? (schemaMismatch ? "이 PC 의 힉스필드 CLI 가 이 모델 옵션을 받지 않습니다 — CLI 업데이트를 확인하세요"
      : !params && spec.options.some((o) => o.key === "scale") ? (srcFailed ? "원본 크기를 읽지 못해 Topaz 로 보낼 수 없습니다" : "원본 크기를 읽는 중")
      : noCost ? "Topaz 는 견적이 없습니다 — 쓴 크레딧은 생성 뒤 기록에서 확인"
      : spec.id === "bytedance_video_upscale" ? "FPS 30 넘게 고르면 비용 2배 · Pro 는 더 비쌉니다"
      : "원본은 그대로 · 결과는 새 카드");
  const thumb = thumbOf(gen, 256);

  return (
    <div className="partial-edit-backdrop upscale-backdrop">
      <div ref={modalRef} className="upscale-modal" role="dialog" aria-modal="true" aria-label="업스케일">
        <header className="info-head upscale-head">
          <span className="info-title">⤢ 업스케일</span>
          {!submitting && (
            <button className="assets-x" onClick={onClose} title="닫기" aria-label="닫기">
              <CloseIcon />
            </button>
          )}
        </header>
        <div className="upscale-body">
          <div className="upscale-src">
            <div className={"upscale-thumb" + (isVideo ? " video" : "")}>{thumb && <img src={thumb} alt="" draggable={false} />}</div>
            <div className="upscale-size">
              {srcText}<span className="upscale-arrow">→</span>{target}
              {sub && <small>{sub}</small>}
            </div>
          </div>
          <div className="sl-controls upscale-chips" ref={chipsRef}>
            <div className="sl-left">
              <div className="sl-chip-wrap">
                <button type="button" className={"sl-chip" + (menu === "model" ? " active" : "")} title="업스케일 모델" aria-label="업스케일 모델"
                  aria-haspopup="listbox" aria-expanded={menu === "model"} disabled={submitting}
                  onClick={() => setMenu(menu === "model" ? null : "model")}>
                  {family ? <ModelFamilyIcon family={family} className="sl-chip-ic" /> : <span className="sl-dot" />}
                  <span className="sl-chip-label">{spec.label}</span>
                  <span className="sl-caret">›</span>
                </button>
                {menu === "model" && (
                  <div className="sl-dropdown upscale-menu" role="listbox" aria-label="업스케일 모델">
                    <div className="sl-dd-title">{isVideo ? "Video" : "Image"} Upscale</div>
                    <div className="sl-dd-scroll">
                      {models.map((row) => {
                        const allowed = modelAllowed(modelPolicy, row.id);
                        const rowFamily = modelFamily(row.id);
                        return (
                          <button key={row.id} type="button" role="option" aria-selected={row.id === spec.id} aria-label={row.label}
                            disabled={!allowed} className={"sl-dd-item has-ic" + (row.id === spec.id ? " sel" : "") + (allowed ? "" : " blocked")}
                            onClick={() => { m.setModel(row.id); setMenu(null); }}>
                            {rowFamily && <ModelFamilyIcon family={rowFamily} />}
                            <span className="sl-dd-text">
                              <span>{row.label}{!allowed && <span className="sl-dd-lock"> 🔒</span>}</span>
                              <small className="sl-model-description">{row.description}</small>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {models.some((row) => !modelAllowed(modelPolicy, row.id)) && (
                      <div className="sl-dd-note">🔒 = 이 그룹의 '사용 모델'에 없음</div>
                    )}
                  </div>
                )}
              </div>
              {spec.options.map((option) => {
                const value = values[option.key] ?? option.initial;
                if (option.toggle) {
                  return (
                    <div key={option.key} className="sl-chip sl-opt-audio upscale-toggle" title={option.label}>
                      <span className="upscale-k">{option.label}</span>
                      <div className="sl-adv-opts">
                        {option.choices.map((choice) => (
                          <button key={String(choice.value)} type="button" className={"sl-adv-opt" + (value === choice.value ? " sel" : "")}
                            aria-pressed={value === choice.value} aria-label={`${option.label} ${choice.label}`} disabled={submitting}
                            onClick={() => setValue(option.key, choice.value)}>{choice.label}</button>
                        ))}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={option.key} className="sl-chip-wrap">
                    <button type="button" className={"sl-chip sl-opt-chip" + (menu === option.key ? " active" : "")} title={option.label}
                      aria-label={option.label} aria-haspopup="listbox" aria-expanded={menu === option.key} disabled={submitting}
                      onClick={() => setMenu(menu === option.key ? null : option.key)}>
                      <span className="upscale-k">{option.label}</span>
                      <span className="sl-opt-text">{choiceLabel(option, value)}</span>
                      <span className="sl-caret">›</span>
                    </button>
                    {menu === option.key && (
                      <div className="sl-dropdown pe-menu-small" role="listbox" aria-label={option.label}>
                        <div className="sl-dd-title">{option.label}</div>
                        <div className="sl-dd-scroll">
                          {option.choices.map((choice) => (
                            <button key={String(choice.value)} type="button" role="option" aria-selected={choice.value === value}
                              className={"sl-dd-item" + (choice.value === value ? " sel" : "")}
                              onClick={() => { setValue(option.key, choice.value); setMenu(null); }}>
                              {choice.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="upscale-gen-row">
            <span className={"upscale-hint" + (blockedMessage || schemaMismatch ? " warn" : "")}>{hint}</span>
            <button type="button" className="sl-gen upscale-gen" disabled={!canSubmit} onClick={() => void submit()}
              title={credits != null ? `업스케일 — 예상 ${formatCredits(credits)} 크레딧` : "업스케일 — 견적 없음"}>
              {submitting ? "보내는 중" : "Upscale"} <span className="sl-sparkle">✦</span>
              {credits != null ? <span className="sl-cost">{formatCredits(credits)}</span>
                : costLoading ? <span className="sl-cost loading">…</span> : <span className="sl-cost">—</span>}
            </button>
          </div>
          {error && <div className="partial-edit-error upscale-error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

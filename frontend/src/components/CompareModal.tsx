// v02 DAM — 버전 비교 + 차이 하이라이트 (로드맵 PART 3 §3-2-2).
// 벌크 선택한 2개+ 생성본을 나란히 놓고 프롬프트 단어·파라미터 값의 '의미 있는' 차이를 색칠한다.
// 계보 무관 — 아무거나 골라 비교(로드맵 결정사항). 데이터는 이미 클라이언트에 있어 서버 호출 없음.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { refSrc } from "../lib/promptParts";
import type { Generation, MediaType, Reference } from "../types";

// 참조(소스) 동일성 키 — 원본 URL 우선(가장 안정적), 없으면 파일경로/ id.
function refKey(r: Reference): string {
  return r.source_url || r.file_path || r.id;
}

// 비교표에서 숨기는 내부/노이즈 필드 — 의미 있는 파라미터 차이만 보이게(로드맵 §3-2-2 의도).
//  · prompt: 상단에 단어 하이라이트로 이미 크게 표시(중복)
//  · medias: 입력 참조 이미지의 raw JSON(업로드 id/url) — 아래 '참조' 썸네일로 대체
//  · reference_elements: 보통 빈 배열(내부 필드)
const HIDDEN_PARAMS = new Set(["prompt", "medias", "reference_elements"]);

// 프롬프트를 단어 토큰으로 — 공백 분리, 빈 토큰 제거. 비교는 소문자 기준(표시는 원형 유지).
function tokenize(s: string): string[] {
  return (s || "").split(/(\s+)/).filter((t) => t.trim().length > 0);
}

// 모든 열에 공통으로 들어간 단어 집합(소문자) — 여기 없는 단어가 '바뀐 단어'.
function commonTokens(prompts: string[]): Set<string> {
  const sets = prompts.map((p) => new Set(tokenize(p).map((t) => t.toLowerCase())));
  if (sets.length === 0) return new Set();
  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((t) => sets[i].has(t)));
  }
  return common;
}

// <<<...>>> 엘리먼트(입력 요소 참조) 1개와 정확히 일치.
// 엘리먼트 토큰 패턴(<<<x>>> 형태). 판정·추출·split 세 변형을 한 소스에서 파생해 서로 어긋나지 않게.
const ELEMENT_SRC = "<{2,}[^<>]*>{2,}";
const ELEMENT_RE = new RegExp(`^${ELEMENT_SRC}$`); // 단일 토큰 판정(.test)
const ELEMENT_RE_G = new RegExp(ELEMENT_SRC, "g"); // 전체 추출(.match)
const ELEMENT_SPLIT_RE = new RegExp(`(${ELEMENT_SRC})`); // split 캡처(엘리먼트만 분리)

function extractElements(text: string): string[] {
  return text.match(ELEMENT_RE_G) || [];
}

// 모든 버전에 공통으로 든 엘리먼트(소문자) — 여기 없는 엘리먼트가 '바뀐 엘리먼트'.
function commonElements(prompts: string[]): Set<string> {
  const sets = prompts.map((p) => new Set(extractElements(p).map((e) => e.toLowerCase())));
  if (sets.length === 0) return new Set();
  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((e) => sets[i].has(e)));
  }
  return common;
}

// 프롬프트 렌더 — '바뀐' 것만 강조: 바뀐 엘리먼트<<<>>>는 녹색, 그 외 바뀐 단어는 노란색.
function renderPrompt(text: string, common: Set<string>, commonElems: Set<string>) {
  const parts = text.split(ELEMENT_SPLIT_RE);
  return parts.map((part, pi) => {
    if (!part) return null;
    if (ELEMENT_RE.test(part)) {
      // 엘리먼트는 '바뀐(공통 아님)' 경우에만 녹색. 모든 버전에 같으면 강조 없음.
      const changed = !commonElems.has(part.toLowerCase());
      return (
        <span key={pi} className={changed ? "cmp-diff-g" : undefined}>
          {part}{" "}
        </span>
      );
    }
    return tokenize(part).map((tok, ti) => {
      const diff = !common.has(tok.toLowerCase());
      return (
        <span key={pi + "-" + ti} className={diff ? "cmp-diff" : undefined}>
          {tok}{" "}
        </span>
      );
    });
  });
}

function paramValue(g: Generation, key: string): string {
  const v = (g.params || {})[key];
  if (v === undefined || v === null) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function mediaThumb(path: string | null | undefined, w: number): string | null {
  if (!path) return null;
  return path.startsWith("/media/") ? api.genThumbUrl(path, w) : path;
}

export function CompareModal({
  gens,
  onClose,
}: {
  gens: Generation[];
  onClose: () => void;
}) {
  const [onlyDiff, setOnlyDiff] = useState(false); // 다른 값만 보기 토글
  const [promptOnly, setPromptOnly] = useState(false); // 프롬프트만 보기(이미지·파라미터 숨김)
  // 소스(참조) 원본 미리보기 — 비교 모달 위에 뜨는 자체 라이트박스(전역 미리보기는 z-index 가 낮아 가림).
  const [srcPreview, setSrcPreview] = useState<{ url: string; type: MediaType; name: string } | null>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]); // 영상 동기 재생용
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (srcPreview) setSrcPreview(null); // 라이트박스 먼저 닫기
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, srcPreview]);

  // 영상 동기 재생 — 한 곳에서 재생/정지하면 전부 같이. 길이가 다르면 먼저 끝난 영상은
  // 마지막 프레임에서 대기하다가, 가장 긴 영상이 끝나는 순간 전부 0으로 되감고 동시 재시작.
  useEffect(() => {
    const vids = videoRefs.current.filter((v): v is HTMLVideoElement => !!v);
    if (promptOnly || vids.length === 0) return;
    // 프로그램적으로 일으킨 play/pause 이벤트는 무시(무한 전파 방지).
    const ignore = new Set<HTMLVideoElement>();
    const playAll = (except?: HTMLVideoElement) =>
      vids.forEach((v) => {
        if (v !== except && v.paused) {
          ignore.add(v);
          v.play().catch(() => ignore.delete(v));
        }
      });
    const pauseAll = (except?: HTMLVideoElement) =>
      vids.forEach((v) => {
        if (v !== except && !v.paused) {
          ignore.add(v);
          v.pause();
        }
      });
    let restarting = false;
    const onPlay = (e: Event) => {
      const t = e.target as HTMLVideoElement;
      if (ignore.has(t)) {
        ignore.delete(t);
        return;
      }
      playAll(t);
    };
    const onPause = (e: Event) => {
      const t = e.target as HTMLVideoElement;
      if (ignore.has(t)) {
        ignore.delete(t);
        return;
      }
      if (t.ended) return; // 끝나서 멈춘 건 전파 안 함(짧은 영상은 대기)
      pauseAll(t);
    };
    const onEnded = (e: Event) => {
      if (restarting) return;
      const t = e.target as HTMLVideoElement;
      const maxDur = Math.max(...vids.map((v) => v.duration || 0));
      if ((t.duration || 0) >= maxDur - 0.05 || vids.every((v) => v.ended)) {
        restarting = true;
        vids.forEach((v) => (v.currentTime = 0));
        playAll();
        setTimeout(() => (restarting = false), 120);
      }
    };
    vids.forEach((v) => {
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("ended", onEnded);
    });
    playAll(); // 열리면 동시 자동재생(muted 라 정책 통과)
    return () =>
      vids.forEach((v) => {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
        v.removeEventListener("ended", onEnded);
      });
  }, [gens, promptOnly]);

  const prompts = gens.map((g) => g.display_prompt || g.prompt || "");
  const common = commonTokens(prompts);
  const commonElems = commonElements(prompts); // 바뀐 엘리먼트 판정용

  // 공통 소스(모든 버전에 동일하게 들어간 참조) 집합 — 여기 없는 참조 = '다르게 들어간 소스' → 크게 표시.
  const refSets = gens.map((g) => new Set(g.references.map(refKey)));
  let commonRefs = new Set<string>(refSets[0] || []);
  for (let i = 1; i < refSets.length; i++) {
    commonRefs = new Set([...commonRefs].filter((k) => refSets[i].has(k)));
  }

  // 파라미터 키 합집합(삽입 순서 보존) → 노이즈/내부 필드 제거(원시값이 하나도 없는 키 = raw JSON blob 도 숨김).
  const allKeys: string[] = [];
  for (const g of gens) {
    for (const k of Object.keys(g.params || {})) {
      if (!allKeys.includes(k)) allKeys.push(k);
    }
  }
  const keyDiffers = (k: string) =>
    new Set(gens.map((g) => paramValue(g, k))).size > 1;
  const meaningful = allKeys.filter((k) => {
    if (HIDDEN_PARAMS.has(k)) return false;
    // 값이 전부 객체/배열(또는 부재)인 키 = 내부 blob → 숨김. 하나라도 원시값이면 표시.
    return gens.some((g) => {
      const v = (g.params || {})[k];
      return v != null && typeof v !== "object";
    });
  });
  const keys = onlyDiff ? meaningful.filter(keyDiffers) : meaningful;

  const thumbOf = (g: Generation) => {
    const a = g.assets[0];
    const raw = a?.thumbnail_path || (a?.type !== "video" ? a?.file_path : null);
    return mediaThumb(raw, 512);
  };
  const refThumb = (r: Reference) => mediaThumb(r.thumbnail_path || r.file_path, 128);

  return (
    <>
      <div className="cmp-backdrop" onMouseDown={onClose} />
      <div className="cmp-modal" role="dialog" aria-label="버전 비교">
        <header className="admin-head">
          <span className="admin-title">⊞ 버전 비교 ({gens.length})</span>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>
        <div className="cmp-note">
          <span>
            바뀐 <span className="cmp-diff-g">{"<<<엘리먼트>>>"}</span>는 녹색, 그 외 바뀐
            단어·값은 <span className="cmp-diff">노란색</span>으로 표시합니다. 계보와 무관하게
            선택한 것끼리 비교합니다.
          </span>
          <div className="cmp-toggles">
            <label className="cmp-onlydiff">
              <input
                type="checkbox"
                checked={onlyDiff}
                disabled={promptOnly}
                onChange={(e) => setOnlyDiff(e.target.checked)}
              />
              다른 값만 보기
            </label>
            <label className="cmp-onlydiff">
              <input
                type="checkbox"
                checked={promptOnly}
                onChange={(e) => setPromptOnly(e.target.checked)}
              />
              프롬프트만 보기
            </label>
          </div>
        </div>
        <div className="cmp-body">
          <div
            className="cmp-cols"
            style={{ gridTemplateColumns: `repeat(${gens.length}, minmax(220px, 1fr))` }}
          >
            {gens.map((g, idx) => {
              const asset = g.assets[0];
              const isVideo = asset?.type === "video";
              const thumb = thumbOf(g); // 영상은 포스터(썸네일)
              return (
                <div key={g.id} className={"cmp-col" + (g.is_final ? " final" : "")}>
                  {!promptOnly && (
                    <>
                      <div className="cmp-thumb">
                        {isVideo && asset ? (
                          // 영상 — 동기 재생(ref). loop 제거: 가장 긴 영상 끝에서 전부 동시 재시작
                          <video
                            ref={(el) => {
                              videoRefs.current[idx] = el;
                            }}
                            src={asset.file_path}
                            poster={thumb || undefined}
                            controls
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : thumb ? (
                          <img src={thumb} alt={g.prompt} loading="lazy" decoding="async" />
                        ) : (
                          <div className="cmp-thumb-empty">{g.status}</div>
                        )}
                        {g.is_final && <span className="cmp-final-badge">★ 최종</span>}
                      </div>
                      <div className="cmp-model">{g.model || "—"}</div>
                    </>
                  )}
                  {/* 입력 참조(소스) — '프롬프트만 보기'에서도 프롬프트와 함께 표시 */}
                  {g.references.length > 0 && (
                    <div className="cmp-refs">
                      {g.references.map((r) => {
                        const t = refThumb(r);
                        if (!t) return null;
                        const isDiff = !commonRefs.has(refKey(r));
                        const full = refSrc(r.file_path) || r.source_url || t;
                        return (
                          <button
                            key={r.id}
                            type="button"
                            className={"cmp-ref-btn" + (isDiff ? " diff" : "")}
                            title={
                              (isDiff ? "다른 소스 — " : "") +
                              (r.role || "참조") +
                              " · 클릭하면 원본 보기"
                            }
                            onClick={() =>
                              setSrcPreview({ url: full, type: r.type, name: r.role || "소스" })
                            }
                          >
                            <img src={t} className="cmp-ref" alt={r.role || "reference"} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* 프롬프트 — <<<>>> 엘리먼트는 녹색, 그 외 바뀐 단어는 노란색. promptOnly면 전체 펼침 */}
                  <div className={"cmp-prompt" + (promptOnly ? " full" : "")}>
                    {renderPrompt(prompts[idx], common, commonElems)}
                  </div>
                  {/* 파라미터 — 이 이미지에 붙는 정보(라벨·값). 다른 값은 노란색 */}
                  {!promptOnly &&
                    (keys.length > 0 ? (
                      <div className="cmp-info">
                        {keys.map((k) => (
                          <div key={k} className="cmp-info-row">
                            <span className="cmp-info-label">{k}</span>
                            <span
                              className={
                                "cmp-info-value" + (keyDiffers(k) ? " cmp-diff" : "")
                              }
                            >
                              {paramValue(g, k)}
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
            })}
          </div>
        </div>
      </div>

      {/* 소스 원본 라이트박스 — 비교 모달 위에 표시(전역 미리보기보다 z-index 높게) */}
      {srcPreview && (
        <div className="cmp-srcbox" onMouseDown={() => setSrcPreview(null)}>
          <div className="cmp-srcbox-inner" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="cmp-srcbox-x"
              title="닫기"
              onClick={() => setSrcPreview(null)}
            >
              ✕
            </button>
            {srcPreview.type === "video" ? (
              <video src={srcPreview.url} controls autoPlay muted loop playsInline />
            ) : (
              <img src={srcPreview.url} alt={srcPreview.name} />
            )}
            <div className="cmp-srcbox-name">{srcPreview.name}</div>
          </div>
        </div>
      )}
    </>
  );
}

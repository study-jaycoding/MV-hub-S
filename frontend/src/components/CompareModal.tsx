// v02 DAM — 버전 비교 + 차이 하이라이트 (로드맵 PART 3 §3-2-2).
// 벌크 선택한 2개+ 생성본을 나란히 놓고 프롬프트 단어·파라미터 값의 '의미 있는' 차이를 색칠한다.
// 계보 무관 — 아무거나 골라 비교(로드맵 결정사항). 데이터는 이미 클라이언트에 있어 서버 호출 없음.
import { useEffect, useRef, useState } from "react";
import {
  commonPromptElements,
  commonPromptTokens,
  compareParamKeys,
  refKey,
} from "../lib/compareDiff";
import { useModelDisplayName } from "../lib/modelCatalog";
import { CompareGenerationColumn } from "./compare/CompareGenerationColumn";
import {
  CompareSourceLightbox,
  type CompareSourcePreview,
} from "./compare/CompareSourceLightbox";
import type { Generation } from "../types";

export function CompareModal({
  gens,
  onClose,
}: {
  gens: Generation[];
  onClose: () => void;
}) {
  const modelName = useModelDisplayName();
  const [onlyDiff, setOnlyDiff] = useState(false); // 다른 값만 보기 토글
  const [promptOnly, setPromptOnly] = useState(false); // 프롬프트만 보기(이미지·파라미터 숨김)
  // 소스(참조) 원본 미리보기 — 비교 모달 위에 뜨는 자체 라이트박스(전역 미리보기는 z-index 가 낮아 가림).
  const [srcPreview, setSrcPreview] = useState<CompareSourcePreview | null>(null);
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
  const common = commonPromptTokens(prompts);
  const commonElems = commonPromptElements(prompts); // 바뀐 엘리먼트 판정용

  // 공통 소스(모든 버전에 동일하게 들어간 참조) 집합 — 여기 없는 참조 = '다르게 들어간 소스' → 크게 표시.
  const refSets = gens.map((g) => new Set(g.references.map(refKey)));
  let commonRefs = new Set<string>(refSets[0] || []);
  for (let i = 1; i < refSets.length; i++) {
    commonRefs = new Set([...commonRefs].filter((k) => refSets[i].has(k)));
  }

  const keys = compareParamKeys(gens, onlyDiff);

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
            {gens.map((generation, idx) => (
              <CompareGenerationColumn
                key={generation.id}
                common={common}
                commonElems={commonElems}
                commonRefs={commonRefs}
                generation={generation}
                generations={gens}
                index={idx}
                keys={keys}
                modelName={modelName}
                onlyDiff={onlyDiff}
                onSourcePreview={setSrcPreview}
                prompt={prompts[idx]}
                promptOnly={promptOnly}
                videoRefs={videoRefs}
              />
            ))}
          </div>
        </div>
      </div>

      <CompareSourceLightbox preview={srcPreview} onClose={() => setSrcPreview(null)} />
    </>
  );
}

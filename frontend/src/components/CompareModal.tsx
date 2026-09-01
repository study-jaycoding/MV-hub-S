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
import { bindSynchronizedVideos } from "../lib/synchronizedVideos";
import {
  compareImageSource,
  fitCompareWindowToViewport,
  moveCompareWindow,
  resizeCompareWindow,
  type CompareWindowRect,
} from "../lib/compareWindow";
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
  const [onlyDiff, setOnlyDiff] = useState(false); // 다른 값 비교 토글
  const [promptOnly, setPromptOnly] = useState(false); // 프롬프트 비교(이미지·파라미터 숨김)
  // 이미지 비교 — 부분 수정의 A/B 와 같은 세로 분할선 와이프(왼쪽 A=1번, 오른쪽 B=2번,
  // 마우스 x 를 따라온다). 이미지 2개를 선택했을 때만 가능.
  const [imageCompare, setImageCompare] = useState(false);
  const [splitX, setSplitX] = useState(0.5); // 0..1, 와이프 상자 폭 기준
  const wipeSrcs = gens.map((g) => {
    const a = g.assets?.[0];
    return a?.type === "image" ? compareImageSource(a.file_path, a.thumbnail_path, true) : null;
  });
  const canImageCompare = gens.length === 2 && wipeSrcs.every((s) => !!s);
  const [maximized, setMaximized] = useState(false);
  const [windowRect, setWindowRect] = useState<CompareWindowRect | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  // 이미지 표시 방식 — 전체 보기(contain, 블랙바) ↔ 꽉 채우기(cover, 크롭). 다음에 열어도 유지.
  const [fitContain, setFitContain] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cmpFit") === "1";
    } catch {
      return false; // 프라이빗 모드·스토리지 차단 환경에서 접근이 막혀도 모달이 크래시하지 않게
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("cmpFit", fitContain ? "1" : "0");
    } catch {
      /* 스토리지 차단 환경 — 유지 저장만 건너뛴다 */
    }
  }, [fitContain]);
  // 소스(참조) 원본 미리보기 — 비교 모달 위에 뜨는 자체 라이트박스(전역 미리보기는 z-index 가 낮아 가림).
  const [srcPreview, setSrcPreview] = useState<CompareSourcePreview | null>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]); // 영상 동기 재생용
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 모달이 열려 있는 동안 이 모달이 키를 소유 — 폼 컨트롤(체크박스 등) 밖의 키는 배경(캔버스
      //  Delete 로 선택 카드 삭제 등)으로 새지 않게 막는다. capture 단계라 먼저 등록된 SceneBoard
      //  bubble 리스너보다 앞서 stopPropagation 이 걸린다.
      const t = e.target as HTMLElement | null;
      const formEl = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (!formEl) e.stopPropagation();
      if (e.key !== "Escape") return;
      if (srcPreview) setSrcPreview(null); // 라이트박스 먼저 닫기
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, srcPreview]);

  useEffect(() => {
    const onViewportResize = () => {
      setWindowRect((current) =>
        current
          ? fitCompareWindowToViewport(current, window.innerWidth, window.innerHeight)
          : null,
      );
    };
    window.addEventListener("resize", onViewportResize);
    return () => {
      window.removeEventListener("resize", onViewportResize);
      interactionCleanupRef.current?.();
    };
  }, []);

  const currentRect = (): CompareWindowRect | null => {
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  const beginWindowInteraction = (
    mode: "move" | "resize",
    event: React.PointerEvent<HTMLElement>,
  ) => {
    if (maximized || event.button !== 0) return;
    if (mode === "move" && (event.target as HTMLElement).closest("button, input, label")) return;
    const start = currentRect();
    if (!start) return;
    event.preventDefault();
    interactionCleanupRef.current?.();
    setWindowRect(start);
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;

    const onPointerMove = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      const deltaX = nextEvent.clientX - startX;
      const deltaY = nextEvent.clientY - startY;
      setWindowRect(
        mode === "move"
          ? moveCompareWindow(start, deltaX, deltaY, window.innerWidth, window.innerHeight)
          : resizeCompareWindow(start, deltaX, deltaY, window.innerWidth, window.innerHeight),
      );
    };
    const stop = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      interactionCleanupRef.current = null;
    };
    interactionCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const toggleMaximized = () => {
    interactionCleanupRef.current?.();
    if (!maximized && !windowRect) setWindowRect(currentRect());
    setMaximized((current) => !current);
  };

  // 영상 동기화 — 재생·정지·종료·수동 탐색을 두 비교 모달이 같은 공용 규칙으로 처리한다.
  useEffect(() => {
    const vids = videoRefs.current.filter((v): v is HTMLVideoElement => !!v);
    if (promptOnly || imageCompare || vids.length === 0) return;
    return bindSynchronizedVideos(vids);
  }, [gens, maximized, promptOnly, imageCompare]);

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
      <div
        ref={modalRef}
        className={"cmp-modal cmp-window" + (maximized ? " maximized" : "")}
        role="dialog"
        aria-label="버전 비교"
        style={
          !maximized && windowRect
            ? {
                left: windowRect.left,
                top: windowRect.top,
                width: windowRect.width,
                height: windowRect.height,
                transform: "none",
              }
            : undefined
        }
      >
        <header
          className="admin-head"
          onPointerDown={(event) => beginWindowInteraction("move", event)}
          onDoubleClick={(event) => {
            if (!(event.target as HTMLElement).closest("button")) toggleMaximized();
          }}
        >
          <span className="admin-title">⊞ 버전 비교 ({gens.length})</span>
          <div className="cmp-window-actions">
            <button
              className="cmp-window-control"
              onClick={toggleMaximized}
              title={maximized ? "창 크기로 복원" : "전체화면"}
              aria-label={maximized ? "창 크기로 복원" : "전체화면"}
            >
              {maximized ? "❐" : "□"}
            </button>
            <button className="assets-x" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
        </header>
        <div className="cmp-note">
          <span>
            바뀐 <span className="cmp-diff-g">{"<<<엘리먼트>>>"}</span>는 녹색, 그 외 바뀐
            단어·값은 <span className="cmp-diff">노란색</span>으로 표시합니다. 계보와 무관하게
            선택한 것끼리 비교합니다.
          </span>
          <div className="cmp-toggles">
            <button
              className={"fit-toggle" + (fitContain || maximized ? " on" : "")}
              disabled={maximized || imageCompare}
              onClick={() => setFitContain((v) => !v)}
              title={
                maximized
                  ? "전체화면에서는 원본 전체 보기로 고정됩니다"
                  : fitContain
                  ? "전체 보기(블랙바) — 클릭 시 꽉 채우기"
                  : "꽉 채우기(크롭) — 클릭 시 전체 보기"
              }
            >
              {fitContain || maximized ? "▢" : "▣"}
            </button>
            <label className="cmp-onlydiff">
              <input
                type="checkbox"
                checked={onlyDiff}
                disabled={promptOnly || imageCompare}
                onChange={(e) => setOnlyDiff(e.target.checked)}
              />
              다른 값 비교
            </label>
            <label
              className="cmp-onlydiff"
              title={
                canImageCompare
                  ? "이미지 2장을 세로 분할선으로 겹쳐 비교 — 마우스를 좌우로 움직이세요"
                  : "이미지 생성본 2개를 선택했을 때만 쓸 수 있습니다"
              }
            >
              <input
                type="checkbox"
                checked={imageCompare}
                disabled={!canImageCompare}
                onChange={(e) => {
                  setImageCompare(e.target.checked);
                  setSplitX(0.5);
                }}
              />
              이미지 비교
            </label>
            <label className="cmp-onlydiff">
              <input
                type="checkbox"
                checked={promptOnly}
                disabled={imageCompare}
                onChange={(e) => setPromptOnly(e.target.checked)}
              />
              프롬프트 비교
            </label>
          </div>
        </div>
        <div className="cmp-body">
          {imageCompare && canImageCompare ? (
            <div
              className="cmp-imgwipe"
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                if (!rect.width) return;
                setSplitX(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
              }}
            >
              {/* 바닥 = B(2번), 위에 A(1번)를 겹치고 분할선 오른쪽을 clip — 왼쪽 A / 오른쪽 B */}
              <img src={wipeSrcs[1]!} alt="" draggable={false} />
              <img
                src={wipeSrcs[0]!}
                alt=""
                draggable={false}
                style={{ clipPath: `inset(0 ${(100 - splitX * 100).toFixed(2)}% 0 0)` }}
              />
              <div className="cmp-abline" style={{ left: `${(splitX * 100).toFixed(2)}%` }} />
              <div className="cmp-ablabel">A 1번 · 2번 B</div>
            </div>
          ) : (
            <div
              className={"cmp-cols" + (fitContain || maximized ? " fit-contain" : "")}
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
                  useOriginalMedia={maximized}
                  videoRefs={videoRefs}
                />
              ))}
            </div>
          )}
        </div>
        {!maximized && (
          <div
            className="cmp-window-resize"
            onPointerDown={(event) => beginWindowInteraction("resize", event)}
            title="드래그하여 창 크기 조절"
            aria-hidden="true"
          />
        )}
      </div>

      <CompareSourceLightbox preview={srcPreview} onClose={() => setSrcPreview(null)} />
    </>
  );
}

// 스포트라이트 프롬프트의 '미디어 레퍼런스 토큰 → 색 있는 알약' 정규화 로직을 SpotlightPrompt 에서 추출.
//  · resolveTokenMedia: 토큰(@image1/<<<video1>>> 등)의 종류·번호 → 그 트레이 항목의 썸네일/비디오 URL.
//  · blur effect: 입력창을 벗어나면 손으로 친 토큰을 알약으로 감싼다(편집 종료 표시 후 정규화).
//  · scheduleLiveWrap: 타이핑이 잠깐 멈추면(디바운스 350ms) 손으로 친 토큰을 바로 알약으로 — 캐럿 노드는 제외.
// editingTokenNodeRef 는 멘션 감지와 공유되므로 컴포넌트가 소유하고, 여기선 blur 에서 null 로만 해제한다.
// onPromptChanged 는 반드시 안정된(useCallback) 콜백을 넘겨야 blur 재구독 빈도가 원본(model/trayRefs 변화 시)과 같다.
import { useCallback, useEffect, useRef } from "react";
import { refSrc } from "./promptParts";
import { wrapRefTokens } from "./promptEditor";
import { usesMediaRefTokens } from "./seedancePrompt";
import type { SpotlightTrayRef } from "../components/spotlight/SpotlightRefTray";

interface Params {
  model: string;
  trayRefs: SpotlightTrayRef[];
  editorRef: React.RefObject<HTMLDivElement>;
  editingTokenNodeRef: React.MutableRefObject<Node | null>;
  composingRef: React.MutableRefObject<boolean>;
  onPromptChanged: () => void; // 안정된 콜백(useCallback)이어야 함 — 트레이 역할 배지 갱신 신호.
}

export interface SpotlightTokenWrapApi {
  // refsOverride: setTrayRefs 가 아직 state 에 반영 전(재사용/히스토리 복원 직후)이면 방금 만든 트레이로 직접 푼다.
  resolveTokenMedia: (kind: string, n: number, refsOverride?: SpotlightTrayRef[]) => string | undefined;
  scheduleLiveWrap: () => void;
}

export function useSpotlightTokenWrap({
  model,
  trayRefs,
  editorRef,
  editingTokenNodeRef,
  composingRef,
  onPromptChanged,
}: Params): SpotlightTokenWrapApi {
  // 토큰(@image1/<<<video1>>>)의 종류·번호 → 그 트레이 항목의 썸네일/비디오 URL. 알약에 미디어를 넣는 데 쓴다.
  const resolveTokenMedia = useCallback(
    (kind: string, n: number, refsOverride?: SpotlightTrayRef[]): string | undefined => {
      const type = kind === "video" ? "video" : kind === "audio" ? "audio" : "image";
      let c = 0;
      // refsOverride: 재사용 직후 setTrayRefs 가 아직 state 에 반영 전이라, 방금 만든 트레이로 직접 푼다(stale 방지).
      for (const ref of refsOverride ?? trayRefs) {
        if (ref.type === type && ++c === n) {
          // 항목이 존재하면 썸네일이 없어도 "" 를 돌려줘 '존재함'을 알린다(undefined = 트레이에 없음 = missing).
          return type === "video" ? refSrc(ref.file_path) || "" : ref.thumb || "";
        }
      }
      return undefined;
    },
    [trayRefs],
  );

  // 입력창을 벗어나면(blur) 손으로 친 토큰(<<<video1>>>·@image1·언더바 변형)을 알약으로 감싼다(썸네일 포함).
  // 편집 중엔 안 건드리고(포커스 유지), 벗어날 때만 정리 → 캐럿 튐 없이 @처럼 보이게 한다.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const onBlur = () => {
      editingTokenNodeRef.current = null; // 편집 종료 — 재알약화되므로 멘션 억제 해제(가드보다 먼저)
      if (!usesMediaRefTokens(model)) return;
      wrapRefTokens(ed, resolveTokenMedia); // 풀어둔 토큰·손으로 친 토큰을 알약으로 정규화
      onPromptChanged();
    };
    ed.addEventListener("blur", onBlur);
    return () => ed.removeEventListener("blur", onBlur);
  }, [model, resolveTokenMedia, onPromptChanged, editorRef, editingTokenNodeRef]);

  // 라이브 알약화 — 타이핑이 잠깐 멈추면 손으로 친 토큰(<<<video1>>>·@image1)을 바로 알약으로 감싼다.
  // '지금 입력 중인 토큰'(캐럿이 있는 텍스트 노드)은 건드리지 않아 캐럿이 튀지 않는다(에디터를 벗어날 때
  // 까지 기다리던 딜레이 제거). 편집 모드(알약 클릭)인 동안엔 쉬어 이름 편집을 방해하지 않는다.
  const liveWrapTimer = useRef<number | null>(null);
  const scheduleLiveWrap = useCallback(() => {
    if (!usesMediaRefTokens(model)) return;
    if (liveWrapTimer.current) window.clearTimeout(liveWrapTimer.current);
    liveWrapTimer.current = window.setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || composingRef.current) return;
      wrapRefTokens(ed, resolveTokenMedia, { skipCaretNode: true }); // 입력 중 토큰(캐럿 노드)은 두고 나머지만
    }, 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, resolveTokenMedia]);
  useEffect(() => () => {
    if (liveWrapTimer.current) window.clearTimeout(liveWrapTimer.current);
  }, []);

  return { resolveTokenMedia, scheduleLiveWrap };
}

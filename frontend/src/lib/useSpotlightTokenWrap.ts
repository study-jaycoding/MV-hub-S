// 스포트라이트 프롬프트의 '미디어 레퍼런스 토큰 → 색 있는 알약' 정규화 로직을 SpotlightPrompt 에서 추출.
//  · resolveTokenMedia: 토큰(@image1/<<<video1>>> 등)의 종류·번호 → 그 트레이 항목의 썸네일/비디오 URL.
//  · blur effect: 입력창을 벗어나면 손으로 친 토큰을 알약으로 감싼다(편집 종료 표시 후 정규화).
//  · scheduleLiveWrap: 타이핑이 잠깐 멈추면(디바운스 350ms) 손으로 친 토큰을 바로 알약으로 — 캐럿 노드는 제외.
// editingTokenNodeRef 는 멘션 감지와 공유되므로 컴포넌트가 소유하고, 여기선 blur 에서 null 로만 해제한다.
// onPromptChanged 는 반드시 안정된(useCallback) 콜백을 넘겨야 blur 재구독 빈도가 원본(model/trayRefs 변화 시)과 같다.
import { useCallback, useEffect, useRef } from "react";
import { displayRefThumb } from "./media";
import { refSrc } from "./promptParts";
import { refreshTokenPills, wrapRefTokens } from "./promptEditor";
import { usesMediaRefTokens } from "./seedancePrompt";
import type { SpotlightTrayRef } from "../components/spotlight/SpotlightRefTray";

interface Params {
  model: string;
  trayRefs: SpotlightTrayRef[];
  editorRef: React.RefObject<HTMLDivElement>;
  editingTokenNodeRef: React.MutableRefObject<Node | null>;
  composingRef: React.MutableRefObject<boolean>;
  onPromptChanged: () => void; // 안정된 콜백(useCallback)이어야 함 — 트레이 역할 배지 갱신 신호.
  assetVersionTick?: number; // 전역 어셋 버전 표 스냅샷 — 원본이 바뀌면 알약 썸네일을 다시 그리게 하는 트리거.
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
  assetVersionTick,
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
          // asset 소스면 file_path 로 버전 반영된 URL 생성(원본 교체 시 새 썸네일). 항목이 있으면 최소 ""(존재).
          return type === "video" ? refSrc(ref.file_path) || "" : displayRefThumb(ref) || "";
        }
      }
      return undefined;
    },
    [trayRefs],
  );
  // 타이머가 실제로 발화할 때(350ms 뒤)의 '최신' resolveTokenMedia 를 쓰도록 ref 로 보관한다.
  // 카드 복귀 직후 스케줄된 라이브랩 타이머가 스케줄 시점의 낡은 trayRefs(이전 카드/빈 트레이) 클로저를
  // 붙잡아, 방금 복원한 @image1/@image2 를 '트레이에 없음(missing)'=빨간 경고로 잘못 칠하던 버그 수정.
  const resolveTokenMediaRef = useRef(resolveTokenMedia);
  resolveTokenMediaRef.current = resolveTokenMedia;

  // 입력창을 벗어나면(blur) 손으로 친 토큰(<<<video1>>>·@image1·언더바 변형)을 알약으로 감싼다(썸네일 포함).
  // 편집 중엔 안 건드리고(포커스 유지), 벗어날 때만 정리 → 캐럿 튐 없이 @처럼 보이게 한다.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const onBlur = () => {
      editingTokenNodeRef.current = null; // 편집 종료 — 재알약화되므로 멘션 억제 해제(가드보다 먼저)
      if (!usesMediaRefTokens(model)) return;
      // 발화 시점의 최신 resolve 사용(타이머와 동일 이유) — 낡은 trayRefs 로 missing 오탐 방지.
      // 한 번 missing 으로 칠하면 wrapRefTokens 가 기존 알약을 건너뛰어 자동 교정이 안 되므로 여기서도 막는다.
      wrapRefTokens(ed, resolveTokenMediaRef.current); // 풀어둔 토큰·손으로 친 토큰을 알약으로 정규화
      onPromptChanged();
    };
    ed.addEventListener("blur", onBlur);
    return () => ed.removeEventListener("blur", onBlur);
  }, [model, onPromptChanged, editorRef, editingTokenNodeRef]);

  // 라이브 알약화 — 타이핑이 잠깐 멈추면 손으로 친 토큰(<<<video1>>>·@image1)을 바로 알약으로 감싼다.
  // '지금 입력 중인 토큰'(캐럿이 있는 텍스트 노드)은 건드리지 않아 캐럿이 튀지 않는다(에디터를 벗어날 때
  // 까지 기다리던 딜레이 제거). 편집 모드(알약 클릭)인 동안엔 쉬어 이름 편집을 방해하지 않는다.
  const liveWrapTimer = useRef<number | null>(null);
  // 트레이 순서/구성이 바뀌면 이미 박힌 알약 썸네일도 그 위치의 새 레퍼런스로 즉시 갱신한다.
  //  @imageN 은 '위치 토큰'이라 순서만 바뀌어도 가리키는 이미지가 달라진다 → 표시(썸네일)를 실시간 일치.
  //  refreshTokenPills 는 원자 알약(contentEditable=false)만 교체하므로 편집 캐럿에 영향 없다.
  //  ★file_path 포함 필수 — 비디오 알약은 resolveTokenMedia 가 thumb 이 아니라 file_path(refSrc)를 쓰므로,
  //   같은 thumb 의 서로 다른 비디오를 재정렬해도 sig 가 바뀌게 하려면 file_path 가 있어야 한다.
  const trayMediaSig = trayRefs.map((r) => `${r.type}:${r.file_path}:${r.thumb || ""}`).join("|");
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !usesMediaRefTokens(model)) return;
    if (composingRef.current) return; // IME 조합 중엔 건드리지 않는다(조합 깨짐 방지)
    refreshTokenPills(ed, resolveTokenMediaRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayMediaSig, model, assetVersionTick]);

  const scheduleLiveWrap = useCallback(() => {
    if (!usesMediaRefTokens(model)) return;
    if (liveWrapTimer.current) window.clearTimeout(liveWrapTimer.current);
    liveWrapTimer.current = window.setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || composingRef.current) return;
      // 발화 시점의 최신 resolve(정착된 trayRefs)로 해석 — 스케줄 시점 클로저(낡은 refs) 사용 금지.
      wrapRefTokens(ed, resolveTokenMediaRef.current, { skipCaretNode: true }); // 입력 중 토큰(캐럿 노드)은 두고 나머지만
    }, 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  useEffect(() => () => {
    if (liveWrapTimer.current) window.clearTimeout(liveWrapTimer.current);
  }, []);

  return { resolveTokenMedia, scheduleLiveWrap };
}

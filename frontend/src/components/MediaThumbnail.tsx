// 생성본 썸네일의 미디어 분기(영상 포스터 / 이미지 / 포스터 없는 영상)를 한 곳으로 모은 표현 컴포넌트.
// 카드 그리드·히스토리 패널·히스토리 보드가 똑같은 3분기를 복붙하고 있었다 — 새 미디어 타입이나
// loading/preload 속성을 바꿀 때 한 곳만 고치면 된다. 사이트마다 다른 placeholder(상태 표시)는
// fallback 슬롯으로 받아 각자 유지(에셋 코멘트처럼 억지 통합하지 않음). AssetCell(오디오·fillStyle·
// node 모델)은 구조가 달라 포함하지 않는다.
import type { ReactNode, Ref } from "react";
import { useEffect, useState } from "react";

export interface MediaThumbnailLoadState {
  thumbBroken: boolean;
  mediaBroken: boolean;
}

export const INITIAL_MEDIA_THUMBNAIL_LOAD_STATE: MediaThumbnailLoadState = {
  thumbBroken: false,
  mediaBroken: false,
};

// 이미지 썸네일 실패는 원본 재시도가 가능할 때 한 번만 넘기고, 그 외 실패는 최종 fallback으로 간다.
// DOM 없이도 경계조건을 검증할 수 있게 순수 전이로 둔다.
export function nextMediaThumbnailErrorState(
  state: MediaThumbnailLoadState,
  canRetryOriginal: boolean,
): MediaThumbnailLoadState {
  if (canRetryOriginal && !state.thumbBroken) {
    return { thumbBroken: true, mediaBroken: false };
  }
  return { ...state, mediaBroken: true };
}

export function nextVideoPosterErrorState(
  state: MediaThumbnailLoadState,
): MediaThumbnailLoadState {
  return state.mediaBroken ? state : { thumbBroken: true, mediaBroken: false };
}

interface Props {
  className?: string;
  thumb: string | null | undefined; // 썸네일(포스터) URL
  isVideo: boolean; // 결과물이 영상인가
  src?: string | null; // 영상 파일 경로(영상일 때만 필요)
  alt?: string; // 이미지 대체 텍스트
  videoRef?: Ref<HTMLVideoElement>; // 호버 재생용 ref(필요 없으면 생략)
  fallback: ReactNode; // 썸네일·영상 둘 다 없을 때 보일 사이트별 상태 플레이스홀더
  onError?: () => void; // 미디어 로드 실패(원본 URL 죽음 등) — 카드가 '원본 없음' 표시에 사용
  // 이미지 썸네일이 깨졌을 때 원본 src 로 한 번 재시도(교차서버 팀 레퍼런스처럼 캐시 썸네일만 죽은 경우).
  // opt-in — 기본 off 라 기존 소비처 동작은 그대로. src 가 thumb 와 다를 때만 유효.
  retrySrcOnThumbError?: boolean;
}

export function MediaThumbnail({
  className,
  thumb,
  isVideo,
  src,
  alt = "",
  videoRef,
  fallback,
  onError,
  retrySrcOnThumbError,
}: Props) {
  const [loadState, setLoadState] = useState<MediaThumbnailLoadState>(
    INITIAL_MEDIA_THUMBNAIL_LOAD_STATE,
  );
  // 다른 미디어로 재렌더되면 이전 URL의 실패·재시도 상태를 넘기지 않는다.
  useEffect(() => setLoadState(INITIAL_MEDIA_THUMBNAIL_LOAD_STATE), [thumb, src, isVideo]);
  const terminalError = () => {
    if (!loadState.mediaBroken) onError?.();
    setLoadState({ ...loadState, mediaBroken: true });
  };
  if (loadState.mediaBroken) return <>{fallback}</>;
  // 영상 + 썸네일: 포스터로 깔고 호버 시 재생(preload 없음).
  // poster 자체의 HTTP 실패는 <video onError>로 일관되게 전달되지 않으므로 같은 URL의 숨은
  // 이미지 probe로 실패를 감지한다. 실패하면 아래의 preload=metadata 첫 프레임 폴백으로 한 번만
  // 전환한다. 정상 경로는 브라우저 캐시가 요청을 합쳐 원본 영상 바이트를 전혀 읽지 않는다.
  if (thumb && isVideo && !loadState.thumbBroken)
    return (
      <>
        <img
          src={thumb}
          alt=""
          aria-hidden="true"
          style={{ display: "none" }}
          onError={() => setLoadState(nextVideoPosterErrorState(loadState))}
        />
        <video
          className={className}
          ref={videoRef ?? undefined}
          src={src ?? undefined}
          poster={thumb}
          muted
          loop
          playsInline
          preload="none"
          draggable={false}
          onError={terminalError}
        />
      </>
    );
  // 이미지(또는 영상의 정지 썸네일).
  if (thumb) {
    // 재시도 옵션 + 썸네일이 깨졌고 원본 src 가 별도로 있으면 원본으로 교체(한 번만).
    const canRetry = retrySrcOnThumbError && !!src && src !== thumb;
    const imgSrc = canRetry && loadState.thumbBroken ? src : thumb;
    return (
      <img
        className={className}
        src={imgSrc}
        loading="lazy"
        decoding="async"
        alt={alt}
        draggable={false}
        onError={() => {
          const next = nextMediaThumbnailErrorState(loadState, !!canRetry);
          if (next.mediaBroken && !loadState.mediaBroken) onError?.();
          setLoadState(next);
        }}
      />
    );
  }
  // 영상인데 썸네일 없음: 첫 프레임을 메타데이터로 띄워 'done' 대신 내용이 보이게.
  if (isVideo && src)
    return (
      <video
        className={className}
        ref={videoRef ?? undefined}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
        onError={terminalError}
      />
    );
  // 둘 다 없음 → 사이트별 플레이스홀더.
  return <>{fallback}</>;
}

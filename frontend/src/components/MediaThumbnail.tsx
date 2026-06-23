// 생성본 썸네일의 미디어 분기(영상 포스터 / 이미지 / 포스터 없는 영상)를 한 곳으로 모은 표현 컴포넌트.
// 카드 그리드·히스토리 패널·히스토리 보드가 똑같은 3분기를 복붙하고 있었다 — 새 미디어 타입이나
// loading/preload 속성을 바꿀 때 한 곳만 고치면 된다. 사이트마다 다른 placeholder(상태 표시)는
// fallback 슬롯으로 받아 각자 유지(에셋 코멘트처럼 억지 통합하지 않음). AssetCell(오디오·fillStyle·
// node 모델)은 구조가 달라 포함하지 않는다.
import type { ReactNode, Ref } from "react";

interface Props {
  thumb: string | null | undefined; // 썸네일(포스터) URL
  isVideo: boolean; // 결과물이 영상인가
  src?: string | null; // 영상 파일 경로(영상일 때만 필요)
  alt?: string; // 이미지 대체 텍스트
  videoRef?: Ref<HTMLVideoElement>; // 호버 재생용 ref(필요 없으면 생략)
  fallback: ReactNode; // 썸네일·영상 둘 다 없을 때 보일 사이트별 상태 플레이스홀더
}

export function MediaThumbnail({ thumb, isVideo, src, alt = "", videoRef, fallback }: Props) {
  // 영상 + 썸네일: 포스터로 깔고 호버 시 재생(preload 없음).
  if (thumb && isVideo)
    return (
      <video
        ref={videoRef ?? undefined}
        src={src ?? undefined}
        poster={thumb}
        muted
        loop
        playsInline
        preload="none"
        draggable={false}
      />
    );
  // 이미지(또는 영상의 정지 썸네일).
  if (thumb)
    return <img src={thumb} loading="lazy" decoding="async" alt={alt} draggable={false} />;
  // 영상인데 썸네일 없음: 첫 프레임을 메타데이터로 띄워 'done' 대신 내용이 보이게.
  if (isVideo && src)
    return (
      <video
        ref={videoRef ?? undefined}
        src={src}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
      />
    );
  // 둘 다 없음 → 사이트별 플레이스홀더.
  return <>{fallback}</>;
}

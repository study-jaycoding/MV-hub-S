import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_THUMBNAIL_LOAD_STATE,
  nextMediaThumbnailErrorState,
  nextVideoPosterErrorState,
} from "../src/components/MediaThumbnail";

describe("MediaThumbnail failure state", () => {
  it("moves directly to fallback when no original retry is available", () => {
    expect(nextMediaThumbnailErrorState(INITIAL_MEDIA_THUMBNAIL_LOAD_STATE, false)).toEqual({
      thumbBroken: false,
      mediaBroken: true,
    });
  });

  it("retries the original once, then moves to fallback after the original also fails", () => {
    const retry = nextMediaThumbnailErrorState(INITIAL_MEDIA_THUMBNAIL_LOAD_STATE, true);
    const failed = nextMediaThumbnailErrorState(retry, true);

    expect(retry).toEqual({ thumbBroken: true, mediaBroken: false });
    expect(failed).toEqual({ thumbBroken: true, mediaBroken: true });
  });

  it("keeps terminal failure terminal", () => {
    const failed = { thumbBroken: true, mediaBroken: true };
    expect(nextMediaThumbnailErrorState(failed, true)).toEqual(failed);
  });

  it("영상 포스터 실패 상태는 원본 영상 첫 프레임 폴백을 사용할 수 있는 비종료 상태다", () => {
    expect(nextVideoPosterErrorState(INITIAL_MEDIA_THUMBNAIL_LOAD_STATE)).toEqual({
      thumbBroken: true,
      mediaBroken: false,
    });
  });
});

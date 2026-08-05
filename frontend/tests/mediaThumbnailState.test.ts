import { describe, expect, it } from "vitest";
import {
  INITIAL_MEDIA_THUMBNAIL_LOAD_STATE,
  nextMediaThumbnailErrorState,
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
});

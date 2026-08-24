import { describe, expect, it } from "vitest";
import {
  dataTransferHasFiles,
  filesFromDataTransfer,
  mediaThumbUrl,
  thumbOf,
} from "../src/lib/media";

type TransferParts = {
  types?: string[];
  files?: File[];
  items?: Array<{ kind: string; getAsFile: () => File | null }>;
};

function transfer({ types = [], files = [], items = [] }: TransferParts): DataTransfer {
  return { types, files, items } as unknown as DataTransfer;
}

const sceneFile = { name: "base01.mvscene.json", type: "application/json" } as File;

describe("외부 파일 드래그 판별", () => {
  it("Files 타입의 대소문자가 달라도 파일 드래그로 인식한다", () => {
    expect(dataTransferHasFiles(transfer({ types: ["files"] }))).toBe(true);
  });

  it("types가 비어도 files 또는 file item이 있으면 인식한다", () => {
    expect(dataTransferHasFiles(transfer({ files: [sceneFile] }))).toBe(true);
    expect(
      dataTransferHasFiles(
        transfer({ items: [{ kind: "file", getAsFile: () => sceneFile }] }),
      ),
    ).toBe(true);
  });

  it("표준 files 목록을 우선 반환한다", () => {
    expect(filesFromDataTransfer(transfer({ files: [sceneFile] }))).toEqual([sceneFile]);
  });

  it("files가 비면 items에서 파일을 복원하고 null은 제외한다", () => {
    expect(
      filesFromDataTransfer(
        transfer({
          items: [
            { kind: "string", getAsFile: () => null },
            { kind: "file", getAsFile: () => null },
            { kind: "file", getAsFile: () => sceneFile },
          ],
        }),
      ),
    ).toEqual([sceneFile]);
  });
});

describe("미디어 썸네일 URL", () => {
  it("포스터 없는 영상도 원본 대신 media-thumb 첫 프레임 캐시를 사용한다", () => {
    const generation = {
      assets: [{ type: "video", file_path: "/media/aa/result.mp4", thumbnail_path: null }],
    } as Parameters<typeof thumbOf>[0];

    expect(thumbOf(generation, 256)).toBe(
      "/api/media-thumb?src=%2Fmedia%2Faa%2Fresult.mp4&w=256",
    );
    expect(mediaThumbUrl("/media/aa/result.mp4", null, "video", 512)).toBe(
      "/api/media-thumb?src=%2Fmedia%2Faa%2Fresult.mp4&w=512",
    );
  });

  it("오디오는 영상 포스터 경로를 만들지 않는다", () => {
    expect(mediaThumbUrl("/media/aa/sound.wav", null, "audio", 256)).toBeNull();
  });

  it("포스터 없는 원격 영상은 대용량 전체 다운로드 대신 Range 폴백을 남긴다", () => {
    expect(mediaThumbUrl("https://cdn.example/result.mp4", null, "video", 256)).toBeNull();
    expect(
      mediaThumbUrl(
        "https://cdn.example/result.mp4",
        "https://cdn.example/poster.jpg",
        "video",
        256,
      ),
    ).toContain("/api/media-thumb?");
  });
});

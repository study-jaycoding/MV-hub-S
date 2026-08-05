import { describe, expect, it } from "vitest";
import { dataTransferHasFiles, filesFromDataTransfer } from "../src/lib/media";

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

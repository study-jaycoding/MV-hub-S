// 다운로드 폴더에 직접 저장할 때 같은 이름의 파일을 덮지 않는다(조작 규칙 49 — 22회차, Codex 전수 검토).
// 전엔 `getFileHandle(name, { create: true })` → `createWritable()` 이 기존 파일의 내용을 말없이 갈아, 소스 이름이 같은 다른 그림을
// 받으면 먼저 받은 파일이 사라졌다(두 번째도 '성공'으로 떴다). 폴더는 가짜 핸들이다 — File System Access API 는 jsdom 에 없다.
import { Blob as NodeBlob } from "node:buffer";
import { expect, it } from "vitest";
import { writeIntoDir } from "../src/lib/downloadDir";

const blob = (text: string) => new NodeBlob([text]) as unknown as Blob;

/** 가짜 폴더 — 파일 이름 → 내용. getFileHandle 은 진짜처럼 없는 파일에 NotFoundError 를 던진다. `gate` 를 주면 쓰기가 그것을 기다린다. */
function fakeDir(gate?: Promise<void>, caseBlind = false) {
  const files = new Map<string, Blob>();
  const keyOf = (name: string) => (caseBlind ? name.toLowerCase() : name); // Windows 폴더는 대소문자만 다른 이름을 같은 파일로 본다
  const dir = {
    async getFileHandle(asked: string, options?: { create?: boolean }) {
      const name = keyOf(asked);
      if (!files.has(name) && !options?.create) throw Object.assign(new Error("없음"), { name: "NotFoundError" });
      return {
        getFile: async () => files.get(name)!,
        createWritable: async () => ({
          write: async (data: Blob) => { await gate; files.set(name, data); },
          close: async () => {},
        }),
      };
    },
  };
  const read = async () => Object.fromEntries(await Promise.all([...files].map(async ([name, data]) => [name, await data.text()])));
  return { dir, files, read };
}

it("같은 이름의 다른 파일이 있으면 덮지 않고 번호를 붙인다 — 같은 내용이면 다시 쓰지 않는다", async () => {
  const { dir, read } = fakeDir();
  expect(await writeIntoDir(dir, "shot.png", blob("첫 그림"))).toBe(true);
  expect(await writeIntoDir(dir, "shot.png", blob("둘째 그림"))).toBe(true); // 소스 이름이 같은 다른 그림
  expect(await read()).toEqual({ "shot.png": "첫 그림", "shot (1).png": "둘째 그림" }); // 전엔 shot.png 가 둘째 그림으로 바뀌었다
  expect(await writeIntoDir(dir, "shot.png", blob("첫 그림"))).toBe(true); // 같은 것을 다시 받았다 — 사본을 늘리지 않는다
  expect(await writeIntoDir(dir, "shot.png", blob("둘째 그림"))).toBe(true); // 번호 붙은 쪽과 같은 것도
  expect(Object.keys(await read())).toEqual(["shot.png", "shot (1).png"]);
  expect(await writeIntoDir(dir, "shot.png", blob("셋째 그림"))).toBe(true);
  expect((await read())["shot (2).png"]).toBe("셋째 그림");
  // 길이가 같아도 내용이 다르면 다른 파일이다 · 확장자가 없는 이름
  expect(await writeIntoDir(dir, "note", blob("가나다"))).toBe(true);
  expect(await writeIntoDir(dir, "note", blob("가나라"))).toBe(true);
  expect(await read()).toMatchObject({ note: "가나다", "note (1)": "가나라" });
});

it("잇달아 시작한 저장 둘이 같은 빈 이름을 같이 잡지 않는다(둘 다 '없음'을 보고 같은 파일에 쓰면 하나가 사라진다)", async () => {
  let open!: () => void;
  const { dir, read } = fakeDir(new Promise<void>((resolve) => { open = resolve; }));
  const both = Promise.all([writeIntoDir(dir, "clip.mp4", blob("영상 A")), writeIntoDir(dir, "clip.mp4", blob("영상 B"))]);
  open();
  expect(await both).toEqual([true, true]);
  expect(await read()).toEqual({ "clip.mp4": "영상 A", "clip (1).mp4": "영상 B" }); // 전엔 clip.mp4 하나에 나중 것만 남았다
});

// Codex 코드 리뷰: 쓰는 중인 이름을 글자 그대로 잡으면, 대소문자만 다른 두 이름(Shot.png · shot.png)이 서로 다른 이름으로 보여 둘 다
//  '없음'을 확인하고 — Windows 폴더에서는 같은 파일이라 — 한 파일에 같이 쓴다.
it("대소문자만 다른 이름으로 잇달아 시작한 저장 둘도 한 파일에 같이 쓰지 않는다(Windows 폴더)", async () => {
  let open!: () => void;
  const { dir, read } = fakeDir(new Promise<void>((resolve) => { open = resolve; }), true);
  const both = Promise.all([writeIntoDir(dir, "Shot.png", blob("그림 A")), writeIntoDir(dir, "shot.png", blob("그림 B"))]);
  open();
  expect(await both).toEqual([true, true]);
  expect(await read()).toEqual({ "shot.png": "그림 A", "shot (1).png": "그림 B" }); // 전엔 한 파일에 나중 것만 남았다
});

it("읽을 수 없는 폴더(권한이 풀림 등)의 오류는 삼키지 않고 올린다 — 부르는 쪽이 일반 다운로드로 돌린다", async () => {
  const dir = { getFileHandle: async () => { throw Object.assign(new Error("권한 없음"), { name: "NotAllowedError" }); } };
  await expect(writeIntoDir(dir, "shot.png", blob("그림"))).rejects.toThrow("권한 없음");
  // '있는지 못 봤다'를 '없다'로 치지 않는다 — 치면 있는 파일을 덮는다(되돌려 확인이 안 잡던 줄: 위의 폴더는 만들기도 같이 실패해 차이가 안 보였다).
  //  있는지 보는 조회만 실패하고 만들기는 되는 폴더 — 파일은 그대로여야 한다.
  const { dir: real, read } = fakeDir();
  await writeIntoDir(real, "shot.png", blob("먼저 받은 그림"));
  const flaky = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      if (!options?.create) throw Object.assign(new Error("잠깐 못 읽음"), { name: "InvalidStateError" });
      return real.getFileHandle(name, options);
    },
  };
  await expect(writeIntoDir(flaky, "shot.png", blob("나중 그림"))).rejects.toThrow("잠깐 못 읽음");
  expect(await read()).toEqual({ "shot.png": "먼저 받은 그림" });
});

it("쓰다 실패하면(디스크 꽉 참·잠김) 방금 만든 빈 파일을 치우고 오류를 올린다 — 있던 파일은 그대로(47회차)", async () => {
  const { dir: real, files, read } = fakeDir();
  await writeIntoDir(real, "shot.png", blob("먼저 받은 그림"));
  const aborted: string[] = [];
  const full = {
    getFileHandle: async (name: string, options?: { create?: boolean }) => {
      const handle = await real.getFileHandle(name, options);
      if (options?.create) files.set(name, blob("")); // 진짜처럼 만들면 빈 파일이 생긴다
      return {
        ...handle,
        createWritable: async () => ({
          write: async () => { throw Object.assign(new Error("디스크 꽉 참"), { name: "QuotaExceededError" }); },
          close: async () => {},
          abort: async () => { aborted.push(name); },
        }),
      };
    },
    removeEntry: async (name: string) => { files.delete(name); },
  };
  await expect(writeIntoDir(full, "shot.png", blob("나중 그림"))).rejects.toThrow("디스크 꽉 참");
  expect(aborted).toEqual(["shot (1).png"]);
  expect(await read()).toEqual({ "shot.png": "먼저 받은 그림" }); // 전엔 빈 'shot (1).png' 가 남았다
});

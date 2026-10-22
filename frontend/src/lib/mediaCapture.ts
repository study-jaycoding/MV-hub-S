// 크게 보기의 영상 장면·이미지를 PNG 로 떠서 클립보드에 담거나 파일로 저장한다(Jay 2026-10-22 — 크롬 우클릭 메뉴 대신 앱 메뉴).
//  클립보드 쓰기·저장 창은 사용자 동작(누름)이 식기 전에 열어야 한다 — 그래서 둘 다 **만드는 중인 Promise** 를 받아, 누른 자리에서
//  바로 부르게 했다(그림을 다 만든 뒤 부르면 영상 사본을 읽는 몇 초 사이 허락이 식어 막힌다).
import { fetchBlob } from "./download";

function canvasPng(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(source, 0, 0, width, height);
    // 다른 출처의 그림이 그려졌으면 여기서 SecurityError 가 난다(아래 videoFramePng 가 받는다)
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png encode failed"))), "image/png");
  });
}

function mediaEvent(media: HTMLMediaElement, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), 15_000);
    media.addEventListener(type, () => { clearTimeout(timer); resolve(); }, { once: true });
    media.addEventListener("error", () => { clearTimeout(timer); reject(new Error("media load failed")); }, { once: true });
  });
}

/** 보이는 영상의 지금 장면. CDN 영상은 그대로 그리면 다른 출처라 막힌다 — 같은 주소를 CORS 로 따로 읽어 같은 시각에서 뜬다
 *  (힉스필드 CDN 은 CORS 를 허용한다 — 격리 실측 854×480). 같은 출처(로컬 미디어)는 보이는 영상을 바로 그린다. */
export async function videoFramePng(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("video not ready");
  // 누른 순간의 장면 — 사본을 읽는 동안에도 원본은 계속 재생된다(Codex 검토 10-22: 뒤의 장면을 떴다)
  const at = video.currentTime;
  const src = video.currentSrc || video.src;
  try {
    return await canvasPng(video, width, height);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
  const copy = document.createElement("video");
  copy.crossOrigin = "anonymous";
  copy.muted = true;
  copy.preload = "auto";
  copy.src = src;
  try {
    await mediaEvent(copy, "loadedmetadata");
    const seeked = mediaEvent(copy, "seeked");
    copy.currentTime = at;
    await seeked;
    return await canvasPng(copy, width, height);
  } finally {
    copy.removeAttribute("src");
    copy.load(); // 받던 것을 놓는다
  }
}

/** 이미지 원본을 PNG 로 — 클립보드는 PNG 만 받는다. 받은 바이트로 그려서 다른 출처라도 막히지 않는다. */
export async function imagePng(url: string, name: string): Promise<Blob> {
  const blob = await fetchBlob(url, name);
  if (!blob) throw new Error("image fetch failed");
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    return await canvasPng(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** PNG 를 클립보드에. 못 담으면 그 까닭 — "media"(그림을 못 만듦) · "clipboard"(브라우저가 막음·지원 안 함). */
export async function copyPng(png: Promise<Blob>): Promise<"ok" | "media" | "clipboard"> {
  png.catch(() => {}); // 실패는 아래에서 가른다(처리 안 된 거절로 남기지 않는다)
  try {
    if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") throw new Error("clipboard unsupported");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return "ok";
  } catch {
    return (await png.then(() => true, () => false)) ? "clipboard" : "media";
  }
}

type WritableFile = { write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type SaveFilePicker = (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableFile> }>;

/** 다른 이름으로 저장 — 저장 창이 없는 환경(보안 문맥 밖·다른 브라우저)이면 내려받기. 창에서 취소하면 "cancelled". */
export async function saveBlobAs(blob: Promise<Blob>, name: string): Promise<"saved" | "downloaded" | "cancelled" | "failed"> {
  blob.catch(() => {});
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    let handle: Awaited<ReturnType<SaveFilePicker>>;
    try {
      handle = await picker.call(window, { suggestedName: name });
    } catch (error) {
      return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
    }
    let writable: WritableFile | null = null;
    try {
      writable = await handle.createWritable();
      await writable.write(await blob);
      await writable.close();
      return "saved";
    } catch {
      await writable?.abort().catch(() => {}); // 덜 쓴 내용을 남기지 않는다
      return "failed";
    }
  }
  let data: Blob;
  try {
    data = await blob;
  } catch {
    return "failed";
  }
  const href = URL.createObjectURL(data);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return "downloaded";
}

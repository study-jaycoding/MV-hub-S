"use strict";
const path = require("path");
const DEFAULT_ORIGIN = "http://127.0.0.1:8010";
const accepts = { min: 1, max: 1 };
// prepare가 보존하는 원본 확장자 중 media_types.CACHE_MEDIA_EXTENSIONS만 내준다.
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
function hubOrigin(value) {
  if (typeof value !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(value)) return null;
  try {
    const url = new URL(value);
    const port = Number(value.match(/:(\d+)\/?$/)[1]);
    if (port < 1 || port > 65535 || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}
function pageOrigin(value) { try { return new URL(value).origin; } catch { return null; } }
function createHubState() {
  let origin = DEFAULT_ORIGIN;
  const navigation = url => pageOrigin(url) === origin;
  const ipc = input => {
    try {
      const { sender, owner, frame, mainFrame } = input;
      return !!frame && sender === owner && frame === mainFrame && navigation(frame.url);
    } catch { return false; } // 닫히는 프레임의 접근자가 던져도 동기 호출에는 거절을 돌려준다.
  };
  return {
    get origin() { return origin; },
    set(value) { origin = hubOrigin(value) || DEFAULT_ORIGIN; return origin; },
    navigation, ipc,
    hello(input) { return { origin, supported: ipc(input) }; },
  };
}
function acceptsProtocol(value) { return Number.isInteger(value) && value >= accepts.min && value <= accepts.max; }
function dragPath(value, stat) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(value)
      || value.includes("\0") || !MEDIA_EXTENSIONS.has(path.win32.extname(value).toLowerCase())) return false;
  try { return stat(value).isFile(); } catch { return false; }
}
function restoreBounds(saved, displays) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || saved.width < 320 || saved.height < 240) return null;
  return displays.some(({ x, y, width, height }) => saved.x >= x && saved.y >= y && saved.x + saved.width <= x + width && saved.y + saved.height <= y + height)
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null;
}
module.exports = { DEFAULT_ORIGIN, accepts, MEDIA_EXTENSIONS, hubOrigin, createHubState, acceptsProtocol, dragPath, restoreBounds };

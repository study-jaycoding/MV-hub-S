"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// sandbox에서는 argv나 로컬 모듈 없이 main의 현재 출처 한 곳만 믿는다.
const hello = ipcRenderer.sendSync("mvhub:hello");
if (hello && hello.supported && window === window.top && window.location.origin === hello.origin) {
  contextBridge.exposeInMainWorld("mvhubResolve", {
    protocol: 1, accepts: { min: 1, max: 1 },
    startDrag: (path, opts) => ipcRenderer.sendSync("mvhub:drag", path, opts) === true,
  });
}

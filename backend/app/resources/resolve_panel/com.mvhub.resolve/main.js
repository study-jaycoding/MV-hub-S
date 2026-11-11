"use strict";
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const rules = require("./rules");
const state = rules.createHubState();
let win, retry;
const dataRoot = () => path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "MVHub", "resolve-panel");
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const input = event => ({ sender: event.sender, owner: win && win.webContents, frame: event.senderFrame, mainFrame: win && win.webContents.mainFrame });
ipcMain.on("mvhub:hello", event => {
  try { event.returnValue = state.hello(input(event)); }
  catch { event.returnValue = { origin: state.origin, supported: false }; }
});
ipcMain.on("mvhub:drag", (event, file, opts) => {
  let accepted = false;
  try {
    if (!state.ipc(input(event)) || !rules.acceptsProtocol(opts && opts.protocol) || !rules.dragPath(file, fs.statSync)) {
      event.returnValue = false; return;
    }
    // 동기 IPC 답부터 내보내야 Windows 끌기 고리 중 렌더러를 붙잡지 않는다.
    event.returnValue = true;
    accepted = true;
    event.sender.startDrag({ file, icon: path.join(__dirname, "img", "drag.png") });
  } catch (error) {
    if (!accepted) event.returnValue = false;
    else console.error("MV Hub drag failed", error);
  }
});
function loadHub() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(retry);
  const config = read(path.join(dataRoot(), "hub.json"));
  const origin = state.set(config && config.url);
  win.loadURL(`${origin}/?embed=resolve-panel`).catch(() => {});
}
function openPanel() {
  if (win && !win.isDestroyed()) { win.show(); return; }
  const bounds = rules.restoreBounds(read(path.join(dataRoot(), "window.json")), screen.getAllDisplays().map(display => display.workArea));
  win = new BrowserWindow({ width: 540, height: 820, ...(bounds || {}), title: "MV Hub", alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), partition: "persist:mvhub-resolve-panel", contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const navigation = (event, url) => { if (!state.navigation(url)) event.preventDefault(); };
  win.webContents.on("will-navigate", navigation);
  win.webContents.on("will-redirect", navigation);
  win.webContents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
    if (!mainFrame || code === -3 || !state.navigation(url)) return;
    win.loadFile(path.join(__dirname, "offline.html")).catch(error => console.error("MV Hub offline page", error));
    clearTimeout(retry); retry = setTimeout(loadHub, 3000);
  });
  win.on("page-title-updated", event => { event.preventDefault(); win.setTitle("MV Hub"); });
  win.on("close", () => {
    try {
      fs.mkdirSync(dataRoot(), { recursive: true });
      const target = path.join(dataRoot(), "window.json"), tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(win.getBounds())); fs.renameSync(tmp, target);
    } catch (error) { console.error("MV Hub window position", error); }
  });
  win.on("closed", () => { clearTimeout(retry); win = null; });
  loadHub();
}
app.whenReady().then(openPanel);
app.on("activate", openPanel);

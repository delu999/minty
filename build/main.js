var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};

// src/main.ts
var import_electron = require("electron");
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
var pty = __toESM(require("node-pty"));
var ptyProcesses = new Map;
var mainWindow = null;
function buildPath(...parts) {
  return import_path.default.join(import_electron.app.getAppPath(), "build", ...parts);
}
var dataFile = import_path.default.join(import_electron.app.getPath("userData"), "projects.json");
function loadProjects() {
  try {
    if (import_fs.default.existsSync(dataFile)) {
      return JSON.parse(import_fs.default.readFileSync(dataFile, "utf-8"));
    }
  } catch (err) {
    console.error("Failed to load projects:", err);
  }
  return { projects: [], activeIndex: -1 };
}
function saveProjects(data) {
  try {
    import_fs.default.mkdirSync(import_path.default.dirname(dataFile), { recursive: true });
    import_fs.default.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save projects:", err);
  }
}
function createWindow() {
  mainWindow = new import_electron.BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: "#0f0f0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: buildPath("preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(buildPath("renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
import_electron.app.whenReady().then(() => {
  createWindow();
  import_electron.app.on("activate", () => {
    if (import_electron.BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
});
import_electron.app.on("window-all-closed", () => {
  for (const [, p] of ptyProcesses) {
    try {
      p.kill();
    } catch {}
  }
  if (process.platform !== "darwin")
    import_electron.app.quit();
});
import_electron.ipcMain.handle("projects:load", () => loadProjects());
import_electron.ipcMain.handle("projects:save", (_e, data) => saveProjects(data));
import_electron.ipcMain.handle("dialog:open-folder", async () => {
  if (!mainWindow)
    return null;
  const result = await import_electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Project Folder"
  });
  if (result.canceled || result.filePaths.length === 0)
    return null;
  return result.filePaths[0];
});
import_electron.ipcMain.handle("pty:spawn", (_e, { id, cwd }) => {
  if (ptyProcesses.has(id))
    return;
  const shell = process.platform === "win32" ? process.env.COMSPEC || "powershell.exe" : process.env.SHELL || "/bin/bash";
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined)
      env[k] = v;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env
  });
  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:data:${id}`, data);
    }
  });
  ptyProcess.onExit(() => {
    ptyProcesses.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:exit:${id}`);
    }
  });
  ptyProcesses.set(id, ptyProcess);
});
import_electron.ipcMain.handle("pty:write", (_e, { id, data }) => {
  ptyProcesses.get(id)?.write(data);
});
import_electron.ipcMain.handle("pty:resize", (_e, { id, cols, rows }) => {
  const p = ptyProcesses.get(id);
  if (p && cols > 0 && rows > 0) {
    try {
      p.resize(cols, rows);
    } catch {}
  }
});
import_electron.ipcMain.handle("pty:kill", (_e, { id }) => {
  const p = ptyProcesses.get(id);
  if (p) {
    try {
      p.kill();
    } catch {}
    ptyProcesses.delete(id);
  }
});

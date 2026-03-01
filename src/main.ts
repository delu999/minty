import { app, BrowserWindow, ipcMain, dialog } from "electron"
import path from "path"
import fs from "fs"
import * as pty from "node-pty"

// ── Types ────────────────────────────────────────────────────────────────────

interface Project {
  id: string
  name: string
  path: string
}

interface ProjectsData {
  projects: Project[]
  activeIndex: number
}

// ── State ────────────────────────────────────────────────────────────────────

const ptyProcesses = new Map<string, pty.IPty>()
let mainWindow: BrowserWindow | null = null

function buildPath(...parts: string[]): string {
  return path.join(app.getAppPath(), "build", ...parts)
}

// ── Persistence ──────────────────────────────────────────────────────────────

const dataFile = path.join(app.getPath("userData"), "projects.json")

function loadProjects(): ProjectsData {
  try {
    if (fs.existsSync(dataFile)) {
      return JSON.parse(fs.readFileSync(dataFile, "utf-8")) as ProjectsData
    }
  } catch (err) {
    console.error("Failed to load projects:", err)
  }
  return { projects: [], activeIndex: -1 }
}

function saveProjects(data: ProjectsData): void {
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8")
  } catch (err) {
    console.error("Failed to save projects:", err)
  }
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
      sandbox: false,
    },
  })

  mainWindow.loadFile(buildPath("renderer", "index.html"))

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // Kill all pty processes cleanly
  for (const [, p] of ptyProcesses) {
    try { p.kill() } catch { /* ignore */ }
  }
  if (process.platform !== "darwin") app.quit()
})

// ── IPC: Projects ─────────────────────────────────────────────────────────────

ipcMain.handle("projects:load", () => loadProjects())

ipcMain.handle("projects:save", (_e, data: ProjectsData) => saveProjects(data))

// ── IPC: Dialog ───────────────────────────────────────────────────────────────

ipcMain.handle("dialog:open-folder", async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Project Folder",
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// ── IPC: PTY ──────────────────────────────────────────────────────────────────

ipcMain.handle("pty:spawn", (_e, { id, cwd }: { id: string; cwd: string }) => {
  if (ptyProcesses.has(id)) return // already running

  const shell =
    process.platform === "win32"
      ? process.env.COMSPEC || "powershell.exe"
      : process.env.SHELL || "/bin/bash"

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // Ensure correct TERM for color support
  env["TERM"] = "xterm-256color"
  env["COLORTERM"] = "truecolor"

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  })

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:data:${id}`, data)
    }
  })

  ptyProcess.onExit(() => {
    ptyProcesses.delete(id)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty:exit:${id}`)
    }
  })

  ptyProcesses.set(id, ptyProcess)
})

ipcMain.handle("pty:write", (_e, { id, data }: { id: string; data: string }) => {
  ptyProcesses.get(id)?.write(data)
})

ipcMain.handle("pty:resize", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  const p = ptyProcesses.get(id)
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows) } catch { /* ignore if already dead */ }
  }
})

ipcMain.handle("pty:kill", (_e, { id }: { id: string }) => {
  const p = ptyProcesses.get(id)
  if (p) {
    try { p.kill() } catch { /* ignore */ }
    ptyProcesses.delete(id)
  }
})

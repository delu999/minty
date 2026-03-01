import { contextBridge, ipcRenderer } from "electron"

// ── Exposed API shape ─────────────────────────────────────────────────────────

const minty = {
  platform: process.platform,

  // Persistence
  loadProjects: () =>
    ipcRenderer.invoke("projects:load") as Promise<{
      projects: Array<{ id: string; name: string; path: string }>
      activeIndex: number
    }>,
  saveProjects: (data: {
    projects: Array<{ id: string; name: string; path: string }>
    activeIndex: number
  }) => ipcRenderer.invoke("projects:save", data) as Promise<void>,

  // Native dialog
  openFolderDialog: () =>
    ipcRenderer.invoke("dialog:open-folder") as Promise<string | null>,

  // PTY management
  spawnPty: (id: string, cwd: string) =>
    ipcRenderer.invoke("pty:spawn", { id, cwd }) as Promise<void>,
  writePty: (id: string, data: string) =>
    ipcRenderer.invoke("pty:write", { id, data }) as Promise<void>,
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("pty:resize", { id, cols, rows }) as Promise<void>,
  killPty: (id: string) =>
    ipcRenderer.invoke("pty:kill", { id }) as Promise<void>,

  // PTY data stream — returns a disposer
  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(`pty:data:${id}`, handler)
    return () => ipcRenderer.removeListener(`pty:data:${id}`, handler)
  },

  // PTY exit notification — fires once
  onPtyExit: (id: string, cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.once(`pty:exit:${id}`, handler)
    return () => ipcRenderer.removeListener(`pty:exit:${id}`, handler)
  },
}

contextBridge.exposeInMainWorld("minty", minty)

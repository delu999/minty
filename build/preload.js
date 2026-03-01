// src/preload.ts
var import_electron = require("electron");
var minty = {
  platform: process.platform,
  loadProjects: () => import_electron.ipcRenderer.invoke("projects:load"),
  saveProjects: (data) => import_electron.ipcRenderer.invoke("projects:save", data),
  openFolderDialog: () => import_electron.ipcRenderer.invoke("dialog:open-folder"),
  spawnPty: (id, cwd) => import_electron.ipcRenderer.invoke("pty:spawn", { id, cwd }),
  writePty: (id, data) => import_electron.ipcRenderer.invoke("pty:write", { id, data }),
  resizePty: (id, cols, rows) => import_electron.ipcRenderer.invoke("pty:resize", { id, cols, rows }),
  killPty: (id) => import_electron.ipcRenderer.invoke("pty:kill", { id }),
  onPtyData: (id, cb) => {
    const handler = (_e, data) => cb(data);
    import_electron.ipcRenderer.on(`pty:data:${id}`, handler);
    return () => import_electron.ipcRenderer.removeListener(`pty:data:${id}`, handler);
  },
  onPtyExit: (id, cb) => {
    const handler = () => cb();
    import_electron.ipcRenderer.once(`pty:exit:${id}`, handler);
    return () => import_electron.ipcRenderer.removeListener(`pty:exit:${id}`, handler);
  }
};
import_electron.contextBridge.exposeInMainWorld("minty", minty);

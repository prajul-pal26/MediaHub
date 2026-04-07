import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mediahub", {
  // Setup progress listener
  onProgress: (callback: (data: { step: string; percent: number }) => void) => {
    ipcRenderer.on("setup:progress", (_event, data) => callback(data));
  },

  // App controls
  restartServices: () => ipcRenderer.invoke("app:restart-services"),
  getLogs: (service?: string) => ipcRenderer.invoke("app:get-logs", service),
  getStatus: () => ipcRenderer.invoke("app:get-status"),
  checkUpdates: () => ipcRenderer.invoke("app:check-updates"),
  applyUpdates: () => ipcRenderer.invoke("app:apply-updates"),
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),

  // GitHub token for private repos
  setGithubToken: (token: string) => ipcRenderer.invoke("setup:set-github-token", token),

  // Admin credentials during setup
  submitAdminCredentials: (email: string, password: string) =>
    ipcRenderer.invoke("setup:admin-credentials", email, password),

  // Update notifications
  onUpdateAvailable: (callback: () => void) => {
    ipcRenderer.on("update:available", () => callback());
  },
  onUpdateDownloaded: (callback: () => void) => {
    ipcRenderer.on("update:downloaded", () => callback());
  },
});

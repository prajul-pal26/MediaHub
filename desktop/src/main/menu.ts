import { Menu, BrowserWindow, shell, app } from "electron";
import { DockerManager } from "./docker-manager";
import { UpdateManager } from "./update-manager";

export function buildMenu(
  mainWindow: BrowserWindow,
  docker: DockerManager,
  updateManager: UpdateManager
) {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "MediaHub",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Check for Updates",
          click: async () => {
            mainWindow.webContents.send("setup:progress", {
              step: "Checking for updates...",
              percent: 10,
            });
            const hasUpdates = await updateManager.checkCodeUpdate();
            if (hasUpdates) {
              mainWindow.webContents.send("setup:progress", {
                step: "Update available! Downloading...",
                percent: 20,
              });
            } else {
              mainWindow.webContents.send("setup:progress", {
                step: "Already up to date!",
                percent: 100,
              });
            }
          },
        },
        { type: "separator" },
        {
          label: "Restart Services",
          click: async () => {
            await docker.restartServices();
          },
        },
        {
          label: "Stop Services",
          click: async () => {
            await docker.stopServices();
          },
        },
        { type: "separator" },
        {
          label: "View Logs",
          click: async () => {
            const logs = await docker.getLogs(undefined, 500);
            const logWindow = new BrowserWindow({
              width: 900,
              height: 600,
              title: "MediaHub Logs",
            });
            logWindow.loadURL(
              `data:text/html,<html><body style="background:#1a1a2e;color:#eee;font-family:monospace;font-size:12px;padding:16px;white-space:pre-wrap;overflow:auto;">${encodeURIComponent(logs)}</body></html>`
            );
          },
        },
        {
          label: "Service Status",
          click: async () => {
            const statuses = await docker.getServiceStatus();
            const text = statuses
              .map((s) => `${s.status === "running" ? "+" : "-"} ${s.name}: ${s.status}`)
              .join("\n");
            const statusWindow = new BrowserWindow({
              width: 500,
              height: 400,
              title: "Service Status",
            });
            statusWindow.loadURL(
              `data:text/html,<html><body style="background:#1a1a2e;color:#eee;font-family:monospace;font-size:14px;padding:24px;white-space:pre-wrap;"><h2 style="color:#00d4aa">Service Status</h2>${encodeURIComponent(text)}</body></html>`
            );
          },
        },
        { type: "separator" },
        {
          label: "Open Supabase Studio",
          click: () => shell.openExternal("http://localhost:54323"),
        },
        {
          label: "Open Email Testing (Inbucket)",
          click: () => shell.openExternal("http://localhost:54324"),
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

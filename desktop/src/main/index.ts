import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import { DockerManager } from "./docker-manager";
import { GitManager } from "./git-manager";
import { SetupManager } from "./setup-manager";
import { UpdateManager } from "./update-manager";
import { TrayManager } from "./tray-manager";
import { buildMenu } from "./menu";

const DATA_DIR = path.join(app.getPath("home"), "MediaHub");
const REPO_URL = "git@github.com:DeepVidyaAI/MediaHub.git";
const APP_URL = "https://localhost:3443";

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;

const dockerManager = new DockerManager(DATA_DIR);
const gitManager = new GitManager(REPO_URL, path.join(DATA_DIR, "code"));
const setupManager = new SetupManager(DATA_DIR, dockerManager, gitManager);
const updateManager = new UpdateManager(gitManager, dockerManager, setupManager);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "MediaHub",
    icon: path.join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Start with the setup/loading screen
  mainWindow.loadFile(path.join(__dirname, "../renderer/setup.html"));

  mainWindow.on("close", (event) => {
    // Minimize to tray instead of closing
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showDashboard() {
  if (mainWindow) {
    // Load the actual MediaHub app
    mainWindow.loadURL(APP_URL);

    // Handle certificate errors for localhost self-signed cert
    mainWindow.webContents.on("certificate-error", (event, _url, _error, _cert, callback) => {
      event.preventDefault();
      callback(true);
    });
  }
}

async function startup() {
  createWindow();
  buildMenu(mainWindow!, dockerManager, updateManager);
  trayManager = new TrayManager(mainWindow!, dockerManager);

  const sendProgress = (step: string, percent: number) => {
    mainWindow?.webContents.send("setup:progress", { step, percent });
  };

  try {
    // Check if first run
    const isFirstRun = await setupManager.isFirstRun();

    if (isFirstRun) {
      sendProgress("Running first-time setup...", 0);
      await setupManager.runSetup(sendProgress);
    } else {
      // Normal startup
      sendProgress("Checking for updates...", 10);
      const hasUpdates = await updateManager.checkCodeUpdate();

      if (hasUpdates) {
        sendProgress("Downloading updates...", 20);
        await updateManager.applyCodeUpdate(sendProgress);
      }

      sendProgress("Starting services...", 50);
      await dockerManager.startServices();

      sendProgress("Waiting for app to be ready...", 80);
      await dockerManager.waitForApp();

      sendProgress("MediaHub is ready!", 100);
    }

    // Small delay so user sees "ready" message
    await new Promise((r) => setTimeout(r, 1500));

    // Switch to the dashboard
    showDashboard();
    trayManager.setStatus("running");
  } catch (error: any) {
    sendProgress(`Error: ${error.message}`, -1);
    trayManager?.setStatus("error");
  }
}

// ─── IPC Handlers ───

ipcMain.handle("app:get-status", async () => {
  return {
    services: await dockerManager.getServiceStatus(),
    version: await gitManager.getCurrentVersion(),
  };
});

ipcMain.handle("app:restart-services", async () => {
  await dockerManager.restartServices();
});

ipcMain.handle("app:get-logs", async (_event, service: string) => {
  return await dockerManager.getLogs(service);
});

ipcMain.handle("app:check-updates", async () => {
  return await updateManager.checkCodeUpdate();
});

ipcMain.handle("app:apply-updates", async () => {
  const sendProgress = (step: string, percent: number) => {
    mainWindow?.webContents.send("setup:progress", { step, percent });
  };
  mainWindow?.loadFile(path.join(__dirname, "../renderer/setup.html"));
  await updateManager.applyCodeUpdate(sendProgress);
  await new Promise((r) => setTimeout(r, 1500));
  showDashboard();
});

ipcMain.handle("app:open-external", async (_event, url: string) => {
  shell.openExternal(url);
});

ipcMain.handle("setup:set-github-token", async (_event, token: string) => {
  gitManager.setToken(token);
});

ipcMain.handle("setup:admin-credentials", async (_event, email: string, password: string) => {
  setupManager.setAdminCredentials(email, password);
});

// ─── App Lifecycle ───

app.on("ready", startup);

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on("before-quit", async () => {
  // Don't stop Docker on quit — services keep running in background
  // User can explicitly stop via menu
  trayManager?.destroy();
  app.exit(0);
});

// Allow self-signed certificates for localhost
app.on("certificate-error", (event, _webContents, _url, _error, _cert, callback) => {
  event.preventDefault();
  callback(true);
});

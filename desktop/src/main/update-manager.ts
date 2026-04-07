import { autoUpdater } from "electron-updater";
import { BrowserWindow } from "electron";
import { GitManager } from "./git-manager";
import { DockerManager } from "./docker-manager";
import { SetupManager } from "./setup-manager";

type ProgressFn = (step: string, percent: number) => void;

export class UpdateManager {
  private git: GitManager;
  private docker: DockerManager;
  private setup: SetupManager;

  constructor(git: GitManager, docker: DockerManager, setup: SetupManager) {
    this.git = git;
    this.docker = docker;
    this.setup = setup;
  }

  // Check for new Electron app version (GitHub Releases)
  async checkAppUpdate(): Promise<boolean> {
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.updateInfo?.version !== undefined;
    } catch {
      return false;
    }
  }

  // Install Electron app update
  async installAppUpdate(): Promise<void> {
    autoUpdater.quitAndInstall();
  }

  // Check for new code on GitHub (main branch)
  async checkCodeUpdate(): Promise<boolean> {
    try {
      return await this.git.hasUpdates();
    } catch {
      return false;
    }
  }

  // Pull latest code and rebuild
  async applyCodeUpdate(onProgress: ProgressFn): Promise<void> {
    onProgress("Pulling latest code...", 20);
    await this.git.pull();

    onProgress("Rebuilding app and worker...", 40);
    await this.docker.rebuildServices();

    onProgress("Running database migrations...", 70);
    await this.docker.runMigrations();

    onProgress("Waiting for app to restart...", 85);
    await this.docker.waitForApp();

    onProgress("Update complete!", 100);
  }

  // Set up auto-updater events for Electron binary updates
  setupAutoUpdater(mainWindow: BrowserWindow) {
    autoUpdater.autoDownload = false;

    autoUpdater.on("update-available", () => {
      mainWindow.webContents.send("update:available");
    });

    autoUpdater.on("update-downloaded", () => {
      mainWindow.webContents.send("update:downloaded");
    });

    autoUpdater.on("error", (error) => {
      console.error("Auto-updater error:", error);
    });
  }
}

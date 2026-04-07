import { Tray, Menu, nativeImage, BrowserWindow, app } from "electron";
import path from "path";
import { DockerManager } from "./docker-manager";

type Status = "running" | "starting" | "error" | "stopped";

export class TrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow;
  private docker: DockerManager;
  private status: Status = "starting";

  constructor(mainWindow: BrowserWindow, docker: DockerManager) {
    this.mainWindow = mainWindow;
    this.docker = docker;
    this.createTray();
  }

  private createTray() {
    const iconPath = path.join(__dirname, "../../assets/icon.png");
    let icon: Electron.NativeImage;

    try {
      icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch {
      // Fallback: create a simple colored icon
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("MediaHub");
    this.updateMenu();

    this.tray.on("click", () => {
      this.mainWindow.show();
      this.mainWindow.focus();
    });
  }

  setStatus(status: Status) {
    this.status = status;
    const tooltips: Record<Status, string> = {
      running: "MediaHub — Running",
      starting: "MediaHub — Starting...",
      error: "MediaHub — Error",
      stopped: "MediaHub — Stopped",
    };
    this.tray?.setToolTip(tooltips[status]);
    this.updateMenu();
  }

  private updateMenu() {
    const statusLabels: Record<Status, string> = {
      running: "Status: Running",
      starting: "Status: Starting...",
      error: "Status: Error",
      stopped: "Status: Stopped",
    };

    const menu = Menu.buildFromTemplate([
      { label: statusLabels[this.status], enabled: false },
      { type: "separator" },
      {
        label: "Open MediaHub",
        click: () => {
          this.mainWindow.show();
          this.mainWindow.focus();
        },
      },
      {
        label: "Restart Services",
        click: async () => {
          this.setStatus("starting");
          try {
            await this.docker.restartServices();
            this.setStatus("running");
          } catch {
            this.setStatus("error");
          }
        },
      },
      {
        label: "Stop Services",
        click: async () => {
          await this.docker.stopServices();
          this.setStatus("stopped");
        },
      },
      { type: "separator" },
      {
        label: "Quit MediaHub",
        click: () => {
          this.tray?.destroy();
          app.exit(0);
        },
      },
    ]);

    this.tray?.setContextMenu(menu);
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}

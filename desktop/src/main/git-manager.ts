import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import fs from "fs";
import path from "path";

export class GitManager {
  private repoUrl: string;
  private localPath: string;
  private token: string | null = null;

  constructor(repoUrl: string, localPath: string) {
    this.repoUrl = repoUrl;
    this.localPath = localPath;
  }

  setToken(token: string) {
    this.token = token;
  }

  private getAuthUrl(): string {
    // Convert SSH URL to HTTPS for isomorphic-git (SSH not supported)
    let url = this.repoUrl;
    if (url.startsWith("git@github.com:")) {
      url = url.replace("git@github.com:", "https://github.com/").replace(/\.git$/, ".git");
    }
    if (this.token) {
      url = url.replace("https://", `https://${this.token}@`);
    }
    return url;
  }

  private getAuth() {
    if (this.token) {
      return {
        onAuth: () => ({ username: this.token!, password: "x-oauth-basic" }),
      };
    }
    return {};
  }

  async isCloned(): Promise<boolean> {
    try {
      await git.resolveRef({ fs, dir: this.localPath, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  async clone(onProgress?: (phase: string, loaded: number, total: number) => void): Promise<void> {
    // Ensure parent directory exists
    const parentDir = path.dirname(this.localPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    await git.clone({
      fs,
      http,
      dir: this.localPath,
      url: this.getAuthUrl(),
      ref: "main",
      singleBranch: true,
      depth: 1,
      ...this.getAuth(),
      onProgress: onProgress
        ? (event) => onProgress(event.phase, event.loaded, event.total || 0)
        : undefined,
    });
  }

  async hasUpdates(): Promise<boolean> {
    try {
      // Fetch latest from remote
      await git.fetch({
        fs,
        http,
        dir: this.localPath,
        ref: "main",
        singleBranch: true,
        ...this.getAuth(),
      });

      const localHead = await git.resolveRef({ fs, dir: this.localPath, ref: "HEAD" });
      const remoteHead = await git.resolveRef({ fs, dir: this.localPath, ref: "refs/remotes/origin/main" });

      return localHead !== remoteHead;
    } catch {
      return false;
    }
  }

  async pull(): Promise<void> {
    await git.pull({
      fs,
      http,
      dir: this.localPath,
      ref: "main",
      singleBranch: true,
      author: { name: "MediaHub Desktop", email: "desktop@mediahub.local" },
      ...this.getAuth(),
    });
  }

  async getCurrentVersion(): Promise<string> {
    try {
      const sha = await git.resolveRef({ fs, dir: this.localPath, ref: "HEAD" });
      return sha.slice(0, 7);
    } catch {
      return "unknown";
    }
  }

  async getLastCommitMessage(): Promise<string> {
    try {
      const commits = await git.log({ fs, dir: this.localPath, depth: 1 });
      return commits[0]?.commit?.message || "";
    } catch {
      return "";
    }
  }

  // Load saved token from config file
  async loadToken(configPath: string): Promise<void> {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.githubToken) {
        this.token = config.githubToken;
      }
    } catch {
      // No config file yet
    }
  }

  // Save token to config file
  async saveToken(configPath: string, token: string): Promise<void> {
    let config: any = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // New config
    }
    config.githubToken = token;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.token = token;
  }
}

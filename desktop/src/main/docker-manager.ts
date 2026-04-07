import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const exec = promisify(execFile);

export interface ServiceStatus {
  name: string;
  status: "running" | "stopped" | "starting" | "error";
  health?: string;
}

export class DockerManager {
  private dataDir: string;
  private composeFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.composeFile = path.join(dataDir, "code", "docker-compose.yml");
  }

  // ─── Docker Detection ───

  async isDockerInstalled(): Promise<boolean> {
    try {
      await exec("docker", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async isDockerRunning(): Promise<boolean> {
    try {
      await exec("docker", ["info"], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  getDockerInstallUrl(): string {
    switch (process.platform) {
      case "darwin":
        return "https://docs.docker.com/desktop/install/mac-install/";
      case "win32":
        return "https://docs.docker.com/desktop/install/windows-install/";
      default:
        return "https://docs.docker.com/engine/install/";
    }
  }

  // ─── Service Management ───

  async startServices(): Promise<void> {
    if (!fs.existsSync(this.composeFile)) {
      throw new Error(`docker-compose.yml not found at ${this.composeFile}`);
    }

    await this.compose(["up", "-d", "--build"]);
  }

  async stopServices(): Promise<void> {
    await this.compose(["down"]);
  }

  async restartServices(): Promise<void> {
    await this.compose(["restart"]);
  }

  async rebuildServices(): Promise<void> {
    await this.compose(["up", "-d", "--build", "--force-recreate", "app", "worker"]);
  }

  // ─── Health Checks ───

  async getServiceStatus(): Promise<ServiceStatus[]> {
    try {
      const { stdout } = await exec("docker", [
        "compose", "-f", this.composeFile,
        "ps", "--format", "json",
      ]);

      const services: ServiceStatus[] = [];
      // docker compose ps --format json outputs one JSON object per line
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const container = JSON.parse(line);
          services.push({
            name: container.Service || container.Name,
            status: container.State === "running" ? "running" : "stopped",
            health: container.Health || undefined,
          });
        } catch {
          // Skip malformed lines
        }
      }
      return services;
    } catch {
      return [];
    }
  }

  async waitForApp(timeoutMs = 120000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // Check if the app responds on port 3000
        const http = await import("http");
        const isReady = await new Promise<boolean>((resolve) => {
          const req = http.get("http://localhost:3000", (res) => {
            resolve(res.statusCode !== undefined && res.statusCode < 500);
          });
          req.on("error", () => resolve(false));
          req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
          });
        });

        if (isReady) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("App did not start within timeout");
  }

  async waitForDatabase(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await exec("docker", [
          "compose", "-f", this.composeFile,
          "exec", "-T", "db", "pg_isready", "-U", "supabase_admin", "-d", "supabase",
        ], { timeout: 5000 });
        if (stdout.includes("accepting connections")) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Database did not start within timeout");
  }

  // ─── Logs ───

  async getLogs(service?: string, tail = 200): Promise<string> {
    const args = ["compose", "-f", this.composeFile, "logs", "--tail", String(tail), "--no-color"];
    if (service) args.push(service);

    try {
      const { stdout } = await exec("docker", args, { timeout: 10000 });
      return stdout;
    } catch (e: any) {
      return e.stdout || e.message;
    }
  }

  // ─── Migrations ───

  async runMigrations(): Promise<void> {
    const codeDir = path.join(this.dataDir, "code");
    const schemaFile = path.join(codeDir, "src/server/db/schema.sql");
    const migrationsDir = path.join(codeDir, "supabase/migrations");

    // Apply main schema
    if (fs.existsSync(schemaFile)) {
      const schema = fs.readFileSync(schemaFile, "utf-8");
      await this.execInDb(schema);
    }

    // Apply migrations in order
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
        await this.execInDb(sql);
      }
    }

    // Restart PostgREST to pick up schema changes
    await this.compose(["restart", "rest"]);
  }

  private async execInDb(sql: string): Promise<void> {
    const child = spawn("docker", [
      "compose", "-f", this.composeFile,
      "exec", "-T", "db",
      "env", "PGPASSWORD=postgres",
      "psql", "-U", "supabase_admin", "-d", "supabase",
    ]);

    child.stdin.write(sql);
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`psql exited with code ${code}`));
      });
      child.on("error", reject);
    });
  }

  // ─── Helper ───

  private async compose(args: string[]): Promise<string> {
    const { stdout } = await exec("docker", ["compose", "-f", this.composeFile, ...args], {
      timeout: 300000, // 5 min timeout for builds
      cwd: path.dirname(this.composeFile),
    });
    return stdout;
  }
}

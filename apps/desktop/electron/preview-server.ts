import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@repo/shared";
import {
  devServerStartCommand,
  devServerStopCommand,
  isDevServerFailure,
  parseDevServerReady,
} from "@repo/store-generator";
import { app } from "electron";

/**
 * Serves a generated store with its own Astro dev server, so the in-app
 * preview is the real site rather than an imitation.
 *
 * Astro needs a `node_modules` it can resolve `astro/config` from, and a
 * generated store has none. Installing ~190 packages per store would be absurd,
 * so one shared runtime is linked in as each store's `node_modules`. The
 * generated `.gitignore` already excludes it, and a store copied elsewhere to
 * deploy just runs `npm install` as its README says.
 */
export interface PreviewHandle {
  storeId: string;
  url: string;
  pid: number | null;
  projectDir: string;
}

const STARTUP_TIMEOUT_MS = 90_000;

export interface PreviewServerOptions {
  /** Overrides runtime discovery; set by tests. */
  runtimeDir?: string;
}

export class PreviewServer {
  readonly #running = new Map<string, PreviewHandle>();
  readonly #runtimeDir: string | undefined;
  #nextPort = 4331;

  constructor({ runtimeDir }: PreviewServerOptions = {}) {
    this.#runtimeDir = runtimeDir;
  }

  get(storeId: string): PreviewHandle | undefined {
    return this.#running.get(storeId);
  }

  list(): PreviewHandle[] {
    return [...this.#running.values()];
  }

  /** Starts (or returns an already-running) preview for a store. */
  async start(storeId: string, projectDir: string): Promise<PreviewHandle> {
    const existing = this.#running.get(storeId);
    if (existing) return existing;

    if (!existsSync(join(projectDir, "package.json"))) {
      throw new AppError(
        "NOT_FOUND",
        "That store's files are missing. Regenerate it and try again.",
        projectDir,
      );
    }

    const astroBin = this.#astroBin();
    await this.#linkRuntime(projectDir);

    const port = this.#nextPort++;
    const { command, args, cwd } = devServerStartCommand({
      projectDir,
      port,
      astroBin,
    });

    const output = await this.#run(command, args, cwd);

    if (isDevServerFailure(output)) {
      throw new AppError(
        "INTERNAL",
        "The preview server wouldn't start.",
        firstLine(output),
      );
    }

    const ready = parseDevServerReady(output);
    if (!ready) {
      throw new AppError(
        "INTERNAL",
        "The preview server started but never reported an address.",
        firstLine(output),
      );
    }

    // Astro reports whatever host it bound; force loopback so the renderer's
    // CSP only ever has to allow 127.0.0.1.
    const url = ready.url.replace("localhost", "127.0.0.1");
    const handle: PreviewHandle = { storeId, url, pid: ready.pid, projectDir };
    this.#running.set(storeId, handle);
    return handle;
  }

  async stop(storeId: string): Promise<void> {
    const handle = this.#running.get(storeId);
    if (!handle) return;
    this.#running.delete(storeId);

    const { command, args, cwd } = devServerStopCommand(
      handle.projectDir,
      this.#astroBin(),
    );

    try {
      await this.#run(command, args, cwd);
    } catch {
      // Fall through to the pid, below.
    }

    // `astro dev stop` is the supported path, but if it failed the daemon is
    // still holding a port; the pid it told us about is the backstop.
    if (handle.pid !== null) {
      try {
        process.kill(handle.pid);
      } catch {
        // Already gone.
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)));
  }

  /**
   * The shared runtime's `astro` binary.
   *
   * In the monorepo this is the workspace install. A packaged build has no
   * workspace, so `DSV_PREVIEW_RUNTIME` points at a runtime installed into
   * userData instead.
   */
  #astroBin(): string {
    for (const dir of this.#runtimeCandidates()) {
      const bin = join(dir, "node_modules", ".bin", "astro");
      if (existsSync(bin)) return bin;
    }

    throw new AppError(
      "INTERNAL",
      "Preview needs Astro installed. Run npm install in the project, or set DSV_PREVIEW_RUNTIME to a folder with Astro in it.",
      "no astro binary found",
    );
  }

  #runtimeCandidates(): string[] {
    const candidates: string[] = [];
    if (this.#runtimeDir) candidates.push(this.#runtimeDir);
    if (process.env.DSV_PREVIEW_RUNTIME) {
      candidates.push(process.env.DSV_PREVIEW_RUNTIME);
    }
    candidates.push(app.getAppPath());
    candidates.push(join(app.getAppPath(), "..", ".."));
    candidates.push(join(app.getPath("userData"), "preview-runtime"));
    return candidates;
  }

  /** Points the store's `node_modules` at the shared runtime. */
  async #linkRuntime(projectDir: string): Promise<void> {
    const target = join(projectDir, "node_modules");
    if (existsSync(target)) return;

    for (const dir of this.#runtimeCandidates()) {
      const source = join(dir, "node_modules");
      if (!existsSync(join(source, ".bin", "astro"))) continue;

      await mkdir(projectDir, { recursive: true });
      try {
        // `junction` is a no-op flag off Windows, and the only kind of
        // directory link Windows allows without elevation.
        await symlink(source, target, "junction");
      } catch {
        // A pre-existing link, or a filesystem that refuses them: Astro will
        // report the real problem when it fails to start.
      }
      return;
    }
  }

  /** Runs a short-lived command and resolves with everything it printed. */
  #run(command: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, NODE_ENV: "development", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const collect = (chunk: Buffer) => {
        output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const timer = setTimeout(() => {
        child.kill();
        reject(
          new AppError(
            "INTERNAL",
            "The preview server took too long to start.",
            "timeout",
          ),
        );
      }, STARTUP_TIMEOUT_MS);

      child.on("error", (cause) => {
        clearTimeout(timer);
        reject(
          new AppError("INTERNAL", "Couldn't launch the preview server.", cause.message),
        );
      });

      child.on("close", () => {
        clearTimeout(timer);
        resolve(output);
      });
    });
  }
}

function firstLine(output: string): string {
  return output.split(/\r?\n/).find((line) => line.trim())?.slice(0, 200) ?? "";
}

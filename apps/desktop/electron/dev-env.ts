import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { AppError, type DevEnvStatus } from "@repo/shared";
import {
  classifyDevEnv,
  installCommand,
  isInterestingInstallLine,
  parseInstallFailure,
  parseInstalledPackageCount,
} from "@repo/store-generator";

/**
 * Sets a generated store up as a project the user can work in themselves.
 *
 * The store the preview runs is not a project anyone can open: its
 * `node_modules` is a symlink to our shared Astro runtime (see
 * `preview-server.ts`), which resolves only on this machine, only while the app
 * is installed. That is fine for framing a dev server and wrong for everything
 * the user is told to do next — open it in an editor, commit it, copy it to a
 * build machine.
 *
 * So this replaces the link with a real `npm install` in the store's own
 * folder. The result is an ordinary Astro project with no tie back to us.
 *
 * We do not bundle a Node toolchain to do it. If npm isn't on the user's
 * machine we say so and print the command, rather than shipping a second copy
 * of Node inside an Electron app that already contains one.
 */
export interface DevEnvProgressEvent {
  storeId: string;
  phase: "installing" | "done" | "failed";
  line: string;
}

export interface DevEnvInstallResult {
  storeId: string;
  packageCount: number | null;
  status: DevEnvStatus;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Where a GUI-launched app can find npm when PATH is the login shell's. */
const EXTRA_PATHS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  join(process.env.HOME ?? "", ".nvm/current/bin"),
  join(process.env.HOME ?? "", ".volta/bin"),
];

export class DevEnvManager {
  readonly #running = new Set<string>();
  #npmPath: string | null | undefined;
  #nodeVersion: string | null | undefined;

  isInstalling(storeId: string): boolean {
    return this.#running.has(storeId);
  }

  /**
   * What state a store's dev environment is in.
   *
   * Cheap enough to call whenever the screen opens: one lstat, two existsSync,
   * and a readdir only when there is something to count.
   */
  async status(storeId: string, projectDir: string): Promise<DevEnvStatus> {
    const projectPresent = existsSync(join(projectDir, "package.json"));
    const nodeModules = join(projectDir, "node_modules");

    let nodeModulesPresent = false;
    let nodeModulesIsLink = false;
    try {
      const stats = await lstat(nodeModules);
      nodeModulesPresent = true;
      nodeModulesIsLink = stats.isSymbolicLink();
    } catch {
      // Not there at all.
    }

    const kind = classifyDevEnv({ nodeModulesPresent, nodeModulesIsLink });

    return {
      storeId,
      projectDir,
      kind,
      projectPresent,
      envFilePresent: existsSync(join(projectDir, ".env")),
      needsStripeEnv: await this.#needsStripeEnv(projectDir),
      toolchain: {
        npmPath: await this.#findNpm(),
        nodeVersion: await this.#findNodeVersion(),
      },
      packageCount: kind === "installed" ? await countPackages(nodeModules) : null,
    };
  }

  /**
   * Runs `npm install` in the store's folder.
   *
   * The caller must stop any running preview first: its dev server has the
   * shared runtime open, and this deletes that link out from under it.
   */
  async install(
    storeId: string,
    projectDir: string,
    onProgress: (event: DevEnvProgressEvent) => void,
  ): Promise<DevEnvInstallResult> {
    if (this.#running.has(storeId)) {
      throw new AppError(
        "DEV_ENV_FAILED",
        "That store is already being set up. Give it a moment.",
      );
    }

    if (!existsSync(join(projectDir, "package.json"))) {
      throw new AppError(
        "NOT_FOUND",
        "That store's files are missing. Regenerate it and try again.",
        projectDir,
      );
    }

    const npmPath = await this.#findNpm();
    if (!npmPath) {
      throw new AppError(
        "NODE_NOT_FOUND",
        "Node.js and npm aren't installed on this machine. Install Node 24 or newer from nodejs.org, then try again.",
        "npm not found on PATH",
      );
    }

    this.#running.add(storeId);
    try {
      await this.#removeSharedRuntimeLink(projectDir, onProgress, storeId);

      const { command, args, cwd } = installCommand({ projectDir, npmPath });
      onProgress({
        storeId,
        phase: "installing",
        line: `${command} ${args.join(" ")}`,
      });

      const output = await this.#run(command, args, cwd, (line) => {
        if (isInterestingInstallLine(line)) {
          onProgress({ storeId, phase: "installing", line: line.trim() });
        }
      });

      const failure = parseInstallFailure(output.text);
      if (output.code !== 0 || failure) {
        onProgress({
          storeId,
          phase: "failed",
          line: failure ?? `npm exited with code ${output.code}`,
        });
        throw new AppError(
          "DEV_ENV_FAILED",
          "npm install didn't finish. The output above says why.",
          failure ?? `exit code ${output.code}`,
        );
      }

      const packageCount = parseInstalledPackageCount(output.text);
      onProgress({
        storeId,
        phase: "done",
        line: packageCount
          ? `Installed ${packageCount} packages. This store is now a standalone project.`
          : "Install finished. This store is now a standalone project.",
      });

      return {
        storeId,
        packageCount,
        status: await this.status(storeId, projectDir),
      };
    } finally {
      this.#running.delete(storeId);
    }
  }

  /**
   * Deletes the shared-runtime symlink before installing.
   *
   * Without this, npm would follow the link and install into the *shared*
   * runtime — corrupting the preview for every other store on the machine.
   * `rm` on a symlink removes the link, never what it points at.
   */
  async #removeSharedRuntimeLink(
    projectDir: string,
    onProgress: (event: DevEnvProgressEvent) => void,
    storeId: string,
  ): Promise<void> {
    const nodeModules = join(projectDir, "node_modules");
    try {
      const stats = await lstat(nodeModules);
      if (!stats.isSymbolicLink()) return;
    } catch {
      return;
    }

    onProgress({
      storeId,
      phase: "installing",
      line: "Replacing the shared preview runtime with a real install…",
    });
    await rm(nodeModules, { force: true, recursive: false });
  }

  /** Reads the store's own data island rather than being told by the caller. */
  async #needsStripeEnv(projectDir: string): Promise<boolean> {
    try {
      const raw = await readFile(join(projectDir, "src/data/store.json"), "utf8");
      const parsed = JSON.parse(raw) as { checkout?: { hasApi?: unknown } };
      return parsed.checkout?.hasApi === true;
    } catch {
      return false;
    }
  }

  async #findNpm(): Promise<string | null> {
    if (this.#npmPath !== undefined) return this.#npmPath;

    const candidates =
      process.platform === "win32" ? ["npm.cmd", "npm"] : ["npm"];

    for (const candidate of candidates) {
      if (await this.#canRun(candidate, ["--version"])) {
        this.#npmPath = candidate;
        return candidate;
      }
    }

    // A macOS/Linux app launched from Finder or a .desktop file inherits a
    // minimal PATH that usually omits every Node installation.
    for (const dir of EXTRA_PATHS) {
      const candidate = join(dir, "npm");
      if (existsSync(candidate) && (await this.#canRun(candidate, ["--version"]))) {
        this.#npmPath = candidate;
        return candidate;
      }
    }

    this.#npmPath = null;
    return null;
  }

  async #findNodeVersion(): Promise<string | null> {
    if (this.#nodeVersion !== undefined) return this.#nodeVersion;

    try {
      const result = await this.#run("node", ["--version"], process.cwd());
      const version = result.text.trim().split(/\r?\n/)[0] ?? null;
      this.#nodeVersion = result.code === 0 && version ? version : null;
    } catch {
      this.#nodeVersion = null;
    }
    return this.#nodeVersion;
  }

  async #canRun(command: string, args: string[]): Promise<boolean> {
    try {
      const result = await this.#run(command, args, process.cwd());
      return result.code === 0;
    } catch {
      return false;
    }
  }

  #run(
    command: string,
    args: string[],
    cwd: string,
    onLine?: (line: string) => void,
  ): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          PATH: [process.env.PATH, ...EXTRA_PATHS].filter(Boolean).join(delimiter),
          // Electron sets these for its own bundled Node; npm would try to
          // build native modules against Electron's headers if they leaked in.
          npm_config_runtime: "",
          npm_config_target: "",
          npm_config_disturl: "",
          ELECTRON_RUN_AS_NODE: "",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // npm on Windows is a .cmd shim, which needs a shell to launch.
        shell: process.platform === "win32",
      });

      let text = "";
      let buffered = "";

      const collect = (chunk: Buffer) => {
        const value = chunk.toString("utf8");
        text += value;
        if (!onLine) return;

        buffered += value;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      };

      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const timer = setTimeout(() => {
        child.kill();
        reject(
          new AppError(
            "DEV_ENV_FAILED",
            "npm install took too long and was stopped.",
            "timeout",
          ),
        );
      }, INSTALL_TIMEOUT_MS);

      child.on("error", (cause) => {
        clearTimeout(timer);
        reject(
          new AppError("DEV_ENV_FAILED", "Couldn't run npm.", cause.message),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (buffered && onLine) onLine(buffered);
        resolve({ code: code ?? 1, text });
      });
    });
  }
}

/**
 * Counts installed packages, including scoped ones.
 *
 * Only ever called for a real install, where the answer is a fact worth showing
 * ("193 packages") rather than a guess.
 */
async function countPackages(nodeModules: string): Promise<number | null> {
  try {
    const entries = await readdir(nodeModules, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      if (!entry.name.startsWith("@")) {
        count += 1;
        continue;
      }
      const scoped = await readdir(join(nodeModules, entry.name), {
        withFileTypes: true,
      });
      count += scoped.filter((child) => child.isDirectory()).length;
    }

    return count;
  } catch {
    return null;
  }
}

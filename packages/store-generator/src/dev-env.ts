import type { DevEnvKind } from "@repo/shared";

/**
 * Setting up a generated store as a project the user can actually work in.
 *
 * As with `preview.ts`, only the pure parts live here — command construction
 * and output parsing — so they can be unit-tested without spawning anything.
 * The process spawning is in `apps/desktop/electron/dev-env.ts`.
 *
 * The problem this solves: the in-app preview symlinks a *shared* Astro
 * runtime in as the store's `node_modules`, which is fine for our own dev
 * server and useless to the user. Open that folder in an editor and imports
 * resolve through a path outside the project; copy it to another machine and
 * it is a dangling link. Installing gives them a real, portable project.
 */

export interface DevEnvCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface InstallCommandOptions {
  projectDir: string;
  /** Resolved npm executable. Defaults to whatever is on PATH. */
  npmPath?: string;
}

/**
 * `npm install`, not `npm ci`: a generated store ships no lockfile, and `ci`
 * refuses to run without one.
 *
 * Audit and funding output is suppressed because it is noise in a progress
 * pane and, in npm's own exit codes, an audit failure is not an install
 * failure — it just makes one look like it.
 */
export function installCommand({
  projectDir,
  npmPath = "npm",
}: InstallCommandOptions): DevEnvCommand {
  return {
    command: npmPath,
    args: ["install", "--no-audit", "--no-fund", "--loglevel", "info"],
    cwd: projectDir,
  };
}

/** `npm run dev` in the store's own folder — what the user runs afterwards. */
export function devCommand({
  projectDir,
  npmPath = "npm",
}: InstallCommandOptions): DevEnvCommand {
  return { command: npmPath, args: ["run", "dev"], cwd: projectDir };
}

/** Renders a command back as the line a user would type in a terminal. */
export function formatCommand({ command, args }: DevEnvCommand): string {
  return [command, ...args].join(" ");
}

export interface DevEnvProbe {
  nodeModulesPresent: boolean;
  /** True when `node_modules` is a symlink/junction — i.e. our shared runtime. */
  nodeModulesIsLink: boolean;
}

/**
 * What kind of `node_modules` a store has.
 *
 * The link/real distinction is the whole point: both let Astro start, but only
 * one of them survives the user copying the folder somewhere else, which is
 * exactly what they are told to do to deploy it.
 */
export function classifyDevEnv({
  nodeModulesPresent,
  nodeModulesIsLink,
}: DevEnvProbe): DevEnvKind {
  if (!nodeModulesPresent) return "none";
  return nodeModulesIsLink ? "linked" : "installed";
}

/**
 * Extracts a usable reason from a failed `npm install`.
 *
 * npm prints the actionable line as `npm error <thing>` (`npm ERR!` before
 * v10), buried in a wall of debug output. Surfacing the first one is the
 * difference between "it didn't work" and "you're offline".
 */
export function parseInstallFailure(output: string): string | null {
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = /^\s*npm (?:error|ERR!)\s+(.*\S)/.exec(line);
    if (!match) continue;

    const detail = match[1] as string;
    // The code/errno/syscall preamble repeats the same failure less usefully.
    if (/^(code|errno|syscall|path|command|signal)\b/i.test(detail)) continue;
    if (/^A complete log/i.test(detail)) continue;
    return detail.slice(0, 200);
  }

  if (/ENOENT|not recognized|command not found/i.test(output)) {
    return "npm could not be run. Install Node.js and try again.";
  }
  return null;
}

/** `added 193 packages in 8s` → 193. Used to report what the user now has. */
export function parseInstalledPackageCount(output: string): number | null {
  const match = /added\s+(\d+)\s+packages?/i.exec(output);
  if (!match) return null;
  const count = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * Trims npm's chatter down to lines worth showing in a progress pane.
 *
 * npm emits thousands of `npm http fetch` lines at `--loglevel info`; streaming
 * all of them into the renderer would be both useless and slow.
 */
export function isInterestingInstallLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^npm (info|verb|sill|http) /i.test(trimmed)) return false;
  if (/^npm notice/i.test(trimmed)) return false;
  return true;
}

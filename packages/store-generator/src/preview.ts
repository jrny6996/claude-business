/**
 * Running a generated store's Astro dev server.
 *
 * The preview shown in the app is the *real* site, served by Astro, so it can
 * never drift from what deploys. This module holds only the pure parts —
 * command construction and output parsing — so they can be unit-tested; the
 * process spawning lives in the Electron main process.
 *
 * Two facts drive the design:
 *
 * - A generated store has no `node_modules`, and Astro cannot start without
 *   one: the generated `astro.config.mjs` does `import ... from "astro/config"`,
 *   which fails to resolve. So a shared runtime is linked in as the store's
 *   `node_modules` rather than installing ~190 packages per store.
 * - `astro dev` daemonises. It prints the URL and pid, then exits 0. There is
 *   no long-lived child to babysit, and `astro dev stop` shuts it down.
 */

export interface DevServerCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface DevServerOptions {
  /** The generated Astro project. */
  projectDir: string;
  port: number;
  /** Path to the `astro` executable in the shared preview runtime. */
  astroBin: string;
  host?: string;
}

export function devServerStartCommand({
  projectDir,
  port,
  astroBin,
  host = "127.0.0.1",
}: DevServerOptions): DevServerCommand {
  return {
    command: astroBin,
    args: ["dev", "--port", String(port), "--host", host],
    cwd: projectDir,
  };
}

export function devServerStopCommand(
  projectDir: string,
  astroBin: string,
): DevServerCommand {
  return { command: astroBin, args: ["dev", "stop"], cwd: projectDir };
}

export interface DevServerReady {
  url: string;
  pid: number | null;
}

/**
 * Reads the daemon's startup output.
 *
 * Astro logs JSON lines like
 * `{"message":"Dev server running at http://localhost:4399 (pid 638553)…"}`,
 * and falls back to plain text in some versions, so both are handled.
 */
export function parseDevServerReady(output: string): DevServerReady | null {
  const text = extractMessages(output);

  const url = /https?:\/\/[^\s"'()]+/.exec(text)?.[0];
  if (!url) return null;
  if (!/dev server running|local\b|watching/i.test(text) && !url) return null;

  const pid = /\(pid\s+(\d+)\)/.exec(text)?.[1];

  return {
    url: url.replace(/[/,.]+$/, ""),
    pid: pid ? Number.parseInt(pid, 10) : null,
  };
}

/** True when the output says the server died rather than started. */
export function isDevServerFailure(output: string): boolean {
  return /exited before becoming ready|EADDRINUSE|failed to start/i.test(
    extractMessages(output),
  );
}

function extractMessages(output: string): string {
  const parts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { message?: unknown };
        if (typeof parsed.message === "string") {
          parts.push(parsed.message);
          continue;
        }
      } catch {
        // Not JSON after all; fall through to the raw line.
      }
    }
    parts.push(trimmed);
  }
  return parts.join("\n");
}

/**
 * The store files a theme change touches.
 *
 * Only these two carry theme or product data, so a live preview can be updated
 * by rewriting them and letting Astro's HMR do the rest — no restart, no
 * rebuild.
 */
export const THEME_HOT_FILES = ["src/styles/theme.css", "src/data/store.json"] as const;

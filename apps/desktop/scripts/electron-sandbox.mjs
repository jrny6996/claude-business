import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import electronPath from "electron";

/**
 * Chromium's sandbox needs help on Linux, and this app needs the sandbox.
 *
 * The desktop app loads real AliExpress pages in a BrowserWindow to scrape
 * them, so the renderer is executing untrusted remote code by design. That is
 * exactly the situation the sandbox exists for, which is why a broken sandbox
 * stops the launch here instead of quietly adding `--no-sandbox`.
 *
 * Chromium can sandbox two ways, and needs one of them:
 *
 * 1. **User namespaces** — no setup, but Ubuntu 24.04+ ships
 *    `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks it.
 * 2. **The setuid helper** — `chrome-sandbox` owned by root with mode 4755.
 *    npm can't set that, and reinstalling Electron resets it.
 *
 * With neither available, Electron aborts with a SIGTRAP and a message about
 * `chrome-sandbox` that reads like a corrupt install. It isn't.
 */

const SETUID_BIT = 0o4000;

export function sandboxBinaryPath() {
  return join(dirname(electronPath), "chrome-sandbox");
}

async function readProcValue(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Whether the kernel will let an unprivileged process create a namespace. */
async function userNamespacesUsable() {
  const max = await readProcValue("/proc/sys/user/max_user_namespaces");
  if (max !== null && Number(max) === 0) return false;

  const apparmor = await readProcValue(
    "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
  );
  // 1 means AppArmor denies the unprivileged clone, which is the common case
  // on recent Ubuntu and the reason this check exists at all.
  if (apparmor === "1") return false;

  return true;
}

function setuidHelperUsable() {
  try {
    const stats = statSync(sandboxBinaryPath());
    return stats.uid === 0 && (stats.mode & SETUID_BIT) !== 0;
  } catch {
    return false;
  }
}

/**
 * Reports whether Electron can sandbox. Non-Linux platforms manage their own
 * sandboxing and always pass.
 */
export async function inspectSandbox() {
  if (process.platform !== "linux") return { ok: true, reason: null };

  if (setuidHelperUsable()) return { ok: true, reason: "setuid-helper" };
  if (await userNamespacesUsable()) return { ok: true, reason: "user-namespaces" };

  return { ok: false, reason: "no-sandbox-available" };
}

function remedy() {
  const binary = sandboxBinaryPath();
  return `
Electron can't start: Chromium has no way to sandbox itself on this machine.

This is a one-time machine setup, not a broken install. Pick either fix:

  1. Grant the setuid helper (per Electron install — redo after reinstalling it):

       sudo chown root:root ${binary}
       sudo chmod 4755 ${binary}

     Or just run:  npm run fix-sandbox --workspace @repo/desktop

  2. Allow unprivileged user namespaces system-wide (survives reinstalls):

       sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

     To persist across reboots:
       echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf

If you genuinely can't get root, you can start without the sandbox:

       DSV_DISABLE_SANDBOX=1 npm run dev --workspace @repo/desktop

  Understand what that costs: this app opens real AliExpress pages in a
  Chromium window to scrape them, so the renderer runs untrusted remote code.
  The sandbox is the thing containing it. Use this for a quick look, not daily.
`;
}

/**
 * Returns the argv to launch Electron with, or exits with an explanation.
 */
export async function electronLaunchArgs(baseArgs = ["."]) {
  const report = await inspectSandbox();
  if (report.ok) return baseArgs;

  if (process.env.DSV_DISABLE_SANDBOX === "1") {
    process.stderr.write(
      "\n[store-validator] WARNING: starting with --no-sandbox. Scraped pages " +
        "will run unsandboxed in this session.\n\n",
    );
    return ["--no-sandbox", ...baseArgs];
  }

  process.stderr.write(remedy());
  process.exit(1);
}

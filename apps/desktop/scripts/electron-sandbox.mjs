import { renameSync, statSync } from "node:fs";
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
 * Chromium can sandbox three ways, and needs one of them:
 *
 * 1. **User namespaces** — no setup, but Ubuntu 24.04+ ships
 *    `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks it.
 * 2. **The bundled setuid helper** — `chrome-sandbox` owned by root with mode
 *    4755. npm can't set that, and reinstalling Electron resets it.
 * 3. **Somebody else's setuid helper**, borrowed via `CHROME_DEVEL_SANDBOX`.
 *    Any Chrome or Chromium installed from a package already has one, granted
 *    by that package's own root install. See displaceBundledHelper() for the catch.
 *
 * With none available, Electron aborts with a SIGTRAP and a message about
 * `chrome-sandbox` that reads like a corrupt install. It isn't.
 */

const SETUID_BIT = 0o4000;
const WORLD_EXEC_BIT = 0o0001;
const NON_ROOT_WRITE_BITS = 0o0022;

/**
 * Setuid helpers shipped by packages that install as root. Chromium's SUID
 * sandbox protocol is versioned and has been stable for years, so a helper
 * from a different Chromium build is fine; a mismatch fails loudly at launch
 * rather than silently dropping the sandbox.
 */
const BORROWABLE_HELPERS = [
  "/opt/google/chrome/chrome-sandbox",
  "/opt/google/chrome-beta/chrome-sandbox",
  "/opt/google/chrome-unstable/chrome-sandbox",
  "/opt/microsoft/msedge/chrome-sandbox",
  "/usr/lib/chromium/chrome-sandbox",
  "/usr/lib/chromium-browser/chrome-sandbox",
  "/usr/lib/electron/chrome-sandbox",
];

export function sandboxBinaryPath() {
  return join(dirname(electronPath), "chrome-sandbox");
}

/** Where an unusable bundled helper gets moved to. See displaceBundledHelper(). */
export function displacedBinaryPath() {
  return `${sandboxBinaryPath()}.unusable`;
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

/**
 * Chromium's own requirements for a helper it will exec: root-owned, setuid,
 * executable by us. The write check is ours — a helper any non-root account
 * could overwrite is a helper we'd be handing root to, so don't borrow one.
 */
function helperUsable(path) {
  try {
    const stats = statSync(path);
    return (
      stats.uid === 0 &&
      (stats.mode & SETUID_BIT) !== 0 &&
      (stats.mode & WORLD_EXEC_BIT) !== 0 &&
      (stats.mode & NON_ROOT_WRITE_BITS) === 0
    );
  } catch {
    return false;
  }
}

function bundledHelperUsable() {
  return helperUsable(sandboxBinaryPath());
}

function bundledHelperPresent() {
  try {
    statSync(sandboxBinaryPath());
    return true;
  } catch {
    return false;
  }
}

/** First borrowable helper on this machine, or null. */
function borrowableHelper() {
  const fromEnv = process.env.CHROME_DEVEL_SANDBOX;
  const candidates = fromEnv ? [fromEnv, ...BORROWABLE_HELPERS] : BORROWABLE_HELPERS;
  return candidates.find(helperUsable) ?? null;
}

/**
 * Reports how Electron can sandbox, and what has to happen first.
 * Non-Linux platforms manage their own sandboxing and always pass.
 */
export async function inspectSandbox() {
  if (process.platform !== "linux") return { ok: true, reason: null, helper: null };

  if (bundledHelperUsable()) return { ok: true, reason: "setuid-helper", helper: null };
  if (await userNamespacesUsable())
    return { ok: true, reason: "user-namespaces", helper: null };

  const helper = borrowableHelper();
  if (helper) return { ok: true, reason: "borrowed-helper", helper };

  return { ok: false, reason: "no-sandbox-available", helper: null };
}

/**
 * `CHROME_DEVEL_SANDBOX` is only consulted when there is no `chrome-sandbox`
 * beside the Electron binary: Chromium prefers its sibling and aborts on it if
 * it isn't root-owned and setuid, which is exactly the state npm leaves it in.
 * So the unusable one is moved aside, once, to let the borrowed one be seen.
 *
 * Nothing is destroyed — it keeps its bytes under `.unusable`, and
 * `npm run fix-sandbox` puts it back if root ever becomes available. `npm
 * install` restores it too (still unusable), and this runs again next launch.
 */
function displaceBundledHelper() {
  if (!bundledHelperPresent()) return;
  renameSync(sandboxBinaryPath(), displacedBinaryPath());
  process.stderr.write(
    `\n[store-validator] The bundled chrome-sandbox isn't root-owned, so Chromium ` +
      `would refuse it.\n[store-validator] Moved it to ${displacedBinaryPath()} and ` +
      `borrowed a granted helper instead.\n\n`,
  );
}

function remedy() {
  const binary = sandboxBinaryPath();
  return `
Electron can't start: Chromium has no way to sandbox itself on this machine.

This is a one-time machine setup, not a broken install. Pick any fix:

  1. Allow unprivileged user namespaces system-wide (survives reinstalls):

       sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

     To persist across reboots:
       echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf

  2. Grant the bundled setuid helper (per Electron install — redo after
     reinstalling it):

       sudo chown root:root ${binary}
       sudo chmod 4755 ${binary}

     Or just run:  npm run fix-sandbox --workspace @repo/desktop

  3. Install any packaged Chrome or Chromium. Its own setuid helper gets
     borrowed automatically, and that needs no root from you:

       sudo apt install chromium

If you genuinely can't get root, you can start without the sandbox:

       DSV_DISABLE_SANDBOX=1 npm run dev --workspace @repo/desktop

  Understand what that costs: this app opens real AliExpress pages in a
  Chromium window to scrape them, so the renderer runs untrusted remote code.
  The sandbox is the thing containing it. Use this for a quick look, not daily.
`;
}

/**
 * Returns how to launch Electron — argv plus any environment it needs — or
 * exits with an explanation.
 */
export async function electronLaunch(baseArgs = ["."]) {
  const report = await inspectSandbox();

  if (report.reason === "borrowed-helper") {
    displaceBundledHelper();
    return { args: baseArgs, env: { CHROME_DEVEL_SANDBOX: report.helper } };
  }

  if (report.ok) return { args: baseArgs, env: {} };

  if (process.env.DSV_DISABLE_SANDBOX === "1") {
    process.stderr.write(
      "\n[store-validator] WARNING: starting with --no-sandbox. Scraped pages " +
        "will run unsandboxed in this session.\n\n",
    );
    return { args: ["--no-sandbox", ...baseArgs], env: {} };
  }

  process.stderr.write(remedy());
  process.exit(1);
}

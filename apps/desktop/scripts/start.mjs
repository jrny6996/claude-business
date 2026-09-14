import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import electronPath from "electron";
import { electronLaunchArgs } from "./electron-sandbox.mjs";

// A missing build is the other common "it just won't start", and the error
// Electron gives for it is no clearer than the sandbox one.
if (!existsSync(new URL("../dist-electron/main.js", import.meta.url))) {
  process.stderr.write(
    "\nNothing to run: dist-electron/main.js is missing.\n" +
      "Build it first:  npm run build --workspace @repo/desktop\n\n",
  );
  process.exit(1);
}

// Anything after the script is forwarded to Electron, so flags like
// --remote-debugging-port or --inspect work through `npm start -- <flag>`.
const forwarded = process.argv.slice(2);

const child = spawn(electronPath, await electronLaunchArgs([".", ...forwarded]), {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));

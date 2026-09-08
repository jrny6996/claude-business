import { describe, expect, it } from "vitest";
import {
  classifyDevEnv,
  devCommand,
  formatCommand,
  installCommand,
  isInterestingInstallLine,
  parseInstallFailure,
  parseInstalledPackageCount,
} from "./dev-env.js";

describe("installCommand", () => {
  // A generated store ships no lockfile, and `npm ci` refuses to run without
  // one — using it here would fail every single time.
  it("uses install rather than ci, because there is no lockfile", () => {
    const { args } = installCommand({ projectDir: "/stores/a" });
    expect(args[0]).toBe("install");
    expect(args).not.toContain("ci");
  });

  it("suppresses audit and funding noise", () => {
    const { args } = installCommand({ projectDir: "/stores/a" });
    expect(args).toContain("--no-audit");
    expect(args).toContain("--no-fund");
  });

  it("runs in the store's own directory", () => {
    expect(installCommand({ projectDir: "/stores/a" }).cwd).toBe("/stores/a");
  });

  it("honours an explicit npm path for packaged builds", () => {
    const cmd = installCommand({ projectDir: "/s", npmPath: "/usr/local/bin/npm" });
    expect(cmd.command).toBe("/usr/local/bin/npm");
  });
});

describe("devCommand", () => {
  it("is the line the user runs after installing", () => {
    expect(formatCommand(devCommand({ projectDir: "/s" }))).toBe("npm run dev");
  });
});

describe("classifyDevEnv", () => {
  it("reports nothing installed", () => {
    expect(
      classifyDevEnv({ nodeModulesPresent: false, nodeModulesIsLink: false }),
    ).toBe("none");
  });

  // The distinction that matters: a link runs in-app but breaks the moment the
  // user copies the folder to deploy it.
  it("distinguishes our shared runtime link from a real install", () => {
    expect(
      classifyDevEnv({ nodeModulesPresent: true, nodeModulesIsLink: true }),
    ).toBe("linked");
    expect(
      classifyDevEnv({ nodeModulesPresent: true, nodeModulesIsLink: false }),
    ).toBe("installed");
  });
});

describe("parseInstallFailure", () => {
  it("pulls the actionable line out of modern npm output", () => {
    const output = [
      "npm error code ENOTFOUND",
      "npm error syscall getaddrinfo",
      "npm error request to https://registry.npmjs.org/astro failed",
      "npm error A complete log of this run can be found in: /tmp/x.log",
    ].join("\n");

    expect(parseInstallFailure(output)).toBe(
      "request to https://registry.npmjs.org/astro failed",
    );
  });

  it("still reads the older npm ERR! format", () => {
    expect(parseInstallFailure("npm ERR! network timeout at registry")).toBe(
      "network timeout at registry",
    );
  });

  it("skips the code/errno preamble that repeats the failure less usefully", () => {
    const output = "npm error code E404\nnpm error 404 Not Found - GET astro";
    expect(parseInstallFailure(output)).toBe("404 Not Found - GET astro");
  });

  it("explains a missing npm binary in plain language", () => {
    expect(parseInstallFailure("spawn npm ENOENT")).toMatch(/install node\.js/i);
  });

  it("returns null for a successful run", () => {
    expect(parseInstallFailure("added 193 packages in 8s")).toBeNull();
  });
});

describe("parseInstalledPackageCount", () => {
  it("reads the package count npm reports", () => {
    expect(parseInstalledPackageCount("added 193 packages in 8s")).toBe(193);
  });

  it("handles a single package without tripping on the plural", () => {
    expect(parseInstalledPackageCount("added 1 package in 1s")).toBe(1);
  });

  it("returns null when npm said nothing of the sort", () => {
    expect(parseInstalledPackageCount("up to date")).toBeNull();
  });
});

describe("isInterestingInstallLine", () => {
  // At --loglevel info npm emits thousands of http fetch lines; forwarding all
  // of them to the renderer would be useless and slow.
  it("drops npm's per-request chatter", () => {
    expect(isInterestingInstallLine("npm http fetch GET 200 https://x 12ms")).toBe(
      false,
    );
    expect(isInterestingInstallLine("npm info run astro@7.3.1")).toBe(false);
    expect(isInterestingInstallLine("npm notice New version available")).toBe(false);
    expect(isInterestingInstallLine("   ")).toBe(false);
  });

  it("keeps progress and errors", () => {
    expect(isInterestingInstallLine("added 193 packages in 8s")).toBe(true);
    expect(isInterestingInstallLine("npm error code ENOTFOUND")).toBe(true);
  });
});

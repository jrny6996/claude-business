import { describe, expect, it } from "vitest";
import {
  devServerStartCommand,
  devServerStopCommand,
  isDevServerFailure,
  parseDevServerReady,
} from "./preview.js";

describe("devServerStartCommand", () => {
  it("runs astro dev in the store directory", () => {
    expect(
      devServerStartCommand({
        projectDir: "/stores/shop",
        port: 4399,
        astroBin: "/runtime/node_modules/.bin/astro",
      }),
    ).toEqual({
      command: "/runtime/node_modules/.bin/astro",
      args: ["dev", "--port", "4399", "--host", "127.0.0.1"],
      cwd: "/stores/shop",
    });
  });

  it("stops the server from the same directory", () => {
    expect(devServerStopCommand("/stores/shop", "/bin/astro").args).toEqual([
      "dev",
      "stop",
    ]);
  });
});

describe("parseDevServerReady", () => {
  it("reads Astro's JSON daemon output", () => {
    const output = JSON.stringify({
      message:
        "Dev server running at http://localhost:4399 (pid 638553)\n  Stop:   astro dev stop",
      label: "SKIP_FORMAT",
      level: "info",
    });

    expect(parseDevServerReady(output)).toEqual({
      url: "http://localhost:4399",
      pid: 638553,
    });
  });

  it("reads plain-text output without a pid", () => {
    expect(
      parseDevServerReady("  Local    http://127.0.0.1:4321/"),
    ).toEqual({ url: "http://127.0.0.1:4321", pid: null });
  });

  it("returns null when nothing is ready yet", () => {
    expect(parseDevServerReady("")).toBeNull();
    expect(parseDevServerReady("building...")).toBeNull();
  });
});

describe("isDevServerFailure", () => {
  it("recognises the daemon dying", () => {
    expect(
      isDevServerFailure(
        JSON.stringify({ message: "Dev server process exited before becoming ready." }),
      ),
    ).toBe(true);
  });

  it("recognises a port clash", () => {
    expect(isDevServerFailure("Error: listen EADDRINUSE 0.0.0.0:4399")).toBe(true);
  });

  it("does not cry wolf on normal output", () => {
    expect(isDevServerFailure("Dev server running at http://localhost:4399")).toBe(
      false,
    );
  });
});

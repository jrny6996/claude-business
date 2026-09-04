import { defineConfig } from "astro/config";

// Static marketing site, deployed separately from the desktop app.
export default defineConfig({
  output: "static",
  build: { format: "directory" },
});

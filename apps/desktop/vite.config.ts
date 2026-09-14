import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Renderer build. `base: "./"` matters: the packaged app loads index.html over
 * `file://`, where absolute asset paths resolve to the filesystem root.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});

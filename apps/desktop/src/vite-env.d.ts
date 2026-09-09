/// <reference types="vite/client" />

// Side-effect CSS imports. `vite/client` covers relative paths; the design
// system is imported by package subpath, which needs its own declaration.
declare module "*.css";
declare module "@repo/design-system/styles.css";

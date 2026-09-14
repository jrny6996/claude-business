import { z } from "zod";

/**
 * The per-store development environment.
 *
 * A generated store is the user's own Astro project, and the point of this
 * feature is that they can leave the app entirely: open the folder in their
 * editor, run `npm run dev`, edit templates, and deploy it themselves.
 *
 * That is not true straight after generation. The in-app preview links a
 * *shared* Astro runtime in as the store's `node_modules` (see
 * `apps/desktop/electron/preview-server.ts`), which is enough for our own dev
 * server and nothing else — copy the folder elsewhere, or open a terminal in
 * it, and the link points at a path that may not exist. Setting up a dev
 * environment replaces that link with a real install the user owns.
 */
export const DevEnvKindSchema = z.enum([
  /** No `node_modules` at all — nothing will run yet. */
  "none",
  /** Our shared preview runtime, linked in. Fine in-app, not portable. */
  "linked",
  /** A real `npm install` in the store's own folder. Fully theirs. */
  "installed",
]);
export type DevEnvKind = z.infer<typeof DevEnvKindSchema>;

export const DevEnvStatusSchema = z.object({
  storeId: z.string().min(1),
  projectDir: z.string().min(1),
  kind: DevEnvKindSchema,
  /** True when the store's files are on disk at all. */
  projectPresent: z.boolean(),
  /** `.env` exists — the store's own local secrets file. */
  envFilePresent: z.boolean(),
  /** This store needs a STRIPE_SECRET_KEY to run checkout locally. */
  needsStripeEnv: z.boolean(),
  /** Node/npm found on PATH. Without it we can only print the command. */
  toolchain: z
    .object({
      npmPath: z.string().nullable().default(null),
      nodeVersion: z.string().nullable().default(null),
    })
    .prefault({}),
  /** Package count, when we can cheaply tell. */
  packageCount: z.number().int().nonnegative().nullable().default(null),
});
export type DevEnvStatus = z.infer<typeof DevEnvStatusSchema>;

/** Progress lines streamed to the UI while `npm install` runs. */
export interface DevEnvProgress {
  storeId: string;
  phase: "installing" | "done" | "failed";
  line: string;
}

/** Minimum Node the generated Astro project needs. Matches `.nvmrc`. */
export const STORE_NODE_VERSION = "24";

import { AppError, type DeployProvider, type Store } from "@repo/shared";
import { nowOf, type AppContext } from "../context.js";

/**
 * BYO hosting.
 *
 * We never serve storefront traffic, so "deploy" here means: hand the user's
 * own deploy token to their own Vercel/Netlify account, or tell them the exact
 * command to run. We are not a reverse proxy and never become one.
 *
 * The actual upload is performed by the host's own CLI in the Electron main
 * process (see `apps/desktop`), because shipping a full multipart deploy
 * implementation for two providers is a lot of fragile surface for no benefit
 * over the tools they already publish.
 */
export interface DeployInstructions {
  provider: DeployProvider;
  /** Directory the user should deploy. */
  projectDir: string;
  /** Ready-to-run command, token supplied via env var, never inlined. */
  command: string;
  /** Env var the token must be provided as. */
  tokenEnvVar: string;
  tokenPresent: boolean;
  notes: string[];
}

const TOKEN_ENV: Record<DeployProvider, string> = {
  vercel: "VERCEL_TOKEN",
  netlify: "NETLIFY_AUTH_TOKEN",
};

export function getDeployInstructions(
  ctx: AppContext,
  storeId: string,
  provider: DeployProvider,
): DeployInstructions {
  const store = ctx.data.stores.findById(storeId);
  if (!store) throw new AppError("NOT_FOUND", "That store no longer exists.");
  if (!store.outputDir) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Generate the store before deploying it.",
    );
  }

  const tokenPresent = ctx.data.settings.describeSecret(
    provider === "vercel" ? "deploy_token_vercel" : "deploy_token_netlify",
  ).present;

  return {
    provider,
    projectDir: store.outputDir,
    command:
      provider === "vercel"
        ? "npx vercel deploy --prod --yes"
        : "npx netlify deploy --prod --dir dist",
    tokenEnvVar: TOKEN_ENV[provider],
    tokenPresent,
    notes:
      provider === "vercel"
        ? [
            "Run npm install and npm run build in the project folder first.",
            "Vercel detects Astro automatically; no extra configuration needed.",
          ]
        : [
            "Run npm install and npm run build in the project folder first.",
            "Netlify deploys the built dist/ directory.",
          ],
  };
}

/** Records a successful deploy so the UI can link to the live store. */
export function recordDeployment(
  ctx: AppContext,
  storeId: string,
  deployedUrl: string,
): Store {
  let url: URL;
  try {
    url = new URL(deployedUrl);
  } catch {
    throw new AppError("VALIDATION_FAILED", "That doesn't look like a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("VALIDATION_FAILED", "Deployed URLs must be http or https.");
  }

  const store = ctx.data.stores.update(
    storeId,
    { status: "deployed", deployedUrl: url.toString() },
    nowOf(ctx).toISOString(),
  );
  if (!store) throw new AppError("NOT_FOUND", "That store no longer exists.");
  return store;
}

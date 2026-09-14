import type { Context } from "hono";
import { z } from "zod";
import { AppError, toAppError, type AppErrorShape, type ErrorCode } from "@repo/shared";

const STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_URL: 400,
  UNSUPPORTED_SOURCE: 400,
  VALIDATION_FAILED: 400,
  MISSING_OPENROUTER_KEY: 400,
  MISSING_GEMINI_KEY: 400,
  MISSING_AI_KEY: 400,
  MISSING_STRIPE_KEY: 400,
  MISSING_DEPLOY_TOKEN: 400,
  UNAUTHORIZED: 401,
  PREMIUM_REQUIRED: 402,
  NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  PARSE_FAILED: 422,
  FETCH_FAILED: 502,
  BOT_CHALLENGE: 409,
  CHALLENGE_ABANDONED: 409,
  OPENROUTER_REQUEST_FAILED: 502,
  GEMINI_REQUEST_FAILED: 502,
  STRIPE_REQUEST_FAILED: 502,
  DEPLOY_FAILED: 502,
  WRITE_FAILED: 500,
  INTERNAL: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

/**
 * Turns any thrown value into a JSON error the renderer can display.
 *
 * Unknown errors collapse to a generic message on purpose — a stack trace or a
 * raw provider response could carry a secret, and neither helps the user.
 * Schema failures are the one unknown worth translating: they are the user's
 * input being wrong, not the app being broken, so they earn a 400 and the
 * offending field name.
 */
export function respondWithError(c: Context, cause: unknown): Response {
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    const path = issue?.path.join(".");
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: issue
            ? `${path || "request"}: ${issue.message}`
            : "That request wasn't valid.",
        } satisfies AppErrorShape,
      },
      400,
    );
  }

  const shape: AppErrorShape = toAppError(cause);
  const status = cause instanceof AppError ? statusFor(cause.code) : 500;
  return c.json({ ok: false, error: shape }, status as never);
}

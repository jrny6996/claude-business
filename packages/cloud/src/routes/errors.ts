import type { Context } from "hono";
import { z } from "zod";
import { AppError, toAppError, type AppErrorShape, type ErrorCode } from "@repo/shared";

const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  PREMIUM_REQUIRED: 402,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 507,
  CLOUD_REQUEST_FAILED: 502,
  INTERNAL: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS[code] ?? 500;
}

/**
 * Turns any thrown value into a JSON error.
 *
 * Same envelope as the local API, so the desktop client has one shape to
 * handle. Unknown errors collapse to a generic message deliberately: this
 * service holds the licence signing key and a Stripe secret, and a stack trace
 * or a raw provider response is exactly the sort of thing that leaks one.
 */
export function respondWithError(c: Context, cause: unknown): Response {
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    return c.json(
      {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: issue
            ? `${issue.path.join(".") || "request"}: ${issue.message}`
            : "That request wasn't valid.",
        } satisfies AppErrorShape,
      },
      400,
    );
  }

  const shape = toAppError(cause);
  const status = cause instanceof AppError ? statusFor(cause.code) : 500;

  if (!(cause instanceof AppError)) {
    console.error("[cloud] unhandled error", cause);
  }

  return c.json({ ok: false, error: shape }, status as never);
}

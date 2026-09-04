/**
 * Error codes surfaced to the renderer. Every one of these must map to a
 * message a non-technical user can act on — scraping and deploys are both
 * inherently fragile, so failures have to be legible rather than silent.
 */
export const ERROR_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_SOURCE",
  "FETCH_FAILED",
  "BOT_CHALLENGE",
  "CHALLENGE_ABANDONED",
  "PARSE_FAILED",
  "PRODUCT_NOT_FOUND",
  "MISSING_OPENROUTER_KEY",
  "OPENROUTER_REQUEST_FAILED",
  "MISSING_STRIPE_KEY",
  "STRIPE_REQUEST_FAILED",
  "MISSING_DEPLOY_TOKEN",
  "DEPLOY_FAILED",
  "PREMIUM_REQUIRED",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "WRITE_FAILED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorShape {
  code: ErrorCode;
  /** User-facing, plain language. Never contains secrets or raw stack traces. */
  message: string;
  /** Optional non-sensitive detail for the UI (e.g. which field failed). */
  detail?: string;
}

export class AppError extends Error implements AppErrorShape {
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  toShape(): AppErrorShape {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

export type Result<T, E = AppErrorShape> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Narrows an unknown thrown value into a safe, user-facing error shape. */
export function toAppError(cause: unknown): AppErrorShape {
  if (cause instanceof AppError) return cause.toShape();
  return {
    code: "INTERNAL",
    message: "Something went wrong. Please try again.",
  };
}

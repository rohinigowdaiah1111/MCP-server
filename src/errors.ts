/**
 * Standardized error model for the MCP server (implementationplan.md, Section 7).
 *
 * Every failure that can reach a calling agent is normalized into an
 * `AppError` with a stable `code`, a `retryable` hint, and a safe `message`
 * that never leaks secrets (tokens, credential file contents, stack traces).
 */

export type ErrorCode =
  | "INVALID_INPUT"
  | "REAUTH_REQUIRED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** Optional machine-readable extras (e.g. retryAfterMs) safe to expose to the agent. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

interface GaxiosLikeError {
  code?: number | string;
  response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
  message?: string;
}

function extractStatus(error: GaxiosLikeError): number | undefined {
  const status = error.response?.status ?? (typeof error.code === "number" ? error.code : undefined);
  return status;
}

/**
 * Maps errors thrown by `googleapis`/`google-auth-library` calls into the
 * server's standardized `AppError` taxonomy so every tool handler can return
 * a consistent, actionable response regardless of which Google API failed.
 */
export function mapGoogleApiError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;

  const gaxiosError = (error ?? {}) as GaxiosLikeError;
  const status = extractStatus(gaxiosError);
  const upstreamMessage = gaxiosError.response?.data?.error?.message ?? gaxiosError.message;

  switch (status) {
    case 401:
      return new AppError(
        "REAUTH_REQUIRED",
        `${context}: Google credentials are missing, expired, or revoked. Run \`npm run authorize\` again.`,
        { retryable: false, cause: error }
      );
    case 403:
      return new AppError(
        "REAUTH_REQUIRED",
        `${context}: Access denied by Google (insufficient scope or permission). ` +
          "Run `npm run authorize` again to re-grant the required scopes.",
        { retryable: false, cause: error }
      );
    case 429:
      return new AppError("RATE_LIMITED", `${context}: Google API rate limit exceeded. Please retry shortly.`, {
        retryable: true,
        details: { retryAfterMs: 2000 },
        cause: error,
      });
    case 404:
      return new AppError("INVALID_INPUT", `${context}: The requested resource was not found.`, {
        retryable: false,
        cause: error,
      });
    case 409:
      return new AppError("CONFLICT", `${context}: The resource was modified concurrently. Please retry.`, {
        retryable: true,
        cause: error,
      });
    default:
      if (status !== undefined && status >= 500) {
        return new AppError("UPSTREAM_ERROR", `${context}: Google API is temporarily unavailable.`, {
          retryable: true,
          cause: error,
        });
      }
      return new AppError(
        "INTERNAL_ERROR",
        `${context}: ${upstreamMessage ?? "An unexpected error occurred."}`,
        { retryable: false, cause: error }
      );
  }
}

export function toStructuredText(error: unknown): string {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  return JSON.stringify(appError.toJSON());
}

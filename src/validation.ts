/**
 * Input validation for the issue_refund tool.
 *
 * Pure functions — no I/O, no Razorpay calls, no logs. Validation runs
 * before any external side effect so we can reject bad input cheaply.
 */

export interface RefundInput {
  payment_id: string;
  amount: number;
  request_id: string;
  reason?: string;
}

export interface ValidationFailure {
  type: "validation_error";
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: RefundInput }
  | { ok: false; error: ValidationFailure };

/**
 * Returns true if the value is a non-empty string after trimming.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Returns true if the value is a positive integer (Number, > 0, no fractional part).
 * Razorpay amounts are integers in the smallest currency unit (paise for INR).
 */
function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/**
 * Validates raw input (typically a parsed JSON body or MCP tool argument)
 * against the RefundInput shape. Returns a discriminated result so callers
 * can handle the failure path without try/catch.
 */
export function validateRefundInput(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      error: {
        type: "validation_error",
        code: "invalid_body",
        message: "Request body must be a JSON object.",
      },
    };
  }

  const input = raw as Record<string, unknown>;

  if (!isNonEmptyString(input.payment_id)) {
    return {
      ok: false,
      error: {
        type: "validation_error",
        code: "missing_payment_id",
        message: "payment_id is required and must be a non-empty string.",
      },
    };
  }

  if (!isPositiveInteger(input.amount)) {
    return {
      ok: false,
      error: {
        type: "validation_error",
        code: "invalid_amount",
        message: "amount is required and must be a positive integer (paise).",
      },
    };
  }

  if (!isNonEmptyString(input.request_id)) {
    return {
      ok: false,
      error: {
        type: "validation_error",
        code: "missing_request_id",
        message: "request_id is required and must be a non-empty string.",
      },
    };
  }

  if (input.reason !== undefined && typeof input.reason !== "string") {
    return {
      ok: false,
      error: {
        type: "validation_error",
        code: "invalid_reason",
        message: "reason, if provided, must be a string.",
      },
    };
  }

  return {
    ok: true,
    value: {
      payment_id: input.payment_id.trim(),
      amount: input.amount,
      request_id: input.request_id.trim(),
      reason: typeof input.reason === "string" ? input.reason : undefined,
    },
  };
}

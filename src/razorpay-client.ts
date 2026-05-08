/**
 * Thin wrapper around the Razorpay SDK.
 *
 * Exposes a single operation: issuing a refund against a known
 * payment_id. Razorpay refunds are scoped to a payment (not a
 * "charge"), so callers must already have the payment_id in hand —
 * this layer does not search for one.
 */

import Razorpay from "razorpay";

export interface RazorpayClientError {
  type: "razorpay_client_error";
  code: string;
  message: string;
  cause?: unknown;
}

let cachedClient: Razorpay | null = null;

/**
 * Lazily constructs and caches a single Razorpay client. Throws if
 * RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is not set, since every
 * refund path requires both.
 */
export function getRazorpayClient(): Razorpay {
  if (cachedClient !== null) {
    return cachedClient;
  }
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (typeof keyId !== "string" || keyId.length === 0) {
    const err: RazorpayClientError = {
      type: "razorpay_client_error",
      code: "missing_api_key",
      message: "RAZORPAY_KEY_ID is not set in the environment.",
    };
    throw err;
  }
  if (typeof keySecret !== "string" || keySecret.length === 0) {
    const err: RazorpayClientError = {
      type: "razorpay_client_error",
      code: "missing_api_secret",
      message: "RAZORPAY_KEY_SECRET is not set in the environment.",
    };
    throw err;
  }
  cachedClient = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
  return cachedClient;
}

/**
 * Resets the cached Razorpay client. Used in tests; no-op in production.
 */
export function resetRazorpayClientForTests(): void {
  cachedClient = null;
}

/**
 * Shape of the refund object returned by Razorpay's API. The SDK's own
 * types are loose, so we model only the fields V0 actually reads.
 */
export interface RazorpayRefund {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  payment_id: string;
  status: string;
  notes?: Record<string, string> | unknown;
  created_at?: number;
  [key: string]: unknown;
}

/**
 * Issues a Razorpay refund against the given payment_id.
 *
 * - amountPaise is in paise (smallest unit, integer). Razorpay rejects
 *   non-integer or rupee-denominated amounts.
 * - notes is stored on the refund by Razorpay and is the right place
 *   for our request_id, so the refund is cross-referenceable from the
 *   Razorpay dashboard back to our audit log.
 */
export async function issueRefund(
  paymentId: string,
  amountPaise: number,
  notes: Record<string, string>,
): Promise<RazorpayRefund> {
  const client = getRazorpayClient();

  try {
    const refund = (await client.payments.refund(paymentId, {
      amount: amountPaise,
      notes,
    })) as unknown as RazorpayRefund;
    return refund;
  } catch (err: unknown) {
    const clientErr: RazorpayClientError = {
      type: "razorpay_client_error",
      code: "refund_create_failed",
      message: `Failed to create refund for payment ${paymentId}.`,
      cause: err,
    };
    throw clientErr;
  }
}

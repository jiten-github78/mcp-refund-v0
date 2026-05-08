/**
 * Demo refund execution path.
 *
 * Mirrors the real executeRefund pipeline (kill switch, validation,
 * idempotency, audit log) but skips the Razorpay call entirely. The
 * audit trail goes to a separate demo-logs.json so demo activity
 * never touches the real audit log.
 *
 * The point: anyone can hit POST /demo/issue_refund without configuring
 * Razorpay keys and see the full safety semantics in action — duplicates
 * blocked, kill switch respected, every call logged.
 */

import { randomBytes } from "crypto";

import { validateRefundInput } from "./validation.js";
import {
  appendLog,
  findByRequestId,
  DEMO_LOGS_PATH,
  type LogEntry,
} from "./storage.js";

const DEMO_NOTE =
  "This is a demo response. No real refund was issued. Try with your own Razorpay keys via /issue_refund for real testing.";

export interface DemoRefundSuccess {
  ok: true;
  refund_id: string;
  status: "processed";
  amount: number;
  payment_id: string;
  request_id: string;
  reasoning_input?: string;
  demo: true;
  note: string;
}

export interface DemoRefundDuplicate {
  ok: true;
  duplicate: true;
  refund_id: string | null;
  status: string;
  request_id: string;
  original_entry: LogEntry;
  demo: true;
  note: string;
}

export interface DemoRefundFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  request_id?: string;
  demo: true;
  note: string;
}

export type DemoRefundResult =
  | DemoRefundSuccess
  | DemoRefundDuplicate
  | DemoRefundFailure;

function nowIso(): string {
  return new Date().toISOString();
}

function generateDemoRefundId(): string {
  return `rfnd_demo_${randomBytes(8).toString("hex")}`;
}

/**
 * Demo refund executor. Same semantics as executeRefund except step 4
 * (the Razorpay call) is replaced by synthesizing a fake refund_id.
 */
export async function executeDemoRefund(
  rawInput: unknown,
): Promise<DemoRefundResult> {
  // Step 1: kill switch — DEMO_ENABLED is independent of REFUNDS_ENABLED so
  // the public demo can be open while the real /issue_refund path stays
  // locked down on the same deployment.
  if (process.env.DEMO_ENABLED !== "true") {
    return {
      ok: false,
      demo: true,
      note: DEMO_NOTE,
      error: {
        code: "demo_disabled",
        message: "Demo disabled by system",
      },
    };
  }

  // Step 2: validation.
  const validated = validateRefundInput(rawInput);
  if (!validated.ok) {
    return {
      ok: false,
      demo: true,
      note: DEMO_NOTE,
      error: {
        code: validated.error.code,
        message: validated.error.message,
      },
    };
  }
  const { payment_id, amount, request_id, reason } = validated.value;

  // Step 3: idempotency, against demo-logs.json.
  let existing: LogEntry | null;
  try {
    existing = await findByRequestId(request_id, DEMO_LOGS_PATH);
  } catch (err: unknown) {
    return {
      ok: false,
      demo: true,
      note: DEMO_NOTE,
      request_id,
      error: {
        code: "idempotency_lookup_failed",
        message: `Could not check duplicate status: ${String(err)}`,
      },
    };
  }
  if (existing !== null) {
    try {
      const dupEntry: LogEntry = {
        timestamp: nowIso(),
        request_id,
        payment_id,
        amount_paise: amount,
        razorpay_refund_id: existing.razorpay_refund_id,
        status: "duplicate_blocked",
        reasoning_input: reason,
        razorpay_response: null,
      };
      await appendLog(dupEntry, DEMO_LOGS_PATH);
    } catch (logErr: unknown) {
      process.stderr.write(
        `[mcp-refund] failed to write demo duplicate-blocked log: ${String(logErr)}\n`,
      );
    }
    return {
      ok: true,
      duplicate: true,
      refund_id: existing.razorpay_refund_id,
      status: existing.status,
      request_id,
      original_entry: existing,
      demo: true,
      note: DEMO_NOTE,
    };
  }

  // Step 4: synthesize a fake refund_id (no Razorpay call).
  const demoRefundId = generateDemoRefundId();

  // Step 5: success log to demo-logs.json.
  const entry: LogEntry = {
    timestamp: nowIso(),
    request_id,
    payment_id,
    amount_paise: amount,
    razorpay_refund_id: demoRefundId,
    status: "success",
    reasoning_input: reason,
    razorpay_response: null,
  };
  try {
    await appendLog(entry, DEMO_LOGS_PATH);
  } catch (err: unknown) {
    return {
      ok: false,
      demo: true,
      note: DEMO_NOTE,
      request_id,
      error: {
        code: "log_write_failed",
        message: `Failed to record demo refund: ${String(err)}`,
      },
    };
  }

  return {
    ok: true,
    refund_id: demoRefundId,
    status: "processed",
    amount,
    payment_id,
    request_id,
    reasoning_input: reason,
    demo: true,
    note: DEMO_NOTE,
  };
}

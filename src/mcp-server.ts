/**
 * MCP server exposing the single tool `issue_refund`.
 *
 * The exported `executeRefund` function is the shared core: both the
 * MCP tool handler and the Express POST /issue_refund endpoint call it,
 * so the safety semantics (kill switch, validation, idempotency, audit
 * log, fail-closed behavior) live in exactly one place.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { validateRefundInput } from "./validation.js";
import {
  appendLog,
  findByRequestId,
  type LogEntry,
} from "./storage.js";
import { issueRefund } from "./razorpay-client.js";

export interface RefundSuccess {
  ok: true;
  refund_id: string;
  status: string;
  amount: number;
  payment_id: string;
  request_id: string;
  duplicate?: false;
}

export interface RefundDuplicate {
  ok: true;
  duplicate: true;
  refund_id: string | null;
  status: string;
  request_id: string;
  original_entry: LogEntry;
}

export interface RefundFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
  request_id?: string;
}

export type RefundResult = RefundSuccess | RefundDuplicate | RefundFailure;

/**
 * Returns the current ISO-8601 timestamp. Pulled into a helper so tests
 * can clock-mock if/when we add them.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Reads an arbitrary thrown value and returns a normalized
 * { code, message } shape suitable for both API responses and the
 * audit log. Never re-throws — used inside catch blocks.
 */
function normalizeError(err: unknown): { code: string; message: string } {
  if (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    "code" in err &&
    "message" in err
  ) {
    const typed = err as { code: string; message: string };
    return { code: typed.code, message: typed.message };
  }
  if (err instanceof Error) {
    return { code: "unexpected_error", message: err.message };
  }
  return { code: "unexpected_error", message: String(err) };
}

/**
 * Core refund execution. Performs the steps in the exact order required
 * by the V0 contract:
 *   1. Kill-switch check
 *   2. Input validation
 *   3. Idempotency lookup against logs.json
 *   4. Issue the Razorpay refund against payment_id
 *   5. Append a success log entry
 *   6. Return success
 *
 * Any thrown error after step 1 is caught, recorded as a failed log
 * entry, and surfaced to the caller. The function never partially
 * executes: either Razorpay acknowledges the refund and we record it,
 * or we record a failure and return an error.
 */
export async function executeRefund(rawInput: unknown): Promise<RefundResult> {
  // Step 1: kill switch.
  if (process.env.REFUNDS_ENABLED !== "true") {
    return {
      ok: false,
      error: {
        code: "refunds_disabled",
        message: "Refunds disabled by system",
      },
    };
  }

  // Step 2: validation.
  const validated = validateRefundInput(rawInput);
  if (!validated.ok) {
    return {
      ok: false,
      error: {
        code: validated.error.code,
        message: validated.error.message,
      },
    };
  }
  const { payment_id, amount, request_id, reason } = validated.value;

  // Step 3: idempotency.
  let existing: LogEntry | null;
  try {
    existing = await findByRequestId(request_id);
  } catch (err: unknown) {
    const norm = normalizeError(err);
    return {
      ok: false,
      request_id,
      error: {
        code: "idempotency_lookup_failed",
        message: `Could not check duplicate status: ${norm.message}`,
      },
    };
  }
  if (existing !== null) {
    // Best-effort log of the duplicate attempt. findByRequestId returns
    // the FIRST match, so the original entry will continue to win
    // idempotency lookups even after duplicate_blocked entries are appended.
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
      await appendLog(dupEntry);
    } catch (logErr: unknown) {
      process.stderr.write(
        `[mcp-refund] failed to write duplicate-blocked log: ${String(logErr)}\n`,
      );
    }
    return {
      ok: true,
      duplicate: true,
      refund_id: existing.razorpay_refund_id,
      status: existing.status,
      request_id,
      original_entry: existing,
    };
  }

  // Step 4: Razorpay refund. The notes carry our request_id so the
  // refund is cross-referenceable from the Razorpay dashboard.
  try {
    const notes: Record<string, string> = { request_id };
    if (typeof reason === "string" && reason.length > 0) {
      notes.reason = reason;
    }

    const refund = await issueRefund(payment_id, amount, notes);

    // Step 5: success log.
    const entry: LogEntry = {
      timestamp: nowIso(),
      request_id,
      payment_id,
      amount_paise: amount,
      razorpay_refund_id: refund.id,
      status: "success",
      reasoning_input: reason,
      razorpay_response: refund,
    };
    await appendLog(entry);

    // Step 6: return.
    return {
      ok: true,
      refund_id: refund.id,
      status: refund.status ?? "unknown",
      amount,
      payment_id,
      request_id,
    };
  } catch (err: unknown) {
    const norm = normalizeError(err);

    // Best-effort failure log. If even this throws, we surface the
    // original error rather than the logging error so the caller
    // sees the real cause.
    try {
      const failureEntry: LogEntry = {
        timestamp: nowIso(),
        request_id,
        payment_id,
        amount_paise: amount,
        razorpay_refund_id: null,
        status: "failed",
        reasoning_input: reason,
        razorpay_response: null,
        error: norm,
      };
      await appendLog(failureEntry);
    } catch (logErr: unknown) {
      process.stderr.write(
        `[mcp-refund] failed to write failure log: ${String(logErr)}\n`,
      );
    }

    return {
      ok: false,
      request_id,
      error: norm,
    };
  }
}

/**
 * JSON Schema describing the issue_refund tool's input. Exported so the
 * MCP server and any future HTTP-side OpenAPI doc agree exactly.
 */
export const ISSUE_REFUND_INPUT_SCHEMA = {
  type: "object",
  properties: {
    payment_id: {
      type: "string",
      description:
        "Razorpay payment ID to refund against (e.g. pay_ABC123). Must already be a captured payment.",
    },
    amount: {
      type: "integer",
      minimum: 1,
      description:
        "Refund amount in the smallest currency unit (paise for INR). Integer only.",
    },
    request_id: {
      type: "string",
      description:
        "Unique idempotency key. Reusing a previous request_id returns the original result and never re-executes.",
    },
    reason: {
      type: "string",
      description: "Optional human-readable reason, recorded in the audit log.",
    },
  },
  required: ["payment_id", "amount", "request_id"],
  additionalProperties: false,
} as const;

/**
 * Constructs the MCP server, registers the issue_refund tool, and returns
 * the server instance. Caller is responsible for connecting a transport.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    {
      name: "mcp-refund",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "issue_refund",
          description:
            "Issue a Razorpay refund against a payment_id. Gated by a global kill switch, idempotency check, and append-only audit log. Never partial-executes: any failure is logged with status 'failed' and surfaced as an error.",
          inputSchema: ISSUE_REFUND_INPUT_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "issue_refund") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                code: "unknown_tool",
                message: `Unknown tool: ${request.params.name}`,
              },
            }),
          },
        ],
      };
    }

    const result = await executeRefund(request.params.arguments);
    return {
      isError: result.ok === false,
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  return server;
}

/**
 * Connects the MCP server to a stdio transport. This is what Claude
 * Desktop and other MCP clients spawn as a subprocess.
 */
export async function startMcpStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-refund] MCP server listening on stdio\n");
}

/**
 * Entry point.
 *
 * Two run modes:
 *   - default: starts the Express HTTP server (used by Railway, curl, Postman).
 *   - --mcp:   starts the MCP stdio server (used by Claude Desktop / MCP clients).
 *
 * The two modes are kept separate because stdio MCP requires stdout to be
 * reserved for protocol traffic, so we never want Express logs going to
 * stdout in that mode.
 */

import "dotenv/config";

import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";

import { executeRefund, startMcpStdio } from "./mcp-server.js";
import { readLogs } from "./storage.js";

/**
 * Builds the Express app. Pulled into its own function so future tests
 * can construct an app instance without binding a port.
 */
export function buildHttpApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/issue_refund", async (req: Request, res: Response) => {
    const result = await executeRefund(req.body);
    const status = result.ok ? 200 : statusForError(result.error.code);
    res.status(status).json(result);
  });

  app.get("/logs", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const logs = await readLogs();
      res.status(200).json(logs);
    } catch (err: unknown) {
      next(err);
    }
  });

  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction,
    ) => {
      process.stderr.write(`[mcp-refund] unhandled error: ${String(err)}\n`);
      res.status(500).json({
        ok: false,
        error: {
          code: "internal_error",
          message: "Internal server error",
        },
      });
    },
  );

  return app;
}

/**
 * Maps a refund error code to an HTTP status code. Defaults to 400
 * (caller's fault) for validation/idempotency issues, 503 for the
 * kill switch, and 502 for Razorpay-side failures.
 */
function statusForError(code: string): number {
  switch (code) {
    case "refunds_disabled":
      return 503;
    case "missing_payment_id":
    case "missing_request_id":
    case "invalid_amount":
    case "invalid_reason":
    case "invalid_body":
      return 400;
    case "refund_create_failed":
      return 502;
    default:
      return 500;
  }
}

/**
 * Starts the HTTP server on process.env.PORT (defaulting to 3000).
 */
async function startHttp(): Promise<void> {
  const app = buildHttpApp();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    process.stderr.write(`[mcp-refund] HTTP listening on :${port}\n`);
  });
}

/**
 * Eager sandbox-only check. Refuses to boot if RAZORPAY_KEY_ID is a
 * production key (rzp_live_*). Skips silently if no key is set, so the
 * lazy path in razorpay-client.ts can produce its own error.
 */
function assertSandboxOnly(): void {
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (typeof keyId === "string" && keyId.startsWith("rzp_live_")) {
    process.stderr.write(
      "[mcp-refund] fatal: production Razorpay keys (rzp_live_*) are rejected. V0 is sandbox-only — use a test key (rzp_test_*).\n",
    );
    process.exit(1);
  }
}

/**
 * Process entry. Selects HTTP or MCP mode based on the --mcp flag.
 */
async function main(): Promise<void> {
  assertSandboxOnly();
  const isMcpMode = process.argv.includes("--mcp");
  if (isMcpMode) {
    await startMcpStdio();
  } else {
    await startHttp();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[mcp-refund] fatal: ${String(err)}\n`);
  process.exit(1);
});

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
import { executeDemoRefund } from "./demo-server.js";
import { readLogs, DEMO_LOGS_PATH } from "./storage.js";

/**
 * In-memory per-IP rate limiter for /demo routes. 30 requests per IP
 * per rolling hour. State resets on process restart, which is fine —
 * Railway redeploys also wipe the demo log file, so the two are
 * effectively in sync.
 */
const DEMO_RATE_WINDOW_MS = 60 * 60 * 1000;
const DEMO_RATE_MAX = 30;
const demoRateBuckets = new Map<string, number[]>();

function rateLimitDemo(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const recent = (demoRateBuckets.get(ip) ?? []).filter(
    (t) => now - t < DEMO_RATE_WINDOW_MS,
  );
  if (recent.length >= DEMO_RATE_MAX) {
    const oldestRetryMs = DEMO_RATE_WINDOW_MS - (now - recent[0]);
    res.status(429).json({
      ok: false,
      demo: true,
      error: {
        code: "rate_limited",
        message: `Demo rate limit exceeded: ${DEMO_RATE_MAX} requests per hour per IP. Retry in ~${Math.ceil(oldestRetryMs / 1000)}s.`,
      },
    });
    return;
  }
  recent.push(now);
  demoRateBuckets.set(ip, recent);
  next();
}

/**
 * Builds the Express app. Pulled into its own function so future tests
 * can construct an app instance without binding a port.
 */
export function buildHttpApp(): express.Express {
  const app = express();
  // Trust Railway's reverse proxy so req.ip reflects the real client IP
  // for the demo rate limiter.
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      name: "mcp-refund-v0",
      description:
        "Safety layer for AI agents that issue refunds. Sandbox-only V0.",
      endpoints: {
        health: "GET /health",
        issue_refund: "POST /issue_refund",
        logs: "GET /logs",
        demo_issue_refund:
          "POST /demo/issue_refund (try without Razorpay keys, rate-limited)",
        demo_logs: "GET /demo/logs",
      },
      repo: "https://github.com/jiten-github78/mcp-refund-v0",
    });
  });

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

  app.post(
    "/demo/issue_refund",
    rateLimitDemo,
    async (req: Request, res: Response) => {
      const result = await executeDemoRefund(req.body);
      const status = result.ok
        ? 200
        : statusForError((result as { error: { code: string } }).error.code);
      res.status(status).json(result);
    },
  );

  app.get(
    "/demo/logs",
    rateLimitDemo,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const logs = await readLogs(DEMO_LOGS_PATH);
        res.status(200).json(logs);
      } catch (err: unknown) {
        next(err);
      }
    },
  );

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

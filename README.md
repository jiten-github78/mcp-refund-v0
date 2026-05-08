# mcp-refund-v0

**Razorpay for AI agents — V0.** A Model Context Protocol server that sits between an AI agent and your Razorpay account. The agent decides *whether* to refund a customer; this server decides whether the agent is allowed to. Every call passes through a global kill switch, an idempotency check, and an append-only audit log. Either Razorpay acknowledges the refund and we record it, or we record a failure and return an error — there is no partial-execution path.

---

## Quickstart

```bash
# 1. Install
cd mcp-refund-v0
npm install

# 2. Get Razorpay test credentials
#    - Sign up / log in at https://razorpay.com
#    - Switch the dashboard to Test Mode (top-right toggle)
#    - Settings → API Keys → Generate Test Key
#    - Copy the Key ID (rzp_test_...) and Key Secret

# 3. Configure
cp .env.example .env
# Edit .env — paste RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET
# Leave REFUNDS_ENABLED=true to allow refunds

# 4. Build & run (HTTP mode, for curl/Postman/Railway)
npm run build
npm start
# → [mcp-refund] HTTP listening on :3000

# Or run MCP stdio mode (for Claude Desktop):
npm run start:mcp
```

Dev mode with auto-reload:

```bash
npm run dev        # HTTP
npm run dev:mcp    # MCP stdio
```

> **Note.** V0 only handles refunds against existing test payments. It does
> not create test payments. Use the Razorpay dashboard's test checkout (or a
> hosted Payment Link in Test Mode) to capture a payment first, then take
> the resulting `pay_...` ID and refund it through this API.

---

## Calling the tool from Claude Desktop

Add this to your Claude Desktop MCP config (typically `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "mcp-refund": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-refund-v0/dist/index.js", "--mcp"],
      "env": {
        "RAZORPAY_KEY_ID": "rzp_test_...",
        "RAZORPAY_KEY_SECRET": "...",
        "REFUNDS_ENABLED": "true"
      }
    }
  }
}
```

Restart Claude Desktop. The `issue_refund` tool will appear and Claude can call it directly.

---

## Calling the HTTP endpoint with curl

```bash
# Issue a refund — amount is in paise (₹15.00 = 1500 paise)
curl -X POST http://localhost:3000/issue_refund \
  -H "Content-Type: application/json" \
  -d '{
    "payment_id": "pay_ABC123XYZ",
    "amount": 1500,
    "request_id": "req_2026-05-07_001",
    "reason": "Customer reported duplicate charge"
  }'

# Replay the same request_id — should be blocked as duplicate
curl -X POST http://localhost:3000/issue_refund \
  -H "Content-Type: application/json" \
  -d '{
    "payment_id": "pay_ABC123XYZ",
    "amount": 1500,
    "request_id": "req_2026-05-07_001"
  }'

# View the full audit log
curl http://localhost:3000/logs

# Health check
curl http://localhost:3000/health
```

`amount` is an integer in the smallest currency unit (paise for INR — 100 paise = ₹1). `payment_id` must be a captured Razorpay payment (`pay_...`). `request_id` must be unique across all calls; reusing one returns the original outcome and never re-executes.

---

## The 4 golden rules

These are non-negotiable in every version, including V0:

1. **`request_id` is mandatory.** A refund without a unique idempotency key is rejected before anything else happens. No exceptions for "just this once."
2. **Duplicates are blocked.** If a `request_id` has been seen before, the original outcome is returned and Razorpay is never called again. The agent cannot retry its way into a double refund.
3. **Never execute on error.** Validation, kill-switch, and idempotency checks all run before Razorpay. If any of them — or the Razorpay call itself — fails, the result is logged with `status: "failed"` and an error is returned. There is no half-success state.
4. **Every request is logged.** Successes and failures both append to `logs.json`. Writes are atomic (write to `.tmp`, then rename) so a crash mid-write cannot corrupt the audit trail.

---

## Kill switch

Set `REFUNDS_ENABLED=false` (or unset it) in the environment to disable all refunds globally. Every call returns:

```json
{ "ok": false, "error": { "code": "refunds_disabled", "message": "Refunds disabled by system" } }
```

This is checked **before** validation, before idempotency, before anything else. It is the master off-switch when something is wrong.

---

## What is NOT in V0

V0 is intentionally minimal. The following are explicitly **out of scope**:

- ❌ Creating test payments (use the Razorpay dashboard / Payment Links for that)
- ❌ `cancel_subscription` tool
- ❌ `extend_trial` tool
- ❌ Dashboard / web UI
- ❌ Multi-provider support (no Stripe, no PayPal, no Adyen — Razorpay only)
- ❌ Rollback / un-refund flow
- ❌ Per-agent rate limits, per-customer caps, or spend budgets
- ❌ Database (logs.json is the storage layer)
- ❌ Authentication on the HTTP endpoint (V0 assumes private deployment)

These will land in later versions. Do not ask V0 to do them.

---

## Deploying to Railway

```bash
# Push to GitHub, then on Railway:
# 1. New Project → Deploy from GitHub repo
# 2. Set environment variables: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, REFUNDS_ENABLED=true
# 3. Railway auto-detects Node, runs `npm install && npm run build`, then `npm start`
# 4. Health check at /health is wired up via railway.json
```

`PORT` is set automatically by Railway. `logs.json` is in the repo gitignore — note that on Railway's ephemeral filesystem, **logs persist only until the next deploy**. For production, swap to a real database; that's not V0's problem.

---

## License

MIT

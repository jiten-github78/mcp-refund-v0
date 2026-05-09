# mcp-refund-v0
**Stripe for AI agents — a safety layer for autonomous refunds.**

Status: V0 sandbox-only · MIT License · Built on Anthropic MCP

## Try it in 10 seconds

No setup, no Razorpay keys, no signup. Hit the demo endpoint:

```bash
curl -X POST https://web-production-60b12.up.railway.app/demo/issue_refund \
  -H "Content-Type: application/json" \
  -d '{"payment_id":"pay_TEST","amount":1500,"request_id":"my-first-test","reason":"trying it out"}'
```

You get back a realistic refund response with a `rfnd_demo_*` ID. Hit the same command again — you get the original refund back, not a new one. That's the idempotency check working with zero setup. Browse the demo audit log at https://web-production-60b12.up.railway.app/demo/logs.

Demo endpoints are rate-limited to 30 req/hr per IP and write to a separate audit log so they never touch real refund traffic. Convinced? See the Quickstart below to run it for real with your own Razorpay keys.

## The problem
AI agents in production today can suggest a refund but can't safely execute one. They lack idempotency, rollback, and audit trails. Calling Stripe/Razorpay APIs directly from agents leads to double-refunds, silent failures, and no audit when something goes wrong.

## What this does
- Single MCP/HTTP endpoint that AI agents call to issue refunds
- Built-in idempotency (same request_id never refunds twice)
- Kill switch (disable all refunds with one env var)
- Append-only audit log (probably appears 1-2 times)

  ## Why this exists
AI agents can suggest refunds today. But safely executing financial actions requires:
- Idempotency (so retries don't double-charge)
- Audit logging (so compliance and post-mortems are possible)
- Execution controls (kill switch, approval workflows)
- Rollback-safe flows (so half-completed actions can be undone)

mcp-refund-v0 is a first step toward that infrastructure layer.

## How it fits together
```
AI Agent (Claude / Cursor / custom)
        ↓
mcp-refund-v0  (validation, kill switch, idempotency)
        ↓
Razorpay Sandbox API
        ↓
Append-only audit log (logs.json)
```

## 60-second quickstart
```bash
git clone https://github.com/jiten-github78/mcp-refund-v0
cd mcp-refund-v0
npm install
cp .env.example .env
# Get test keys at razorpay.com → Test Mode → API Keys, paste into .env
npm run dev
```

Then test:
```bash
curl -X POST http://localhost:3000/issue_refund \
  -H "Content-Type: application/json" \
  -d '{"payment_id":"pay_xxx","amount":100,"request_id":"test-001","reason":"first refund"}'
```

## The 4 golden rules
1. request_id is mandatory
2. Duplicates are blocked at our layer (Razorpay never called twice)
3. On error, we never partial-execute
4. Every request is logged

## Sandbox-only by design
Runs ONLY in payment provider sandboxes (Razorpay test mode). Production keys (rzp_live_*) are rejected at startup. Why: refunds touch real money. V0 proves the architecture in a fully isolated test environment.

## What's NOT in V0
- Stripe / Paddle / Adyen support (V1)
- Approval workflows (V2)
- Multi-tenant hosting (V2)
- SOC 2 (when MRR > $50K)

## License
MIT

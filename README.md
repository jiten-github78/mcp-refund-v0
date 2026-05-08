# mcp-refund-v0
**Stripe for AI agents — a safety layer for autonomous refunds.**

Status: V0 sandbox-only · MIT License · Built on Anthropic MCP

## The problem
AI agents in production today can suggest a refund but can't safely execute one. They lack idempotency, rollback, and audit trails. Calling Stripe/Razorpay APIs directly from agents leads to double-refunds, silent failures, and no audit when something goes wrong.

## What this does
- Single MCP/HTTP endpoint that AI agents call to issue refunds
- Built-in idempotency (same request_id never refunds twice)
- Kill switch (disable all refunds with one env var)
- Tamper-proof audit log (every action recorded)

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

## Live demo (proof of life only)

The deployment is live at: https://web-production-60b12.up.railway.app

Test it:
```bash
curl https://web-production-60b12.up.railway.app/health
# Returns: {"status":"ok"}
```

This URL is for verifying the project compiles and runs in production. Do NOT use the /issue_refund endpoint here for your own tests — it uses my sandbox keys and writes to my audit log.

For real testing, clone the repo and use your own Razorpay test keys (see Quickstart above).

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

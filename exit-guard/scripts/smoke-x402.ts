/**
 * scripts/smoke-x402.ts
 *
 * Proves the paid path is actually gated and advertises a challenge agents can pay.
 * Does NOT settle real USDC — that needs a funded agentic wallet signing EIP-3009.
 *
 * Usage (service running on PORT, .env loaded by dotenv in config via the server):
 *   npm run dev          # other terminal
 *   npm run smoke:x402
 */
import "dotenv/config";

const base = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

function fail(msg: string): never {
  console.error(`FAILED — ${msg}`);
  process.exit(1);
}

function ok(msg: string) {
  console.log(`OK — ${msg}`);
}

async function main() {
  console.log("Exit Guard — x402 challenge smoke");
  console.log(`Target ${base}`);

  const healthRes = await fetch(`${base}/health`);
  const health = (await healthRes.json()) as {
    ok?: boolean;
    x402?: {
      enabled?: boolean;
      active?: boolean;
      payTo?: string;
      priceAtomic?: string;
      facilitator?: string;
    };
  };
  if (!health.x402) fail("/health missing x402 block — restart server with updated code");
  if (!health.x402.enabled) fail("x402 enabled=false in .env — set X402_ENABLED=true");
  if (!health.x402.active) fail(`x402 not active (payTo invalid?). got ${JSON.stringify(health.x402)}`);
  if (!health.x402.priceAtomic || health.x402.priceAtomic === "0.02") {
    fail(`priceAtomic should be USDC atomic units, got ${health.x402.priceAtomic}`);
  }
  ok(
    `x402 active payTo=${health.x402.payTo} priceAtomic=${health.x402.priceAtomic} via ${health.x402.facilitator}`
  );

  // Register a throwaway position (free). Uses live Base RPC.
  const reg = await fetch(`${base}/v1/positions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: process.env.KEEPERHUB_WALLET_ADDRESS,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      stopPrice: 0.0001,
      feeTier: 500,
    }),
  });
  const regBody = await reg.text();
  if (!reg.ok) fail(`register position failed ${reg.status}: ${regBody}`);
  const positionId = (JSON.parse(regBody) as { position: { id: string } }).position.id;
  ok(`registered position ${positionId}`);

  // Free evaluate — must NOT 402
  const ev = await fetch(`${base}/v1/positions/${positionId}/evaluate`, { method: "POST" });
  if (ev.status === 402) fail("evaluate returned 402 — evaluate must stay free");
  if (!ev.ok) fail(`evaluate failed ${ev.status}: ${await ev.text()}`);
  ok(`evaluate is free (status ${ev.status})`);

  // Paid exit without header — must 402 with agent-readable challenge
  const exitRes = await fetch(`${base}/v1/positions/${positionId}/exit`, { method: "POST" });
  const exitBody = await exitRes.json();
  if (exitRes.status !== 402) {
    fail(`exit without payment expected 402, got ${exitRes.status}: ${JSON.stringify(exitBody)}`);
  }
  const prHeader = exitRes.headers.get("PAYMENT-REQUIRED") ?? exitRes.headers.get("payment-required");
  if (!prHeader) fail("missing PAYMENT-REQUIRED header (KeeperHub / x402 v2 agents need this)");
  if (!Array.isArray(exitBody.accepts) || !exitBody.accepts[0]) {
    fail(`402 body missing accepts[]: ${JSON.stringify(exitBody)}`);
  }
  const accept = exitBody.accepts[0] as {
    network: string;
    asset: string;
    payTo: string;
    maxAmountRequired: string;
    scheme: string;
  };
  if (accept.network !== "eip155:8453") fail(`expected Base mainnet network, got ${accept.network}`);
  if (accept.asset?.toLowerCase() !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
    fail(`expected Base USDC asset, got ${accept.asset}`);
  }
  if (!/^\d+$/.test(accept.maxAmountRequired)) {
    fail(`maxAmountRequired must be atomic integer string, got ${accept.maxAmountRequired}`);
  }
  ok(
    `402 challenge: scheme=${accept.scheme} amount=${accept.maxAmountRequired} → ${accept.payTo}`
  );
  ok("PAYMENT-REQUIRED header present");

  // Garbage payment header — still 402, never executes
  const bad = await fetch(`${base}/v1/positions/${positionId}/exit`, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": "not-a-real-payment" },
  });
  if (bad.status !== 402) fail(`bad payment expected 402, got ${bad.status}`);
  ok("invalid PAYMENT-SIGNATURE rejected with 402");

  console.log(`
All x402 challenge checks passed.

To complete a REAL paid call (moves USDC):
  1. Install KeeperHub agentic wallet:
       npx -p @keeperhub/wallet keeperhub-wallet skill install
       npx -p @keeperhub/wallet keeperhub-wallet add
  2. Fund the agent wallet with a little Base USDC
  3. Have the agent POST /v1/positions/<id>/exit — wallet intercepts 402, signs, retries
  4. Watch server logs for: [x402] settled call fee tx=0x...

OR list Exit Guard as a KeeperHub Marketplace workflow so agents discover it via
search_workflows / call_workflow and pay through KeeperHub's own x402 rails
(see https://docs.keeperhub.com/workflows/marketplace).
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

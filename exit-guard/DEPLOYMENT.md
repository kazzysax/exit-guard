# Deployment guide

Everything up to this point — the contract, the service, 39 tests — was built and
verified inside a sandboxed environment with no KeeperHub key, no wallet, and a
network allowlist that blocks Base RPC entirely. That's why `smoke-live.ts` exists:
it's the script that turns "the code is correct" into "the system works," and it
tells you exactly which step failed if something doesn't.

Run each numbered section below in order. Do not skip ahead — later steps assume
earlier ones succeeded.

---

## 0. Prerequisites

- Node 20+
- A KeeperHub account with an organization and an API key (`kh_...`)
- A wallet with a small amount of ETH on Base, for the one-time contract deploy
- This repo, unzipped

```bash
npm install
```

Expected: `added 129 packages` (or similar), no errors.

---

## 1. Compile the contract

```bash
npm run compile
```

Expected output:
```
COMPILED OK. bytecode bytes: 4115 | abi entries: 27
```

This writes `artifacts/ExitGuardExecutor.json` (ABI + bytecode). It's gitignored —
regenerate it any time with this command; don't hand-edit it.

---

## 2. Run the test suite

```bash
npm test
```

Expected: `ALL SMOKE TESTS PASSED`, `ALL KEEPERHUB CLIENT TESTS PASSED`,
`ALL ENGINE TESTS PASSED`, `ALL SERVER TESTS PASSED` — 39 checks, no network calls,
no credentials needed. This is the "the logic is correct" proof. It does not prove
the system works live — that's what the rest of this document is for.

---

## 3. Connect KeeperHub and get your wallet address

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

Then run `/mcp` in Claude Code and complete the OAuth flow in the browser.

Call `get_wallet_integration`. Copy the returned address — this is your
`KEEPERHUB_WALLET_ADDRESS`. It is the only address the deployed contract will ever
let call `exit()`.

Also grab an API key from **app.keeperhub.com → Settings → API Keys → Organisation
tab**. This is your `KEEPERHUB_API_KEY`.

---

## 4. Fill in .env

```bash
cp .env.example .env
```

At minimum, fill in:

```
KEEPERHUB_API_KEY=kh_...
KEEPERHUB_WALLET_ADDRESS=0x...
```

Leave `EXECUTOR_ADDRESS` blank for now — you don't have it yet.

---

## 5. Deploy the executor contract

```bash
DEPLOYER_PRIVATE_KEY=0x... npm run deploy
```

`DEPLOYER_PRIVATE_KEY` is a throwaway key you control, funded with a few dollars of
ETH on Base. It is used once, for the deploy transaction and the `setKeeper` call
that follows it. It is **not** the key that executes exits — that's the KeeperHub
Turnkey wallet, which never leaves KeeperHub's enclave.

Expected output ends with:
```
ExitGuardExecutor deployed at 0x...
Authorising KeeperHub wallet 0x... as keeper...
Keeper set. tx: 0x...

Add to .env:
  EXECUTOR_ADDRESS=0x...
```

**This deploy transaction is your first real, bankable onchain transaction.** Copy
its hash — it satisfies the submission requirement independently of everything
after this point.

Paste `EXECUTOR_ADDRESS` into `.env`.

---

## 6. Run the live smoke test

```bash
npm run smoke:live
```

This is the script that replaces guessing with knowing. It runs six real,
uncached checks in order and stops at the first failure with a specific message
telling you what to fix:

| # | Checks | If it fails here |
|---|---|---|
| 0 | `.env` has the required keys | You skipped step 4 |
| 1 | Base RPC responds with chain id 8453 | Check `BASE_RPC_URL` |
| 2 | SwapRouter02, QuoterV2, factory, WETH, USDC all have code at their addresses | The hardcoded Base addresses in `src/config.ts` are stale — re-verify them |
| 3 | KeeperHub API key is valid, `get_spending_limits` responds | Bad key, or the REST path in `src/keeperhub.ts` doesn't match KeeperHub's actual API — this is the step most likely to catch that |
| 4 | The executor contract has code at `EXECUTOR_ADDRESS` | Deploy didn't complete, or wrong chain/RPC |
| 5 | `KEEPERHUB_WALLET_ADDRESS` is an authorised keeper on the contract | Re-run `npm run deploy`, or call `setKeeper` manually |
| 6 | KeeperHub can execute a real read-only call through the contract | Confirms the exact request shape KeeperHub expects — fix `src/keeperhub.ts` against the actual error text |

Expected final line:
```
All live checks passed. The KeeperHub <-> Base <-> executor path is confirmed end to end.
```

If you stop here with all six passing, you have a genuinely working system and a
second real transaction (step 6's read call, if KeeperHub logs it as an execution).

---

## 7. Onboard a position (from the trading agent's own wallet)

Two transactions, from the wallet actually holding the position — not from
`DEPLOYER_PRIVATE_KEY`:

```solidity
executor.setEnrolled(true);
token.approve(executorAddress, positionSize);   // exact size, never max
```

---

## 8. Start the service and register a position

```bash
npm run dev
```

```bash
curl -X POST http://localhost:8787/v1/positions \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "0xYourAgentWallet",
    "token": "0xTokenAddress",
    "stopPrice": 0.001,
    "feeTier": 10000
  }'
```

Response includes the computed `stopSqrtPriceX96`/`targetSqrtPriceX96` and a
`readiness` block telling you if step 7 is complete.

---

## 9. Evaluate, then exit

```bash
curl -X POST http://localhost:8787/v1/positions/<id>/evaluate
```

Free, no payment header needed. Confirm it reports `hold` if your stop is below
current price, or `exit` if you deliberately set it above.

```bash
curl -X POST http://localhost:8787/v1/positions/<id>/exit
```

If `X402_ENABLED=false` (the default), this runs immediately — no payment header
required. **This is your third real, bankable transaction**: `simulate: true`
first, then the real `exit()` call through KeeperHub, landing a Uniswap swap.

---

## Troubleshooting

**Step 3 (KeeperHub) fails with a 404 or unexpected error shape.**
Expected — `src/keeperhub.ts` was written against the MCP tool docs, not KeeperHub's
REST API reference. Run `list_action_schemas` or check `docs.keeperhub.com/api/direct-execution`
for the real endpoint paths and request bodies, then correct `keeperhub.ts` to match.
This is the single most likely thing to need a fix.

**Step 2 (Base addresses) fails.**
Uniswap or Base occasionally migrates router versions. Re-verify
`SwapRouter02` / `QuoterV2` addresses against Uniswap's official Base deployment
list before assuming the code is wrong.

**Step 5 (keeper authorization) fails after a successful deploy.**
`deploy.ts` only calls `setKeeper` if `KEEPERHUB_WALLET_ADDRESS` differs from the
deployer address. If they're the same address, the deployer is already the keeper
by virtue of being the constructor's `msg.sender` — this is expected, not a bug.

**`exit()` reverts even after simulation passed.**
Simulation and broadcast happen at different block heights. A price move between
the two — or someone else moving the pool — can flip a marginal simulate-pass into
a real revert. This is not a bug in the contract; it's exactly the risk the
guarded tier's private routing and retry logic exist to reduce.

# Exit Guard

The exit layer for onchain agents. Base + Uniswap V3, executing through KeeperHub.

Every trading agent has an entry. Almost none has a safe exit. And the moment you most
need a sell to land — a crash, a gas spike, a rug — is exactly when a hot-key transaction
fails: stuck nonce, underpriced gas, public mempool, sandwiched.

Exit Guard is a service agents call. Give it a position and a rule; it reads live pool
price, simulates before signing, and lands the swap through KeeperHub with managed
retries, smart gas, and private routing. Proceeds return to the caller in the **same
transaction** — we never hold funds at rest.

---

## Architecture

```
Trading agent            Exit Guard service              KeeperHub              Base
─────────────            ──────────────────              ─────────              ────
  decides         ──▶    POST /v1/positions/:id/exit
                          │
                          ├─ evaluate()      ─────────────────────────────▶  slot0, balanceOf,
                          │                                                   allowance, quote
                          ├─ router.decideTier()
                          │    fast │ guarded
                          │
                          ├─ simulate: true  ──────────▶  execute_contract_call
                          │                                (wouldRevert?)
                          │
                          └─ execute         ──────────▶  execute_contract_call ──▶ ExitGuardExecutor
                                                            + idempotency_key         .exit()
                                                                                       │
                                                                                       ├─ transferFrom(owner)
                                                                                       ├─ exactInputSingle
                                                                                       ├─ fee → treasury
                                                                                       └─ remainder → owner
```

The executor contract is what makes this non-custodial. Pull, swap, split, and return
happen in one call and revert as a unit. Between the agent's wallet and the agent's
wallet, the position exists only inside a single transaction.

## Components

| Path | What it does |
|---|---|
| `contracts/ExitGuardExecutor.sol` | Atomic pull-swap-split-return. Keeper-gated, owner opt-in, 1% fee ceiling, reentrancy guard. |
| `src/priceMath.ts` | sqrtPriceX96 conversion, slippage floors, and the token-ordering inversion. |
| `src/uniswap.ts` | Pool state, token metadata, quotes, readiness checks. |
| `src/keeperhub.ts` | REST client. Idempotency keys on writes, cold-start retry, bounded polling. |
| `src/router.ts` | Tier scoring with weighted rules and an explanation per decision. |
| `src/engine.ts` | Evaluate → simulate → route → execute → record. |
| `src/x402.ts` | 402 challenge, facilitator verify, settle-on-success only. |
| `src/server.ts` | HTTP API. Free evaluate, paid exit. |
| `src/store.ts` | Position registry and append-only receipts. |

## Setup

```bash
npm install
cp .env.example .env          # fill in KEEPERHUB_API_KEY and KEEPERHUB_WALLET_ADDRESS
npm run compile               # solc → artifacts/ExitGuardExecutor.json
DEPLOYER_PRIVATE_KEY=0x... npm run deploy
# paste EXECUTOR_ADDRESS into .env
npm run dev
```

Get `KEEPERHUB_WALLET_ADDRESS` from `get_wallet_integration` over the KeeperHub MCP
server. That address is set as the contract's keeper; it is the only address permitted
to call `exit()`.

### Agent onboarding — two transactions, once

```solidity
executor.setEnrolled(true);                  // explicit opt-in
token.approve(executorAddress, positionSize) // exact size, never max
```

Either can be revoked unilaterally at any time. An allowance without enrolment does
nothing — authorisation is deliberately two-factor.

## API

| Endpoint | Cost | Purpose |
|---|---|---|
| `POST /v1/positions` | free | Register a position, get computed thresholds back |
| `POST /v1/positions/:id/evaluate` | **free** | Check the rule. Never charged. |
| `POST /v1/positions/:id/exit` | x402 | Evaluate and execute if breached |
| `GET /v1/receipts` | free | Audit trail |
| `GET /health` | free | Liveness + KeeperHub spending limits |

## Pricing

A nominal x402 call fee settles up front on the paid endpoint. The real fee is a few
bps of proceeds, taken **inside** the executor contract — which means it cannot be
collected unless the swap actually lands. Evaluations are free, so an agent is never
charged for a check that does not trade.

## Failure handling

| Failure | Handling |
|---|---|
| Honeypot / revert | Caught by `simulate: true` before anything is signed |
| Retry after timeout | `idempotency_key` derived from position + price, so a replay cannot double-sell |
| KeeperHub cold start | Retried with the documented `retryAfterSeconds`; connection errors are **not** retried |
| Allowance revoked | Detected in readiness check, returns a structured reason, not a raw revert |
| Gas spike / sandwich | Router escalates to the guarded tier and logs why |
| Hung execution | Bounded polling with a hard ceiling — never waits forever on an exit |

## Tests

```bash
npm install
npm test
```

39 assertions across four suites, all against mocks — no network, no KeeperHub key needed:

| Suite | Covers |
|---|---|
| `test/smoke.ts` | Price round-trips, mixed-decimal pairs, the token-ordering inversion (both directions), router scoring |
| `test/keeperhub.test.ts` | Cold-start retry vs hard-stop on real errors, idempotency key propagation, bounded polling that never hangs |
| `test/engine.test.ts` | All four exit outcomes — hold, blocked, simulation-caught-revert, full success — verified against a fake chain and fake KeeperHub via the `deps` injection seam in `engine.ts` |
| `test/server.test.ts` | HTTP boundary: input validation, the free/paid split under x402, 404 vs 402 vs 409 |

The `deps` object in `engine.ts` is what makes this possible without a real RPC or API
key: production code calls `deps.readPoolState` etc., which default to the real
implementations, and tests override individual entries. Nothing about the production
code path changes — the seam exists so the decision logic (hold vs exit vs blocked,
simulate-before-sign, fee computed from actual not quoted output) is provably correct
independent of any live dependency.

One real bug this caught: the first version of the token1 price-inversion logic swapped
the stop/target slots but forgot to reciprocate the price — silently turning a stop-loss
into a take-profit for any position where the traded token is token1 in its pool. Fixed,
with four assertions now pinned to that exact branch.


## Known limitations

- **In-memory store.** Positions and receipts do not survive a restart. The `store`
  interface is narrow so Postgres is a one-file swap.
- **Single chain.** `CHAINS` is a map and `chainId` is threaded through, but only Base
  is tested. Adding a chain is config; claiming it works without testing is not.
- **The x402 middleware is hand-rolled** for legibility and dependency-light review.
  Production should use the official package.
- **Executor is unaudited.** It is deliberately small — one external state-changing
  function, no upgradeability, no admin path to user funds beyond `rescue` on stranded
  balances — but small is not the same as audited.
- **No Safe module.** Enrolment plus allowance is good; a Safe module with scoped
  permissions is better and is the intended next step.

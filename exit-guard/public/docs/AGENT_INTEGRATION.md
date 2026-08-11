# Exit Guard — agent integration

Machine-oriented guide for adding the Exit Guard terminal to an autonomous trading agent.

## Service

| Key | Value |
|-----|--------|
| Base URL | `https://exit-guard.onrender.com` |
| Chain | Base mainnet (`8453`) |
| Protocol fee (API) | x402 exact USDC on `POST .../exit` only |
| Evaluate | free |
| Execution | KeeperHub `execute_contract_call` → `ExitGuardExecutor.exit` |

Discover live config:

```http
GET https://exit-guard.onrender.com/health
GET https://exit-guard.onrender.com/ping
```

`/health` returns `executor`, `x402.payTo`, `x402.priceAtomic`, facilitator, and free vs paid routes.

## Prerequisites

1. **Owner wallet** (holds the ERC-20 position) on Base.
2. Onchain (once):
   - `executor.setEnrolled(true)`
   - `token.approve(executor, amountIn)`
3. **Payer wallet** with Base USDC for x402 (KeeperHub agentic wallet recommended).

```bash
npx -p @keeperhub/wallet keeperhub-wallet skill install
npx -p @keeperhub/wallet keeperhub-wallet add
```

## Tool surface (map these into your agent tools)

### `exit_guard_register`

- `POST /v1/positions`
- Body: `{ owner, token, stopPrice, feeTier?, targetPrice?, slippageBps?, feeBps? }`
- Returns: `position.id`, pool price, `readiness`

### `exit_guard_evaluate`

- `POST /v1/positions/:id/evaluate`
- Free. Returns `{ action: "hold"|"exit"|"blocked", reason, ... }`

### `exit_guard_exit`

- `POST /v1/positions/:id/exit`
- May return **402** with payment requirements. Sign x402 (`PAYMENT-SIGNATURE` / `X-PAYMENT`) and retry.
- On success: receipt with `outcome` and optional tx hash.

### `exit_guard_receipts`

- `GET /v1/receipts?positionId=`

## Recommended agent policy

```
if readiness not ready → ask user to enrol/approve; do not exit
if evaluate.action == hold → do nothing (no payment)
if evaluate.action == blocked → surface reason
if evaluate.action == exit → call exit; on 402 pay with agentic wallet and retry once
never send max uint256 allowance unless user explicitly requests it
```

## Example curl

```bash
HOST=https://exit-guard.onrender.com

curl -s $HOST/health | jq .

curl -s -X POST $HOST/v1/positions \
  -H 'Content-Type: application/json' \
  -d '{"owner":"0x...","token":"0x...","stopPrice":0.001,"feeTier":10000}'

curl -s -X POST $HOST/v1/positions/<id>/evaluate

# May 402 — agentic wallet handles payment header then retries
curl -s -X POST $HOST/v1/positions/<id>/exit
```

## Claude Code / Cursor / OpenCode

1. Install KeeperHub agentic wallet skill (x402 autopay).
2. Optionally add KeeperHub MCP for onchain enrol/approve if the agent should prepare the wallet.
3. Add a skill or custom tool that calls the Exit Guard HTTP API with base URL above.
4. Paste the “Drop-in agent instructions” block from `docs/index.html` into the agent system prompt or skill.

## Errors to handle

| HTTP | Meaning |
|------|---------|
| 400 | Bad input (address, stopPrice, feeBps > 1%) |
| 402 | Payment required for `/exit` |
| 404 | Unknown position id |
| 409 | Position already closed |
| 502 | Exit failed after payment gate (e.g. simulation revert) |
| 503 | KeeperHub / dependency down |

## Repo

https://github.com/kazzysax/exit-guard

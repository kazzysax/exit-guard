# Exit Guard

**The exit layer for onchain trading agents** — Base + Uniswap V3, execution through [KeeperHub](https://docs.keeperhub.com), pay-per-use via [x402](https://docs.x402.org) (Base USDC).

Agents register a position + stop/target rule. Exit Guard reads live pool price, simulates before signing, and lands the swap through KeeperHub in one atomic transaction. Proceeds return to the agent wallet in the same tx — **non-custodial**.

| | |
|--|--|
| Service | `exit-guard/` (Node / Express API) |
| Landing page | `site/` |
| Chain | Base (`8453`) |
| Execution | KeeperHub org wallet (keeper-gated contract) |
| API fee | x402 USDC on `POST /v1/positions/:id/exit` |
| Evaluate | **Free** |

## Public API

| Method | Path | Cost | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | free | Liveness + x402 status |
| `POST` | `/v1/positions` | free | Register position + readiness |
| `GET` | `/v1/positions/:id` | free | Position + receipts |
| `POST` | `/v1/positions/:id/evaluate` | free | Check stop/target (no trade) |
| `POST` | `/v1/positions/:id/exit` | **x402** | Simulate → execute exit |
| `GET` | `/v1/receipts` | free | Audit trail |

### Agent onboarding (once per owner)

On Base, against the deployed `ExitGuardExecutor`:

```text
1. setEnrolled(true)
2. token.approve(executor, positionSize)   // exact size preferred
```

Then call the API with that `owner` address.

### Paying for exits

Paid agents use an [x402](https://docs.x402.org) / [KeeperHub agentic wallet](https://docs.keeperhub.com/agent/agentic-wallet):

```bash
npx -p @keeperhub/wallet keeperhub-wallet skill install
npx -p @keeperhub/wallet keeperhub-wallet add
# fund the printed address with Base USDC
```

`POST .../exit` returns **HTTP 402** with payment requirements; the wallet signs and retries. Evaluate stays free.

## Repo layout

```
exit-guard/          # API service (deploy this)
  src/               # engine, server, x402, KeeperHub client
  contracts/         # ExitGuardExecutor.sol
  scripts/           # deploy + live smoke
  test/              # offline suites
site/                # static marketing page
```

## Local development

```bash
cd exit-guard
npm install
cp .env.example .env   # fill KEEPERHUB_* and EXECUTOR_ADDRESS
npm test
npm run dev            # http://localhost:8787
```

See [`exit-guard/DEPLOYMENT.md`](exit-guard/DEPLOYMENT.md) for contract deploy + live smoke.

## Deploy (Railway)

1. Connect this GitHub repo to Railway (or `railway up` from `exit-guard/`).
2. Set **root directory** to `exit-guard`.
3. Configure variables (see `exit-guard/.env.example`):

   - `KEEPERHUB_API_KEY`
   - `KEEPERHUB_WALLET_ADDRESS`
   - `EXECUTOR_ADDRESS`
   - `BASE_RPC_URL` (prefer a dedicated RPC, not the public rate-limited endpoint)
   - `X402_ENABLED=true`
   - `X402_PAY_TO` (your USDC receiving address)
   - `X402_CALL_PRICE_USDC=0.02`
   - `X402_FACILITATOR_URL=https://facilitator.payai.network`

4. Generate a public domain. Agents call `https://<your-domain>/v1/...`.

## Security notes

- Never commit `.env` (gitignored).
- The executor is **unaudited**; use small sizes in production.
- In-memory store: positions reset on redeploy (swap to Postgres for HA).
- x402 settles only after a successful HTTP response.

## License

ISC

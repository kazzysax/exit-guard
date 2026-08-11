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

## Live public API

| | |
|--|--|
| **Site + API (use this)** | https://exit-guard.onrender.com |
| **UI** | https://exit-guard.onrender.com/ |
| **Agent docs** | https://exit-guard.onrender.com/docs/ |
| **Health** | https://exit-guard.onrender.com/health |
| **Alt static host** | https://exit-guard-site.onrender.com |
| **Host** | Render (UI is served from the API service root) |

```bash
curl https://exit-guard.onrender.com/health
```

> Free Render services can spin down when idle. This deploy keeps warm with:
> - `GET /ping` — cheap liveness probe (no KeeperHub call)  
> - **In-process** keep-alive every **60s** (`KEEPALIVE_URL` / `KEEPALIVE_INTERVAL_MS`)  
> - **GitHub Action** [`.github/workflows/keepalive.yml`](.github/workflows/keepalive.yml) — external **1-minute** pings (Render free cron requires a paid plan)

## Deploy (Render)

Blueprint: [`render.yaml`](render.yaml) at repo root.

1. Connect https://github.com/kazzysax/exit-guard in the Render dashboard, or use the CLI.
2. Root directory: `exit-guard` · build: `npm ci && npm run build` · start: `npm start`.
3. Secrets (set in Render env, never commit):

   - `KEEPERHUB_API_KEY`
   - `KEEPERHUB_WALLET_ADDRESS`
   - `EXECUTOR_ADDRESS`
   - `X402_PAY_TO`
   - `BASE_RPC_URL` (prefer a dedicated RPC)

4. Agents call `https://exit-guard.onrender.com/v1/...`.

## Security notes

- Never commit `.env` (gitignored).
- The executor is **unaudited**; use small sizes in production.
- In-memory store: positions reset on redeploy (swap to Postgres for HA).
- x402 settles only after a successful HTTP response.

## License

[MIT](LICENSE) © 2026 kazzysax

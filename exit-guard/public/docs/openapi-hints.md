# Exit Guard — endpoint summary for tool schemas

Base: `https://exit-guard.onrender.com`

```
GET  /ping
GET  /health
POST /v1/positions
GET  /v1/positions/{id}
POST /v1/positions/{id}/evaluate
POST /v1/positions/{id}/exit          # x402 paid
GET  /v1/receipts?positionId={id}
```

## POST /v1/positions

```json
{
  "owner": "0x...",
  "token": "0x...",
  "stopPrice": 0.001,
  "feeTier": 10000,
  "targetPrice": null,
  "slippageBps": 300,
  "feeBps": 30
}
```

## POST /v1/positions/{id}/evaluate

Empty body. Free.

## POST /v1/positions/{id}/exit

Empty body. On 402, respond with header:

- `PAYMENT-SIGNATURE: <base64 or json payment payload>`
- or legacy `X-PAYMENT: ...`

Payment network: `eip155:8453` · asset: Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

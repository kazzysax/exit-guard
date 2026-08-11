import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  // KeeperHub
  keeperhubBaseUrl: process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com",
  keeperhubApiKey: required("KEEPERHUB_API_KEY"),
  keeperhubWallet: required("KEEPERHUB_WALLET_ADDRESS").toLowerCase(),
  exitWorkflowId: process.env.EXIT_WORKFLOW_ID ?? "",

  // Chain
  rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  executorAddress: (process.env.EXECUTOR_ADDRESS ?? "").toLowerCase(),

  // Economics
  defaultFeeBps: Number(process.env.DEFAULT_FEE_BPS ?? 30),
  defaultSlippageBps: Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 300),

  // x402 — agents pay Base USDC per /exit call (evaluate stays free).
  // Default payTo = KeeperHub org wallet so payouts land where you already operate.
  // Default facilitator = PayAI (supports Base mainnet free tier). x402.org is testnet-only.
  x402PayTo: (process.env.X402_PAY_TO ?? process.env.KEEPERHUB_WALLET_ADDRESS ?? "").trim(),
  x402CallPriceUsdc: process.env.X402_CALL_PRICE_USDC ?? "0.02",
  x402FacilitatorUrl:
    process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network",
  x402Enabled: process.env.X402_ENABLED !== "false",

  // Router thresholds
  router: {
    baseFeeGweiCeiling: Number(process.env.ROUTER_BASEFEE_GWEI ?? 0.05),
    slippageAlertBps: Number(process.env.ROUTER_SLIPPAGE_ALERT_BPS ?? 150),
    consecutiveFailureCeiling: Number(process.env.ROUTER_FAILURE_CEILING ?? 2),
    largeNotionalWeth: process.env.ROUTER_LARGE_NOTIONAL_WETH ?? "0.25",
  },
} as const;

export const BASE = {
  chainId: 8453,
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
} as const;

/**
 * Chain config is a map, not a hardcode. Only Base is tested; the shape is here
 * so adding a chain is config rather than a refactor.
 */
export const CHAINS: Record<number, typeof BASE> = {
  8453: BASE,
};

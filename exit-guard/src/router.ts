import { config } from "./config.js";
import { currentBaseFeeGwei } from "./uniswap.js";

/**
 * Execution router.
 *
 * KeeperHub is not a fallback. It is the reliability tier. The router decides
 * which tier a given exit deserves, and — critically — logs WHY. An unexplained
 * routing decision is indistinguishable from a coin flip to anyone auditing it.
 */

export type Tier = "fast" | "guarded";

export interface RouterSignals {
  baseFeeGwei: number;
  lastRealisedSlippageBps: number;
  consecutiveFailures: number;
  notionalWeth: number;
  poolLiquidity: bigint;
  positionShareOfLiquidityBps: number;
}

export interface RouterDecision {
  tier: Tier;
  score: number;
  reasons: string[];
  signals: RouterSignals;
  decidedAt: string;
}

interface Rule {
  name: string;
  weight: number;
  test: (s: RouterSignals) => boolean;
  explain: (s: RouterSignals) => string;
}

const RULES: Rule[] = [
  {
    name: "gas_spike",
    weight: 3,
    test: (s) => s.baseFeeGwei > config.router.baseFeeGweiCeiling,
    explain: (s) =>
      `base fee ${s.baseFeeGwei.toFixed(4)} gwei exceeds ceiling ${config.router.baseFeeGweiCeiling}`,
  },
  {
    name: "sandwich_fingerprint",
    weight: 4,
    test: (s) => s.lastRealisedSlippageBps > config.router.slippageAlertBps,
    explain: (s) =>
      `previous exit realised ${s.lastRealisedSlippageBps} bps below quote — consistent with extraction`,
  },
  {
    name: "recent_failures",
    weight: 4,
    test: (s) => s.consecutiveFailures >= config.router.consecutiveFailureCeiling,
    explain: (s) => `${s.consecutiveFailures} consecutive failed or stuck executions`,
  },
  {
    name: "large_notional",
    weight: 2,
    test: (s) => s.notionalWeth > Number(config.router.largeNotionalWeth),
    explain: (s) =>
      `notional ${s.notionalWeth.toFixed(4)} WETH above ${config.router.largeNotionalWeth} — extraction scales with size`,
  },
  {
    name: "thin_liquidity",
    weight: 3,
    test: (s) => s.positionShareOfLiquidityBps > 100,
    explain: (s) =>
      `position is ${s.positionShareOfLiquidityBps} bps of pool liquidity — price impact risk`,
  },
];

const ESCALATION_THRESHOLD = 3;

export function decideTier(signals: RouterSignals): RouterDecision {
  const reasons: string[] = [];
  let score = 0;

  for (const rule of RULES) {
    if (rule.test(signals)) {
      score += rule.weight;
      reasons.push(`${rule.name}: ${rule.explain(signals)}`);
    }
  }

  const tier: Tier = score >= ESCALATION_THRESHOLD ? "guarded" : "fast";
  if (reasons.length === 0) reasons.push("all signals nominal");

  return { tier, score, reasons, signals, decidedAt: new Date().toISOString() };
}

export async function gatherSignals(params: {
  notionalWeth: number;
  poolLiquidity: bigint;
  positionShareOfLiquidityBps: number;
  lastRealisedSlippageBps: number;
  consecutiveFailures: number;
}): Promise<RouterSignals> {
  const baseFeeGwei = await currentBaseFeeGwei();
  return { baseFeeGwei, ...params };
}

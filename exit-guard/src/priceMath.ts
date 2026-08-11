/**
 * Uniswap V3 price math.
 *
 * A pool stores price as sqrtPriceX96 = sqrt(token1/token0) * 2^96, in RAW units.
 * Agents think in human prices. This module is the translation layer, and it is
 * the single most error-prone part of the system — a wrong threshold means an
 * exit that fires instantly or never fires at all.
 */

const Q96 = 2n ** 96n;

/** Integer square root via Newton's method. Exact for perfect squares, floor otherwise. */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrt of negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * Convert a human-readable price into a sqrtPriceX96 threshold.
 *
 * @param humanPrice  How many token1 per 1 token0, in human units.
 * @param decimals0   Decimals of token0.
 * @param decimals1   Decimals of token1.
 */
export function humanPriceToSqrtPriceX96(
  humanPrice: number,
  decimals0: number,
  decimals1: number
): bigint {
  if (!(humanPrice > 0) || !Number.isFinite(humanPrice)) {
    throw new Error("humanPrice must be a positive finite number");
  }

  // Scale to preserve precision through the integer conversion.
  const PRECISION = 10n ** 18n;
  const scaled = BigInt(Math.round(humanPrice * 1e18));

  // rawPrice = humanPrice * 10^decimals1 / 10^decimals0
  const numerator = scaled * 10n ** BigInt(decimals1);
  const denominator = PRECISION * 10n ** BigInt(decimals0);

  // sqrtPriceX96 = sqrt(rawPrice) * 2^96
  //             = sqrt(numerator * 2^192 / denominator)
  const inner = (numerator * Q96 * Q96) / denominator;
  return sqrtBigInt(inner);
}

/** Inverse: what human price does this pool state represent? */
export function sqrtPriceX96ToHumanPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): number {
  const PRECISION = 10n ** 18n;
  const rawPriceScaled =
    (sqrtPriceX96 * sqrtPriceX96 * PRECISION * 10n ** BigInt(decimals0)) /
    (Q96 * Q96 * 10n ** BigInt(decimals1));
  return Number(rawPriceScaled) / 1e18;
}

/**
 * Build the stop and target thresholds for a position, handling token ordering.
 *
 * If the position token is token1, price moves INVERSELY to sqrtPriceX96 —
 * a falling token price means a RISING sqrtPriceX96. Getting this backwards is
 * the classic bug: your stop-loss becomes a take-profit.
 */
export function buildThresholds(params: {
  positionTokenIsToken0: boolean;
  stopHumanPrice: number;
  targetHumanPrice?: number;
  decimals0: number;
  decimals1: number;
}): { stopSqrtPriceX96: bigint; targetSqrtPriceX96: bigint; inverted: boolean } {
  const { positionTokenIsToken0, stopHumanPrice, targetHumanPrice, decimals0, decimals1 } = params;

  const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
  const MIN_SQRT = 4295128739n;

  const stopRaw = humanPriceToSqrtPriceX96(stopHumanPrice, decimals0, decimals1);
  const targetRaw =
    targetHumanPrice !== undefined
      ? humanPriceToSqrtPriceX96(targetHumanPrice, decimals0, decimals1)
      : undefined;

  if (positionTokenIsToken0) {
    return {
      stopSqrtPriceX96: stopRaw,
      targetSqrtPriceX96: targetRaw ?? MAX_SQRT,
      inverted: false,
    };
  }

  // Position token is token1.
  //
  // The agent quotes prices for THEIR token, which is 1/P where P is the pool price.
  // A stop at price s means: exit when 1/P <= s, i.e. when P >= 1/s.
  // So the agent's stop lands in the UPPER threshold, and against a reciprocal price.
  // Swapping the slots without reciprocating the price silently turns a stop-loss
  // into a take-profit — which is why this branch has its own test.
  const upper = humanPriceToSqrtPriceX96(1 / stopHumanPrice, decimals0, decimals1);
  const lower =
    targetHumanPrice !== undefined
      ? humanPriceToSqrtPriceX96(1 / targetHumanPrice, decimals0, decimals1)
      : MIN_SQRT;

  return {
    stopSqrtPriceX96: lower,
    targetSqrtPriceX96: upper,
    inverted: true,
  };
}

/** Slippage floor. Never pass 0 to a router — that is an open invitation to a sandwich. */
export function applySlippage(quotedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 5000) {
    throw new Error("slippageBps out of sane range");
  }
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Realised slippage in bps. A large positive value is the fingerprint of a sandwich. */
export function realisedSlippageBps(quotedOut: bigint, actualOut: bigint): number {
  if (quotedOut === 0n) return 0;
  const diff = quotedOut - actualOut;
  return Number((diff * 10_000n) / quotedOut);
}

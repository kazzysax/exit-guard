import { getAddress } from "viem";
import { config, BASE } from "./config.js";
import { keeperhub, KeeperHubError } from "./keeperhub.js";
import { store, type Position, type Receipt } from "./store.js";
import { decideTier, gatherSignals } from "./router.js";
import {
  readPoolState,
  readPositionReadiness,
  quoteExit,
  executorAbi,
  type PoolState,
} from "./uniswap.js";
import { applySlippage, realisedSlippageBps, sqrtPriceX96ToHumanPrice } from "./priceMath.js";

/**
 * Injectable dependencies. Production code always uses these defaults; tests
 * override individual entries to exercise branching logic without a real
 * chain or a real KeeperHub connection. This is the seam — not a mocking
 * framework — so the production path stays exactly what ships.
 */
export const deps = {
  readPositionReadiness,
  readPoolState,
  quoteExit,
  executeContractCall: keeperhub.executeContractCall.bind(keeperhub),
  waitForCompletion: keeperhub.waitForCompletion.bind(keeperhub),
  gatherSignals,
};

export interface EvaluationResult {
  action: "exit" | "hold" | "blocked";
  reason: string;
  sqrtPriceX96: string;
  humanPrice: number;
  claimable: string;
  receipt?: Receipt;
}

/** Read-only. Free. This is what agents call to check without paying a completion fee. */
export async function evaluate(position: Position): Promise<EvaluationResult> {
  const readiness = await deps.readPositionReadiness(position.owner, position.token);
  const pool = await deps.readPoolState(position.pool);
  const humanPrice = sqrtPriceX96ToHumanPrice(pool.sqrtPriceX96, pool.decimals0, pool.decimals1);

  if (!readiness.ready) {
    return {
      action: "blocked",
      reason: readiness.reason ?? "position not claimable",
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      humanPrice,
      claimable: readiness.claimable.toString(),
    };
  }

  const stop = BigInt(position.stopSqrtPriceX96);
  const target = BigInt(position.targetSqrtPriceX96);
  const price = pool.sqrtPriceX96;

  if (price <= stop) {
    return {
      action: "exit",
      reason: `stop breached: ${price} <= ${stop}`,
      sqrtPriceX96: price.toString(),
      humanPrice,
      claimable: readiness.claimable.toString(),
    };
  }
  if (price >= target) {
    return {
      action: "exit",
      reason: `target reached: ${price} >= ${target}`,
      sqrtPriceX96: price.toString(),
      humanPrice,
      claimable: readiness.claimable.toString(),
    };
  }

  return {
    action: "hold",
    reason: "price within bounds",
    sqrtPriceX96: price.toString(),
    humanPrice,
    claimable: readiness.claimable.toString(),
  };
}

function shareOfLiquidityBps(amountIn: bigint, liquidity: bigint): number {
  if (liquidity === 0n) return 10_000;
  const bps = (amountIn * 10_000n) / liquidity;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/**
 * Full exit path. Simulate first — always. A revert caught in simulation costs
 * nothing; a revert caught onchain costs gas and leaves the position exposed.
 */
export async function executeExit(position: Position): Promise<Receipt> {
  const evaluation = await evaluate(position);

  if (evaluation.action !== "exit") {
    return store.addReceipt({
      positionId: position.id,
      outcome: evaluation.action === "hold" ? "held" : "blocked",
      sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
      error: evaluation.action === "blocked" ? evaluation.reason : undefined,
    });
  }

  const pool: PoolState = await deps.readPoolState(position.pool);
  const amountIn = BigInt(evaluation.claimable);

  const quotedOut = await deps.quoteExit({
    token: position.token,
    amountIn,
    feeTier: position.feeTier,
  });
  const minOut = applySlippage(quotedOut, position.slippageBps);

  const signals = await deps.gatherSignals({
    notionalWeth: Number(quotedOut) / 1e18,
    poolLiquidity: pool.liquidity,
    positionShareOfLiquidityBps: shareOfLiquidityBps(amountIn, pool.liquidity),
    lastRealisedSlippageBps: store.lastRealisedSlippageBps(position.id),
    consecutiveFailures: store.consecutiveFailures(position.id),
  });
  const decision = decideTier(signals);

  console.log(
    `[router] position=${position.id} tier=${decision.tier} score=${decision.score} :: ${decision.reasons.join(" | ")}`
  );

  const callArgs = [
    getAddress(position.owner),
    getAddress(position.token),
    position.feeTier,
    amountIn,
    minOut,
    position.feeBps,
  ];

  const base = {
    chainId: BASE.chainId,
    contractAddress: config.executorAddress,
    abi: executorAbi,
    functionName: "exit",
    args: callArgs.map((a) => (typeof a === "bigint" ? a.toString() : a)),
  };

  // --- Preflight ---------------------------------------------------------
  try {
    const sim = await deps.executeContractCall({ ...base, simulate: true });
    if (sim.wouldRevert || sim.success === false) {
      return store.addReceipt({
        positionId: position.id,
        outcome: "failed",
        tier: decision.tier,
        routerScore: decision.score,
        routerReasons: decision.reasons,
        sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
        amountIn: amountIn.toString(),
        quotedOut: quotedOut.toString(),
        simulatedWouldRevert: true,
        error: "simulation predicted revert — nothing signed or broadcast",
      });
    }
  } catch (err) {
    const message = err instanceof KeeperHubError ? err.message : String(err);
    return store.addReceipt({
      positionId: position.id,
      outcome: "failed",
      tier: decision.tier,
      routerScore: decision.score,
      routerReasons: decision.reasons,
      sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
      amountIn: amountIn.toString(),
      quotedOut: quotedOut.toString(),
      simulatedWouldRevert: true,
      error: `simulation failed: ${message}`,
    });
  }

  // --- Execute -----------------------------------------------------------
  const idempotencyKey = `exit-${position.id}-${evaluation.sqrtPriceX96}`;

  try {
    const submitted = await deps.executeContractCall({ ...base, idempotencyKey });
    const executionId = submitted.executionId ?? submitted.id;
    if (!executionId) throw new Error("no execution id returned");

    const final = await deps.waitForCompletion(executionId);
    const succeeded = String(final.status).toLowerCase() === "completed";

    if (!succeeded) {
      return store.addReceipt({
        positionId: position.id,
        outcome: "failed",
        tier: decision.tier,
        routerScore: decision.score,
        routerReasons: decision.reasons,
        sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
        amountIn: amountIn.toString(),
        quotedOut: quotedOut.toString(),
        executionId,
        transactionHash: final.transactionHash,
        error: `execution settled as ${final.status}`,
      });
    }

    const actualOut = extractAmountOut(final) ?? quotedOut;
    const slipBps = realisedSlippageBps(quotedOut, actualOut);
    const feeAmount = (actualOut * BigInt(position.feeBps)) / 10_000n;

    store.closePosition(position.id);

    return store.addReceipt({
      positionId: position.id,
      outcome: "executed",
      tier: decision.tier,
      routerScore: decision.score,
      routerReasons: decision.reasons,
      sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
      amountIn: amountIn.toString(),
      quotedOut: quotedOut.toString(),
      actualOut: actualOut.toString(),
      realisedSlippageBps: slipBps,
      feeAmount: feeAmount.toString(),
      ownerAmount: (actualOut - feeAmount).toString(),
      transactionHash: final.transactionHash,
      executionId,
    });
  } catch (err) {
    const message = err instanceof KeeperHubError ? err.message : String(err);
    return store.addReceipt({
      positionId: position.id,
      outcome: "failed",
      tier: decision.tier,
      routerScore: decision.score,
      routerReasons: decision.reasons,
      sqrtPriceX96AtEval: evaluation.sqrtPriceX96,
      amountIn: amountIn.toString(),
      quotedOut: quotedOut.toString(),
      error: message,
    });
  }
}

function extractAmountOut(result: Record<string, unknown>): bigint | undefined {
  const candidate = (result.result ?? (result as any).returnValue) as unknown;
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) return BigInt(candidate);
  if (typeof candidate === "bigint") return candidate;
  if (Array.isArray(candidate) && typeof candidate[0] === "string") return BigInt(candidate[0]);
  return undefined;
}

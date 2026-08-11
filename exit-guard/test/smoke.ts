process.env.KEEPERHUB_API_KEY = "kh_test";
process.env.KEEPERHUB_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
};

async function main() {
  const { humanPriceToSqrtPriceX96, sqrtPriceX96ToHumanPrice, applySlippage, realisedSlippageBps, buildThresholds } =
    await import("../src/priceMath.js");
  const { decideTier } = await import("../src/router.js");

  for (const p of [0.5, 1, 1234.5, 0.000012]) {
    const s = humanPriceToSqrtPriceX96(p, 18, 18);
    const back = sqrtPriceX96ToHumanPrice(s, 18, 18);
    const err = Math.abs(back - p) / p;
    check(`price round-trip ${p}`, err < 1e-6, `err=${err.toExponential(2)}`);
  }

  const usdcWeth = humanPriceToSqrtPriceX96(0.0004, 6, 18);
  check("mixed decimals produce non-zero sqrtPriceX96", usdcWeth > 0n, usdcWeth.toString());

  check("minOut applies 3% haircut", applySlippage(10n ** 18n, 300) === 970000000000000000n);
  check("realised slippage detects 150bps", realisedSlippageBps(10n ** 18n, 985n * 10n ** 15n) === 150);

  const t0 = buildThresholds({ positionTokenIsToken0: true, stopHumanPrice: 1, targetHumanPrice: 2, decimals0: 18, decimals1: 18 });
  const t1 = buildThresholds({ positionTokenIsToken0: false, stopHumanPrice: 1, targetHumanPrice: 2, decimals0: 18, decimals1: 18 });
  check("token0 not inverted", t0.inverted === false);
  check("token0 stop below target", t0.stopSqrtPriceX96 < t0.targetSqrtPriceX96);
  check("token1 inverted", t1.inverted === true);
  check("token1 thresholds ordered", t1.stopSqrtPriceX96 < t1.targetSqrtPriceX96);

  const expectUpper = humanPriceToSqrtPriceX96(1 / 1, 18, 18);
  const expectLower = humanPriceToSqrtPriceX96(1 / 2, 18, 18);
  check("token1 stop reciprocated into upper bound", t1.targetSqrtPriceX96 === expectUpper);
  check("token1 target reciprocated into lower bound", t1.stopSqrtPriceX96 === expectLower);

  const calm = decideTier({ baseFeeGwei: 0.01, lastRealisedSlippageBps: 10, consecutiveFailures: 0, notionalWeth: 0.05, poolLiquidity: 10n ** 20n, positionShareOfLiquidityBps: 5 });
  const hostile = decideTier({ baseFeeGwei: 0.9, lastRealisedSlippageBps: 400, consecutiveFailures: 3, notionalWeth: 2, poolLiquidity: 10n ** 18n, positionShareOfLiquidityBps: 900 });
  check("calm conditions route fast", calm.tier === "fast", `score=${calm.score}`);
  check("hostile conditions escalate", hostile.tier === "guarded", `score=${hostile.score} reasons=${hostile.reasons.length}`);
  check("escalation is explained", hostile.reasons.length === 5);

  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

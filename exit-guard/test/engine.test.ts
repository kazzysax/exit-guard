/**
 * engine.ts is the highest-stakes file in the repo — it decides whether to sign a
 * transaction. These tests mock BOTH the chain (viem readContract) and KeeperHub,
 * so they exercise the actual branching logic, not network behaviour.
 */
process.env.KEEPERHUB_API_KEY = "kh_test";
process.env.KEEPERHUB_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.EXECUTOR_ADDRESS = "0x0000000000000000000000000000000000000002";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
};

async function main() {
  const { store } = await import("../src/store.js");
  const { executeExit, deps } = await import("../src/engine.js");

  const OWNER = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  const TOKEN = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
  const POOL = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

  // ---- Case 1: price within bounds -> HOLD, no chain write, no fee --------
  {
    deps.readPositionReadiness = async () => ({
      balance: 1000n,
      allowance: 1000n,
      enrolled: true,
      claimable: 1000n,
      ready: true,
    });
    deps.readPoolState = async () => ({
      address: POOL,
      token0: TOKEN,
      token1: "0x4200000000000000000000000000000000000006",
      fee: 10000,
      sqrtPriceX96: 5000n, // strictly between stop=1000 and target=9000
      liquidity: 10n ** 18n,
      decimals0: 18,
      decimals1: 18,
      symbol0: "TEST",
      symbol1: "WETH",
    });

    let contractCallInvoked = false;
    deps.executeContractCall = async () => {
      contractCallInvoked = true;
      return { success: true };
    };

    const position = store.createPosition({
      owner: OWNER,
      token: TOKEN,
      pool: POOL,
      feeTier: 10000,
      stopSqrtPriceX96: "1000",
      targetSqrtPriceX96: "9000",
      slippageBps: 300,
      feeBps: 30,
    });

    const receipt = await executeExit(position);
    check("hold: outcome is held", receipt.outcome === "held", receipt.outcome);
    check("hold: never calls KeeperHub", contractCallInvoked === false);
    check("hold: position remains open", store.getPosition(position.id)?.status === "open");
  }

  // ---- Case 2: allowance insufficient -> BLOCKED, no chain write ----------
  {
    deps.readPositionReadiness = async () => ({
      balance: 1000n,
      allowance: 100n, // less than balance
      enrolled: true,
      claimable: 100n,
      ready: false,
      reason: "allowance is below position size",
    });

    let contractCallInvoked = false;
    deps.executeContractCall = async () => {
      contractCallInvoked = true;
      return { success: true };
    };

    const position = store.createPosition({
      owner: OWNER,
      token: TOKEN,
      pool: POOL,
      feeTier: 10000,
      stopSqrtPriceX96: "1000",
      targetSqrtPriceX96: "9000",
      slippageBps: 300,
      feeBps: 30,
    });

    const receipt = await executeExit(position);
    check("blocked: outcome is blocked", receipt.outcome === "blocked", receipt.outcome);
    check("blocked: reason surfaced", receipt.error?.includes("allowance") ?? false, receipt.error);
    check("blocked: never calls KeeperHub", contractCallInvoked === false);
  }

  // ---- Case 3: stop breached, simulation predicts revert -> FAILED, no submit --
  {
    deps.readPositionReadiness = async () => ({
      balance: 1000n,
      allowance: 1000n,
      enrolled: true,
      claimable: 1000n,
      ready: true,
    });
    deps.readPoolState = async () => ({
      address: POOL,
      token0: TOKEN,
      token1: "0x4200000000000000000000000000000000000006",
      fee: 10000,
      sqrtPriceX96: 500n, // below stop=1000 -> should exit
      liquidity: 10n ** 18n,
      decimals0: 18,
      decimals1: 18,
      symbol0: "TEST",
      symbol1: "WETH",
    });
    deps.quoteExit = async () => 990n;
    deps.gatherSignals = async () => ({
      baseFeeGwei: 0.01,
      lastRealisedSlippageBps: 0,
      consecutiveFailures: 0,
      notionalWeth: 0.001,
      poolLiquidity: 10n ** 18n,
      positionShareOfLiquidityBps: 1,
    });

    let submitCalled = false;
    deps.executeContractCall = async (params: any) => {
      if (params.simulate) {
        return { success: true, wouldRevert: true };
      }
      submitCalled = true;
      return { executionId: "should-not-reach" };
    };

    const position = store.createPosition({
      owner: OWNER,
      token: TOKEN,
      pool: POOL,
      feeTier: 10000,
      stopSqrtPriceX96: "1000",
      targetSqrtPriceX96: "9000",
      slippageBps: 300,
      feeBps: 30,
    });

    const receipt = await executeExit(position);
    check("revert predicted: outcome is failed", receipt.outcome === "failed", receipt.outcome);
    check("revert predicted: flagged as simulated", receipt.simulatedWouldRevert === true);
    check("revert predicted: real submit NEVER called", submitCalled === false);
    check(
      "revert predicted: position stays open for retry",
      store.getPosition(position.id)?.status === "open"
    );
  }

  // ---- Case 4: stop breached, simulation OK, execution succeeds -> EXECUTED --
  {
    deps.readPositionReadiness = async () => ({
      balance: 1000n,
      allowance: 1000n,
      enrolled: true,
      claimable: 1000n,
      ready: true,
    });
    deps.readPoolState = async () => ({
      address: POOL,
      token0: TOKEN,
      token1: "0x4200000000000000000000000000000000000006",
      fee: 10000,
      sqrtPriceX96: 500n,
      liquidity: 10n ** 18n,
      decimals0: 18,
      decimals1: 18,
      symbol0: "TEST",
      symbol1: "WETH",
    });
    deps.quoteExit = async () => 1_000_000_000_000_000_000n; // 1 WETH quoted
    deps.gatherSignals = async () => ({
      baseFeeGwei: 0.01,
      lastRealisedSlippageBps: 0,
      consecutiveFailures: 0,
      notionalWeth: 1,
      poolLiquidity: 10n ** 18n,
      positionShareOfLiquidityBps: 1,
    });

    let sawSimulate = false;
    let sawReal = false;
    let idemKeys = new Set<string>();
    deps.executeContractCall = async (params: any) => {
      if (params.simulate) {
        sawSimulate = true;
        return { success: true, wouldRevert: false };
      }
      sawReal = true;
      if (params.idempotencyKey) idemKeys.add(params.idempotencyKey);
      return { executionId: "exec_success" };
    };
    deps.waitForCompletion = async () => ({
      status: "completed",
      transactionHash: "0xfeedface",
      result: "980000000000000000", // 0.98 WETH actual, 2% realised slippage
    });

    const position = store.createPosition({
      owner: OWNER,
      token: TOKEN,
      pool: POOL,
      feeTier: 10000,
      stopSqrtPriceX96: "1000",
      targetSqrtPriceX96: "9000",
      slippageBps: 300,
      feeBps: 30,
    });

    const receipt = await executeExit(position);
    check("executed: simulate ran before real call", sawSimulate === true);
    check("executed: real call ran after simulate passed", sawReal === true);
    check("executed: outcome is executed", receipt.outcome === "executed", receipt.outcome);
    check("executed: tx hash captured", receipt.transactionHash === "0xfeedface");
    check(
      "executed: realised slippage computed (~200bps)",
      (receipt.realisedSlippageBps ?? -1) >= 195 && (receipt.realisedSlippageBps ?? -1) <= 205,
      String(receipt.realisedSlippageBps)
    );
    check(
      "executed: fee is 30bps of actual output, not quoted",
      receipt.feeAmount === ((980000000000000000n * 30n) / 10000n).toString(),
      receipt.feeAmount
    );
    check("executed: position closed", store.getPosition(position.id)?.status === "closed");
  }

  console.log(failures === 0 ? "\nALL ENGINE TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

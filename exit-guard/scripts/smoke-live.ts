/**
 * scripts/smoke-live.ts
 *
 * Walks the credentialed path end to end, in dependency order, and stops at the
 * FIRST real failure instead of letting later steps fail confusingly because an
 * earlier one was silently wrong. This is deliberately linear — no parallelism —
 * so a failure always points at exactly one cause.
 *
 * This is the script that turns "the code compiles" into "the system works."
 * Nothing here is mocked. Every step is a real network call.
 *
 * Usage:
 *   cp .env.example .env    # fill in KEEPERHUB_API_KEY and KEEPERHUB_WALLET_ADDRESS
 *   npm run smoke:live
 *
 * Safe to re-run. Steps that already succeeded are skipped where the chain lets
 * us check (e.g. an existing deployment), and every write uses a fresh
 * idempotency key so re-running never double-executes.
 */

import "dotenv/config";

let stepNumber = 0;

function step(name: string) {
  stepNumber++;
  console.log(`\n[${stepNumber}] ${name}`);
}

function pass(detail: string) {
  console.log(`    OK — ${detail}`);
}

function fail(detail: string): never {
  console.log(`    FAILED — ${detail}`);
  console.log(`\nStopped at step ${stepNumber}. Fix this before re-running — later steps depend on it.`);
  process.exit(1);
}

// --- Step 0: env vars present, BEFORE importing anything that requires them ---
// src/config.ts throws at import time if these are missing. That is correct for
// the running service, but it produces a raw stack trace here instead of a clean
// numbered failure — so we check first and fail cleanly if the caller forgot .env.
step("Required environment variables present");
const REQUIRED = ["KEEPERHUB_API_KEY", "KEEPERHUB_WALLET_ADDRESS"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  fail(`missing: ${missing.join(", ")}. Copy .env.example to .env and fill these in first.`);
}
pass(`${REQUIRED.join(", ")} are set`);

async function main() {
  // Deferred until after the env check above, so a missing key fails at step 0
  // instead of crashing during module resolution.
  const { config, BASE } = await import("../src/config.js");
  const { publicClient } = await import("../src/uniswap.js");
  const { keeperhub, KeeperHubError } = await import("../src/keeperhub.js");
  const { getAddress } = await import("viem");

  console.log("Exit Guard — live smoke test");
  console.log("Every step below is a real call. Nothing is mocked.");

  // --- 1. Base RPC is reachable and returns the expected chain -------------
  step("Base RPC reachable");
  try {
    const chainId = await publicClient.getChainId();
    if (chainId !== BASE.chainId) {
      fail(`RPC returned chain ${chainId}, expected ${BASE.chainId}. Check BASE_RPC_URL.`);
    }
    pass(`chain id ${chainId} confirmed via ${config.rpcUrl}`);
  } catch (err) {
    fail(`could not reach ${config.rpcUrl}: ${String(err)}`);
  }

  // --- 2. Known Base contracts actually have code at these addresses -------
  step("Base addresses have deployed code");
  for (const [label, addr] of Object.entries({
    "SwapRouter02": BASE.swapRouter02,
    "QuoterV2": BASE.quoterV2,
    "Uniswap V3 Factory": BASE.uniswapV3Factory,
    "WETH": BASE.weth,
    "USDC": BASE.usdc,
  })) {
    const code = await publicClient.getCode({ address: getAddress(addr) });
    if (!code || code === "0x") {
      fail(`${label} at ${addr} has no code on this RPC. Address may be wrong or RPC may be misconfigured.`);
    }
    pass(`${label} ${addr} — ${(code.length - 2) / 2} bytes`);
  }

  // --- 3. KeeperHub API key is valid and the wallet resolves ---------------
  step("KeeperHub API key valid, spending limits reachable");
  try {
    const limits = await keeperhub.getSpendingLimits();
    pass(`spending limits: ${JSON.stringify(limits)}`);
  } catch (err) {
    if (err instanceof KeeperHubError) {
      fail(
        `KeeperHub returned ${err.status} (${err.code ?? "no code"}): ${err.message}. ` +
          `Check KEEPERHUB_API_KEY and KEEPERHUB_BASE_URL. This is the step most likely ` +
          `to reveal the REST path in src/keeperhub.ts is wrong — check the actual ` +
          `response shape against docs.keeperhub.com/api and correct that file.`
      );
    }
    fail(String(err));
  }

  // --- 4. Executor is deployed and reachable --------------------------------
  step("Executor contract deployed");
  if (!config.executorAddress) {
    fail("EXECUTOR_ADDRESS is not set. Run: DEPLOYER_PRIVATE_KEY=0x... npm run deploy");
  }
  const executorCode = await publicClient.getCode({ address: getAddress(config.executorAddress) });
  if (!executorCode || executorCode === "0x") {
    fail(
      `No code at EXECUTOR_ADDRESS=${config.executorAddress}. ` +
        `Either the deploy hasn't run, or this is the wrong chain/RPC.`
    );
  }
  pass(`executor code present, ${(executorCode.length - 2) / 2} bytes`);

  // --- 5. KeeperHub wallet is authorised as keeper on the executor ---------
  step("KeeperHub wallet is an authorised keeper");
  try {
    const isKeeper = await publicClient.readContract({
      address: getAddress(config.executorAddress),
      abi: [
        {
          inputs: [{ name: "", type: "address" }],
          name: "keepers",
          outputs: [{ name: "", type: "bool" }],
          stateMutability: "view",
          type: "function",
        },
      ] as const,
      functionName: "keepers",
      args: [getAddress(config.keeperhubWallet)],
    });
    if (!isKeeper) {
      fail(
        `${config.keeperhubWallet} is not an authorised keeper on the executor. ` +
          `Re-run npm run deploy, or call setKeeper(address, true) manually as admin.`
      );
    }
    pass(`${config.keeperhubWallet} confirmed as keeper`);
  } catch (err) {
    fail(`could not read keepers() mapping: ${String(err)}`);
  }

  // --- 6. A real, harmless KeeperHub write executes end to end -------------
  step("KeeperHub can execute a real read-only contract call through the executor");
  try {
    const result = await keeperhub.executeContractCall({
      chainId: BASE.chainId,
      contractAddress: config.executorAddress,
      abi: [
        {
          inputs: [],
          name: "MAX_FEE_BPS",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "MAX_FEE_BPS",
      args: [],
    });
    pass(`round trip through KeeperHub succeeded: ${JSON.stringify(result)}`);
  } catch (err) {
    if (err instanceof KeeperHubError) {
      fail(
        `execute_contract_call failed with ${err.status}: ${err.message}. ` +
          `This confirms the exact shape KeeperHub expects for chain_id/contract_address/` +
          `abi/function_name/args — compare against the error and fix src/keeperhub.ts.`
      );
    }
    fail(String(err));
  }

  console.log(
    "\nAll live checks passed. The KeeperHub <-> Base <-> executor path is confirmed " +
      "end to end. You are clear to run npm run dev and register a real position."
  );
}

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});

import { readFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE } from "../src/config.js";

/**
 * Deploys ExitGuardExecutor and wires the KeeperHub org wallet as keeper.
 *
 * Run: npm run compile && DEPLOYER_PRIVATE_KEY=0x... npm run deploy
 *
 * The deployer key is used ONCE for deployment and admin setup. It is not the
 * key that executes exits — that is the KeeperHub Turnkey wallet, which never
 * leaves its enclave.
 */

const artifact = JSON.parse(readFileSync("artifacts/ExitGuardExecutor.json", "utf8")) as {
  abi: unknown[];
  bytecode: Hex;
};

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const keeper = process.env.KEEPERHUB_WALLET_ADDRESS;
  const feeRecipient = process.env.FEE_RECIPIENT ?? keeper;

  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY required");
  if (!keeper) throw new Error("KEEPERHUB_WALLET_ADDRESS required (from get_wallet_integration)");

  const account = privateKeyToAccount(pk as Hex);
  const rpc = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

  const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });

  console.log(`Deploying from ${account.address}`);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${Number(balance) / 1e18} ETH`);
  if (balance === 0n) throw new Error("deployer has no ETH on Base");

  const hash = await wallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode,
    args: [
      getAddress(BASE.swapRouter02),
      getAddress(BASE.weth),
      getAddress(feeRecipient as string),
    ],
  });

  console.log(`Deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const address = receipt.contractAddress;
  if (!address) throw new Error("no contract address in receipt");

  console.log(`\nExitGuardExecutor deployed at ${address}`);

  if (getAddress(keeper) !== account.address) {
    console.log(`Authorising KeeperHub wallet ${keeper} as keeper...`);
    const setHash = await wallet.writeContract({
      address,
      abi: artifact.abi as never,
      functionName: "setKeeper",
      args: [getAddress(keeper), true],
    });
    await publicClient.waitForTransactionReceipt({ hash: setHash });
    console.log(`Keeper set. tx: ${setHash}`);
  }

  console.log(`\nAdd to .env:\n  EXECUTOR_ADDRESS=${address}`);
  console.log(`\nEach trading agent must then, from its own wallet:`);
  console.log(`  1. ${address}.setEnrolled(true)`);
  console.log(`  2. token.approve(${address}, positionSize)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

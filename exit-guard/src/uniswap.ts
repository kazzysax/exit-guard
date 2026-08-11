import {
  createPublicClient,
  http,
  parseAbi,
  getAddress,
  type Address,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { config, BASE } from "./config.js";

export const publicClient: PublicClient = createPublicClient({
  chain: base,
  transport: http(config.rpcUrl),
}) as PublicClient;

export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const quoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const executorAbi = parseAbi([
  "function enrolled(address) view returns (bool)",
  "function exit(address owner, address token, uint24 poolFee, uint256 amountIn, uint256 amountOutMinimum, uint16 feeBps) returns (uint256)",
]);

export const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

export interface PoolState {
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
}

export async function readPoolState(poolAddress: string): Promise<PoolState> {
  const pool = getAddress(poolAddress);

  const [slot0, token0, token1, fee, liquidity] = await Promise.all([
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "fee" }),
    publicClient.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
  ]);

  const [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: token1, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: token0, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address: token1, abi: erc20Abi, functionName: "symbol" }),
  ]);

  return {
    address: pool,
    token0,
    token1,
    fee: Number(fee),
    sqrtPriceX96: slot0[0],
    liquidity,
    decimals0: Number(decimals0),
    decimals1: Number(decimals1),
    symbol0,
    symbol1,
  };
}

export async function findPool(token: string, feeTier: number): Promise<Address> {
  const pool = await publicClient.readContract({
    address: BASE.uniswapV3Factory as Address,
    abi: factoryAbi,
    functionName: "getPool",
    args: [getAddress(token), BASE.weth as Address, feeTier],
  });
  if (pool === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No Uniswap V3 pool for ${token} at fee tier ${feeTier}`);
  }
  return pool;
}

/** Quote the exit. QuoterV2 is state-mutating by signature but safe over eth_call. */
export async function quoteExit(params: {
  token: string;
  amountIn: bigint;
  feeTier: number;
}): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: BASE.quoterV2 as Address,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: getAddress(params.token),
        tokenOut: BASE.weth as Address,
        amountIn: params.amountIn,
        fee: params.feeTier,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

export interface PositionReadiness {
  balance: bigint;
  allowance: bigint;
  enrolled: boolean;
  claimable: bigint;
  ready: boolean;
  reason?: string;
}

/** Everything that must be true before an exit can even be attempted. */
export async function readPositionReadiness(
  owner: string,
  token: string
): Promise<PositionReadiness> {
  const ownerAddr = getAddress(owner);
  const tokenAddr = getAddress(token);
  const spender = getAddress(config.executorAddress);

  const [balance, allowance, isEnrolled] = await Promise.all([
    publicClient.readContract({
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [ownerAddr],
    }),
    publicClient.readContract({
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "allowance",
      args: [ownerAddr, spender],
    }),
    publicClient.readContract({
      address: spender,
      abi: executorAbi,
      functionName: "enrolled",
      args: [ownerAddr],
    }),
  ]);

  const claimable = balance < allowance ? balance : allowance;

  let reason: string | undefined;
  if (!isEnrolled) reason = "owner has not enrolled with the executor";
  else if (balance === 0n) reason = "position is empty";
  else if (allowance === 0n) reason = "no allowance granted to the executor";
  else if (allowance < balance) reason = "allowance is below position size";

  return {
    balance,
    allowance,
    enrolled: isEnrolled,
    claimable,
    ready: isEnrolled && claimable > 0n && allowance >= balance,
    reason,
  };
}

export async function currentBaseFeeGwei(): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.baseFeePerGas ?? 0n) / 1e9;
}

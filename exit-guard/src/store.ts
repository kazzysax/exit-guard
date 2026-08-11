import { randomUUID } from "node:crypto";
import type { RouterDecision } from "./router.js";

/**
 * In-memory store. Swap for Postgres before anyone real uses this — the
 * interface is deliberately narrow so that swap is a single file change.
 */

export interface Position {
  id: string;
  owner: string;
  token: string;
  pool: string;
  feeTier: number;
  stopSqrtPriceX96: string;
  targetSqrtPriceX96: string;
  slippageBps: number;
  feeBps: number;
  createdAt: string;
  closedAt?: string;
  status: "open" | "closed" | "blocked";
}

export interface Receipt {
  id: string;
  positionId: string;
  outcome: "executed" | "held" | "blocked" | "failed";
  tier?: RouterDecision["tier"];
  routerScore?: number;
  routerReasons?: string[];
  sqrtPriceX96AtEval?: string;
  amountIn?: string;
  quotedOut?: string;
  actualOut?: string;
  realisedSlippageBps?: number;
  feeAmount?: string;
  ownerAmount?: string;
  transactionHash?: string;
  executionId?: string;
  simulatedWouldRevert?: boolean;
  error?: string;
  createdAt: string;
}

const positions = new Map<string, Position>();
const receipts: Receipt[] = [];
const failureStreak = new Map<string, number>();
const lastSlippage = new Map<string, number>();

export const store = {
  createPosition(p: Omit<Position, "id" | "createdAt" | "status">): Position {
    const position: Position = {
      ...p,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "open",
    };
    positions.set(position.id, position);
    return position;
  },

  getPosition(id: string): Position | undefined {
    return positions.get(id);
  },

  listPositions(owner?: string): Position[] {
    const all = [...positions.values()];
    return owner ? all.filter((p) => p.owner.toLowerCase() === owner.toLowerCase()) : all;
  },

  closePosition(id: string, status: Position["status"] = "closed"): void {
    const p = positions.get(id);
    if (p) {
      p.status = status;
      p.closedAt = new Date().toISOString();
    }
  },

  addReceipt(r: Omit<Receipt, "id" | "createdAt">): Receipt {
    const receipt: Receipt = { ...r, id: randomUUID(), createdAt: new Date().toISOString() };
    receipts.push(receipt);

    // Feed the router's memory.
    const key = r.positionId;
    if (r.outcome === "failed") {
      failureStreak.set(key, (failureStreak.get(key) ?? 0) + 1);
    } else if (r.outcome === "executed") {
      failureStreak.set(key, 0);
      if (typeof r.realisedSlippageBps === "number") {
        lastSlippage.set(key, r.realisedSlippageBps);
      }
    }
    return receipt;
  },

  listReceipts(positionId?: string): Receipt[] {
    return positionId ? receipts.filter((r) => r.positionId === positionId) : [...receipts];
  },

  consecutiveFailures(positionId: string): number {
    return failureStreak.get(positionId) ?? 0;
  },

  lastRealisedSlippageBps(positionId: string): number {
    return lastSlippage.get(positionId) ?? 0;
  },
};

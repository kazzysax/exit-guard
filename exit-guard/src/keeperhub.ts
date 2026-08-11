import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * KeeperHub client.
 *
 * Two things this handles that a naive fetch wrapper does not:
 *   1. Idempotency keys on every write, so a retried request cannot double-sell.
 *   2. The documented `upstream_cold_start` response, which is retryable —
 *      unlike connection errors and DNS failures, which are not.
 */

export interface DirectExecutionResult {
  executionId?: string;
  id?: string;
  status?: string;
  transactionHash?: string;
  success?: boolean;
  wouldRevert?: boolean;
  result?: unknown;
  [k: string]: unknown;
}

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "KeeperHubError";
  }

  get isColdStart(): boolean {
    return this.code === "upstream_cold_start" || [502, 503, 504].includes(this.status);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {}
): Promise<T> {
  const { method = "GET", body, idempotencyKey, timeoutMs = 55_000 } = init;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.keeperhubApiKey}`,
    "Content-Type": "application/json",
    "x-request-id": randomUUID(),
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.keeperhubBaseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }

    if (!res.ok) {
      // A simulated revert comes back as HTTP 400 with a wouldRevert body — that's
      // a legitimate simulation result, not a transport/client error, so it's
      // returned to the caller instead of thrown. Every other non-2xx is a hard stop.
      if (typeof parsed?.wouldRevert === "boolean") {
        return parsed as T;
      }
      throw new KeeperHubError(
        parsed?.detail ?? parsed?.error ?? text ?? res.statusText,
        res.status,
        parsed?.error,
        parsed?.request_id ?? res.headers.get("x-request-id") ?? undefined,
        parsed?.retryAfterSeconds
      );
    }

    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Retry ONLY on cold start. Everything else is a hard stop, per the docs. */
async function withColdStartRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!(err instanceof KeeperHubError) || !err.isColdStart || attempt === maxAttempts) {
        throw err;
      }
      const wait = (err.retryAfterSeconds ?? 2 ** attempt) * 1000;
      console.warn(
        `[keeperhub] cold start (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

export const keeperhub = {
  /** Direct contract call. Long-running, so the client timeout is relaxed. */
  async executeContractCall(params: {
    chainId: number;
    contractAddress: string;
    abi: unknown;
    functionName: string;
    args: unknown[];
    simulate?: boolean;
    idempotencyKey?: string;
  }): Promise<DirectExecutionResult> {
    const { simulate, idempotencyKey, ...rest } = params;
    return withColdStartRetry(() =>
      request<DirectExecutionResult>("/api/execute/contract-call", {
        method: "POST",
        timeoutMs: simulate ? 55_000 : 180_000,
        idempotencyKey: simulate ? undefined : idempotencyKey ?? randomUUID(),
        body: {
          chainId: rest.chainId,
          contractAddress: rest.contractAddress,
          abi: JSON.stringify(rest.abi),
          functionName: rest.functionName,
          functionArgs: JSON.stringify(rest.args),
          ...(simulate ? { simulate: true } : {}),
        },
      })
    );
  },

  async getDirectExecutionStatus(executionId: string): Promise<DirectExecutionResult> {
    return request<DirectExecutionResult>(`/api/execute/${executionId}/status`, {
      timeoutMs: 180_000,
    });
  },

  async executeWorkflow(workflowId: string, inputs: Record<string, unknown>) {
    return withColdStartRetry(() =>
      request<{ executionId: string }>(`/api/workflows/${workflowId}/execute`, {
        method: "POST",
        timeoutMs: 180_000,
        idempotencyKey: randomUUID(),
        body: { inputs },
      })
    );
  },

  async getExecution(executionId: string) {
    return request<Record<string, unknown>>(`/api/executions/${executionId}`);
  },

  async getSpendingLimits() {
    return request<Record<string, unknown>>("/api/analytics/spend-cap");
  },

  /**
   * Poll until terminal. Bounded backoff, hard ceiling — never poll forever,
   * because a hung poll in an exit path is indistinguishable from a lost position.
   */
  async waitForCompletion(
    executionId: string,
    opts: { maxWaitMs?: number } = {}
  ): Promise<DirectExecutionResult> {
    const maxWaitMs = opts.maxWaitMs ?? 180_000;
    const started = Date.now();
    let delay = 1_000;

    while (Date.now() - started < maxWaitMs) {
      const status = await this.getDirectExecutionStatus(executionId);
      const s = String(status.status ?? "").toLowerCase();
      if (s === "completed" || s === "failed" || s === "reverted") return status;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 8_000);
    }
    throw new Error(`Execution ${executionId} did not settle within ${maxWaitMs}ms`);
  },
};

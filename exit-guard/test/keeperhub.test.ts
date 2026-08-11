/**
 * Tests keeperhub.ts against a mocked fetch. No real network call, no API key needed —
 * this is the client's CONTRACT, not the live integration.
 */
process.env.KEEPERHUB_API_KEY = "kh_test";
process.env.KEEPERHUB_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
};

type MockResponse = { status: number; body: unknown; headers?: Record<string, string> };

function mockFetchSequence(responses: MockResponse[]) {
  let call = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      text: async () => JSON.stringify(r.body),
      headers: {
        get: (k: string) => r.headers?.[k] ?? null,
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, callCount: () => call };
}

async function main() {
  const { keeperhub, KeeperHubError } = await import("../src/keeperhub.js");

  // --- Cold start is retried ---------------------------------------------
  {
    const { calls, callCount } = mockFetchSequence([
      { status: 503, body: { error: "upstream_cold_start", retryAfterSeconds: 0, detail: "waking" } },
      { status: 200, body: { executionId: "exec_1", status: "completed" } },
    ]);
    const start = Date.now();
    const result = await keeperhub.executeContractCall({
      chainId: 8453,
      contractAddress: "0xabc",
      abi: [],
      functionName: "exit",
      args: [],
      idempotencyKey: "k1",
    });
    check("cold start eventually succeeds", (result as any).executionId === "exec_1");
    check("cold start retried exactly once before success", callCount() === 2);
  }

  // --- Non-cold-start error is a hard stop, never retried -----------------
  {
    const { callCount } = mockFetchSequence([
      { status: 400, body: { error: "invalid_input", detail: "bad abi" } },
    ]);
    let threw = false;
    let isKeeperHubError = false;
    try {
      await keeperhub.executeContractCall({
        chainId: 8453,
        contractAddress: "0xabc",
        abi: [],
        functionName: "exit",
        args: [],
        idempotencyKey: "k2",
      });
    } catch (err) {
      threw = true;
      isKeeperHubError = err instanceof KeeperHubError;
    }
    check("400 throws", threw);
    check("400 throws KeeperHubError", isKeeperHubError);
    check("400 is NOT retried (single call)", callCount() === 1);
  }

  // --- Idempotency key is attached on writes -------------------------------
  {
    const { calls } = mockFetchSequence([{ status: 200, body: { executionId: "exec_3" } }]);
    await keeperhub.executeContractCall({
      chainId: 8453,
      contractAddress: "0xabc",
      abi: [],
      functionName: "exit",
      args: [],
      idempotencyKey: "my-fixed-key",
    });
    const header = (calls[0].init.headers as Record<string, string>)["Idempotency-Key"];
    check("idempotency key sent verbatim", header === "my-fixed-key", `got=${header}`);
  }

  // --- simulate:true does NOT get an idempotency key -----------------------
  {
    const { calls } = mockFetchSequence([{ status: 200, body: { success: true, wouldRevert: false } }]);
    await keeperhub.executeContractCall({
      chainId: 8453,
      contractAddress: "0xabc",
      abi: [],
      functionName: "exit",
      args: [],
      simulate: true,
      idempotencyKey: "should-be-ignored",
    });
    const header = (calls[0].init.headers as Record<string, string>)["Idempotency-Key"];
    check("simulate calls carry no idempotency key", header === undefined, `got=${header}`);
  }

  // --- waitForCompletion polls until terminal, then stops ------------------
  {
    mockFetchSequence([
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "completed", transactionHash: "0xdead" } },
    ]);
    const result = await keeperhub.waitForCompletion("exec_x", { maxWaitMs: 10_000 });
    check("waitForCompletion returns terminal state", (result as any).status === "completed");
    check("waitForCompletion surfaces tx hash", (result as any).transactionHash === "0xdead");
  }

  // --- waitForCompletion gives up after maxWaitMs, does not hang ----------
  {
    mockFetchSequence([{ status: 200, body: { status: "pending" } }]);
    let threw = false;
    const start = Date.now();
    try {
      await keeperhub.waitForCompletion("exec_y", { maxWaitMs: 50 });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - start;
    check("waitForCompletion throws instead of hanging forever", threw);
    check("waitForCompletion respects the ceiling", elapsed < 2000, `elapsed=${elapsed}ms`);
  }

  console.log(failures === 0 ? "\nALL KEEPERHUB CLIENT TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

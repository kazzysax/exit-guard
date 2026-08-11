import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getAddress, isAddress } from "viem";
import { config, BASE } from "./config.js";
import { store } from "./store.js";
import { evaluate, executeExit } from "./engine.js";
import { requirePayment, isX402Active, resolvePayTo, toAtomicUsdc } from "./x402.js";
import { readPoolState, findPool, readPositionReadiness } from "./uniswap.js";
import { buildThresholds, sqrtPriceX96ToHumanPrice } from "./priceMath.js";
import { keeperhub } from "./keeperhub.js";

const app = express();
// Render / reverse proxies terminate TLS; needed for correct https:// resource URLs in x402
app.set("trust proxy", 1);
app.use(express.json());

/**
 * Marketing UI + /docs on the same host as the API.
 * Resolve public/ for both `tsx src` (dev) and `node dist/src` (Render).
 */
function resolvePublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(here, "..", "public"), // src/ or dist/ next to public/
    path.join(here, "..", "..", "public"), // dist/src -> ../../public
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0];
}

const publicDir = resolvePublicDir();
app.use(express.static(publicDir, { index: "index.html", extensions: ["html"] }));

const bad = (res: express.Response, msg: string) => res.status(400).json({ error: msg });

/** Lightweight liveness for keep-alive pings (no KeeperHub call). */
app.get("/ping", (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

app.get("/health", async (_req, res) => {
  const x402 = {
    enabled: config.x402Enabled,
    active: isX402Active(),
    payTo: resolvePayTo(),
    priceUsdc: config.x402CallPriceUsdc,
    priceAtomic: (() => {
      try {
        return toAtomicUsdc(config.x402CallPriceUsdc);
      } catch {
        return null;
      }
    })(),
    network: `eip155:${BASE.chainId}`,
    asset: BASE.usdc,
    facilitator: config.x402FacilitatorUrl,
    paidRoute: "POST /v1/positions/:id/exit",
    freeRoutes: ["POST /v1/positions", "POST /v1/positions/:id/evaluate", "GET /v1/receipts"],
  };
  try {
    const limits = await keeperhub.getSpendingLimits();
    res.json({ ok: true, executor: config.executorAddress, spendingLimits: limits, x402 });
  } catch (err) {
    res.status(503).json({ ok: false, error: String(err), x402 });
  }
});

/** Register a position. Free. Returns the computed thresholds so the agent can verify them. */
app.post("/v1/positions", async (req, res) => {
  try {
    const {
      owner,
      token,
      stopPrice,
      targetPrice,
      feeTier = 10_000,
      slippageBps = config.defaultSlippageBps,
      feeBps = config.defaultFeeBps,
    } = req.body ?? {};

    if (!isAddress(owner ?? "")) return bad(res, "owner must be a valid address");
    if (!isAddress(token ?? "")) return bad(res, "token must be a valid address");
    if (typeof stopPrice !== "number" || stopPrice <= 0) {
      return bad(res, "stopPrice must be a positive number");
    }
    if (feeBps > 100) return bad(res, "feeBps exceeds the executor's 1% ceiling");

    const poolAddress = await findPool(token, Number(feeTier));
    const pool = await readPoolState(poolAddress);
    const positionIsToken0 = getAddress(token) === pool.token0;

    const { stopSqrtPriceX96, targetSqrtPriceX96, inverted } = buildThresholds({
      positionTokenIsToken0: positionIsToken0,
      stopHumanPrice: stopPrice,
      targetHumanPrice: typeof targetPrice === "number" ? targetPrice : undefined,
      decimals0: pool.decimals0,
      decimals1: pool.decimals1,
    });

    const readiness = await readPositionReadiness(owner, token);

    const position = store.createPosition({
      owner: getAddress(owner),
      token: getAddress(token),
      pool: poolAddress,
      feeTier: Number(feeTier),
      stopSqrtPriceX96: stopSqrtPriceX96.toString(),
      targetSqrtPriceX96: targetSqrtPriceX96.toString(),
      slippageBps: Number(slippageBps),
      feeBps: Number(feeBps),
    });

    res.status(201).json({
      position,
      pool: {
        address: pool.address,
        pair: `${pool.symbol0}/${pool.symbol1}`,
        currentSqrtPriceX96: pool.sqrtPriceX96.toString(),
        currentPrice: sqrtPriceX96ToHumanPrice(pool.sqrtPriceX96, pool.decimals0, pool.decimals1),
        positionIsToken0,
        thresholdsInverted: inverted,
      },
      readiness: {
        enrolled: readiness.enrolled,
        balance: readiness.balance.toString(),
        allowance: readiness.allowance.toString(),
        ready: readiness.ready,
        reason: readiness.reason,
        nextStep: readiness.ready
          ? "position is armed"
          : `call setEnrolled(true) and approve(${config.executorAddress}, positionSize)`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/v1/positions/:id", (req, res) => {
  const position = store.getPosition(String(req.params.id));
  if (!position) return res.status(404).json({ error: "position not found" });
  res.json({ position, receipts: store.listReceipts(position.id) });
});

/** FREE. Check without trading. Never charged. */
app.post("/v1/positions/:id/evaluate", async (req, res) => {
  const position = store.getPosition(String(req.params.id));
  if (!position) return res.status(404).json({ error: "position not found" });
  try {
    res.json(await evaluate(position));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** PAID. Nominal x402 call fee up front; the completion fee is taken onchain only if the swap lands. */
app.post("/v1/positions/:id/exit", requirePayment(), async (req, res) => {
  const position = store.getPosition(String(req.params.id));
  if (!position) return res.status(404).json({ error: "position not found" });
  if (position.status !== "open") {
    return res.status(409).json({ error: `position is ${position.status}` });
  }
  try {
    const receipt = await executeExit(position);
    const status = receipt.outcome === "failed" ? 502 : 200;
    res.status(status).json({ receipt });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/v1/receipts", (req, res) => {
  const raw = req.query.positionId;
  const positionId = typeof raw === "string" ? raw : undefined;
  res.json({ receipts: store.listReceipts(positionId) });
});

// SPA-ish fallback: /docs and bare paths that are not API/health/ping
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/v1") || req.path === "/health" || req.path === "/ping") {
    return next();
  }
  // Prefer docs index for /docs without trailing slash
  if (req.path === "/docs") {
    return res.sendFile(path.join(publicDir, "docs", "index.html"), (err) => {
      if (err) next();
    });
  }
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) next();
  });
});

export function startServer() {
  // Railway / containers set PORT and need 0.0.0.0 (not localhost-only).
  const host = process.env.HOST ?? "0.0.0.0";
  app.listen(config.port, host, () => {
    console.log(`Exit Guard listening on ${host}:${config.port}`);
    console.log(`  public    ${publicDir} (exists=${fs.existsSync(path.join(publicDir, "index.html"))})`);
    console.log(`  executor  ${config.executorAddress}`);
    console.log(`  keeper    ${config.keeperhubWallet}`);
    const active = isX402Active();
    console.log(
      `  x402      ${active ? "ACTIVE" : config.x402Enabled ? "enabled but payTo invalid" : "disabled"}` +
        (active
          ? ` · ${config.x402CallPriceUsdc} USDC → ${resolvePayTo()} via ${config.x402FacilitatorUrl}`
          : "")
    );
  });
}

export { app };

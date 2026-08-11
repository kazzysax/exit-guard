import type { Request, Response, NextFunction } from "express";
import { isAddress, getAddress } from "viem";
import { config, BASE } from "./config.js";

/**
 * x402 payment middleware for Exit Guard.
 *
 * Protocol (compatible with KeeperHub agentic wallets + Coinbase x402 clients):
 *   1. Unpaid call to a paid route → HTTP 402 + payment requirements
 *      (JSON body + base64 `PAYMENT-REQUIRED` header)
 *   2. Client signs EIP-3009 TransferWithAuthorization for Base USDC
 *   3. Client retries with `PAYMENT-SIGNATURE` (or legacy `X-PAYMENT`) header
 *   4. We verify via facilitator, serve the route, then settle only on success
 *
 * Why the old implementation never collected money:
 *   - X402_ENABLED defaulted to false (middleware no-op)
 *   - X402_PAY_TO was the placeholder "0x..."
 *   - maxAmountRequired was "0.02" (human dollars) instead of USDC atomic units
 *   - facilitator was x402.org which is testnet-only; Base mainnet needs PayAI/CDP
 *   - missing PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers agents expect (x402 v2)
 *
 * Evaluate stays free. The big fee is still the onchain completion fee inside
 * ExitGuardExecutor — this is only the per-call API charge.
 */

const SCHEME = "exact";
const NETWORK = `eip155:${BASE.chainId}`;
const USDC_DECIMALS = 6;

/** Convert "$0.02" / "0.02" / "20000" into USDC atomic units (6 decimals). */
export function toAtomicUsdc(price: string): string {
  const raw = price.trim();
  if (!raw) throw new Error("empty x402 price");

  // Already atomic (integer string, no decimal point, no $)
  if (/^\d+$/.test(raw)) return raw;

  const dollars = raw.startsWith("$") ? raw.slice(1) : raw;
  if (!/^\d+(\.\d+)?$/.test(dollars)) {
    throw new Error(`invalid x402 price: ${price}`);
  }
  const [whole, frac = ""] = dollars.split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const atomic = BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
  return atomic.toString();
}

export function resolvePayTo(): string | null {
  const candidates = [config.x402PayTo, config.keeperhubWallet].filter(Boolean);
  for (const c of candidates) {
    if (isAddress(c)) return getAddress(c);
  }
  return null;
}

export function isX402Active(): boolean {
  return config.x402Enabled && resolvePayTo() !== null;
}

function paymentRequirements(resource: string) {
  const payTo = resolvePayTo();
  if (!payTo) {
    throw new Error("x402 enabled but no valid payTo (set X402_PAY_TO or KEEPERHUB_WALLET_ADDRESS)");
  }

  return {
    x402Version: 1 as const,
    accepts: [
      {
        scheme: SCHEME,
        network: NETWORK,
        // Agents and facilitators require atomic units, not human dollars.
        maxAmountRequired: toAtomicUsdc(config.x402CallPriceUsdc),
        resource,
        description: "Exit Guard — evaluate and execute a position exit",
        mimeType: "application/json",
        payTo,
        asset: BASE.usdc,
        maxTimeoutSeconds: 120,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
}

function b64EncodeJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/**
 * Clients may send a raw JSON string, a base64-encoded PaymentPayload, or an
 * already-stringified object. Facilitators want the decoded payload object.
 */
export function decodePaymentPayload(header: string): unknown {
  const trimmed = header.trim();
  // Base64 of JSON almost never starts with '{'
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.startsWith("{") || decoded.startsWith("[")) {
      return JSON.parse(decoded);
    }
  } catch {
    // fall through — send as-is
  }
  return trimmed;
}

async function verifyWithFacilitator(
  paymentHeader: string,
  requirements: ReturnType<typeof paymentRequirements>["accepts"][0]
): Promise<{ valid: boolean; payer?: string; reason?: string }> {
  try {
    const paymentPayload = decodePaymentPayload(paymentHeader);
    const res = await fetch(`${config.x402FacilitatorUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements: requirements,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      isValid?: boolean;
      payer?: string;
      invalidReason?: string;
      invalidMessage?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        valid: false,
        reason:
          body.invalidReason ??
          body.invalidMessage ??
          body.error ??
          `facilitator returned ${res.status}`,
      };
    }
    return {
      valid: Boolean(body.isValid),
      payer: body.payer,
      reason: body.invalidReason ?? body.invalidMessage,
    };
  } catch (err) {
    return { valid: false, reason: `facilitator unreachable: ${String(err)}` };
  }
}

async function settleWithFacilitator(
  paymentHeader: string,
  requirements: ReturnType<typeof paymentRequirements>["accepts"][0]
): Promise<{ transaction?: string; success: boolean; error?: string }> {
  try {
    const paymentPayload = decodePaymentPayload(paymentHeader);
    const res = await fetch(`${config.x402FacilitatorUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements: requirements,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      transaction?: string;
      success?: boolean;
      error?: string;
    };
    if (!res.ok) {
      return { success: false, error: body.error ?? `facilitator settle ${res.status}` };
    }
    return {
      success: body.success !== false,
      transaction: body.transaction,
      error: body.error,
    };
  } catch (err) {
    return { success: false, error: `facilitator unreachable: ${String(err)}` };
  }
}

function send402(req: Request, res: Response, extra?: Record<string, unknown>) {
  const resource = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
  const body = { ...paymentRequirements(resource), ...extra };
  // x402 v2 clients read the header; KeeperHub MCP surfaces the body in tool errors.
  res.setHeader("PAYMENT-REQUIRED", b64EncodeJson(body));
  res.status(402).json(body);
}

export function requirePayment() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config.x402Enabled) {
      // Explicitly off — free exit path for local dev / smoke tests.
      return next();
    }

    if (!resolvePayTo()) {
      res.status(503).json({
        error:
          "x402 is enabled but X402_PAY_TO is missing/invalid. Set a real Base address to receive USDC.",
      });
      return;
    }

    // Prefer v2 header name; accept legacy X-PAYMENT used by older clients/tests.
    const header =
      req.header("PAYMENT-SIGNATURE") ??
      req.header("X-PAYMENT") ??
      req.header("payment-signature") ??
      req.header("x-payment");

    if (!header) {
      send402(req, res);
      return;
    }

    const resource = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
    const requirements = paymentRequirements(resource).accepts[0];

    const verification = await verifyWithFacilitator(header, requirements);
    if (!verification.valid) {
      send402(req, res, { error: verification.reason ?? "payment verification failed" });
      return;
    }

    (req as Request & { payer?: string }).payer = verification.payer;

    // Settle only after a successful response so a 4xx/5xx does not take funds.
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      void settleWithFacilitator(header, requirements).then((settled) => {
        if (settled.transaction) {
          console.log(
            `[x402] settled call fee tx=${settled.transaction} payer=${verification.payer}`
          );
        } else if (!settled.success) {
          console.warn(`[x402] settle failed: ${settled.error ?? "unknown"}`);
        }
      });
    });

    next();
  };
}

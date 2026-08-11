import type { Request, Response, NextFunction } from "express";
import { isAddress, getAddress } from "viem";
import { config, BASE } from "./config.js";

/**
 * x402 payment middleware for Exit Guard.
 *
 * Challenge shape is x402 **v2** (required by @keeperhub/wallet parseX402Challenge
 * which rejects x402Version !== 2). Facilitator verify/settle still receive the
 * exact-accept requirements object.
 *
 * NOTE: KeeperHub agentic wallet (v0.1.x) only *signs* payments when the resource
 * URL matches KeeperHub marketplace workflows:
 *   /api/mcp/workflows/<slug>/call
 * Generic HTTP APIs (this service) get UNSUPPORTED_RECIPIENT until KEEP-311.
 * Agents can still pay with any generic x402 client / CDP facilitator path.
 */

const SCHEME = "exact";
const NETWORK = `eip155:${BASE.chainId}`;
const USDC_DECIMALS = 6;

/** Convert "$0.02" / "0.02" / "20000" into USDC atomic units (6 decimals). */
export function toAtomicUsdc(price: string): string {
  const raw = price.trim();
  if (!raw) throw new Error("empty x402 price");

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

/** Absolute public URL for this request (Render terminates TLS; trust proxy). */
export function publicResourceUrl(req: Request): string {
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto =
    (req.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() ||
    (req.secure ? "https" : "http");
  return `${proto}://${host}${req.originalUrl}`;
}

export type AcceptRequirement = {
  scheme: string;
  network: string;
  /** x402 v2 field used by KeeperHub wallet */
  amount: string;
  /** v1 alias kept for older clients / our tests */
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
  description?: string;
  mimeType?: string;
  resource?: string;
};

function paymentRequirements(resourceUrl: string) {
  const payTo = resolvePayTo();
  if (!payTo) {
    throw new Error("x402 enabled but no valid payTo (set X402_PAY_TO or KEEPERHUB_WALLET_ADDRESS)");
  }

  const amount = toAtomicUsdc(config.x402CallPriceUsdc);
  const accept: AcceptRequirement = {
    scheme: SCHEME,
    network: NETWORK,
    amount,
    maxAmountRequired: amount,
    payTo,
    asset: BASE.usdc,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2" },
    description: "Exit Guard — evaluate and execute a position exit",
    mimeType: "application/json",
    resource: resourceUrl,
  };

  // v2 envelope expected by @keeperhub/wallet isX402Shape
  return {
    x402Version: 2 as const,
    accepts: [accept],
    resource: {
      url: resourceUrl,
      description: "Exit Guard — evaluate and execute a position exit",
      mimeType: "application/json",
    },
  };
}

function facilitatorRequirements(accept: AcceptRequirement) {
  // PayAI / facilitators typically want the classic exact requirements object
  return {
    scheme: accept.scheme,
    network: accept.network,
    maxAmountRequired: accept.maxAmountRequired ?? accept.amount,
    resource: accept.resource ?? "",
    description: accept.description ?? "Exit Guard exit",
    mimeType: accept.mimeType ?? "application/json",
    payTo: accept.payTo,
    asset: accept.asset,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra: accept.extra,
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
    // fall through
  }
  return trimmed;
}

async function verifyWithFacilitator(
  paymentHeader: string,
  accept: AcceptRequirement
): Promise<{ valid: boolean; payer?: string; reason?: string }> {
  try {
    const paymentPayload = decodePaymentPayload(paymentHeader);
    const requirements = facilitatorRequirements(accept);
    // Try v2 then v1 for facilitator compatibility
    for (const x402Version of [2, 1] as const) {
      const res = await fetch(`${config.x402FacilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version,
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
      if (res.ok && body.isValid) {
        return { valid: true, payer: body.payer };
      }
      if (res.ok && body.isValid === false) {
        return {
          valid: false,
          reason: body.invalidReason ?? body.invalidMessage ?? body.error ?? "invalid payment",
        };
      }
      // non-ok: try next version unless last
      if (x402Version === 1) {
        return {
          valid: false,
          reason:
            body.invalidReason ??
            body.invalidMessage ??
            body.error ??
            `facilitator returned ${res.status}`,
        };
      }
    }
    return { valid: false, reason: "facilitator verify failed" };
  } catch (err) {
    return { valid: false, reason: `facilitator unreachable: ${String(err)}` };
  }
}

async function settleWithFacilitator(
  paymentHeader: string,
  accept: AcceptRequirement
): Promise<{ transaction?: string; success: boolean; error?: string }> {
  try {
    const paymentPayload = decodePaymentPayload(paymentHeader);
    const requirements = facilitatorRequirements(accept);
    for (const x402Version of [2, 1] as const) {
      const res = await fetch(`${config.x402FacilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version,
          paymentPayload,
          paymentRequirements: requirements,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        transaction?: string;
        success?: boolean;
        error?: string;
      };
      if (res.ok) {
        return {
          success: body.success !== false,
          transaction: body.transaction,
          error: body.error,
        };
      }
      if (x402Version === 1) {
        return { success: false, error: body.error ?? `facilitator settle ${res.status}` };
      }
    }
    return { success: false, error: "facilitator settle failed" };
  } catch (err) {
    return { success: false, error: `facilitator unreachable: ${String(err)}` };
  }
}

function send402(req: Request, res: Response, extra?: Record<string, unknown>) {
  const resourceUrl = publicResourceUrl(req);
  const body = { ...paymentRequirements(resourceUrl), ...extra };
  res.setHeader("PAYMENT-REQUIRED", b64EncodeJson(body));
  res.status(402).json(body);
}

export function requirePayment() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config.x402Enabled) {
      return next();
    }

    // KeeperHub marketplace workflows pay via KH x402, then call us with this key
    // so agents are not charged twice (marketplace + API).
    const serviceKey = (process.env.EXIT_GUARD_SERVICE_KEY ?? "").trim();
    const provided =
      req.header("X-Exit-Guard-Key") ??
      req.header("x-exit-guard-key") ??
      "";
    if (serviceKey && provided && provided === serviceKey) {
      (req as Request & { payer?: string }).payer = "keeperhub-marketplace";
      return next();
    }

    if (!resolvePayTo()) {
      res.status(503).json({
        error:
          "x402 is enabled but X402_PAY_TO is missing/invalid. Set a real Base address to receive USDC.",
      });
      return;
    }

    const header =
      req.header("PAYMENT-SIGNATURE") ??
      req.header("X-PAYMENT") ??
      req.header("payment-signature") ??
      req.header("x-payment");

    if (!header) {
      send402(req, res);
      return;
    }

    const resourceUrl = publicResourceUrl(req);
    const accept = paymentRequirements(resourceUrl).accepts[0];

    const verification = await verifyWithFacilitator(header, accept);
    if (!verification.valid) {
      send402(req, res, { error: verification.reason ?? "payment verification failed" });
      return;
    }

    (req as Request & { payer?: string }).payer = verification.payer;

    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      void settleWithFacilitator(header, accept).then((settled) => {
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

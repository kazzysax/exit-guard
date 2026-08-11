/**
 * Create Exit Guard workflows on KeeperHub and list them on the marketplace
 * so agentic wallets can pay via /api/mcp/workflows/<slug>/call.
 *
 * Requires: KEEPERHUB_API_KEY, EXIT_GUARD_SERVICE_KEY in env (or .env via dotenv).
 */
import "dotenv/config";
import fs from "fs";

const BASE = process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com";
const KEY = process.env.KEEPERHUB_API_KEY;
const SERVICE_KEY =
  process.env.EXIT_GUARD_SERVICE_KEY ||
  (fs.existsSync("scripts/.service-key.tmp")
    ? fs.readFileSync("scripts/.service-key.tmp", "utf8").trim()
    : "");
const EG = process.env.EXIT_GUARD_HOST ?? "https://exit-guard.onrender.com";

if (!KEY) {
  console.error("Missing KEEPERHUB_API_KEY");
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error("Missing EXIT_GUARD_SERVICE_KEY");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function manualTrigger(id = "trigger-1") {
  return {
    id,
    type: "trigger",
    data: {
      label: "Manual",
      config: { triggerType: "Manual" },
    },
  };
}

function httpPost(id, label, url, bodyTemplate) {
  return {
    id,
    type: "action",
    data: {
      label,
      config: {
        actionType: "HTTP Request",
        endpoint: url,
        httpMethod: "POST",
        httpHeaders: JSON.stringify({
          "Content-Type": "application/json",
          "X-Exit-Guard-Key": SERVICE_KEY,
        }),
        httpBody: bodyTemplate,
        timeout: 30,
        failOnError: true,
      },
    },
  };
}

function httpGet(id, label, url) {
  return {
    id,
    type: "action",
    data: {
      label,
      config: {
        actionType: "HTTP Request",
        endpoint: url,
        httpMethod: "GET",
        httpHeaders: JSON.stringify({
          "X-Exit-Guard-Key": SERVICE_KEY,
        }),
        timeout: 15,
        failOnError: true,
      },
    },
  };
}

const definitions = [
  {
    name: "Exit Guard — Health",
    description:
      "Liveness + x402 config for Exit Guard (Base exit layer for agents). Returns executor address and payment settings.",
    slug: "exit-guard-health",
    price: "0.01",
    workflowType: "read",
    category: "defi",
    chain: "base",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    nodes: [manualTrigger(), httpGet("step-1", "Health", `${EG}/health`)],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  },
  {
    name: "Exit Guard — Register Position",
    description:
      "Register a Base Uniswap V3 position with a stop price on Exit Guard. Free evaluate later; paid exit via exit-guard-exit.",
    slug: "exit-guard-register",
    price: "0.01",
    workflowType: "read",
    category: "defi",
    chain: "base",
    inputSchema: {
      type: "object",
      required: ["owner", "token", "stopPrice"],
      properties: {
        owner: { type: "string", description: "Agent wallet holding the ERC-20" },
        token: { type: "string", description: "ERC-20 token address on Base" },
        stopPrice: { type: "number", description: "Stop-loss human price vs pool quote" },
        feeTier: { type: "number", description: "Uniswap V3 fee tier (e.g. 500, 3000, 10000)" },
      },
      additionalProperties: false,
    },
    nodes: [
      manualTrigger(),
      httpPost(
        "step-1",
        "Register",
        `${EG}/v1/positions`,
        JSON.stringify({
          owner: "{{@trigger-1:Manual.owner}}",
          token: "{{@trigger-1:Manual.token}}",
          stopPrice: "{{@trigger-1:Manual.stopPrice}}",
          feeTier: "{{@trigger-1:Manual.feeTier}}",
        })
      ),
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  },
  {
    name: "Exit Guard — Evaluate",
    description:
      "Free-on-server check of stop/target + readiness (enrolled/allowance). Never executes a swap. Marketplace call fee applies.",
    slug: "exit-guard-evaluate",
    price: "0.01",
    workflowType: "read",
    category: "defi",
    chain: "base",
    inputSchema: {
      type: "object",
      required: ["positionId"],
      properties: {
        positionId: {
          type: "string",
          description: "Position id returned by exit-guard-register",
        },
      },
      additionalProperties: false,
    },
    nodes: [
      manualTrigger(),
      httpPost(
        "step-1",
        "Evaluate",
        `${EG}/v1/positions/{{@trigger-1:Manual.positionId}}/evaluate`,
        "{}"
      ),
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  },
  {
    name: "Exit Guard — Exit Position",
    description:
      "Simulate then exit a position through Exit Guard + KeeperHub executor on Base. Requires owner enrolled + token approved. Pay-per-call via x402; completion fee only if swap lands.",
    slug: "exit-guard-exit",
    price: "0.05",
    workflowType: "write",
    category: "defi",
    chain: "base",
    inputSchema: {
      type: "object",
      required: ["positionId"],
      properties: {
        positionId: {
          type: "string",
          description: "Position id from exit-guard-register",
        },
      },
      additionalProperties: false,
    },
    nodes: [
      manualTrigger(),
      httpPost(
        "step-1",
        "Exit",
        `${EG}/v1/positions/{{@trigger-1:Manual.positionId}}/exit`,
        "{}"
      ),
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  },
];

async function upsertAndList(def) {
  // Find existing by name or create
  const all = await api("GET", "/api/workflows");
  let wf = all.find((w) => w.name === def.name || w.listedSlug === def.slug);
  if (!wf) {
    console.log("Creating", def.name);
    wf = await api("POST", "/api/workflows/create", {
      name: def.name,
      description: def.description,
      enabled: true,
      nodes: def.nodes,
      edges: def.edges,
    });
  } else {
    console.log("Updating", def.name, wf.id);
    await api("PATCH", `/api/workflows/${wf.id}`, {
      name: def.name,
      description: def.description,
      enabled: true,
      nodes: def.nodes,
      edges: def.edges,
    });
  }

  // List on marketplace
  console.log("Listing", def.slug, "at", def.price, "USDC");
  const listed = await api("PATCH", `/api/workflows/${wf.id}`, {
    description: def.description,
    isListed: true,
    listedSlug: def.slug,
    priceUsdcPerCall: def.price,
    inputSchema: def.inputSchema,
    workflowType: def.workflowType,
    category: def.category,
    chain: def.chain,
    enabled: true,
  });

  return {
    id: listed.id ?? wf.id,
    slug: listed.listedSlug ?? def.slug,
    price: listed.priceUsdcPerCall ?? def.price,
    isListed: listed.isListed,
    callUrl: `${BASE}/api/mcp/workflows/${def.slug}/call`,
  };
}

const results = [];
for (const def of definitions) {
  try {
    results.push(await upsertAndList(def));
  } catch (e) {
    console.error("FAILED", def.slug, e.message);
    results.push({ slug: def.slug, error: e.message });
  }
}

console.log("\n=== MARKETPLACE LISTINGS ===");
console.log(JSON.stringify(results, null, 2));
fs.writeFileSync("scripts/marketplace-listings.json", JSON.stringify(results, null, 2));

// Verify catalog search
const catalog = await api("GET", "/api/mcp/workflows");
const ours = (catalog.items || []).filter((i) => String(i.listedSlug || "").startsWith("exit-guard"));
console.log("\nFound in public catalog:", ours.map((i) => `${i.listedSlug}@${i.priceUsdcPerCall}`).join(", ") || "(none yet)");

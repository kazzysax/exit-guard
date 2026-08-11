/**
 * Unit tests for x402 pricing + payload decoding — no network required.
 */
process.env.KEEPERHUB_API_KEY = "kh_test";
process.env.KEEPERHUB_WALLET_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.X402_ENABLED = "true";
process.env.X402_PAY_TO = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
process.env.X402_CALL_PRICE_USDC = "0.02";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${detail}`);
  if (!ok) failures++;
};

async function main() {
  const { toAtomicUsdc, decodePaymentPayload, resolvePayTo, isX402Active } = await import(
    "../src/x402.js"
  );

  check("0.02 dollars → 20000 atomic", toAtomicUsdc("0.02") === "20000");
  check("$0.02 → 20000 atomic", toAtomicUsdc("$0.02") === "20000");
  check("already atomic 20000 passthrough", toAtomicUsdc("20000") === "20000");
  // Bare integers are atomic units (x402 wire format). Use "$1" or "1.0" for one dollar.
  check("bare integer 1 stays atomic", toAtomicUsdc("1") === "1");
  check("$1 → 1000000 atomic", toAtomicUsdc("$1") === "1000000");
  check("1.0 dollars → 1000000 atomic", toAtomicUsdc("1.0") === "1000000");
  check("$0.001 → 1000 atomic", toAtomicUsdc("$0.001") === "1000");

  const obj = { x402Version: 1, scheme: "exact", payload: { foo: 1 } };
  const raw = JSON.stringify(obj);
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  check("decode raw JSON payload", JSON.stringify(decodePaymentPayload(raw)) === raw);
  check("decode base64 JSON payload", JSON.stringify(decodePaymentPayload(b64)) === raw);

  check("resolvePayTo checksums configured address", Boolean(resolvePayTo()));
  check("isX402Active when enabled + payTo set", isX402Active() === true);

  console.log(failures === 0 ? "\nALL X402 TESTS PASSED" : `\n${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();

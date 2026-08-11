/**
 * Keep-alive pinger for hosts that sleep idle free tiers (e.g. Render).
 *
 * Hits KEEPALIVE_URL (or RENDER_EXTERNAL_URL + /ping) every KEEPALIVE_INTERVAL_MS
 * (default 60s). External Render cron is preferred for cold starts; this loop
 * keeps the process warm once it is already running.
 */
export function startKeepAlive(): void {
  const explicit = (process.env.KEEPALIVE_URL ?? "").trim();
  const renderBase = (process.env.RENDER_EXTERNAL_URL ?? process.env.PUBLIC_URL ?? "").trim();
  const url =
    explicit ||
    (renderBase ? `${renderBase.replace(/\/$/, "")}/ping` : "");

  if (!url) {
    console.log("[keepalive] disabled (set KEEPALIVE_URL or RENDER_EXTERNAL_URL)");
    return;
  }

  const intervalMs = Math.max(
    15_000,
    Number(process.env.KEEPALIVE_INTERVAL_MS ?? 60_000) || 60_000
  );

  const tick = async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "exit-guard-keepalive/1" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[keepalive] ${url} → HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[keepalive] ${url} failed: ${String(err)}`);
    }
  };

  console.log(`[keepalive] every ${intervalMs / 1000}s → ${url}`);
  // First tick after one interval so boot is not delayed.
  setInterval(() => {
    void tick();
  }, intervalMs);
}

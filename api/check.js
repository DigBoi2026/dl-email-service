// /api/check — machine-readable health of the product system.
//
//   200 → healthy
//   503 → something is wrong (a product is unbuyable, or nothing is recommendable)
//   502 → COULD NOT VERIFY (Shopify unreachable / no credentials)
//
// Point any uptime monitor or a Vercel cron at this. An abandoned-cart flow is
// evergreen: it keeps sending for months after anyone last looked at it, so the
// store drifting underneath a static template is the normal case, not the edge case.
// A deploy-time check cannot catch that; a recurring one can.
//
// 502 is deliberately NOT 200. "I couldn't check" must never read as "all good".

import { getCatalog } from "../lib/catalog.js";
import { recommend } from "../lib/recommend.js";
import cfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const catalog = await getCatalog(cfg, { force: true });

    if (!catalog.ok) {
      return res.status(502).json({
        status: "unverified",
        error: catalog.error,
        detail: "Could not reach Shopify — this is NOT a pass.",
      });
    }

    const products = Object.values(catalog.byKey);
    const unavailable = products.filter((p) => p.available === false);
    const noPrice = products.filter((p) => p.available !== false && !Number.isFinite(p.price));
    const lowStock = products.filter(
      (p) => p.available !== false && Number.isFinite(p.inventory) && p.inventory <= 5
    );

    // Can the engine still produce a recommendation for a cold visitor?
    const rec = recommend({}, cfg, copurchase, catalog);

    const problems = [
      ...unavailable.map((p) => `${p.key}: ${p.status === "NOT_FOUND" ? "not in Shopify" : "unavailable"}`),
      ...noPrice.map((p) => `${p.key}: no price`),
      ...(rec.keys.length ? [] : ["engine returns no recommendation"]),
    ];

    return res.status(problems.length ? 503 : 200).json({
      status: problems.length ? "degraded" : "healthy",
      checkedAt: new Date().toISOString(),
      problems,
      warnings: lowStock.map((p) => `${p.key}: only ${p.inventory} left`),
      products: products.length,
      buyable: products.filter((p) => p.available !== false).length,
      sampleRecommendation: rec.keys,
    });
  } catch (e) {
    console.error("check.js error:", e);
    return res.status(502).json({ status: "unverified", error: String(e?.message || e) });
  }
}

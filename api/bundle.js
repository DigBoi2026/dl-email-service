// /api/bundle — recommendation → cart. Rules first, mined data second, fallback last.
//
//   /api/bundle?kid={{ person.KlaviyoID }}&c=site-kit
//   /api/bundle?kid=...&anchor=VARIANT_ID:1&c=...
//
// Decision logic lives in lib/recommend.js (pure, testable, ~0ms). This file just
// does the I/O: fetch history → resolve → stock-check → build cart → redirect →
// write back to Klaviyo in the background.

import { getProfile, setProperties, trackEvent } from "../lib/klaviyo.js";
import { getPurchasedItems, getVariantStock } from "../lib/shopify.js";
import { recommend } from "../lib/recommend.js";
import { afterResponse } from "../lib/background.js";
import cfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

export default async function handler(req, res) {
  const { kid, anchor = "", c = "bundle", cart = "" } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";

  const go = (url) => {
    url.searchParams.set("utm_source", "klaviyo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", c.replace(/[^\w-]/g, ""));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  };
  const fallback = () => go(new URL(`https://${shop}/collections/all`));

  try {
    if (req.method !== "GET") return fallback();

    // CART context — what they're buying right now (abandoned-cart flows).
    // This is what drives FIRST-ORDER AOV: a first-time buyer has no history.
    // Klaviyo can template item names into &cart=... (see README).
    const cartTitles = cart ? cart.split("|").map((s) => s.trim()).filter(Boolean) : [];

    // HISTORY context — what they've bought before. Skip the lookup entirely when
    // we already have cart context and no kid: saves an API round-trip.
    let historyItems = [];
    if (kid) {
      const email = (await getProfile(kid))?.attributes?.email;
      if (email) historyItems = await getPurchasedItems(email);
    }

    // resolve (rules → co-purchase → fallback)
    const { keys, reason, source, ruleId, trigger, confidence, telemetry, degraded } = recommend(
      { cartTitles, historyItems }, cfg, copurchase
    );

    // Surface blind spots in the logs. An unrecognised product silently drops a
    // customer to fallback forever — this is how you find out it happened.
    if (telemetry.warnings.length) console.warn("recommend warnings:", { kid, warnings: telemetry.warnings });
    if (!keys.length) return fallback();

    // stock-check; skip unset placeholders
    const items = [];
    for (const k of keys) {
      const p = cfg.products[k];
      if (!p?.variant || !/^\d+$/.test(p.variant)) continue;
      try {
        const v = await getVariantStock(p.variant);
        if (v?.availableForSale) items.push({ key: k, pair: `${p.variant}:${p.qty || 1}`, title: p.title });
      } catch { items.push({ key: k, pair: `${p.variant}:${p.qty || 1}`, title: p.title }); }
    }
    if (/^\d+:\d+$/.test(anchor)) items.unshift({ key: "anchor", pair: anchor, title: "anchor" });
    if (!items.length) return fallback();

    // cart → customer goes now
    const dest = new URL(`https://${shop}/cart/${items.map((i) => i.pair).join(",")}`);
    if (cfg.discount) dest.searchParams.set("discount", cfg.discount);
    go(dest);

    // bookkeeping behind them
    if (kid) {
      await afterResponse(
        Promise.all([
          setProperties(kid, {
            last_bundle_offer: ruleId || source,
            last_bundle_items: items.map((i) => i.key).join(","),
            last_bundle_source: source,
            last_bundle_trigger: trigger || "",
            last_bundle_confidence: confidence,
            last_bundle_at: new Date().toISOString(),
          }),
          trackEvent(kid, "Clicked Bundle Offer", {
            rule: ruleId || source,
            source,
            reason,
            trigger: trigger || "",
            confidence,
            degraded: !!degraded,
            is_fleet: telemetry.isFleet,
            items: items.map((i) => i.title),
            campaign: c,
          }),
        ])
      );
    }
    return;
  } catch (e) {
    console.error("bundle.js error:", e);
    return fallback();
  }
}

// /api/go — smart one-click cart. Shopify permalink + discount + UTMs,
// now state-aware: expired campaigns redirect to their evergreen page, and
// out-of-stock variants are dropped from the cart (with full-OOS fallback).
//
//   /api/go?items=45678901234567:1&discount=KEEPDIGGING10&c=eofy-jul26
//
// `c` doubles as the campaign key in config/campaigns.json. Unknown keys just
// pass through (plain cart link) so nothing ever breaks.

import { getVariantStock } from "../lib/shopify.js";
import campaigns from "../config/campaigns.json" with { type: "json" };

export default async function handler(req, res) {
  const { items = "", discount = "", c = "email" } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";

  const go = (url) => {
    url.searchParams.set("utm_source", "klaviyo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", c.replace(/[^\w-]/g, ""));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  };

  try {
    // 1) Expired campaign? Send to its evergreen destination instead of a dead offer.
    const cfg = campaigns[c];
    if (cfg?.endsAt && Date.now() > new Date(cfg.endsAt).getTime()) {
      return go(new URL(cfg.endedRedirect || `https://${shop}/collections/all`));
    }

    // 2) Validate + stock-check items (drop anything unavailable).
    let pairs = items
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+:\d+$/.test(s));

    if (pairs.length && process.env.SHOPIFY_ADMIN_TOKEN) {
      const checked = await Promise.all(
        pairs.map(async (p) => {
          try {
            const v = await getVariantStock(p.split(":")[0]);
            return v?.availableForSale ? p : null;
          } catch { return p; } // on lookup failure, keep the item — Shopify cart will handle it
        })
      );
      pairs = checked.filter(Boolean);
      if (!pairs.length) return go(new URL(`https://${shop}/collections/all`));
    }

    const dest = new URL(pairs.length ? `https://${shop}/cart/${pairs.join(",")}` : `https://${shop}/cart`);
    if (discount && /^[A-Za-z0-9_-]+$/.test(discount)) dest.searchParams.set("discount", discount);
    return go(dest);
  } catch (e) {
    console.error("go.js error:", e);
    return go(new URL(`https://${shop}/cart`));
  }
}

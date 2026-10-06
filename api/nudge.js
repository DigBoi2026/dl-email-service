// /api/nudge — $399 NUDGE VERSION click handler.
//
//   /api/nudge?kid={{ person.KlaviyoID }}&value={{ event.extra.total_price }}&c=ac-covers-msg1
//   /api/nudge?...&items=45678:1,45679:2        (current cart pairs, so we ADD not REPLACE)
//   /api/nudge?...&debug=1                      (returns JSON instead of redirecting)
//
// Reader is $X off free shipping. They tap "add it & unlock free shipping".
// We work out the best gap-bridging product (lib/nudge.js), then land them in a
// cart that already contains it.
//
// Cart handling — important:
//   • With `items` (the email passes the current cart): we rebuild the FULL cart
//     permalink `/cart/a:1,b:2,pick:1` so nothing they had is lost.
//   • Without `items`: we use `/cart/add?id=…` which appends to whatever session
//     cart they already have, rather than replacing it.
//
// Safety: this only ever BUILDS a cart. It never charges and never places an order.

import { nudge399 } from "../lib/nudge.js";
import { parseItemsParam } from "../lib/recommend.js";
import { getProfile, trackEvent } from "../lib/klaviyo.js";
import { getPurchasedTitles } from "../lib/shopify.js";
import recommendCfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

export default async function handler(req, res) {
  const { kid = "", value = "", items = "", cart = "", c = "nudge399", debug = "" } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";
  const fallback = new URL(`https://${shop}/cart`);

  const go = (url) => {
    url.searchParams.set("utm_source", "klaviyo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", String(c).replace(/[^\w-]/g, ""));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  };

  try {
    // Cart context. `cart` is a pipe-joined list of product titles from the email.
    const cartTitles = String(cart).split("|").map((s) => s.trim()).filter(Boolean);

    // History (optional) makes the pairing smarter — skip silently if we can't get it.
    let historyTitles = [];
    if (kid) {
      try {
        const profile = await getProfile(kid);
        const email = profile?.attributes?.email;
        if (email) historyTitles = await getPurchasedTitles(email);
      } catch { /* non-fatal — relevance just gets a bit more generic */ }
    }

    const result = await nudge399(
      { cartValue: Number(value), cartItems: parseItemsParam(items), cartTitles, historyTitles },
      recommendCfg,
      copurchase
    );

    if (debug) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(JSON.stringify(result, null, 2));
    }

    const pick = result.pick;
    if (!pick?.variant) return go(fallback);

    // Fire-and-forget analytics so we can measure whether the nudge actually lifts AOV.
    if (kid) {
      trackEvent(kid, "Clicked Free Shipping Nudge", {
        campaign: c,
        state: result.state,
        gap: result.gap,
        threshold: result.threshold,
        product: pick.title,
        price: pick.price,
        crosses_threshold: !!pick.crosses,
      }).catch(() => {});
    }

    const pair = `${pick.variant}:${pick.qty || 1}`;

    // Preserve the existing cart where the email told us what's in it.
    const existing = String(items)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+:\d+$/.test(s));

    if (existing.length) {
      const dest = new URL(`https://${shop}/cart/${[...existing, pair].join(",")}`);
      return go(dest);
    }

    // Otherwise append to whatever session cart they have.
    const dest = new URL(`https://${shop}/cart/add`);
    dest.searchParams.set("id", pick.variant);
    dest.searchParams.set("quantity", String(pick.qty || 1));
    dest.searchParams.set("return_to", "/cart");
    return go(dest);
  } catch (e) {
    console.error("nudge.js error:", e);
    return go(fallback);
  }
}

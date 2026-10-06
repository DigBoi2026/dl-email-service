// /api/add — add one recommended grid product to the shopper's EXISTING cart.
//   /api/add?slot=0|1|2&value=<cartTotal>&items=<variantId:qty:productId,...>&c=<slug>
//
// Resolves the Nth grid pick from the SAME engine the slot image used, so the
// product added is always the product shown.
//
// WHY NOT A CART PERMALINK: /cart/<variant>:<qty>,… REPLACES the cart with exactly
// what the URL lists. Rebuilding it from the email's line_items therefore wiped
// anything the shopper added after the abandoned-cart event fired, along with cart
// attributes and notes — it looked like "add to cart" but behaved like "reset cart
// to this snapshot". /cart/add appends to the live session cart and leaves the rest
// of it alone, which is what the button claims to do.
//
// PRODUCT-PAGE FALLBACK: adding a specific variant is only safe when there is one.
// The DiggerShield Kit has 30 variants (one per machine), the Pro Excavator
// Enclosure 6, KAJO 6 — silently adding "Style 1 / Medium" to someone with a
// different machine ships the wrong part. Anything multi-variant goes to the
// product page so the shopper picks their own fitment. variantCount comes from
// Shopify at request time, so a product that gains variants starts deferring on
// its own rather than waiting for someone to notice.
import { nudge399 } from "../lib/nudge.js";
import { parseItemsParam } from "../lib/recommend.js";
import recommendCfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

export default async function handler(req, res) {
  // `all` is still accepted so links in already-delivered sends keep working; it is
  // no longer read, because the cart is never rebuilt now.
  const { slot = "0", value = "", items = "", c = "rec" } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";
  const go = (url) => {
    url.searchParams.set("utm_source", "klaviyo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", String(c).replace(/[^\w-]/g, ""));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  };
  try {
    const model = await nudge399(
      { cartValue: Number(value), cartItems: parseItemsParam(items) },
      recommendCfg, copurchase
    );
    const n = Math.max(0, Math.min(2, Number(slot) || 0));
    const pick = (model.grid || [])[n];

    // Engine had nothing for this slot — send them to the cart rather than nowhere.
    if (!pick?.variant) return go(new URL(`https://${shop}/cart`));

    // Multi-variant (or unknown variant count) → let them choose on the product page.
    // `variantCount === null` means Shopify didn't answer; deferring is the safe read.
    const mustChoose = pick.variantCount === null || Number(pick.variantCount) > 1;
    if (mustChoose && pick.handle) {
      return go(new URL(`https://${shop}/products/${pick.handle}`));
    }

    // Single variant → append it to whatever is already in their cart.
    const dest = new URL(`https://${shop}/cart/add`);
    dest.searchParams.set("id", String(pick.variant));
    dest.searchParams.set("quantity", String(pick.qty || 1));
    dest.searchParams.set("return_to", "/cart");
    return go(dest);
  } catch (e) {
    console.error("add.js error:", e);
    return go(new URL(`https://${shop}/cart`));
  }
}

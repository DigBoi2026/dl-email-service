// /api/reorder — one-click "buy it again".
//
//   /api/reorder?kid={{ person.KlaviyoID }}&discount=THANKS10&c=kajo-60day
//
// Flow: Klaviyo ID → profile email → last paid Shopify order → rebuild cart with the
// same (still-available) items → redirect to /cart permalink, discount pre-applied.
// If anything is missing (no orders, all items OOS), falls back to the collection page
// so the click is never wasted.
//
// Safety: this only BUILDS a cart — it never charges. Klaviyo IDs are long opaque
// strings, so links aren't practically guessable; worst case a crafted link shows a
// pre-filled cart, it cannot expose personal details or place an order.

import { getProfile, trackEvent } from "../lib/klaviyo.js";
import { getLastOrderItems } from "../lib/shopify.js";

export default async function handler(req, res) {
  const { kid, discount = "", c = "reorder" } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";
  const fallback = new URL(`https://${shop}/collections/all`);

  const go = (url) => {
    url.searchParams.set("utm_source", "klaviyo");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", c.replace(/[^\w-]/g, ""));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url.toString());
  };

  try {
    if (req.method !== "GET" || !kid) return go(fallback);

    const profile = await getProfile(kid);
    const email = profile?.attributes?.email;
    if (!email) return go(fallback);

    const items = await getLastOrderItems(email);
    if (!items?.length) return go(fallback);

    await trackEvent(kid, "Clicked Reorder", { items: items.map((i) => i.title), campaign: c }).catch(() => {});

    const pairs = items.map((i) => `${i.variantId}:${i.quantity}`).join(",");
    const dest = new URL(`https://${shop}/cart/${pairs}`);
    if (discount && /^[A-Za-z0-9_-]+$/.test(discount)) dest.searchParams.set("discount", discount);
    return go(dest);
  } catch (e) {
    console.error("reorder.js error:", e);
    return go(fallback);
  }
}

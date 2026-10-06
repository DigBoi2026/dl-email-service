// /api/review — in-email star rating. Each star in the email is a link:
//
//   /api/review?stars=4&kid={{ person.KlaviyoID }}
//              &sku=KAJO-450G
//              &next=https%3A%2F%2F<your-review-platform-form-url>
//
// Records "Left In-Email Rating" event + `last_rating` property in Klaviyo,
// then redirects to your review platform's form (most platforms — Judge.me,
// Okendo, REVIEWS.io — accept a rating/star query param to pre-fill; wire that
// into `next` per platform).
//
// Segmentation gold: route 1–3 star clicks to a "talk to us" page instead of the
// public review form. Pass a different `next` per star in the block HTML.

import { afterResponse } from "../lib/background.js";

const KLAVIYO_REVISION = "2024-10-15";

export default async function handler(req, res) {
  const { stars, kid, sku = "", next } = req.query;
  const fallback = `https://${process.env.SHOP_DOMAIN || "diggerlid.com"}`;
  const dest = next && next.startsWith("https://") ? next : fallback;
  const n = parseInt(stars, 10);

  const redirect = () => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, dest);
  };

  try {
    if (req.method !== "GET" || !kid || !(n >= 1 && n <= 5)) return redirect();

    const headers = {
      "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      "revision": KLAVIYO_REVISION,
    };

    // Straight to the review form — writes happen behind them.
    redirect();
    await afterResponse(
      Promise.all([
        fetch(`https://a.klaviyo.com/api/profiles/${encodeURIComponent(kid)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            data: { type: "profile", id: kid, attributes: { properties: { last_rating: n, last_rating_sku: sku } } },
          }),
        }),
        fetch("https://a.klaviyo.com/api/events", {
          method: "POST",
          headers,
          body: JSON.stringify({
            data: {
              type: "event",
              attributes: {
                metric: { data: { type: "metric", attributes: { name: "Left In-Email Rating" } } },
                profile: { data: { type: "profile", id: kid } },
                properties: { stars: n, sku },
                value: n,
              },
            },
          }),
        }),
      ])
    );
    return;
  } catch (e) {
    console.error("review.js error:", e);
  }
  return redirect();
}

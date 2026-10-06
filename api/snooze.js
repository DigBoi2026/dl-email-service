// /api/snooze — one-tap inbox self-service (the churn-saver footer).
//
//   /api/snooze?days=30&kid={{ person.KlaviyoID }}     → sets email_snooze_until
//   /api/snooze?mode=monthly&kid=...                   → sets email_frequency=monthly
//   /api/snooze?mode=sales_only&kid=...                → sets email_frequency=sales_only
//
// Then in Klaviyo, add to every campaign's excluded segment:
//   email_snooze_until (date) is after TODAY  →  skip
//   email_frequency = monthly → only include in the monthly digest
// This gives people an alternative to unsubscribing — Zaymo's retention play, free.

import { setProperties, trackEvent } from "../lib/klaviyo.js";
import { afterResponse } from "../lib/background.js";

const MODES = new Set(["monthly", "sales_only", "everything"]);

export default async function handler(req, res) {
  const { kid, days, mode } = req.query;
  const shop = process.env.SHOP_DOMAIN || "diggerlid.com";
  const dest = `https://${shop}/pages/email-preferences-updated`; // simple confirmation page

  const redirect = () => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, dest);
  };

  try {
    if (req.method !== "GET" || !kid) return redirect();

    const props = {};
    const n = parseInt(days, 10);
    if (n >= 1 && n <= 365) {
      props.email_snooze_until = new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    }
    if (mode && MODES.has(mode)) props.email_frequency = mode;
    if (!Object.keys(props).length) return redirect();

    redirect();
    await afterResponse(
      Promise.all([
        setProperties(kid, props),
        trackEvent(kid, "Updated Email Preferences In-Email", props),
      ])
    );
    return;
  } catch (e) {
    console.error("snooze.js error:", e);
  }
  return redirect();
}

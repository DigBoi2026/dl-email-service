// /api/answer — in-email survey/quiz answer capture.
// Click → set Klaviyo profile property → redirect. Works in every email client.
//
// URL shape (generate with `node lib/sign.js`):
//   /api/answer?prop=machine_type&val=excavator_1_2t
//              &kid={{ person.KlaviyoID }}
//              &next=https%3A%2F%2Fdiggerlid.com%2Fpages%2Fthanks
//              &sig=<hmac of prop|val|next>
//
// Notes:
// - `kid` is injected by Klaviyo at send time, so it is NOT part of the signature
//   (we can't sign per-recipient inside Klaviyo). The sig locks prop/val/next so
//   strangers can't write arbitrary properties.
// - Also fires a "Answered In-Email Survey" event so you can trigger flows off it.

import crypto from "node:crypto";
import { afterResponse } from "../lib/background.js";

const KLAVIYO_REVISION = "2024-10-15";

function verify(params, secret) {
  const base = `${params.prop}|${params.val}|${params.next || ""}`;
  const expected = crypto.createHmac("sha256", secret).update(base).digest("hex").slice(0, 20);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.sig || "".padEnd(20, "0")));
}

export default async function handler(req, res) {
  const { prop, val, kid, next, sig } = req.query;
  const fallback = `https://${process.env.SHOP_DOMAIN || "diggerlid.com"}`;
  const dest = next && next.startsWith("https://") ? next : fallback;

  // Always redirect the human, even if the write fails — never show an error page from an email click.
  const redirect = () => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, dest);
  };

  try {
    if (req.method !== "GET") return res.status(405).end(); // ignore SafeLinks HEAD probes
    if (!prop || !val || !kid) return redirect();
    // Click-only survey: cart_survey accepts a closed option enum UNSIGNED, so the
    // abandoned-cart emails need no per-link signing step. The value space is the
    // whole exposure — nobody can write arbitrary data through this door. Every
    // other property still requires the HMAC.
    const OPEN = { cart_survey: /^option[1-9]$/ };
    const openOk = OPEN[prop] && OPEN[prop].test(String(val));
    if (!openOk && !verify({ prop, val, next, sig }, process.env.LINK_SECRET)) return redirect();

    // READABLE SURVEY LABELS (Matthew, 2026-08-13). The link carries val=option<N>
    // (a closed enum — the security boundary), but we write the FULL human answer
    // to the profile so "cart_survey" reads "Just browsing", not "option5". All
    // three abandoned-cart branches share these exact 6 options, so one map serves
    // the whole flow. The raw slug is kept alongside (cart_survey_option) for
    // compact segmentation. option7-9 (unused today) fall back to the slug.
    const SURVEY_LABELS = {
      option1: "Price was more than I was expecting",
      option2: "I was unsure about a feature or details",
      option3: "Shipping uncertainty",
      option4: "I already bought another solution",
      option5: "Just browsing",
      option6: "Not the right time",
    };
    const isSurvey = prop === "cart_survey" && openOk;
    const label = isSurvey ? (SURVEY_LABELS[val] || val) : val;

    const headers = {
      "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      "Content-Type": "application/json",
      "revision": KLAVIYO_REVISION,
    };

    // Send the customer on their way IMMEDIATELY — they don't wait on our writes.
    redirect();

    // ...then do the bookkeeping in the background (parallel, not sequential).
    await afterResponse(
      Promise.all([
        // 1) Set the profile property
        fetch(`https://a.klaviyo.com/api/profiles/${encodeURIComponent(kid)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            data: {
              type: "profile",
              id: kid,
              attributes: { properties: {
                [prop]: label,
                ...(isSurvey ? { [`${prop}_option`]: val } : {}),
                [`${prop}_answered_at`]: new Date().toISOString(),
              } },
            },
          }),
        }),
        // 2) Fire an event (flow trigger / reporting)
        fetch("https://a.klaviyo.com/api/events", {
          method: "POST",
          headers,
          body: JSON.stringify({
            data: {
              type: "event",
              attributes: {
                metric: { data: { type: "metric", attributes: { name: "Answered In-Email Survey" } } },
                profile: { data: { type: "profile", id: kid } },
                properties: { question: prop, answer: label, ...(isSurvey ? { option: val } : {}) },
              },
            },
          }),
        }),
      ])
    );
    return;
  } catch (e) {
    console.error("answer.js error:", e);
  }
  return redirect();
}

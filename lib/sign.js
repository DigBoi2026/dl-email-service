// Generate a signed /api/answer href for a Klaviyo block.
//
//   LINK_SECRET=yoursecret node lib/sign.js machine_type excavator_1_2t [nextUrl]
//
// Paste the output into your block. `{{ person.KlaviyoID }}` stays as a literal —
// Klaviyo replaces it at send time.

import crypto from "node:crypto";

const [, , prop, val, next = ""] = process.argv;
const secret = process.env.LINK_SECRET;
const base = process.env.BASE_URL || "https://email.diggerlid.com";

if (!prop || !val || !secret) {
  console.error("Usage: LINK_SECRET=... node lib/sign.js <prop> <val> [nextUrl]");
  process.exit(1);
}

const sig = crypto.createHmac("sha256", secret).update(`${prop}|${val}|${next}`).digest("hex").slice(0, 20);

const url =
  `${base}/api/answer?prop=${encodeURIComponent(prop)}` +
  `&val=${encodeURIComponent(val)}` +
  (next ? `&next=${encodeURIComponent(next)}` : "") +
  `&sig=${sig}` +
  `&kid={{ person.KlaviyoID }}`;

console.log(url);

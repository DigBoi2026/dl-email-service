// Validate the product system against live Shopify.
//
//   node scripts/check-catalog.js [--templates <dir>]
//
// Exit codes:  0 = healthy   1 = problems found   2 = COULD NOT VERIFY
//
// The 2 matters. A checker that reports "all good" when it couldn't reach Shopify is
// worse than no checker, because it converts an unknown into a false assurance. If
// credentials are missing or the API is down, this fails loudly instead.
//
// WHY THIS EXISTS: an abandoned-cart flow is EVERGREEN. It keeps sending for months
// after anyone last looked at it, so a build-time check is necessary but nowhere near
// sufficient — the store moves underneath a template that never changes. Run this on a
// schedule, not just at deploy. (/api/check serves the same result over HTTP so an
// uptime monitor can watch it.)

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getCatalog } from "../lib/catalog.js";
import cfg from "../config/recommend.json" with { type: "json" };

const args = process.argv.slice(2);
const templatesDir = args.includes("--templates") ? args[args.indexOf("--templates") + 1] : null;

const problems = [];
const warnings = [];
const say = (s = "") => console.log(s);

say("Checking product catalog against live Shopify…\n");

// ── 1. templates must not have re-grown hardcoded product facts ────────────
if (templatesDir) {
  say("  templates:");
  let files = [];
  try {
    files = readdirSync(templatesDir).filter((f) => f.endsWith(".html") && !f.startsWith("_"));
  } catch (e) {
    problems.push(`cannot read templates dir: ${e.message}`);
  }
  for (const f of files) {
    const html = readFileSync(join(templatesDir, f), "utf8");
    const found = [];
    // a literal variant id (not inside a Liquid loop) is a fact that will drift
    for (const id of new Set([...html.matchAll(/items=(\d+):\d+/g)].map((m) => m[1]))) {
      const known = Object.values(cfg.products).some((p) => String(p.variant) === id);
      found.push(`hardcoded variant ${id}${known ? "" : " (not even in config)"}`);
    }
    if (/cdn\.shopify\.com\/s\/files/.test(html) && /api\/img\?type=mate/.test(html) === false)
      found.push("hardcoded Shopify product image");
    // A double quote inside a double-quoted attribute silently ENDS it. Liquid filter
    // args are the usual culprit — stringformat:"s" inside href="..." — and Klaviyo
    // rejects the whole template with a cryptic sanitizer error, no line number.
    //
    // Detection is by the SYMPTOM, not the cause: take everything up to the next quote
    // and look at what follows it. A well-formed attribute is followed by whitespace,
    // > or /. Anything else means the quote closed the attribute early.
    for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const after = html[m.index + m[0].length];
      if (after !== undefined && !/[\s>/]/.test(after) && m[1].includes("{%")) {
        found.push(`attribute terminated early by a quote inside Liquid (use single quotes): …${m[1].slice(-46)}"${after}`);
      }
    }
    // Liquid {% if/for %} as a BARE child of <table> (between </tr> and <tr>) is invalid
    // HTML; the parser foster-parents the tag OUT of the table, leaking raw "{% ... %}"
    // to the top of the email. Wrap such conditionals inside a <td> instead.
    if (/<\/tr>\s*\{%\s*(?:if|else|endif|for|endfor)\b/.test(html))
      found.push("Liquid tag is a bare child of <table> (foster-parenting → leaks to top); put it inside a <td>");
    // The cart total is `$value`, which sits at the event_properties ROOT — a SIBLING of
    // `$extra`, not inside it. Template-side, `event.extra` IS `$extra` (that dict holds
    // checkout_url and line_items, which is why those resolve). So the total is reached
    // with `event|lookup:'$value'`; `event.extra|lookup:'$value'` is one level too deep.
    // Verified against the live Events API, 2026-07-28.
    // This one FAILS SILENTLY: the lookup yields empty, the image receives value=, and
    // the bar renders a perfectly plausible "You're $0 off free shipping" — no error
    // anywhere. Hence a guard rather than trusting review to catch it.
    if (/event\.extra\s*\|\s*lookup:\s*'\$value'/.test(html))
      found.push("event.extra|lookup:'$value' is one level too deep — $value is a sibling of $extra; use event|lookup:'$value' (silently renders $0)");
    // Klaviyo's template language is DJANGO, not Shopify Liquid. The filters already in
    // these templates prove it (floatformat, stringformat, dictsort, slice, pluralize).
    // A Shopify-only tag parses as UNKNOWN and Klaviyo then refuses the WHOLE template:
    // the preview renders every branch at once with raw tags showing, under the notice
    // "Message displayed without tags or variables". No line number, no partial failure —
    // so one stray {% assign %} silently destroys the entire email.
    //   assign → no Django equivalent; inline the filter at each use site instead.
    //            (Django DOES allow filters inside {% if %}, unlike Shopify Liquid.)
    //   capture/unless/elsif → Shopify spellings of {% with %}/{% if not %}/{% elif %}.
    for (const m of html.matchAll(/\{%\s*(assign|capture|endcapture|unless|endunless|elsif)\b/g))
      found.push(`Shopify-Liquid tag {% ${m[1]} %} — Klaviyo is Django; breaks the WHOLE template`);
    // Liquid inside an HTML comment is still parsed by Klaviyo → stray unclosed tags.
    for (const c of html.match(/<!--[\s\S]*?-->/g) || [])
      if (/\{%/.test(c)) { found.push("Liquid {% %} inside an HTML comment (still parsed — reword the comment)"); break; }

    if (found.length) problems.push(`${f}: ${found.join("; ")}`);
    say(`    ${found.length ? "FAIL" : "ok  "} ${f}${found.length ? " — " + found.join("; ") : ""}`);
  }
}

const catalog = await getCatalog(cfg, { force: true });

if (!catalog.ok) {
  say(`\n  COULD NOT VERIFY — ${catalog.error}`);
  say("  Set SHOPIFY_STORE + (SHOPIFY_CLIENT_ID & SHOPIFY_CLIENT_SECRET, or SHOPIFY_ADMIN_TOKEN), then re-run.");
  for (const p of problems) say(`  FAIL  ${p}`);
  say(`\nRESULT: UNVERIFIED${problems.length ? ` (+${problems.length} template problem(s))` : ""} (exit 2)`);
  process.exit(2);
}

// ── 2. every configured product must be buyable ────────────────────────────
say("  product                     price     stock  status");
for (const key of Object.keys(cfg.products || {})) {
  const p = catalog.byKey[key] || {};
  const state =
    p.available === false ? (p.status === "NOT_FOUND" ? "NOT IN SHOPIFY" : "UNAVAILABLE") : "ok";
  if (p.available === false) problems.push(`${key}: ${state} (variant ${p.variant})`);
  if (p.available !== false && !Number.isFinite(p.price)) problems.push(`${key}: no price`);
  if (p.available !== false && Number.isFinite(p.inventory) && p.inventory <= 5)
    warnings.push(`${key}: only ${p.inventory} left`);
  if (!cfg.products[key].blurb) warnings.push(`${key}: no blurb (card copy will be blank)`);
  say(
    `  ${key.padEnd(26)}${String(p.price ?? "-").padStart(7)}${String(p.inventory ?? "-").padStart(9)}  ${state}`
  );
}

// ── 3. the engine must still be able to say something ──────────────────────
const buyable = Object.values(catalog.byKey).filter((p) => p.available !== false);
if (!buyable.length) problems.push("NOTHING is buyable — every recommendation block will be empty");
else if (buyable.length < 3) warnings.push(`only ${buyable.length} buyable products left`);

// ── report ─────────────────────────────────────────────────────────────────
say("");
for (const w of warnings) say(`  WARN  ${w}`);
for (const p of problems) say(`  FAIL  ${p}`);
say("");
if (problems.length) {
  say(`RESULT: ${problems.length} problem(s), ${warnings.length} warning(s) (exit 1)`);
  process.exit(1);
}
say(`RESULT: healthy${warnings.length ? `, ${warnings.length} warning(s)` : ""} (exit 0)`);

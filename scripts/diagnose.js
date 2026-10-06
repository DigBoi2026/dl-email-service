// scripts/diagnose.js — the honesty check. Run it monthly.
//
//   SHOPIFY_STORE=... SHOPIFY_ADMIN_TOKEN=... node scripts/diagnose.js
//
// Replays your REAL order history through the recommendation engine and reports
// where it's blind. This is the "intelligent" part of the system: not guessing
// better, but knowing what it doesn't know and telling you in plain English.
//
// It answers four questions you can't answer by reading the config:
//   1. What are we failing to recognise?  (silent classification misses — the
//      expensive one: a product you never taught it drops every buyer to fallback,
//      forever, with no error)
//   2. Which rules never fire?            (dead strategy taking up space)
//   3. Which rules fire for everyone?     (a rule that always fires isn't a rule,
//      it's a default — and it's probably masking the ones below it)
//   4. How often do we fall back?         (fallback rate = the share of customers
//      we have nothing intelligent to say to)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shopifyGQL } from "../lib/shopify.js";
import { recommend } from "../lib/recommend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "recommend.json"), "utf8"));
let copurchase = {};
try {
  copurchase = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "copurchase.json"), "utf8"));
} catch {}

const MAX = parseInt(process.env.MAX_ORDERS || "500", 10);

async function fetchCustomerHistories() {
  const byEmail = new Map();
  let cursor = null, fetched = 0;
  while (fetched < MAX) {
    const data = await shopifyGQL(
      `query($n: Int!, $after: String) {
         orders(first: $n, after: $after, query: "financial_status:paid", reverse: true) {
           pageInfo { hasNextPage endCursor }
           nodes {
             createdAt
             email
             lineItems(first: 50) { nodes { title quantity } }
           }
         }
       }`,
      { n: Math.min(100, MAX - fetched), after: cursor }
    );
    for (const o of data.orders.nodes) {
      if (!o.email) continue;
      const items = o.lineItems.nodes.map((li) => ({
        title: li.title, quantity: li.quantity, orderedAt: o.createdAt,
      }));
      byEmail.set(o.email, [...(byEmail.get(o.email) || []), ...items]);
    }
    fetched += data.orders.nodes.length;
    process.stdout.write(`\r  fetched ${fetched} orders...`);
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  process.stdout.write("\n");
  return byEmail;
}

const histories = await fetchCustomerHistories();
const bySource = {}, byRule = {}, unclassified = new Map();
let degraded = 0, fleet = 0, stale = 0, confSum = 0;

for (const items of histories.values()) {
  const r = recommend({ historyItems: items }, cfg, copurchase);
  bySource[r.source] = (bySource[r.source] || 0) + 1;
  if (r.ruleId) byRule[r.ruleId] = (byRule[r.ruleId] || 0) + 1;
  if (r.degraded) degraded++;
  if (r.telemetry.isFleet) fleet++;
  if (r.telemetry.staleKeys.length) stale++;
  confSum += r.confidence;
  for (const t of r.telemetry.unclassified) unclassified.set(t, (unclassified.get(t) || 0) + 1);
}

const n = histories.size || 1;
const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;

console.log(`\n${"=".repeat(64)}`);
console.log(`RECOMMENDATION ENGINE DIAGNOSTIC — ${histories.size} customers`);
console.log("=".repeat(64));

console.log(`\nWHICH LAYER IS DOING THE WORK`);
for (const [s, c] of Object.entries(bySource).sort((a, b) => b[1] - a[1]))
  console.log(`  ${s.padEnd(12)} ${String(c).padStart(5)}  ${pct(c)}`);
console.log(`  avg confidence: ${(confSum / n).toFixed(2)}`);
if ((bySource.fallback || 0) / n > 0.4)
  console.log(`  ⚠ FALLBACK RATE ${pct(bySource.fallback)} — for this many customers we have`);
console.log(`      nothing specific to say. Write rules covering the gaps below.`);

console.log(`\nRULE COVERAGE`);
for (const rule of cfg.rules || []) {
  const c = byRule[rule.id] || 0;
  const flag = c === 0 ? "  ← NEVER FIRES (dead rule or wrong order)"
    : c / n > 0.8 ? "  ← fires for almost everyone; it's a default, and it's masking the rules below it"
    : "";
  console.log(`  ${rule.id.padEnd(26)} ${String(c).padStart(5)}  ${pct(c).padStart(6)}${flag}`);
}

console.log(`\nUNRECOGNISED PRODUCTS  ← the expensive blind spot`);
if (!unclassified.size) console.log(`  none — every product title matched. `);
else {
  console.log(`  ${unclassified.size} distinct titles matched nothing. Every customer who`);
  console.log(`  bought one got a fallback recommendation instead of a targeted one.\n`);
  for (const [title, c] of [...unclassified].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`  ${String(c).padStart(4)}×  ${title}`);
  console.log(`\n  FIX: add each to config/recommend.json → products, with match terms.`);
}

console.log(`\nSEGMENTS FOUND`);
console.log(`  fleet buyers (bulk orders)  ${String(fleet).padStart(5)}  ${pct(fleet)}`);
console.log(`  ageing durables (stale)     ${String(stale).padStart(5)}  ${pct(stale)}`);
console.log(`  degraded (too unsure)       ${String(degraded).padStart(5)}  ${pct(degraded)}`);

console.log(`\nCO-PURCHASE DATA`);
if (!copurchase.generatedAt) console.log(`  not generated yet — run: npm run mine`);
else console.log(`  generated ${copurchase.generatedAt} from ${copurchase.ordersAnalysed} orders`);
console.log();

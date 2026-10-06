// $399 NUDGE VERSION — free-shipping threshold nudge for the Loadout engine.
//
// The problem it solves: a warm abandoned-cart reader who scrolls to the bottom
// of the email is close to checking out. Anything we put down there has to lift
// AOV WITHOUT starting a second shopping trip. The strongest lever we have is
// the free-shipping threshold: someone $126 short of $399 reads an add-on as
// SAVING money, not spending more.
//
// So this module answers one question:
//
//     "How far off free shipping is this cart, and which single product
//      best bridges the gap without being a random upsell?"
//
// It reuses the Loadout recommend() engine for RELEVANCE (it already excludes
// anything owned or in-cart, and honours the rules/co-purchase cascade), then
// re-ranks those candidates by PRICE against the shortfall. Relevance first,
// arithmetic second — we never suggest something irrelevant just because the
// number fits.
//
// States it returns:
//   "nudge"     — under the threshold, here's the gap + the product that closes it
//   "qualified" — already over the threshold, no nudge; show a plain pairing instead
//   "unknown"   — no cart value available; caller should fall back to a static block
//
// Prices, titles, images and stock all come from lib/catalog.js (Shopify), never
// hardcoded, so the maths and the copy can't drift from the store.

import { getCatalog } from "./catalog.js";
import { recommend } from "./recommend.js";

// ── SVG for /api/img?type=nudge399 ─────────────────────────────────────────
// Rendered at 2x (1080 wide) and displayed at 540 in the email.
const _BLACK = "#000000", _YELLOW = "#f5eb19", _WHITE = "#ffffff",
      _TRACK = "#3a3637", _MUTE = "#c4c3bf";
const _FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const _esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const _money = (n) => "$" + Number(n).toFixed(2).replace(/\.00$/, "");

/**
 * The gap bar: "You're $126 off free shipping" + progress + the product that
 * closes it. Same visual language as the email (true black, yellow, Bahnschrift).
 */
export function nudgeSVG(m) {
  const W = 1080, PAD = 40;
  const barY = 150, barH = 26;
  const qual = m.state === "qualified";
  // Only draw the product card if we can price it — a priceless price reads as broken.
  const hasPrice = !!m.pick && Number.isFinite(m.pick.price) && m.pick.price > 0;
  // gridHint: this bar is the HEADER of the 1×3 grid, so it has to say what the
  // grid is FOR — without it the reader sees three products and no reason to add
  // one. Opt-in rather than inferred from `pick: null`, because the plain bar
  // renders that way too and must keep its collapsed height.
  //
  // Wording is deliberately "ADD THESE", not "ADD ANY OF THESE": the three slots
  // are different prices and only the crosser clears the gap on its own, so "any"
  // would promise free shipping the cheapest tile can't actually deliver.
  const hint = !!m.gridHint && !qual;
  const H = hasPrice ? 340 : hint ? 296 : 250;
  const pct = Math.max(0.02, Math.min(1, m.progress ?? 0));
  const fillW = Math.round((W - PAD * 2) * pct);

  // Word gaps use dx, not spaces: the renderer collapses whitespace between tspans
  // (and drops &#160;), which glues "You're" onto "$126".
  const head = m.state === "qualified"
    ? `<tspan fill="${_WHITE}">You've unlocked</tspan><tspan fill="${_YELLOW}" dx="14">free shipping</tspan>`
    : `<tspan fill="${_WHITE}">You're</tspan><tspan fill="${_YELLOW}" dx="14">${_esc(_money(m.gap ?? 0))}</tspan><tspan fill="${_WHITE}" dx="14">off free shipping</tspan>`;

  let product = "";
  if (hasPrice) {
    const py = 236;
    product = `
      <line x1="${PAD}" y1="${py - 26}" x2="${W - PAD}" y2="${py - 26}" stroke="${_TRACK}" stroke-width="2"/>
      <rect x="${PAD}" y="${py}" width="72" height="72" fill="${_YELLOW}"/>
      <text x="${PAD + 92}" y="${py + 30}" font-family="${_FONT}" font-size="27" font-weight="bold" fill="${_WHITE}">
        ${_esc(m.pick.title.slice(0, 30).toUpperCase())}
        <tspan fill="${_YELLOW}" dx="14">${_esc(_money(m.pick.price))}</tspan>
      </text>
      <text x="${PAD + 92}" y="${py + 62}" font-family="Arial,sans-serif" font-size="21" fill="${_MUTE}">
        ${_esc(qual ? "Goes well with what you've got." : m.pick.crosses ? "Add it and shipping's on us." : "Add it to get closer.")}
      </text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${_BLACK}"/>
    <text x="${PAD}" y="92" font-family="${_FONT}" font-size="52" font-weight="bold">${head}</text>
    <rect x="${PAD}" y="${barY}" width="${W - PAD * 2}" height="${barH}" fill="${_TRACK}"/>
    <rect x="${PAD}" y="${barY}" width="${fillW}" height="${barH}" fill="${_YELLOW}"/>
    <text x="${PAD}" y="${barY + 58}" font-family="Arial,sans-serif" font-size="22" fill="${_MUTE}">${_esc(_money(m.cartValue ?? 0))} in your cart</text>
    <text x="${W - PAD}" y="${barY + 58}" font-family="Arial,sans-serif" font-size="22" fill="${_MUTE}" text-anchor="end">${qual ? "Shipping&#8217;s on us" : _esc(_money(m.threshold)) + " unlocks it"}</text>
    ${product}
    ${hint ? `<text x="${PAD}" y="${barY + 112}" font-family="${_FONT}" font-size="30" font-weight="bold" fill="${_WHITE}" letter-spacing="0.5">ADD THESE TO YOUR CART TO GET FREE SHIPPING</text>` : ""}
  </svg>`;
}

/** Threshold config with sane defaults. Override in config/recommend.json → freeShipping. */
export function shippingConfig(cfg = {}) {
  return {
    threshold: 399,
    currency: "AUD",
    label: "free shipping",
    // Don't suggest something that overshoots the gap by more than this multiple.
    // Closing a $20 gap with a $524 enclosure is not a nudge, it's a punt.
    maxOvershootMultiple: 6,
    ...(cfg.freeShipping || {}),
  };
}

/**
 * First candidate we can actually put a price on. The nudge/qualified/unknown paths
 * all render a price, so an unpriced pick renders "$NaN" — which shipped once.
 * A missing price means Shopify didn't answer (or the variant is gone), and the
 * honest fallback is to show no product card at all.
 */
export function firstPriced(candidates = []) {
  return (
    candidates.find(
      (c) => Number.isFinite(c.price) && c.price > 0 && c.available !== false
    ) || null
  );
}

/**
 * Up to `max` products for the 1×3 free-shipping grid, ordered by bridge value:
 * CROSSERS first (price >= gap, cheapest → smallest spend to unlock), then the
 * next most relevant. Every entry is priced, in stock and not in the cart (the
 * engine already pruned those). Deterministic, so the slot image and the slot
 * add-to-cart link always resolve to the same product.
 */
export function gridPicks(candidates = [], gap = 0, max = 3) {
  const priced = candidates.filter((c) => Number.isFinite(c.price) && c.price > 0 && c.available !== false);
  const byRank = priced.slice().sort((a, b) => a.rank - b.rank); // relevance order
  if (gap <= 0) return byRank.slice(0, max);
  // Promote the CHEAPEST single-item crosser to slot 1 ("add this, shipping's on us"),
  // then fill by relevance. Keeps the grid relevant while still offering a one-tap unlock.
  const crosser = priced.filter((c) => c.price >= gap).sort((a, b) => a.price - b.price || a.rank - b.rank)[0];
  if (!crosser) return byRank.slice(0, max);
  return [crosser, ...byRank.filter((c) => c.key !== crosser.key)].slice(0, max);
}

/**
 * Pick the product that best bridges `gap`.
 *
 * Priority:
 *   1. CROSSERS — price >= gap, so one tap actually unlocks free shipping.
 *      Take the CHEAPEST crosser: smallest spend for the win. Ties break on
 *      engine rank (candidates arrive already ranked by relevance).
 *   2. CLOSERS — nothing crosses (gap is big). Take the most valuable relevant
 *      product to get as close as possible, and tell the caller it won't cross.
 *
 * Guardrail: a crosser that overshoots the gap by more than
 * `maxOvershootMultiple` is demoted — it reads as an upsell, not a nudge.
 */
export function pickBridge(candidates = [], gap = 0, opts = {}) {
  const maxMult = opts.maxOvershootMultiple ?? 6;
  const priced = candidates.filter((c) => Number.isFinite(c.price) && c.price > 0 && c.available !== false);
  if (!priced.length) return null;

  const sane = priced.filter((c) => c.price <= gap * maxMult);
  const pool = sane.length ? sane : priced;

  const crossers = pool.filter((c) => c.price >= gap).sort((a, b) => a.price - b.price || a.rank - b.rank);
  if (crossers.length) return { ...crossers[0], crosses: true, shortfallAfter: 0 };

  const closers = [...pool].sort((a, b) => b.price - a.price || a.rank - b.rank);
  const best = closers[0];
  return { ...best, crosses: false, shortfallAfter: +(gap - best.price).toFixed(2) };
}

/**
 * $399 Nudge Version — main entry.
 *
 * ctx: { cartValue, cartItems|cartTitles, historyItems|historyTitles }
 * Returns a render-ready object for /api/img?type=nudge399 and /api/nudge.
 */
export async function nudge399(ctx = {}, cfg = {}, copurchase = {}) {
  const ship = shippingConfig(cfg);
  const threshold = Number(ship.threshold);
  const cartValue = Number(ctx.cartValue);

  // ONE Shopify round trip for the whole decision: the catalog supplies both the
  // availability the engine filters on AND the prices the maths needs. Previously
  // recommend() ran blind to stock and variantPrices() made a second, separate call.
  const catalog = await getCatalog(cfg);

  // Relevance first: the engine prunes owned, in-cart AND unavailable items.
  const rec = recommend(ctx, cfg, copurchase, catalog);
  const keys = rec.keys || [];
  const products = cfg.products || {};

  const candidates = keys
    .map((key, i) => {
      const p = products[key] || {};
      const live = catalog.byKey?.[key] || {};
      return {
        key,
        rank: i,
        title: live.title || p.title || key,   // Shopify title wins over the config label
        blurb: p.blurb || "",                  // copy is ours, not Shopify's
        variant: live.variant || p.variant,
        qty: p.qty || 1,
        price: live.price,
        image: live.image,
        available: live.available,
        handle: live.handle,
        variantCount: live.variantCount,
      };
    })
    .filter((c) => c.variant);

  // GRID POOL: the strict cascade can return < 3 relevant items (e.g. a single-item
  // cart). The free-shipping grid should still show 3, so top up with other buyable,
  // not-in-cart, not-already-listed products. These are RANKED LAST (rank 100+) so
  // gridPicks orders the relevant ones first; the single pick still uses `candidates`.
  const usedKeys = new Set(candidates.map((c) => c.key));
  const inCartKeys = new Set(rec.telemetry?.cartKeys || []);
  const topUp = Object.keys(products)
    // displayOnly products are catalogue entries for range emails. They must never
    // drift into a recommendation slot just because they exist in the config.
    .filter((k) => !usedKeys.has(k) && !inCartKeys.has(k) && !products[k]?.displayOnly)
    .map((k, i) => {
      const live = catalog.byKey?.[k] || {};
      return {
        key: k, rank: 100 + i,
        title: live.title || products[k]?.title || k,
        blurb: products[k]?.blurb || "",
        variant: live.variant || products[k]?.variant,
        qty: products[k]?.qty || 1,
        price: live.price, image: live.image, available: live.available,
        handle: live.handle, variantCount: live.variantCount,
      };
    })
    .filter((c) => c.variant && c.available !== false && Number.isFinite(c.price) && c.price > 0);
  let gridPool = [...candidates, ...topUp];

  // AUTHORED ORDER WINS (Matthew, 2026-08-13): when a category RULE matched
  // (grease hierarchy coupler->wipes->pro mat; Portable's forced grid), the
  // free-shipping grid shows the rule's products IN THE RULE'S ORDER. No
  // crosser promotion, no hauler floor — those value-reorders were overriding
  // the merchandised hierarchy (a $100 grease cart led with the Hauler).
  // Generic carts (fallback/co-purchase) keep the bridge-value ordering.
  const authored = rec.source === "rule";

  // HAULER FLOOR: a cart under this is a long way off $399, so no ordinary add-on
  // closes the gap and the grid degrades into "spend $300 more". The Hauler is
  // exactly $399, so it clears the threshold from ANY cart this small on its own.
  // Promoted to the front rather than merely included — at this cart size it is
  // the only single item that actually answers the headline.
  const floor = Number(ship.haulerFloor);
  if (!authored && Number.isFinite(cartValue) && cartValue > 0 && Number.isFinite(floor) && cartValue < floor) {
    const h = gridPool.find((c) => c.key === "hauler");
    if (h) gridPool = [{ ...h, rank: -1 }, ...gridPool.filter((c) => c.key !== "hauler")];
  }

  const base = {
    threshold,
    currency: ship.currency,
    label: ship.label,
    candidates,
    reason: rec.reason,
    source: rec.source,
    catalogOk: catalog.ok,
    confidence: rec.confidence,
    telemetry: rec.telemetry,
  };

  // No cart value → can't do threshold maths. Caller falls back to a static pairing.
  if (!Number.isFinite(cartValue) || cartValue <= 0) {
    return { ...base, state: "unknown", gap: null, progress: null, pick: firstPriced(candidates), grid: gridPicks(gridPool, 0) };
  }

  const gap = +(threshold - cartValue).toFixed(2);

  // Already earned free shipping → don't nag about it. Show a plain pairing.
  if (gap <= 0) {
    return {
      ...base,
      state: "qualified",
      cartValue,
      gap: 0,
      progress: 1,
      pick: firstPriced(candidates),
      grid: gridPicks(gridPool, 0),
      headline: `You've unlocked ${ship.label}`,
    };
  }

  const pick = pickBridge(candidates, gap, ship);
  return {
    ...base,
    state: "nudge",
    cartValue,
    gap,
    progress: Math.max(0, Math.min(1, cartValue / threshold)),
    pick,
    // authored rule -> strict rank order (gap 0 skips the crosser promotion);
    // the single `pick`/subline keeps the bridge maths either way
    grid: gridPicks(gridPool, authored ? 0 : gap),
    headline: `You're $${gap.toFixed(2).replace(/\.00$/, "")} off ${ship.label}`,
    subline: pick
      ? pick.crosses
        ? `Add the ${pick.title} and shipping's on us.`
        : `Add the ${pick.title} to get closer.`
      : `Add $${gap.toFixed(2).replace(/\.00$/, "")} more to unlock it.`,
  };
}

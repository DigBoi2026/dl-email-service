// lib/recommend.js — the recommendation brain. Pure, deterministic, ~0ms, no model.
//
// THREE-LAYER CASCADE:
//   1. RULES       — your strategy. Always wins.
//   2. CO-PURCHASE — mined from your real orders at build time.
//   3. FALLBACK    — spearheads. Never empty.
//
// EDGE-CASE INTELLIGENCE. The design principle: the system must KNOW WHAT IT DOESN'T
// KNOW and say so, rather than guess confidently. The expensive failure here isn't a
// weird customer — it's a SILENT CLASSIFICATION MISS. Launch "Digger Shield Mk2",
// forget the match term, and every Mk2 buyer quietly drops to fallback forever with
// no error. So every decision returns `telemetry.unclassified` and a `confidence`.
//
//   • Unclassified titles      → surfaced, not swallowed. Feeds scripts/diagnose.js.
//   • Stale durables           → a cover bought 4 years ago is a REPLACEMENT
//                                opportunity, not an exclusion. Sun kills covers.
//   • Fleet buyers             → 10 units in one order is Rental Ron, not Charlie.
//   • Low confidence           → degrade to the safe fallback rather than show a
//                                weak guess. A wrong rec in a fitment business is
//                                a return, not a missed upsell.
//   • Rule matched but nothing left to offer → fall through, don't dead-end.

const DAY = 86400000;

/**
 * Is this line item a non-product? Add-on services (shipping protection, tips, gift
 * cards) are real line items but not things anyone abandoned a cart over.
 *
 * They must be dropped BEFORE classification, not after: an unrecognised line item
 * counts as "unclassified", and the unclassified ratio directly scales confidence
 * down. A cart of one product plus Package Protection scored 50% unclassified and
 * halved a perfect rule match. Silently weakening every recommendation.
 */
export function isNonProduct(item, cfg = {}) {
  const np = cfg.nonProducts || {};
  const v = String(item.variantId || "");
  if (v && (np.variants || []).map(String).includes(v)) return true;
  // Product id as well as variant id. The email filters Package Protection out on
  // its way in, but that filter silently failed once (it compared an empty string
  // against the id and so never matched), letting PP through as an unclassified
  // line item — which halves confidence and can tip the engine into its fallback.
  // One layer of defence for an add-on that must never influence recommendations
  // is not enough when the layer can fail without saying anything.
  const pid = String(item.productId || "");
  if (pid && (np.productIds || []).map(String).includes(pid)) return true;
  const t = String(item.title || "").toLowerCase().trim();
  return !!t && (np.match || []).some((m) => t.includes(String(m).toLowerCase()));
}

/** Normalise loose input into {title, variantId, productId, quantity, orderedAt}. */
function normalise(input, cfg) {
  if (!Array.isArray(input)) return [];
  const str = (v) => (v === null || v === undefined ? "" : String(v));
  return input
    .filter((x) => x !== null && x !== undefined)
    .map((x) =>
      typeof x === "object"
        ? {
            title: str(x.title),
            variantId: str(x.variantId ?? x.variant),
            productId: str(x.productId ?? x.product),
            quantity: Number(x.quantity) || 1,
            orderedAt: x.orderedAt || null,
          }
        : { title: str(x), variantId: "", productId: "", quantity: 1, orderedAt: null }
    )
    .filter((x) => x.title !== "" || x.variantId !== "" || x.productId !== "")
    .filter((x) => !cfg || !isNonProduct(x, cfg));
}

// IDENTITY: match on Shopify IDs first, titles only as a last resort.
//
// Title matching is a silent, BACKWARDS failure. Rename a product in Shopify and
// its `match` aliases stop hitting, so the item becomes unclassified, so the engine
// concludes the customer does NOT own it, and recommends the thing they just bought.
// Klaviyo's line_items carry `variant.id` — exact and immutable. Use it.
const _idxCache = new WeakMap();
function idIndex(cfg) {
  let idx = _idxCache.get(cfg);
  if (idx) return idx;
  const byVariant = new Map(), byProduct = new Map();
  for (const [key, p] of Object.entries(cfg.products || {})) {
    if (p?.variant !== undefined && p?.variant !== null) byVariant.set(String(p.variant), key);
    // altVariants: other variant ids that ARE this product. Gift-with-purchase twins
    // are separate $0 Shopify products sharing the paid product's SKU, so without
    // this a customer holding the free Draw Bar Cover reads as not owning one and
    // gets recommended the $129 version. Recommendation still uses `variant` — these
    // are recognition-only aliases.
    for (const alt of p?.altVariants || []) byVariant.set(String(alt), key);
    if (p?.productId !== undefined && p?.productId !== null) byProduct.set(String(p.productId), key);
    // GWP twins are separate Shopify PRODUCTS, not variants, so they need aliasing
    // at this level too — variant aliases alone would miss their other variants.
    for (const alt of p?.altProductIds || []) byProduct.set(String(alt), key);
  }
  idx = { byVariant, byProduct };
  if (typeof cfg === "object") _idxCache.set(cfg, idx);
  return idx;
}

const looksLikeId = (s) => /^\d{6,}$/.test(s);

/** Match an item to a product key by id, then by title. Returns {key, by}. */
function matchItem(item, cfg) {
  const idx = idIndex(cfg);
  if (item.variantId && idx.byVariant.has(item.variantId))
    return { key: idx.byVariant.get(item.variantId), by: "variant" };
  if (item.productId && idx.byProduct.has(item.productId))
    return { key: idx.byProduct.get(item.productId), by: "product" };
  // a bare numeric string is an id someone passed as a title
  if (looksLikeId(item.title) && idx.byVariant.has(item.title))
    return { key: idx.byVariant.get(item.title), by: "variant" };
  const k = item.title ? matchOne(item.title, cfg) : null;
  return k ? { key: k, by: "title" } : { key: null, by: null };
}

const tagsOf = (key, cfg) => new Set(cfg.products?.[key]?.tags || []);
const hasTag = (set, tag, cfg) => [...set].some((k) => tagsOf(k, cfg).has(tag));
const keysWithTag = (tag, cfg) =>
  Object.keys(cfg.products || {}).filter((k) => tagsOf(k, cfg).has(tag));
const isConsumable = (key, cfg) => tagsOf(key, cfg).has("consumable");

/** Match one title to a product key, or null. */
function matchOne(title, cfg) {
  const t = String(title).toLowerCase().trim();
  for (const [key, p] of Object.entries(cfg.products || {})) {
    if (t === key.toLowerCase()) return key;
    if ((p.match || []).some((m) => t.includes(String(m).toLowerCase()))) return key;
  }
  return null;
}

/**
 * Parse the `items=<variantId>:<qty>[:<productId>],…` URL param the emails emit.
 *
 * The productId field is what makes classification survive real carts. Config pins
 * ONE variant per product, but the store sells many: the DiggerShield Kit has 30
 * variants (one per machine), the Pro Excavator Enclosure 6, KAJO 6, Quicky Cover 3.
 * Matching on variant id alone recognised exactly one of each, so a customer who
 * bought a Tan Quicky Cover classified as owning NOTHING, every category rule missed,
 * and the engine fell through to the generic spearhead fallback — quietly, with a
 * plausible-looking grid. Product id is stable across every variant, so one id per
 * product covers the whole range and new variants can't silently drop out.
 *
 * Two-field pairs still parse, so sends built before this change keep working.
 */
export function parseItemsParam(s = "") {
  return String(s)
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [id, qty, pid] = pair.split(":");
      return {
        variantId: String(id || "").trim(),
        quantity: Number(qty) || 1,
        productId: String(pid || "").trim(),
      };
    })
    .filter((x) => x.variantId || x.productId);
}

/** Classify titles → {keys, unclassified}. Unclassified is the important half. */
export function classify(inputs, cfg) {
  const keys = new Set();
  const unclassified = [];
  let titleMatches = 0;
  for (const item of normalise(inputs, cfg)) {
    const { key, by } = matchItem(item, cfg);
    if (key) { keys.add(key); if (by === "title") titleMatches++; }
    else unclassified.push(item.title || item.variantId || item.productId);
  }
  return { keys, unclassified, titleMatches };
}

/** Back-compat helper for the miner. */
export function classifyOwned(inputs, cfg) {
  return classify(inputs, cfg).keys;
}

/**
 * Analyse purchase history: what they own, what's gone stale, are they a fleet buyer.
 */
function analyseHistory(items, cfg) {
  const ec = cfg.edgeCases || {};
  const staleAfter = (ec.durableOwnershipDays ?? 1095) * DAY;
  const fleetAt = ec.fleetQuantityThreshold ?? 5;

  const owned = new Set();
  const stale = new Set();
  const unclassified = [];
  let maxOrderQty = 0;

  // group quantities by order date to detect a genuine bulk order
  const qtyByDate = new Map();

  let titleMatches = 0;
  for (const item of normalise(items, cfg)) {
    const { key, by } = matchItem(item, cfg);
    if (!key) { unclassified.push(item.title || item.variantId || item.productId); continue; }
    if (by === "title") titleMatches++;

    const dateKey = item.orderedAt ? String(item.orderedAt).slice(0, 10) : "unknown";
    qtyByDate.set(dateKey, (qtyByDate.get(dateKey) || 0) + (item.quantity || 1));

    const ts = item.orderedAt ? new Date(item.orderedAt).getTime() : NaN;
    const age = Number.isFinite(ts) ? Date.now() - ts : 0;
    const isStale = !isConsumable(key, cfg) && Number.isFinite(ts) && age > staleAfter;

    if (isStale) stale.add(key);
    else owned.add(key);
  }
  // a key that's fresh anywhere is not stale
  for (const k of owned) stale.delete(k);

  for (const q of qtyByDate.values()) maxOrderQty = Math.max(maxOrderQty, q);

  return { owned, stale, unclassified, titleMatches, isFleet: maxOrderQty >= fleetAt, maxOrderQty };
}

/**
 * Drop anything they own / have in cart / unknown / can't be bought.
 * Consumables are exempt from the ownership rule.
 *
 * AVAILABILITY IS FILTERED HERE, at the one chokepoint every layer already passes
 * through, so no downstream consumer has to remember to check. Previously only the
 * $399 nudge filtered stock, which is exactly why a hardcoded card could offer a
 * grease gun with zero inventory. Safe by construction beats safe by convention.
 *
 * Only `available === false` excludes. `null` means we couldn't reach Shopify and
 * is treated as available — see the FAILURE POLICY in lib/catalog.js.
 */
function prune(keys, { owned, cart, catalog }, cfg) {
  const seen = new Set();
  return keys.filter((k) => {
    if (!cfg.products?.[k] || seen.has(k)) return false;
    if (catalog?.byKey?.[k]?.available === false) return false;
    const consumable = isConsumable(k, cfg);
    if (!consumable && owned.has(k)) return false;
    if (cart.has(k)) return false; // already adding it right now, consumable or not
    seen.add(k);
    return true;
  });
}

function expand(rule, cfg) {
  const out = [...(rule.recommend || [])];
  for (const tag of rule.recommend_tags || []) out.push(...keysWithTag(tag, cfg));
  return out;
}

function triggerFor(set, tags, cfg) {
  for (const k of set) if (tags.some((t) => tagsOf(k, cfg).has(t))) return k;
  return null;
}

function fillReason(reason, triggerKey, cfg) {
  if (!reason) return "";
  return reason.replace(/\{trigger\}/g, cfg.products?.[triggerKey]?.title || "kit");
}

/**
 * Resolve a recommendation.
 * @param {{cartTitles?:any[], historyTitles?:any[], cartItems?:any[], historyItems?:any[]}} ctx
 * @param {object|null} catalog Optional live catalog from lib/catalog.js. When given,
 *        anything Shopify reports unavailable is excluded. Omit and no stock filtering
 *        happens — so prefer the callers that always supply it.
 *        Items may be plain strings or {title, quantity, orderedAt}.
 * @returns {{keys, reason, source, ruleId, trigger, confidence, telemetry}}
 */
export function recommend(ctx = {}, cfg = {}, copurchase = {}, catalog = null) {
  const ec = cfg.edgeCases || {};
  const max = cfg.maxRecommendations || 3;
  const warnings = [];

  const cartIn = ctx.cartItems || ctx.cartTitles || [];
  const histIn = ctx.historyItems || ctx.historyTitles || [];

  const cartRes = classify(cartIn, cfg);
  const cart = cartRes.keys;
  const hist = analyseHistory(histIn, cfg);

  const unclassified = [...new Set([...cartRes.unclassified, ...hist.unclassified])];
  const totalTitles = normalise(cartIn, cfg).length + normalise(histIn, cfg).length;

  // EDGE CASE: we don't understand a big share of what this person bought.
  // Don't pretend. Lower confidence and flag it loudly.
  const unclassifiedRatio = totalTitles ? unclassified.length / totalTitles : 0;
  if (unclassified.length) {
    warnings.push(
      `unclassified_titles: ${unclassified.length}/${totalTitles} — add match terms to config/recommend.json`
    );
  }

  const both = new Set([...cart, ...hist.owned]);
  const ex = { owned: hist.owned, cart, catalog };
  const telemetry = {
    cartKeys: [...cart],
    ownedKeys: [...hist.owned],
    staleKeys: [...hist.stale],
    unclassified,
    unclassifiedRatio: +unclassifiedRatio.toFixed(2),
    isFleet: hist.isFleet,
    maxOrderQty: hist.maxOrderQty,
    // >0 means something matched on a TITLE, i.e. an id wasn't supplied. Not an
    // error, but it's the fragile path — watch it trend to zero.
    titleMatches: (cartRes.titleMatches || 0) + (hist.titleMatches || 0),
    unavailableKeys: catalog
      ? Object.keys(cfg.products || {}).filter((k) => catalog?.byKey?.[k]?.available === false)
      : [],
    catalogOk: catalog ? catalog.ok !== false : null,
    warnings,
  };

  // Layer 0 (grease-system completion) RETIRED 2026-08-13: Matthew's fixed
  // grease hierarchy (coupler -> wipes -> pro mat, skipping in-cart items) is
  // authored in cart_grease_attach.recommend, and the old "missing system part
  // first" promotion would jump that queue (e.g. slot 0 = kajo for a
  // coupler-in-cart cart). The rule's ordered list + prune() does the job now.
  const lead = [];

  const finish = (res) => {
    if (lead.length) res.keys = [...lead, ...res.keys.filter((k) => !lead.includes(k))].slice(0, max);
    // Confidence penalty when we understand little about this customer.
    let confidence = res.confidence * (1 - Math.min(unclassifiedRatio, 0.5));
    confidence = +confidence.toFixed(2);

    // EDGE CASE: too unsure to be useful → degrade to the safe option rather than
    // show a weak guess. Spearheads are never a wrong answer, just a generic one.
    const floor = ec.minConfidence ?? 0.3;
    if (confidence < floor && res.source !== "fallback") {
      const keys = prune(expand(cfg.fallback || {}, cfg), ex, cfg).slice(0, max);
      if (keys.length) {
        warnings.push(`degraded_to_fallback: confidence ${confidence} < ${floor}`);
        return {
          keys: lead.length ? [...lead, ...keys.filter((k) => !lead.includes(k))].slice(0, max) : keys,
          reason: cfg.fallback?.reason || "",
          source: "fallback",
          ruleId: null,
          trigger: null,
          confidence,
          telemetry: { ...telemetry, warnings },
          degraded: true,
        };
      }
    }
    return { ...res, confidence, telemetry, degraded: false };
  };

  // ---- Layer 1: rules (authored order = priority) ----
  for (const rule of cfg.rules || []) {
    const subject = rule.when_scope === "cart" ? cart : both;

    if (rule.when_fleet === true && !hist.isFleet) continue;
    if (rule.when_stale_tags?.length && !rule.when_stale_tags.some((t) => hasTag(hist.stale, t, cfg))) continue;
    if (rule.when?.length && !rule.when.every((k) => subject.has(k))) continue;
    if (rule.when_tags?.length && !rule.when_tags.some((t) => hasTag(subject, t, cfg))) continue;
    if (rule.when_not_tags?.length && rule.when_not_tags.some((t) => hasTag(both, t, cfg))) continue;

    const hasCondition =
      rule.when?.length || rule.when_tags?.length || rule.when_stale_tags?.length || rule.when_fleet;
    if (!hasCondition) continue;

    // Stale rules recommend replacements — the stale item itself is fair game again.
    const exRule = rule.when_stale_tags?.length
      ? { owned: new Set([...hist.owned].filter((k) => !hist.stale.has(k))), cart, catalog }
      : ex;

    // Rule-level FORCE (Matthew, 2026-08-10): a merchandised, fixed grid.
    // `force` keys render in the authored order and are NOT pruned against the
    // cart or history — recommending a second PRO Mat to a PRO Mat cart is the
    // point (they zip together). Only a hard `available === false` from Shopify
    // drops one; the freed slot backfills from the rule's normal recommend list.
    let keys;
    if (rule.force?.length) {
      const seen = new Set();
      const forced = rule.force.filter((k) => {
        if (!cfg.products?.[k] || seen.has(k)) return false;
        if (catalog?.byKey?.[k]?.available === false) return false;
        seen.add(k);
        return true;
      });
      const backfill = prune(expand(rule, cfg), exRule, cfg).filter((k) => !forced.includes(k));
      keys = [...forced, ...backfill].slice(0, max);
    } else {
      keys = prune(expand(rule, cfg), exRule, cfg).slice(0, max);
    }
    if (!keys.length) continue; // EDGE CASE: matched but nothing left → try next rule

    // PAD FROM REGULAR PRIORITIES (Matthew, 2026-08-13): when a hierarchy item
    // is out of stock (or in the cart), the freed slot is NOT hand-forced onto
    // another named product — it falls to whatever the regular cascade would
    // pick anyway: mined co-purchase first, then the spearhead fallback. So the
    // grid reads "hierarchy while in stock, our other products otherwise".
    if (keys.length < max) {
      const cp = cfg.copurchase || {};
      const scored = new Map();
      if (cp.enabled && copurchase.pairs) {
        for (const k of both)
          for (const s of copurchase.pairs[k] || []) {
            if (s.support < (cp.minSupport ?? 5)) continue;
            if (s.confidence < (cp.minConfidence ?? 0.25)) continue;
            if (!scored.has(s.key) || s.confidence > scored.get(s.key)) scored.set(s.key, s.confidence);
          }
      }
      const regular = [
        ...[...scored.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
        ...expand(cfg.fallback || {}, cfg),
      ];
      const pad = prune(regular, exRule, cfg).filter((k) => !keys.includes(k));
      keys = [...keys, ...pad].slice(0, max);
    }

    const trigger =
      (rule.when_stale_tags?.length && triggerFor(hist.stale, rule.when_stale_tags, cfg)) ||
      (rule.when_tags?.length && triggerFor(subject, rule.when_tags, cfg)) ||
      rule.when?.[0] ||
      null;

    return finish({
      keys,
      reason: fillReason(rule.reason, trigger, cfg),
      source: "rule",
      ruleId: rule.id || null,
      trigger,
      confidence: rule.force?.length || rule.when?.length ? 1 : 0.9, // forced/explicit > tag match
    });
  }

  // ---- Layer 2: mined co-purchase ----
  const cp = cfg.copurchase || {};
  if (cp.enabled && copurchase.pairs && both.size) {
    const scored = new Map();
    for (const k of both) {
      for (const s of copurchase.pairs[k] || []) {
        if (s.support < (cp.minSupport ?? 5)) continue;
        if (s.confidence < (cp.minConfidence ?? 0.25)) continue;
        if (!scored.has(s.key) || s.confidence > scored.get(s.key)) scored.set(s.key, s.confidence);
      }
    }
    const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
    const keys = prune(ranked.map(([k]) => k), ex, cfg).slice(0, max);
    if (keys.length) {
      const top = ranked.find(([k]) => keys.includes(k))?.[1] ?? 0.3;
      return finish({
        keys, reason: cp.reason || "", source: "copurchase", ruleId: null,
        trigger: null, confidence: top,
      });
    }
  }

  // ---- Layer 3: fallback ----
  const keys = prune(expand(cfg.fallback || {}, cfg), ex, cfg).slice(0, max);
  if (!keys.length) warnings.push("no_recommendation_possible: customer owns everything");
  return finish({
    keys,
    reason: keys.length ? cfg.fallback?.reason || "" : "",
    source: keys.length ? "fallback" : "none",
    ruleId: null,
    trigger: null,
    confidence: keys.length ? 0.35 : 0,
  });
}

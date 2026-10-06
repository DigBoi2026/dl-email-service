// lib/catalog.js — the single source of truth for PRODUCT FACTS.
//
// THE RULE THIS ENFORCES:
//   Shopify owns the FACTS   — title, price, image, stock, availability.
//   config/recommend.json owns the STRATEGY — which product pairs with what,
//   rules, tags, thresholds, and the key → variant id mapping.
//
// Before this module those two were mixed: titles and prices were hand-typed into
// the config AND again into the email HTML. Three copies of the same fact, drifting
// independently. That is how an email ended up selling a grease gun with zero stock,
// and how a renamed product silently stopped matching.
//
// Nothing downstream should ever hardcode a price, an image or a stock level.
// Ask the catalog.
//
// FAILURE POLICY — deliberate, and worth understanding:
//   available === false  → Shopify told us it's unavailable. Hard exclude.
//   available === null   → we don't KNOW (Shopify down, timeout, variant missing).
//                          Fail OPEN: still recommendable.
// Rationale: a rare out-of-stock recommendation during a Shopify outage is a much
// smaller failure than every email silently losing its recommendation block the
// moment Shopify hiccups. Price-dependent paths (the $399 nudge) fail closed on
// their own, because they need a real number to do the maths.

import { shopifyGQL } from "./shopify.js";

const TTL = 5 * 60 * 1000; // 5min: long enough to serve a burst of opens, short
                           // enough that a sell-out reaches the next reader fast.
let _cache = { at: 0, data: null };

const gid = (id) =>
  String(id).startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`;

const QUERY = `
  query($ids:[ID!]!){
    nodes(ids:$ids){
      ... on ProductVariant {
        id
        price
        availableForSale
        inventoryQuantity
        product { id title status handle variantsCount { count } featuredImage { url } }
      }
    }
  }`;

/** The shape every key starts as: known from config, facts still unknown. */
function baseEntry(key, product = {}) {
  return {
    key,
    variant: product.variant ? String(product.variant) : null,
    productId: null,
    title: product.title || key, // config title is a LABEL of last resort only
    price: null,
    // image_fallback: a Klaviyo-hosted stand-in for when Shopify has no
    // featuredImage for the product (Matthew, 2026-08-13: the grease coupler)
    image: product.image_fallback || null,
    available: null, // null = unknown, see FAILURE POLICY
    inventory: null,
    status: null,
    handle: null,       // for the product-page fallback
    variantCount: null, // >1 → the shopper must choose (size/model/colour), so we
                        // send them to the product page instead of adding blind
  };
}

/**
 * PURE: fold a Shopify `nodes` payload onto the configured products.
 * Exported so it can be tested against real Shopify responses without a network.
 */
export function foldNodes(products = {}, nodes = []) {
  const byKey = {};
  for (const k of Object.keys(products)) byKey[k] = baseEntry(k, products[k]);

  const raw = {};
  for (const n of nodes || []) {
    if (!n?.id) continue;
    raw[String(n.id).split("/").pop()] = n;
  }

  for (const k of Object.keys(byKey)) {
    const v = byKey[k].variant;
    const n = v && raw[v];
    if (!n) {
      // Variant is in config but Shopify didn't return it: deleted, archived or a
      // wrong id. That is NOT "unknown" — a variant we can't resolve must never be
      // recommended, or we send people to a dead product page.
      if (v) { byKey[k].available = false; byKey[k].status = "NOT_FOUND"; }
      continue;
    }
    const price = Number(n.price);
    byKey[k] = {
      ...byKey[k],
      productId: n.product?.id ? String(n.product.id).split("/").pop() : null,
      title: n.product?.title || byKey[k].title,
      price: Number.isFinite(price) ? price : null,
      image: n.product?.featuredImage?.url || products[k]?.image_fallback || null,
      available: n.availableForSale !== false && n.product?.status === "ACTIVE",
      inventory: Number.isFinite(n.inventoryQuantity) ? n.inventoryQuantity : null,
      status: n.product?.status || null,
      handle: n.product?.handle || null,
      variantCount: Number.isFinite(n.product?.variantsCount?.count)
        ? n.product.variantsCount.count
        : null,
    };
  }
  return byKey;
}

/**
 * Live product facts for every key in cfg.products, fetched from Shopify.
 *
 * @returns {{ok:boolean, error:string|null, byKey:Object, byVariant:Object, fetchedAt:number}}
 *   byKey[key] = {key, variant, productId, title, price, image, available, inventory, status}
 */
export async function getCatalog(cfg = {}, { force = false } = {}) {
  if (!force && _cache.data && Date.now() - _cache.at < TTL) return _cache.data;

  const products = cfg.products || {};
  const variantIds = Object.values(products).map((p) => p?.variant).filter(Boolean);

  let byKey, ok = true, error = null;
  try {
    const data = variantIds.length
      ? await shopifyGQL(QUERY, { ids: variantIds.map(gid) })
      : { nodes: [] };
    byKey = foldNodes(products, data?.nodes || []);
  } catch (e) {
    ok = false;
    error = String(e?.message || e);
    console.error("catalog.getCatalog error:", error);
    // Every entry keeps available:null → fail OPEN, see FAILURE POLICY. We do NOT
    // reuse foldNodes here: it would mark everything NOT_FOUND and blank the block.
    byKey = {};
    for (const k of Object.keys(products)) byKey[k] = baseEntry(k, products[k]);
  }

  const byVariant = {};
  for (const k of Object.keys(byKey)) if (byKey[k].variant) byVariant[byKey[k].variant] = byKey[k];

  const out = { ok, error, byKey, byVariant, fetchedAt: Date.now() };
  _cache = { at: Date.now(), data: out };
  return out;
}

/** Test seam: drop the memoised catalog. */
export function clearCatalogCache() {
  _cache = { at: 0, data: null };
}

/** Keys Shopify positively told us are unavailable. Never recommend these. */
export function unavailableKeys(catalog) {
  return Object.values(catalog?.byKey || {})
    .filter((p) => p.available === false)
    .map((p) => p.key);
}

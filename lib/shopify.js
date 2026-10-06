// lib/shopify.js — minimal Shopify Admin GraphQL helper.
//
// AUTH — two supported modes, in priority order:
//   1. SHOPIFY_ADMIN_TOKEN  — a static token (legacy custom apps). Used as-is.
//   2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET — a Dev Dashboard app. Dev
//      Dashboard apps DO NOT issue a static token; you exchange the client id +
//      secret for a short-lived (24h) token via the client_credentials grant, and
//      refresh it before it expires. (This is why pasting the client secret as
//      SHOPIFY_ADMIN_TOKEN failed with "invalid access token".)
//
// Needs SHOPIFY_STORE (xxxx.myshopify.com) and scopes read_products, read_inventory.

const API_VERSION = "2025-01";

// Cached client_credentials token (per warm container). Refresh 5 min early.
let _tok = { value: null, expiresAt: 0 };

/** Return a usable Admin access token — static if given, else client-credentials. */
async function getAccessToken() {
  const staticToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (staticToken) return staticToken;

  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("No Shopify credentials: set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET");
  }

  if (_tok.value && Date.now() < _tok.expiresAt - 5 * 60 * 1000) return _tok.value;

  // Shopify requires x-www-form-urlencoded here (NOT JSON — JSON is silently rejected).
  const res = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`client_credentials failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  _tok = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 86400) * 1000 };
  return _tok.value;
}

export async function shopifyGQL(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// Live sellable quantity for a numeric variant ID.
export async function getVariantStock(variantId) {
  const data = await shopifyGQL(
    `query($id: ID!) {
       productVariant(id: $id) {
         inventoryQuantity
         availableForSale
         product { title handle }
         title
       }
     }`,
    { id: `gid://shopify/ProductVariant/${variantId}` }
  );
  return data.productVariant; // null if not found
}

// Most recent paid order's line items for a customer email.
// Returns [{variantId, quantity, title}] or null.
export async function getLastOrderItems(email) {
  const data = await shopifyGQL(
    `query($q: String!) {
       orders(first: 1, reverse: true, query: $q) {
         nodes {
           name
           lineItems(first: 20) {
             nodes {
               quantity
               title
               variant { id availableForSale }
             }
           }
         }
       }
     }`,
    { q: `email:${JSON.stringify(email)} financial_status:paid` }
  );
  const order = data.orders?.nodes?.[0];
  if (!order) return null;
  return order.lineItems.nodes
    .filter((li) => li.variant?.availableForSale)
    .map((li) => ({
      variantId: li.variant.id.split("/").pop(),
      quantity: li.quantity,
      title: li.title,
    }));
}

// Purchase history as rich items: {title, quantity, orderedAt}.
// The dates and quantities matter — they're what let the engine spot an ageing
// cover (replacement opportunity) and a fleet buyer (bulk order).
export async function getPurchasedItems(email, orders = 10) {
  const data = await shopifyGQL(
    `query($q: String!, $n: Int!) {
       orders(first: $n, reverse: true, query: $q) {
         nodes { createdAt lineItems(first: 20) { nodes { title quantity } } }
       }
     }`,
    { q: `email:${JSON.stringify(email)} financial_status:paid`, n: orders }
  );
  return (data.orders?.nodes || []).flatMap((o) =>
    o.lineItems.nodes.map((li) => ({ title: li.title, quantity: li.quantity, orderedAt: o.createdAt }))
  );
}

// Titles only — used by the co-purchase miner.
export async function getPurchasedTitles(email, orders = 10) {
  return (await getPurchasedItems(email, orders)).map((i) => i.title);
}

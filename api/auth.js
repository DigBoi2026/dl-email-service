// /api/auth — start the Shopify app install (OAuth authorize).
// Visit /api/auth?shop=digger-lid.myshopify.com (shop defaults to SHOPIFY_STORE).
// Redirects the merchant to Shopify's approve screen; on approval Shopify calls
// /api/auth/callback, which completes the install. After that, the app is
// "installed on this shop" and the client_credentials grant works at runtime.
import { randomUUID } from "node:crypto";

const SCOPES = "read_products,read_inventory";
const BASE = "https://email.diggerlid.com";

export default function handler(req, res) {
  const shop = String(req.query.shop || process.env.SHOPIFY_STORE || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send("Missing or invalid ?shop=<store>.myshopify.com");
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) return res.status(500).send("SHOPIFY_CLIENT_ID not set");

  const state = randomUUID();
  const redirectUri = `${BASE}/api/auth/callback`;
  const url =
    `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.setHeader("Set-Cookie", `dl_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.writeHead(302, { Location: url });
  res.end();
}

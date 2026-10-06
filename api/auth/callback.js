// /api/auth/callback — finish the Shopify install.
// Shopify redirects here with ?code=&shop=&state= after the merchant approves.
// Exchanging the code proves the install completed (a forged code won't exchange),
// so we don't need to store the token — runtime uses the client_credentials grant.
export default async function handler(req, res) {
  const { code, shop, state } = req.query;
  if (!code || !shop) return res.status(400).send("Missing code/shop");

  // CSRF: state must match the cookie we set in /api/auth.
  const cookie = String(req.headers.cookie || "");
  const expected = (cookie.match(/dl_oauth_state=([^;]+)/) || [])[1];
  if (!expected || expected !== state) return res.status(403).send("State mismatch — restart at /api/auth");

  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code: String(code),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      return res.status(500).send("Install failed: " + JSON.stringify(j).slice(0, 300));
    }
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(
      `<div style="font-family:Arial;background:#000;color:#fff;padding:60px;text-align:center">
       <h1 style="color:#f5eb19">Installed ✓</h1>
       <p>DiggerLid Email Service is connected to ${shop}. You can close this tab.</p></div>`
    );
  } catch (e) {
    return res.status(500).send("Install error: " + String(e?.message || e));
  }
}

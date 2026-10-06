// lib/mate.js — "Your cart could use a mate" card, rendered from the engine.
//
// WHY THIS REPLACED HARDCODED HTML:
// The card used to be hand-written markup with a baked-in product, price, image and
// variant id. Email is read days after it's built and an abandoned-cart flow sends
// for months, so every one of those facts drifts. It shipped a grease gun with zero
// inventory and a live "Add To Cart" button.
//
// Now the engine chooses (relevance, in-cart pruning, stock) and this draws whatever
// it chose. Nothing about the product is authored in the template any more.
//
// The product PHOTO is fetched from the Shopify CDN and inlined as a data URI,
// because the renderer has no network of its own at draw time. It's a small image
// (Shopify resizes for us via &width) and the whole card is edge-cached.

const BLACK = "#000000", YELLOW = "#f5eb19", WHITE = "#ffffff",
      INK = "#4f4b4c", LINE = "#000000";
const FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => "$" + Number(n).toFixed(2).replace(/\.00$/, "");

/**
 * Fetch a remote image and return a data URI, or null.
 * Never throws: a missing photo degrades to a plain block, it must not kill the card.
 */
export async function toDataURI(url, { ms = 4000, maxBytes = 900_000 } = {}) {
  if (!url) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Shopify CDN resize param — ask for the size we actually draw, not the 3000px original. */
export function sized(url, px = 300) {
  if (!url) return url;
  return url + (url.includes("?") ? "&" : "?") + `width=${px}`;
}

/**
 * The card. Rendered at 2x (1080 wide), displayed at 540 in the email.
 * `pick` is a candidate from the engine: {title, price, image, blurb}.
 */
export function mateSVG(pick, { photo = null } = {}) {
  const W = 1080, H = 300, PAD = 0, IMG = 300;
  if (!pick) {
    // Engine had nothing to offer (owns everything, or all out of stock).
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="120" viewBox="0 0 ${W} 120">
      <rect width="100%" height="100%" fill="${WHITE}"/>
      <rect x="1" y="1" width="${W - 2}" height="118" fill="none" stroke="${LINE}" stroke-width="4"/>
      <text x="${W / 2}" y="70" font-family="${FONT}" font-size="30" font-weight="bold" fill="${BLACK}" text-anchor="middle">YOUR CART'S ALREADY SORTED</text>
    </svg>`;
  }

  const tx = IMG + 44;
  const art = photo
    ? `<image href="${photo}" x="0" y="0" width="${IMG}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="0" y="0" width="${IMG}" height="${H}" fill="${YELLOW}"/>`;

  const price = Number.isFinite(pick.price) && pick.price > 0 ? money(pick.price) : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${WHITE}"/>
    ${art}
    <text x="${tx}" y="86" font-family="${FONT}" font-size="38" font-weight="bold" fill="${BLACK}" letter-spacing="0.5">${esc(String(pick.title).slice(0, 28).toUpperCase())}</text>
    <text x="${tx}" y="132" font-family="Arial,sans-serif" font-size="24" fill="${INK}">${esc(String(pick.blurb || "").slice(0, 46))}</text>
    ${price ? `<text x="${tx}" y="186" font-family="${FONT}" font-size="36" font-weight="bold" fill="${BLACK}">${esc(price)}</text>` : ""}
    <rect x="${tx}" y="212" width="238" height="56" fill="${YELLOW}"/>
    <text x="${tx + 119}" y="248" font-family="${FONT}" font-size="21" font-weight="bold" fill="${BLACK}" text-anchor="middle" letter-spacing="1.5">ADD TO CART</text>
    <rect x="2" y="2" width="${W - 4}" height="${H - 4}" fill="none" stroke="${LINE}" stroke-width="4"/>
  </svg>`;
}

/** Model + photo + SVG for /api/img?type=mate. */
export async function mateCardSVG(pick) {
  if (!pick) return mateSVG(null);
  const photo = await toDataURI(sized(pick.image, 300));
  return mateSVG(pick, { photo });
}

// ── 1×3 grid product card (for /api/img?type=rec&slot=N) ─────────────────────
// One vertical card: photo, name, price, ADD chip. Rendered per slot so each of
// the 3 grid cells is its own image + its own add-to-cart link.
export function recCardSVG(pick, { photo = null, cta = "ADD TO CART" } = {}) {
  const W = 372, IMG = 372, H = 560, B = "#000000";
  if (!pick) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="100%" height="100%" fill="${WHITE}"/><rect x="2" y="2" width="${W-4}" height="${H-4}" fill="none" stroke="#c9c7c2" stroke-width="3"/>
      <text x="${W/2}" y="${H/2-10}" font-family="${FONT}" font-size="26" font-weight="bold" fill="#8a857f" text-anchor="middle">SEE THE</text>
      <text x="${W/2}" y="${H/2+24}" font-family="${FONT}" font-size="26" font-weight="bold" fill="#8a857f" text-anchor="middle">RANGE</text></svg>`;
  }
  const art = photo
    ? `<image href="${photo}" x="0" y="0" width="${IMG}" height="${IMG}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="0" y="0" width="${IMG}" height="${IMG}" fill="${YELLOW}"/>`;
  const name = esc(String(pick.title).slice(0, 18).toUpperCase());
  const price = Number.isFinite(pick.price) && pick.price > 0 ? money(pick.price) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${WHITE}"/>
    ${art}
    <text x="24" y="${IMG + 54}" font-family="${FONT}" font-size="27" font-weight="bold" fill="${BLACK}" letter-spacing="0.5">${name}</text>
    ${price ? `<text x="24" y="${IMG + 100}" font-family="${FONT}" font-size="34" font-weight="bold" fill="${BLACK}">${esc(price)}</text>` : ""}
    <rect x="20" y="${IMG + 122}" width="${W - 40}" height="56" fill="${YELLOW}"/>
    <text x="${W/2}" y="${IMG + 159}" font-family="${FONT}" font-size="22" font-weight="bold" fill="${BLACK}" text-anchor="middle" letter-spacing="1.5">${esc(cta)}</text>
    <rect x="1.5" y="1.5" width="${W-3}" height="${H-3}" fill="none" stroke="${B}" stroke-width="3"/>
  </svg>`;
}

/** Model → one grid slot's card image (photo fetched + inlined). */
export async function recSlotSVG(pick, cta) {
  if (!pick) return recCardSVG(null);
  const photo = await toDataURI(sized(pick.image, 372));
  return recCardSVG(pick, { photo, ...(cta ? { cta } : {}) });
}

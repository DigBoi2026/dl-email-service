// /api/img — open-time dynamic images. Rendered fresh on every open.
// Output is PNG (SVG isn't supported by Gmail/Outlook), branded DiggerLid.
//
// Types:
//   /api/img?type=countdown&to=2026-07-31T23:59:59+10:00&label=EOFY%20ENDS%20IN
//   /api/img?type=stock&variant=45678901234567           (live Shopify stock badge)
//   /api/img?type=state&c=eofy-jul26                     (LIVE vs ENDED banner, from config/campaigns.json)
//   /api/img?type=hero&t=Excavator%20covers%2C%20sorted. (personalized headline strip;
//            pass Klaviyo tags in the URL, e.g. &t={{ person|lookup:'machine_type' }})
//   /api/img?type=weather&d={% now 'Y-m' %}              (rain outlook, EVERY state —
//            abandoned cart has no location data, so the reader finds their own patch.
//            Reports DAYS OF RAIN this month from pre-gathered climate data, so there
//            is no live API call and nothing to time out. See lib/rain.js.)
//   /api/img?type=nudge399&value=273&items=123:1        ($399 free-shipping gap bar)
//   /api/img?type=mate&value=520&items=123:1             (engine-chosen pairing card)
//   /api/img?type=downtime&rate=1000&d={% now 'Y-m' %}   (rain grid + downtime cost calc)
//
// Caveats (by design of email, not this code):
// - Apple MPP pre-fetches images near delivery → countdowns can be stale for Apple
//   opens. Stock/state/hero degrade gracefully (still correct at fetch time).
// - Gmail caches images ~48h per URL. A cache-busting param is injected per send in
//   the block HTML ({% now %}), and we send no-cache headers.

import { svgToPng, svgToRGBA, RENDER_FONT, fontStatus } from "../lib/render.js";
import { getVariantStock } from "../lib/shopify.js";
import { getCatalog } from "../lib/catalog.js";
import { rainOutlookSVG, downtimeModel, downtimeSVG, downtimeFrames, forecastSVG, resolveState, getRainModel } from "../lib/rain.js";
import { framesToGif } from "../lib/gif.js";
import { nudge399, nudgeSVG } from "../lib/nudge.js";
import { parseItemsParam } from "../lib/recommend.js";
import { mateCardSVG, recSlotSVG, toDataURI, sized } from "../lib/mate.js";
import { groundModel, groundSVG } from "../lib/ground.js";
import { forecast7Model, forecast7SVG, groundForecast7Model, groundForecast7SVG } from "../lib/forecast7.js";
import { setupModel, setupSVG } from "../lib/setup.js";
import campaigns from "../config/campaigns.json" with { type: "json" };
import recommendCfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

const BLACK = "#231f20", YELLOW = "#f5eb19", WHITE = "#ffffff", GREY = "#4f4b4c";
const FONT = `${RENDER_FONT},Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

function svgShell(w, h, inner, bg = BLACK) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="${bg}"/>${inner}</svg>`;
}

function resolveTarget(q) {
  // Evergreen: target = start + window. Klaviyo bakes the send time into `start`
  // via {% now 'U' %} (Django unix seconds), so every recipient gets their own 48h.
  // Falls back to an absolute `to` when window/start are absent, so it fails safe.
  const win = Number(q.window);
  if (Number.isFinite(win) && win > 0 && q.start) {
    let st = Number(q.start);
    if (!Number.isFinite(st)) st = new Date(q.start).getTime() / 1000; // ISO fallback
    else if (st > 1e12) st = st / 1000;                               // unix ms
    if (Number.isFinite(st)) return (st + win) * 1000;
  }
  return q.to ? new Date(q.to).getTime() : NaN;
}

function countdownSVG(targetMs, label, expired) {
  const ms = targetMs - Date.now();
  const ended = !(ms > 0);
  // Total HOURS, not days: a 48h sale reads harder as "47H" than "01D 23H".
  const hh = Math.floor(ms / 3600000),
    mm = Math.floor((ms % 3600000) / 60000),
    ss = Math.floor((ms % 60000) / 1000);
  const units = ended ? [] : [
    [String(hh).padStart(2, "0"), "HRS"],
    [String(mm).padStart(2, "0"), "MIN"],
    [String(ss).padStart(2, "0"), "SEC"],
  ];
  const boxes = units.map(([v, u], i) => `
    <g transform="translate(${115 + i * 130},34)">
      <rect width="110" height="86" fill="${YELLOW}"/>
      <text x="55" y="56" font-family="${FONT}" font-size="46" font-weight="bold" fill="${BLACK}" text-anchor="middle">${v}</text>
      <text x="55" y="78" font-family="${FONT}" font-size="15" font-weight="bold" fill="${BLACK}" text-anchor="middle">${u}</text>
    </g>`).join("");
  const head = ended
    ? `<text x="300" y="88" font-family="${FONT}" font-size="30" font-weight="bold" fill="${YELLOW}" text-anchor="middle">${esc(expired || "OFFER'S CLOSED")}</text>`
    : `<text x="300" y="24" font-family="${FONT}" font-size="18" font-weight="bold" fill="${WHITE}" text-anchor="middle" letter-spacing="2">${esc(label || "ENDS IN")}</text>${boxes}`;
  return svgShell(600, 150, head);
}

function stockSVG(qty, title) {
  const low = qty > 0 && qty <= 5;
  const out = qty <= 0;
  const msg = out ? "BACK SOON" : low ? `ONLY ${qty} LEFT` : "IN STOCK &#8212; SHIPS TODAY";
  const color = out ? GREY : YELLOW;
  return svgShell(
    600,
    90,
    `<rect x="0" y="0" width="14" height="90" fill="${color}"/>
     <text x="34" y="38" font-family="${FONT}" font-size="26" font-weight="bold" fill="${color}">${msg}</text>
     <text x="34" y="68" font-family="${FONT}" font-size="16" fill="${WHITE}">${esc((title || "").slice(0, 52))}</text>`
  );
}

function stateSVG(campaign) {
  const cfg = campaigns[campaign];
  const live = cfg && Date.now() < new Date(cfg.endsAt).getTime();
  return live
    ? svgShell(
        600,
        110,
        `<text x="300" y="48" font-family="${FONT}" font-size="34" font-weight="bold" fill="${YELLOW}" text-anchor="middle">${esc(cfg.liveHeadline || "SALE NOW ON")}</text>
         <text x="300" y="84" font-family="${FONT}" font-size="18" fill="${WHITE}" text-anchor="middle">${esc(cfg.liveSub || "We've got you covered.")}</text>`
      )
    : svgShell(
        600,
        110,
        `<text x="300" y="48" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" text-anchor="middle">${esc(cfg?.endedHeadline || "THIS OFFER HAS ENDED")}</text>
         <text x="300" y="84" font-family="${FONT}" font-size="18" fill="${YELLOW}" text-anchor="middle">${esc(cfg?.endedSub || "Full range still ready to ship.")}</text>`
      );
}

function heroSVG(t) {
  return svgShell(
    600,
    100,
    `<rect x="20" y="25" width="560" height="50" fill="${YELLOW}" transform="skewX(-6)"/>
     <text x="300" y="59" font-family="${FONT}" font-size="26" font-weight="bold" fill="${BLACK}" text-anchor="middle">${esc((t || "DIGGERLID").toUpperCase().slice(0, 42))}</text>`
  );
}

// When a block has nothing legitimate to show (e.g. the setup gauge on a cart
// with no recognised grease gear) or a render throws, we still have to return
// an image — an <img> always paints something. A fully transparent 600×2 strip
// collapses the block to an invisible sliver instead of a stray "DIGGERLID"
// bar, which reads as a mistake. Rendered once and cached.
let _blankPNG = null;
function blankPNG() {
  if (!_blankPNG) _blankPNG = svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="2"></svg>`);
  return _blankPNG;
}

export default async function handler(req, res) {
  const { type = "hero", to, label, variant, c, t, value, cart, items = "" } = req.query;
  // ?debug=fonts — confirm the TTFs are actually in the deployed bundle.
  if (req.query.debug === "fonts") return res.status(200).json(fontStatus());
  let svg;
  try {
    if (type === "countdown")
      svg = countdownSVG(resolveTarget(req.query), label, req.query.expired);
    else if (type === "stock") {
      const v = variant ? await getVariantStock(variant) : null;
      svg = stockSVG(v ? v.inventoryQuantity : 0, v ? `${v.product.title}` : "");
    } else if (type === "state") svg = stateSVG(c);
    else if (type === "weather") svg = rainOutlookSVG(); // pure computation, no network
    else if (type === "downtime") {
      // Rain-math cost. &rate = $/day (default 1000). Same monthly data as weather,
      // so no network and the {% now 'Y-m' %} buster is all the freshness it needs.
      // Served as an ANIMATED GIF (raindrops behind the grid). &static=1 gives the
      // flat PNG. Outlook shows GIF frame 1, which is a clean full still.
      const rate = Math.min(100000, Math.max(1, Number(req.query.rate) || 1000));
      const model = downtimeModel(new Date(), rate);
      // STATIC BY DEFAULT (Matthew, 2026-07-30): the rolling rain animation is off.
      // A 322KB GIF for a background effect is the heaviest thing in the email, only
      // some clients animate it, and Outlook shows frame 1 anyway. The block earns its
      // place on the numbers. `&animate=1` still returns the GIF if it is ever wanted.
      if (!req.query.animate) {
        svg = downtimeSVG(model);
      } else {
        const frames = downtimeFrames(model, 10).map(svgToRGBA);
        const gif = framesToGif(frames, { delay: 90, maxColors: 32 });
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "public, max-age=0, s-maxage=86400, stale-while-revalidate=600");
        return res.status(200).send(gif);
      }
    }
    else if (type === "forecast") {
      // THREE TIERS, best available wins. One URL for every recipient.
      //   V2 LIVE     &zip + rain in the next 7 days -> live forecast
      //   V2 LOCAL    &state resolvable              -> their state's climate average
      //   V2 NATIONAL neither                        -> national average, same format
      //
      // The live tier is conditional on its own content: forecast7Model returns null
      // when no rain is coming, because a dry forecast in a cover email argues against
      // the product. We never show a forecast that sells against us.
      const kicker = String(req.query.k || "").slice(0, 60);
      const live = req.query.zip ? await forecast7Model(req.query.zip) : null;
      if (live) {
        svg = forecast7SVG(live, kicker);
      } else {
        const st = resolveState(req.query.state);
        svg = forecastSVG(getRainModel(new Date()), st, kicker); // st null -> national
      }
    }
    else if (type === "ground") {
      // Same three tiers for the PRO Mat, reading the forecast for rough GROUND
      // (wet, frost, cold, hot) rather than rain alone. A mild week returns null and
      // drops to the climate version, because seven pleasant days sells no mat.
      const kicker = String(req.query.k || "").slice(0, 60);
      // &theme=light for the yellow stat-block variant; dark is production default.
      // Both tiers render the SAME shared stat block, so live and climate match.
      const theme = req.query.theme === "light" ? "light" : "dark";
      const base = req.query.zip ? await forecast7Model(req.query.zip) : null;
      const live = base ? groundForecast7Model(base) : null;
      if (live) {
        svg = groundForecast7SVG(live, kicker, theme);
      } else {
        const st = resolveState(req.query.state);
        svg = groundSVG(groundModel(st || null, new Date()), kicker, null, theme); // null -> national
      }
    }
    else if (type === "setup") {
      // Grease: what the cart says about their rig.
      //   /api/img?type=setup&items=<variantId:qty:productId,...>&g=<gun>&t=<greaseType>
      // The variant TITLES are not in the items param, so the email passes the two
      // that matter (&g gun, &t grease type) straight from the line item it already
      // loops over. No lookup, no guess.
      const items = parseItemsParam(req.query.items).map((it) => ({
        ...it,
        variantTitle:
          String(it.productId) === "7780171186346" ? String(req.query.g || "")
          : String(it.productId) === "7780170825898" ? String(req.query.t || "")
          : "",
      }));
      const m = setupModel(items);
      svg = setupSVG(m, String(req.query.k || "").slice(0, 60));
      // Nothing grease-related in the cart: skip rather than render an empty gauge.
      if (!svg) { res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "public, max-age=0, s-maxage=900, stale-while-revalidate=600"); return res.status(200).send(blankPNG()); }
    }
    else if (type === "shipbar") {
      // Header bar only (headline + progress), no product row — the 1×3 grid below
      // carries the products. Same model as nudge399.
      const model = await nudge399(
        { cartValue: Number(value), cartItems: parseItemsParam(items) },
        recommendCfg, copurchase
      );
      svg = nudgeSVG({ ...model, pick: null, gridHint: true });
    }
    else if (type === "videothumb") {
      // /api/img?type=videothumb&src=<image url>&t=<overlay label>
      // A still with a play mark burned in. Email clients cannot embed video, so the
      // thumbnail IS the affordance: without a play button a reader has no reason to
      // think the image is clickable. Drawn, not a glyph, since the vendored font has
      // no play character and a missing one renders as a tofu box.
      const src = String(req.query.src || "");
      const photo = src.startsWith("https://") ? await toDataURI(sized(src, 1080), { maxBytes: 2_000_000 }) : null;
      const W = 1080, H = 608, cx = W / 2, cy = H / 2, R = 74;
      const label = String(req.query.t || "").slice(0, 46);
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <rect width="100%" height="100%" fill="${BLACK}"/>
        ${photo ? `<image href="${photo}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : ""}
        <rect width="100%" height="100%" fill="${BLACK}" opacity="0.28"/>
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="${YELLOW}"/>
        <path d="M ${cx - 22} ${cy - 34} L ${cx + 38} ${cy} L ${cx - 22} ${cy + 34} Z" fill="${BLACK}"/>
        ${label ? `<rect x="0" y="${H - 74}" width="${W}" height="74" fill="${BLACK}" opacity="0.72"/>
        <text x="40" y="${H - 28}" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" letter-spacing="2">${esc(label.toUpperCase())}</text>` : ""}
      </svg>`;
    }
    else if (type === "card") {
      // One product card by config key: /api/img?type=card&key=quicky_cover
      // Facts (title, price, photo, stock) come from Shopify via the catalog, so a
      // range email can never quote a stale price the way hardcoded copy does.
      const catalog = await getCatalog(recommendCfg);
      const key = String(req.query.key || "");
      const p = recommendCfg.products?.[key];
      const live = catalog.byKey?.[key] || {};
      // &cta lets the range grid say VIEW PRODUCT: those cards link to the product
      // page, and a chip reading ADD TO CART would be describing a different action.
      svg = await recSlotSVG(
        p && live.available !== false
          ? { key, title: live.title || p.title, price: live.price,
              image: live.image, variant: live.variant || p.variant }
          : null,
        String(req.query.cta || "").slice(0, 18) || undefined
      );
    }
    else if (type === "rec") {
      // One card of the 1×3 grid. &slot=0|1|2. Deterministic: same engine + inputs
      // → same grid order, so this image matches /api/add?slot=N.
      const slot = Math.max(0, Math.min(2, Number(req.query.slot) || 0));
      const model = await nudge399(
        { cartValue: Number(value), cartItems: parseItemsParam(items) },
        recommendCfg, copurchase
      );
      svg = await recSlotSVG((model.grid || [])[slot] || null);
    }
    else if (type === "nudge399") {
      // &value = cart total, &items = <variantId>:<qty> pairs for what's already in
      // the cart, so the engine can prune it. Without this it happily recommends the
      // very product sitting in the abandoned cart. IDs, not titles: a renamed product
      // stops matching on title and silently reads as "not owned".
      const model = await nudge399(
        {
          cartValue: Number(value),
          cartItems: parseItemsParam(items),
          cartTitles: String(cart || "").split("|").map((s) => s.trim()).filter(Boolean),
        },
        recommendCfg,
        copurchase
      );
      svg = nudgeSVG(model);
    } else if (type === "mate") {
      // "Your cart could use a mate" — the engine chooses, we draw. Nothing about
      // the product is authored in the email template any more, so it cannot drift
      // out of stock or out of date the way the old hardcoded card did.
      const model = await nudge399(
        { cartValue: Number(value), cartItems: parseItemsParam(items) },
        recommendCfg,
        copurchase
      );
      svg = await mateCardSVG(model.pick);
    } else svg = null;

    const png = svg ? svgToPng(svg) : blankPNG();
    res.setHeader("Content-Type", "image/png");
    // CDN-cache at the edge, but keep the browser/proxy from holding a stale copy.
    // s-maxage=60  → Vercel's CDN serves this PNG for 60s. The FIRST person to open
    //   the campaign pays the render cost (~300ms); the next 10,000 get it from the
    //   edge in ~20ms. Freshness stays honest: stock/countdown are minute-precision.
    // stale-while-revalidate=300 → nobody ever waits on a re-render.
    // max-age=0 → no private caching, so a forwarded email still re-fetches.
    // Weather is the SAME image for every recipient and, now that it reports
    // MONTHLY rain-day averages from static data, only changes when the month does.
    // The URL already carries a {% now 'Y-m' %} buster, so cache it hard (24h) —
    // long enough that one render serves the day, short enough that a fix ships.
    // Countdown/stock stay on a tight 60s so they never look stale.
    // nudge399 is keyed by cart value in the URL, so the edge copy is only ever
    // reused by that same cart re-opening. Prices move rarely → 15min is safe.
    const sMax = (type === "weather" || type === "downtime" || type === "forecast" || type === "ground") ? 10800 : ["nudge399","mate","shipbar","rec","card","setup"].includes(type) ? 900 : 60;
    const noStore = type === "countdown";
    res.setHeader("Cache-Control", noStore
      ? "no-store, no-cache, must-revalidate, max-age=0"
      : `public, max-age=0, s-maxage=${sMax}, stale-while-revalidate=600`);
    return res.status(200).send(png);
  } catch (e) {
    console.error("img.js error:", e);
    // Never break the email layout: collapse the block invisibly rather than
    // paint a stray branded bar. The error is logged above for us to see.
    const png = blankPNG();
    res.setHeader("Content-Type", "image/png");
    return res.status(200).send(png);
  }
}

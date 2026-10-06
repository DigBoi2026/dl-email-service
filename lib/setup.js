// lib/setup.js — "YOUR SETUP": the grease-system completeness gauge.
//
// The covers flow got personal by using the reader's region. Grease has something
// better, because the cart itself says who they are:
//
//   adapter variant title  -> the exact gun they own   ("Milwaukee 18v")
//   KAJO variant title     -> the grease they run      ("LZR2")
//   quantity               -> how deep they are in it  (20 packs)
//
// None of that is inferred. It is what they put in the cart.
//
// WHAT THIS DELIBERATELY DOES NOT DO: estimate how long their cartridges will
// last. "20 packs is about 5 months" needs a burn rate we do not have, and it
// varies hugely by machine, hours and how many nipples get done. Inventing one
// would put a made-up number next to three real ones and poison all four.
//
// THE THREE PARTS of the KAJO system:
//   1. cartridges  the grease itself
//   2. adapter     lets a battery gun take screw-top cartridges (brand-specific)
//   3. coupler     gets grease into a blocked nipple without wearing it
//
// The adapter is NOT marked missing when absent: plenty of operators run a manual
// gun and need no adapter at all. Calling that a gap would be telling a customer
// their setup is wrong when it isn't. It reads as "add if you run a battery gun".

const PRODUCTS = {
  cartridges: "7780170825898",
  adapter: "7780171186346",
  coupler: "8010019340458",
};

const BLACK = "#000000", YELLOW = "#f5eb19", WHITE = "#ffffff",
      DIM = "#6b6768", MUTE = "#8a857f", TRACK = "#2c2a28";
const FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Read the cart into a setup model.
 * `items` are the parsed line items: {variantId, productId, quantity, title}.
 * `variantTitles` maps variantId -> variant title, from the catalog or the email.
 */
export function setupModel(items = [], variantTitles = {}) {
  const has = { cartridges: null, adapter: null, coupler: null };
  let packs = 0;

  for (const it of items) {
    const pid = String(it.productId || "");
    const vid = String(it.variantId || "");
    const qty = Number(it.quantity) || 1;
    const vt = it.variantTitle || variantTitles[vid] || "";
    if (pid === PRODUCTS.cartridges) {
      packs += qty;
      // keep the FIRST grease type seen; a mixed cart is common and naming one
      // type is honest, naming all of them is noise
      has.cartridges = has.cartridges || { label: vt || "KAJO", qty: packs };
      has.cartridges.qty = packs;
    } else if (pid === PRODUCTS.adapter) {
      has.adapter = { label: vt || "battery gun adapter", qty };
    } else if (pid === PRODUCTS.coupler) {
      has.coupler = { label: "Quick release coupler", qty };
    }
  }

  // The gap we actually name, in the order that helps the customer rather than the
  // order that sells hardest. Cartridges first: a cart holding only a coupler has
  // no grease in it, and telling that person they need an adapter is answering a
  // question they did not ask. Then the coupler ($29, removes a daily annoyance,
  // the easiest yes). The adapter is last because it is the one that might not
  // apply at all.
  const missing = !has.cartridges ? "cartridges" : !has.coupler ? "coupler" : !has.adapter ? "adapter" : null;
  const owned = ["cartridges", "adapter", "coupler"].filter((k) => has[k]).length;

  return {
    gun: has.adapter?.label || null,     // "Milwaukee 18v" or null (manual gun)
    grease: has.cartridges?.label || null,
    packs,
    has,
    missing,
    owned,
    complete: owned >= 3,
  };
}


// What their grease CHOICE says about the work. These are the six real KAJO
// variants, and each one is a different job: naming it back is the strongest
// personalisation in the block, because the customer chose it deliberately.
const GREASE = {
  "LZR2": { work: "everyday pins and bushes", line: "EVERYDAY GREASING." },
  "LC002": { work: "wet, dirty, high-load work", line: "HARD YARDS GREASE." },
  "LC002 + 3% MOS2": { work: "shock loads and heavy pins", line: "SHOCK LOAD GREASE." },
  "HD800": { work: "heavy duty running gear", line: "HEAVY DUTY GREASE." },
  "CASX (580g)": { work: "the bigger 580g cartridge", line: "THE BIG CARTRIDGE." },
  "Hammer Paste": { work: "the breaker, never the pins", line: "BREAKER PASTE." },
};

// How deep they are in it. A 20-pack cart is a different customer from a 1-pack
// cart and should not be spoken to the same way.
function depth(packs) {
  if (packs >= 12) return "stocked up for the season";
  if (packs >= 4) return "a solid top up";
  if (packs >= 1) return "a starter run";
  return "";
}

const COPY = {
  cartridges: {
    part: "KAJO cartridges",
    why: "Screw-top grease is the point of the system. Nothing else works without it.",
  },
  coupler: {
    part: "Quick release coupler",
    why: "The bit that gets grease into a blocked nipple without wearing it.",
  },
  adapter: {
    part: "Battery gun adapter",
    why: "Add it if you run a battery gun. Manual gun? You are already sorted.",
  },
};

/**
 * The gauge: what they have, what completes it. 1080 wide, shown at 600.
 * Returns null when the cart has no grease gear at all, so the caller can skip
 * the block rather than render an empty one.
 */
export function setupSVG(m, kicker = "") {
  if (!m || m.owned === 0) return null;

  // MOBILE-FIRST TYPE SCALE. This renders at 1080 but displays at ~375px on a
  // phone (0.35x), so anything under ~32px here lands below 11px on screen and
  // is decoration, not information. The old cut had 20-23px body text: unreadable
  // exactly where most of these emails are opened. Fewer, bigger elements; the
  // nuance lives in the email copy around the image, not inside it.
  const W = 1080, PAD = 44;
  const eyebrow = m.gun
    ? `YOUR SETUP &#183; ${esc(m.gun.toUpperCase())}`
    : m.grease ? `YOUR GREASE &#183; ${esc(String(m.grease).toUpperCase())}` : "YOUR SETUP";

  const g = GREASE[m.grease] || null;
  const head = m.complete ? "THAT IS THE FULL SYSTEM." : (g ? g.line : `${m.owned} OF 3.`);
  const gapLine = m.complete
    ? "NOTHING LEFT TO ADD"
    : `${esc(COPY[m.missing].part.toUpperCase())} TO GO`;

  // two short fact lines, both at phone-legible size: what they hold, what runs it
  const fact1 = m.packs ? esc(`${m.packs} \u00d7 ${m.grease || "KAJO"}, ${depth(m.packs)}`) : "";
  const fact2 = m.gun ? esc(`running through a ${m.gun}`) : "";

  const SW = (W - PAD * 2 - 20) / 3;
  const bar = ["cartridges", "adapter", "coupler"].map((k, i) => {
    const on = !!m.has[k];
    const x = PAD + i * (SW + 10);
    return `<rect x="${x.toFixed(1)}" y="344" width="${SW.toFixed(1)}" height="22" fill="${on ? YELLOW : TRACK}"/>`;
  }).join("");
  const labels = ["CARTRIDGES", "ADAPTER", "COUPLER"].map((k, i) => {
    const on = !!m.has[k.toLowerCase()];
    const x = PAD + i * (SW + 10);
    // MUTE, not DIM: at ~9-11px displayed, DIM-on-black is invisible, not subtle
    return `<text x="${x.toFixed(1)}" y="408" font-family="${FONT}" font-size="32" font-weight="bold" fill="${on ? WHITE : MUTE}" letter-spacing="1">${on ? "" : "+ "}${k}</text>`;
  }).join("");

  const H = 452;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${BLACK}"/>
    <text x="${PAD}" y="66" font-family="${FONT}" font-size="30" font-weight="bold" fill="${YELLOW}" letter-spacing="4">${eyebrow}</text>
    <text x="${PAD}" y="144" font-family="${FONT}" font-size="62" font-weight="bold" fill="${WHITE}">${head}</text>
    ${fact1 ? `<text x="${PAD}" y="198" font-family="Arial,sans-serif" font-size="38" fill="#c4c3bf">${fact1}</text>` : ""}
    ${fact2 ? `<text x="${PAD}" y="246" font-family="Arial,sans-serif" font-size="38" fill="#c4c3bf">${fact2}</text>` : ""}
    <text x="${PAD}" y="312" font-family="${FONT}" font-size="46" font-weight="bold" fill="${YELLOW}">${gapLine}</text>
    ${bar}${labels}
  </svg>`;
}

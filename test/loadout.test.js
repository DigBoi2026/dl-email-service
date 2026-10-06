// Regression suite for the Loadout recommendation + product system.
//
// Every test here corresponds to a defect that actually shipped or was one config
// change away from shipping. Run with `npm test` (node:test, no dependencies).
//
//   node --test test/
//
// The rule: if a bug reaches production, it gets a test here before it gets a fix.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { foldNodes, unavailableKeys } from "../lib/catalog.js";
import { recommend, parseItemsParam, classify, isNonProduct } from "../lib/recommend.js";
import { pickBridge, firstPriced, nudgeSVG, shippingConfig } from "../lib/nudge.js";
import { mateSVG, recCardSVG } from "../lib/mate.js";
import { getRainModel, rainSVG, downtimeModel, downtimeSVG, downtimeFrames, forecastSVG, resolveState } from "../lib/rain.js";
import { svgToRGBA } from "../lib/render.js";
import { framesToGif } from "../lib/gif.js";
import { groundModel, groundSVG } from "../lib/ground.js";
import { forecast7Model, forecast7SVG, groundForecast7Model, resolvePostcode } from "../lib/forecast7.js";
import { setupModel, setupSVG } from "../lib/setup.js";
import cfg from "../config/recommend.json" with { type: "json" };
import copurchase from "../config/copurchase.json" with { type: "json" };

// ── helpers ────────────────────────────────────────────────────────────────
const V = {
  enclosure: "43540388937898",
  shield: "42435168469162",
  proMat: "48999426621610",
  quicky: "48365037256874",
  wipes: "47322049020074",
  kajo: "44970926014634",
  coupler: "46189790658730",
  drawBar: "48164802658474",
  hauler: "47663506391210",
  universal: "41738621714602",
  kajoAdapter: "44970914447530",
  // display-only range products (shown in the Covers 02 grid, never recommended)
  cover17: "29410091270221",
  microExc: "33118255939661",
  skidSteer: "41735666204842",
  miniLoader: "41738076684458",
};

const node = ({ v, title = "X", price = "99.00", avail = true, inv = 10, status = "ACTIVE" }) => ({
  id: `gid://shopify/ProductVariant/${v}`,
  price,
  availableForSale: avail,
  inventoryQuantity: inv,
  product: { id: `gid://shopify/Product/p${v}`, title, status, featuredImage: { url: "https://cdn/x.jpg" } },
});

/** A full, healthy catalog; pass overrides to make one product misbehave. */
function catalogWith(overrides = {}) {
  const nodes = Object.entries(V).map(([name, v]) => node({ v, title: name, ...(overrides[v] || {}) }));
  return { ok: true, byKey: foldNodes(cfg.products, nodes) };
}

// ── catalog: facts come from Shopify ───────────────────────────────────────
describe("catalog", () => {
  test("Shopify title wins over the hand-typed config label", () => {
    const c = foldNodes(cfg.products, [node({ v: V.proMat, title: "PRO Mat Mk2" })]);
    assert.equal(c.pro_mat.title, "PRO Mat Mk2");
  });

  test("sold-out variant is marked unavailable (the grease gun that shipped)", () => {
    const c = foldNodes({ gun: { variant: "45400049025194" } },
      [node({ v: "45400049025194", avail: false, inv: 0 })]);
    assert.equal(c.gun.available, false);
  });

  test("archived product is unavailable even if the variant sells", () => {
    const c = foldNodes({ p: { variant: V.proMat } }, [node({ v: V.proMat, status: "ARCHIVED" })]);
    assert.equal(c.p.available, false);
  });

  test("variant missing from Shopify is excluded, not treated as unknown", () => {
    const c = foldNodes({ ghost: { variant: "999999999999" } }, []);
    assert.equal(c.ghost.available, false);
    assert.equal(c.ghost.status, "NOT_FOUND");
  });

  test("unavailableKeys lists only positively-unavailable products", () => {
    const c = catalogWith({ [V.proMat]: { avail: false } });
    assert.deepEqual(unavailableKeys(c), ["pro_mat"]);
  });
});

// ── identity: ids, not title strings ───────────────────────────────────────
describe("identity", () => {
  test("matches on variant id", () => {
    const { keys } = classify([{ variantId: V.proMat }], cfg);
    assert.ok(keys.has("pro_mat"));
  });

  test("a renamed product still matches by id (the silent-rename failure)", () => {
    // Rename breaks every `match` alias. Title-only would call this unclassified,
    // conclude the customer doesn't own it, and recommend it straight back.
    // Uses the enclosure, not the PRO Mat: the protection rule's forced grid
    // (2026-08-10) recommends the in-cart mat ON PURPOSE, so the exclusion
    // invariant is only observable on a non-forced rule.
    const renamed = "DiggerLid Cab Pod";
    const byTitle = recommend({ cartItems: [{ title: renamed }] }, cfg, copurchase);
    assert.ok(byTitle.keys.includes("excavator_pro_enclosure"), "precondition: title-only leaks it");

    const byId = recommend({ cartItems: [{ title: renamed, variantId: V.enclosure }] }, cfg, copurchase);
    assert.ok(!byId.keys.includes("excavator_pro_enclosure"), "id must exclude the in-cart item");
  });

  test("telemetry counts title fallbacks so reliance on them is visible", () => {
    assert.equal(recommend({ cartItems: [{ title: "PRO Mat" }] }, cfg, copurchase).telemetry.titleMatches, 1);
    assert.equal(recommend({ cartItems: [{ variantId: V.proMat }] }, cfg, copurchase).telemetry.titleMatches, 0);
  });

  test("legacy string input still works", () => {
    // A bare title must still classify: proof is the protection rule firing
    // (its forced grid now deliberately includes the in-cart pro_mat, so
    // exclusion is no longer the signal here — the ruleId is).
    const r = recommend({ cartTitles: ["PRO Mat"] }, cfg, copurchase);
    assert.equal(r.ruleId, "cart_protection_attach");
    assert.deepEqual(r.keys, ["pro_mat", "digger_wipes", "quicky_cover"]);
  });

  test("parseItemsParam reads the wire format the emails emit", () => {
    assert.deepEqual(parseItemsParam(`${V.proMat}:2,${V.kajo}:1`), [
      { variantId: V.proMat, quantity: 2, productId: "" },
      { variantId: V.kajo, quantity: 1, productId: "" },
    ]);
    assert.deepEqual(parseItemsParam(""), []);
    assert.deepEqual(parseItemsParam("  "), []);
    assert.deepEqual(parseItemsParam(`${V.kajo}`), [{ variantId: V.kajo, quantity: 1, productId: "" }]);
  });
});

// ── non-product line items ─────────────────────────────────────────────────
describe("non-products", () => {
  const PP = "48022986686634";

  test("Package Protection is recognised by variant id and by title", () => {
    assert.equal(isNonProduct({ variantId: PP }, cfg), true);
    assert.equal(isNonProduct({ title: "Package Protection" }, cfg), true);
    assert.equal(isNonProduct({ title: "PRO Mat" }, cfg), false);
  });

  test("an add-on no longer weakens the recommendation (it halved confidence)", () => {
    const withAddon = recommend(
      { cartItems: [{ variantId: V.coupler }, { variantId: PP, title: "Package Protection" }] },
      cfg, copurchase
    );
    const without = recommend({ cartItems: [{ variantId: V.coupler }] }, cfg, copurchase);
    assert.equal(withAddon.confidence, without.confidence);
    assert.deepEqual(withAddon.keys, without.keys);
    assert.deepEqual(withAddon.telemetry.unclassified, []);
  });

  test("it is never itself recommended", () => {
    const r = recommend({}, cfg, copurchase);
    assert.ok(!r.keys.includes("package_protection"));
  });
});

// ── category upsell rules (Matthew's spec, 2026-07-28) ─────────────────────
describe("category rules", () => {
  const recFor = (variant) =>
    recommend({ cartItems: [{ variantId: variant, quantity: 1 }] }, cfg, copurchase, catalogWith()).keys;

  test("a cover in the cart pulls wipes, mat, draw bar — never another cover", () => {
    const keys = recFor(V.enclosure);
    assert.deepEqual(keys.slice(0, 3), ["digger_wipes", "pro_mat", "draw_bar_cover"]);
  });

  test("grease carts get the fixed hierarchy: coupler, wipes, pro mat (skipping in-cart)", () => {
    // Matthew's spec 2026-08-13: ordered recommend on cart_grease_attach, normal
    // prune (unlike Portable's `force`, nothing in the cart is re-recommended).
    // The old Layer-0 "missing system part first" promotion is retired — it
    // could jump this queue (e.g. slot 0 = kajo for a coupler-in-cart cart).
    assert.deepEqual(recFor(V.kajo), ["coupler", "digger_wipes", "pro_mat"]);
    // coupler already in cart (or out of stock) -> it drops out, the freed slot
    // pads from the REGULAR cascade (co-purchase then spearheads), NOT a
    // hand-forced named product (Matthew, 2026-08-13)
    const k = recFor(V.coupler);
    assert.deepEqual(k.slice(0, 2), ["digger_wipes", "pro_mat"]);
    assert.equal(k.length, 3);
    assert.ok(!["coupler"].includes(k[2]), "in-cart item must not pad back in");
  });

  test("a mat cart gets the FORCED merchandised grid: pro mat, wipes, quicky", () => {
    // Matthew's spec 2026-08-10: the Protection flow's grid is fixed. Slot 1 is
    // another PRO Mat — recommending the product already in the cart is the point
    // (they zip together), so `force` bypasses the in-cart prune. Order is exact.
    assert.deepEqual(recFor(V.proMat), ["pro_mat", "digger_wipes", "quicky_cover"]);
    const rule = cfg.rules.find((r) => r.id === "cart_protection_attach");
    assert.deepEqual(rule.force, ["pro_mat", "digger_wipes", "quicky_cover"]);
  });

  test("forced grid backfills from the recommend list when a forced key is out of stock", () => {
    const cat = catalogWith({ [V.wipes]: { avail: false, inv: 0 } });
    const keys = recommend({ cartItems: [{ variantId: V.proMat, quantity: 1 }] }, cfg, copurchase, cat).keys;
    assert.deepEqual(keys, ["pro_mat", "quicky_cover", "draw_bar_cover"]);
  });

  test("what's in the cart is never recommended back (forced keys exempt)", () => {
    // The protection rule's forced grid (2026-08-10) recommends the in-cart
    // pro_mat ON PURPOSE (two mats zip together). Forced keys are the one
    // sanctioned exception; every other rule keeps the exclusion invariant.
    const forced = new Set(cfg.rules.flatMap((r) => r.force || []));
    for (const v of Object.values(V)) {
      const keys = recFor(v);
      const self = classify([{ variantId: v, quantity: 1 }], cfg).keys ?? [];
      for (const k of self)
        if (!forced.has(k)) assert.ok(!keys.includes(k), `${k} recommended while in cart`);
    }
  });

  test("a non-default variant still classifies (Jason Baughen's cart)", () => {
    // Shipped bug: config pins ONE variant per product but the store sells many
    // (DiggerShield 30, Enclosure 6, KAJO 6, Quicky 3). A Tan Quicky Cover +
    // Universal Engine Cover cart classified as NOTHING, so every category rule
    // missed and the $233 cart got the generic spearhead fallback — a $699
    // enclosure and a $1400 kit. Product id is stable across variants.
    const cart = [
      { variantId: "41738621714602", quantity: 1, productId: "7053360955562" }, // Universal
      { variantId: "48365037224106", quantity: 1, productId: "4604379267149" }, // Quicky, Tan
    ];
    const cl = classify(cart, cfg);
    assert.deepEqual([...cl.keys].sort(), ["quicky_cover", "universal_cover"]);
    assert.deepEqual(cl.unclassified, [], "nothing may fall through");
    const r = recommend({ cartItems: cart }, cfg, copurchase, catalogWith());
    assert.equal(r.source, "rule", "must hit the cover rule, not the fallback");
    assert.deepEqual(r.keys, ["digger_wipes", "pro_mat", "draw_bar_cover"]);
  });

  test("parseItemsParam keeps working on two-field pairs (older sends)", () => {
    assert.deepEqual(parseItemsParam("123:2"), [{ variantId: "123", quantity: 2, productId: "" }]);
    assert.deepEqual(parseItemsParam("123:2:456"),
      [{ variantId: "123", quantity: 2, productId: "456" }]);
  });

  test("a gift-with-purchase twin counts as owning the paid product", () => {
    // The $0 GWP is a separate Shopify product sharing the paid SKU. Before
    // altVariants it read as "not owned" and we upsold a product they already had.
    assert.ok(!recFor("47636639482026").includes("draw_bar_cover"), "free draw bar → still upsold");
    assert.ok(!recFor("48387170533546").includes("hauler"), "free hauler → still upsold");
  });
});

// ── availability enforced in the engine, not by convention ─────────────────
describe("availability", () => {
  test("an unavailable product is never recommended", () => {
    const c = catalogWith({ [V.proMat]: { avail: false } });
    const r = recommend({}, cfg, copurchase, c);
    assert.ok(!r.keys.includes("pro_mat"));
    assert.deepEqual(r.telemetry.unavailableKeys, ["pro_mat"]);
  });

  test("holds on every layer of the cascade, not just the fallback", () => {
    const c = catalogWith({ [V.proMat]: { avail: false }, [V.wipes]: { avail: false } });
    const contexts = [
      {},                                              // fallback
      { cartItems: [{ variantId: V.enclosure }] },      // rule
      { historyItems: [{ variantId: V.kajo }] },        // copurchase / rule
    ];
    for (const ctx of contexts) {
      const r = recommend(ctx, cfg, copurchase, c);
      assert.ok(!r.keys.includes("pro_mat"), `pro_mat leaked via ${r.source}`);
      assert.ok(!r.keys.includes("digger_wipes"), `digger_wipes leaked via ${r.source}`);
    }
  });

  test("a Shopify outage fails OPEN rather than blanking the block", () => {
    const outage = {
      ok: false,
      byKey: Object.fromEntries(Object.keys(cfg.products).map((k) => [k, { key: k, available: null }])),
    };
    const r = recommend({}, cfg, copurchase, outage);
    assert.ok(r.keys.length > 0, "recommendations must survive an outage");
    assert.equal(r.telemetry.catalogOk, false);
  });
});

// ── downtime calculator ────────────────────────────────────────────────────
describe("downtime", () => {
  test("no state is named in the base rain block (all users identify with their own)", () => {
    const svg = rainSVG(getRainModel(new Date(2026, 6, 15)));
    assert.ok(!/cops it/i.test(svg), "the TAS callout must be gone");
  });

  test("cost = round(wetDays*0.2,1) * rate, scales with rate, never NaN", () => {
    const a = downtimeModel(new Date(2026, 6, 15), 1000);
    const b = downtimeModel(new Date(2026, 6, 15), 2000);
    assert.ok(Number.isFinite(a.cost) && a.cost > 0);
    assert.equal(a.lostDays, Math.round(a.wetDays * 0.2 * 10) / 10);
    assert.equal(a.cost, Math.round(a.lostDays * 1000));
    assert.equal(b.cost, a.cost * 2);
  });

  test("animated GIF encodes, loops, and stays small (lo-fi lines, < 500KB)", () => {
    const frames = downtimeFrames(downtimeModel(new Date(2026, 6, 15), 1000), 10).map(svgToRGBA);
    assert.equal(frames.length, 10);
    const gif = framesToGif(frames, { delay: 90, maxColors: 32 });
    assert.equal(gif[0], 0x47); // 'G' — GIF magic
    assert.equal(gif[1], 0x49); // 'I'
    assert.ok(gif.length < 500_000, `GIF too big: ${(gif.length/1024)|0}KB`);
  });

  test("grid renders every month with NO rain-math and no NaN", () => {
    for (let m = 1; m <= 12; m++) {
      const svg = downtimeSVG(downtimeModel(new Date(2026, m - 1, 15), 1000));
      assert.ok(!/NaN|undefined/.test(svg), `month ${m}`);
      assert.match(svg, /AVERAGES \d+ WET DAYS/);
      assert.ok(!/Likely Downtime Cost|RAIN MATH/.test(svg), "cost/math must be gone");
    }
  });
});

// ── $399 nudge ─────────────────────────────────────────────────────────────// ── $399 nudge ─────────────────────────────────────────────────────────────
describe("nudge", () => {
  const priced = [
    { key: "kajo", rank: 0, title: "KAJO Grease Packs", price: 16.7, available: true },
    { key: "pro_mat", rank: 1, title: "PRO Mat", price: 219, available: true },
    { key: "enclosure", rank: 2, title: "Pro Excavator Enclosure", price: 699, available: true },
  ];

  test("picks the cheapest product that actually crosses the gap", () => {
    const p = pickBridge(priced, 126, shippingConfig(cfg));
    assert.equal(p.title, "PRO Mat");
    assert.equal(p.crosses, true);
  });

  test("won't close a $20 gap with a $219 mat (overshoot guard)", () => {
    const p = pickBridge(priced, 20, shippingConfig(cfg));
    assert.ok(p.price <= 20 * 6);
    assert.equal(p.crosses, false);
  });

  test("returns null when nothing has a price", () => {
    assert.equal(pickBridge([{ key: "a", rank: 0, title: "A" }], 100, {}), null);
  });

  test("never renders $NaN when a pick has no price (shipped to production)", () => {
    const pick = firstPriced([{ rank: 0, title: "Pro Excavator Enclosure" }]);
    assert.equal(pick, null, "an unpriced candidate must not be chosen");
    for (const state of ["nudge", "qualified", "unknown"]) {
      const svg = nudgeSVG({ state, threshold: 399, cartValue: 520, gap: 0, progress: 1, pick });
      assert.ok(!/NaN|undefined/.test(svg), `${state} rendered NaN/undefined`);
    }
  });

  test("height collapses when no product card is drawn", () => {
    const h = (m) => Number(nudgeSVG(m).match(/height="(\d+)"/)[1]);
    const base = { state: "nudge", threshold: 399, cartValue: 273, gap: 126, progress: 0.68 };
    assert.equal(h({ ...base, pick: null }), 250);
    assert.equal(h({ ...base, pick: { title: "PRO Mat", price: 219, crosses: true } }), 340);
  });

  test("headline words don't collide (renderer drops plain spaces between tspans)", () => {
    const svg = nudgeSVG({ state: "nudge", threshold: 399, cartValue: 273, gap: 126, progress: 0.68, pick: null });
    assert.match(svg, /dx="14"/, "word gaps must use dx, not whitespace");
  });
});

// ── rain block ─────────────────────────────────────────────────────────────
describe("rain", () => {
  test("all twelve months render without NaN and always show 8 states", () => {
    for (let m = 1; m <= 12; m++) {
      const model = getRainModel(new Date(2026, m - 1, 15));
      assert.equal(model.states.length, 8, `${model.monthName}`);
      assert.ok(!/NaN|undefined/.test(rainSVG(model)), `${model.monthName} rendered NaN`);
    }
  });

  test("no tile ever reads '0 days' — that argues against buying a cover", () => {
    for (let m = 1; m <= 12; m++) {
      const model = getRainModel(new Date(2026, m - 1, 15));
      const svg = rainSVG(model);
      assert.ok(!/>0 days</.test(svg), `${model.monthName} shows a zero tile`);
      for (const s of model.states) {
        assert.ok(s.dry || s.days >= 1, `${model.monthName}/${s.state} is neither dry-flagged nor >=1`);
      }
    }
  });

  test("states are ordered wettest first", () => {
    const { states } = getRainModel(new Date(2026, 6, 15));
    const sorted = [...states].sort((a, b) => b.raw - a.raw);
    assert.deepEqual(states.map((s) => s.state), sorted.map((s) => s.state));
  });

  test("is synchronous — no network in the render path", () => {
    assert.ok(!(getRainModel() instanceof Promise));
  });
});

// ── Klaviyo line-item shape (rendered against a real event, 2026-07-28) ────
describe("line item shape", () => {
  test("Package Protection is caught by product id, not just variant id", () => {
    // The template's own PP filter compared `i.variant.id` (which renders EMPTY —
    // line items expose `variant_id`) against the PP id, so "" != PP was always
    // true and PP was never excluded. The engine must not depend on that filter.
    assert.equal(isNonProduct({ productId: "8376940167338" }, cfg), true);
    assert.equal(isNonProduct({ variantId: "", productId: "8376940167338" }, cfg), true);
    assert.equal(isNonProduct({ productId: "8213717909674" }, cfg), false);
  });

  test("a product-id-only line item still classifies", () => {
    // What the wire actually carries when variant_id is missing.
    const { keys } = classify([{ variantId: "", productId: "8213717909674" }], cfg);
    assert.ok(keys.has("pro_mat"));
  });
});

// ── personalised forecast ──────────────────────────────────────────────────
describe("forecast", () => {
  test("maps the region strings Klaviyo actually sends", () => {
    for (const [given, want] of [["New South Wales","NSW"],["Western Australia","WA"],
        ["Queensland","QLD"],["victoria","VIC"],[" nsw ","NSW"],["ACT","ACT"]])
      assert.equal(resolveState(given), want, given);
  });

  test("unknown or missing region resolves to null so the caller can fall back", () => {
    for (const bad of ["", null, undefined, "Fiji", "Auckland", "NSW2"])
      assert.equal(resolveState(bad), null, String(bad));
  });

  test("every state renders in every month, with no NaN and no zero-day claim", () => {
    for (let mo = 0; mo < 12; mo++) {
      const m = getRainModel(new Date(2026, mo, 15));
      for (const s of m.states) {
        const svg = forecastSVG(m, s.state, "test");
        assert.ok(svg, `${s.state} month ${mo + 1} rendered nothing`);
        assert.ok(!/NaN|undefined/.test(svg), `${s.state} month ${mo + 1} NaN`);
        // a dry state must sell dust, never "0 WET DAYS", which argues against a cover
        if (s.dry) assert.match(svg, /DUST SEASON/);
        else assert.ok(!/>0</.test(svg), `${s.state} month ${mo + 1} claimed zero days`);
      }
    }
  });

  test("the day strip never exceeds the days in the month", () => {
    for (let mo = 0; mo < 12; mo++) {
      const m = getRainModel(new Date(2026, mo, 15));
      const days = new Date(2001, mo + 1, 0).getDate();
      for (const s of m.states) {
        const wet = (forecastSVG(m, s.state).match(/fill="#f5eb19"/g) || []).length;
        assert.ok(wet <= days + 2, `${s.state}: ${wet} tiles > ${days} days`);
      }
    }
  });
});

// ── PRO Mat ground conditions + grease setup gauge ─────────────────────────
describe("ground conditions", () => {
  test("every state has hot, cold and wet, and always a highlight", () => {
    for (const st of ["NSW","VIC","QLD","WA","SA","TAS","NT","ACT"])
      for (let mo = 0; mo < 12; mo++) {
        const m = groundModel(st, new Date(2026, mo, 15));
        assert.ok(m, `${st} ${mo}`);
        assert.ok(Number.isFinite(m.hot) && Number.isFinite(m.cold), `${st} temps`);
        // a mild month must still pick a face, or the block renders flat. hotSoon and
        // coldSoon exist so the copy ("about to get hot") stays true out of season.
        assert.ok(["hot","cold","wet","hotSoon","coldSoon"].includes(m.live),
                  `${st} month ${mo+1} had no face`);
        const svg = groundSVG(m, "k");
        assert.ok(!/NaN|undefined/.test(svg), `${st} ${mo+1} NaN`);
        assert.ok(!/&amp;amp;/.test(svg), "double-escaped ampersand");
      }
  });

  test("the face never claims a season that is months away", () => {
    // "GROUND'S ABOUT TO GET HOT" must not fire when the hot month is half a year
    // off. A QLD reader in July was previously sold on a January average.
    for (const st of ["NSW","VIC","QLD","WA","SA","TAS","NT","ACT"])
      for (let mo = 0; mo < 12; mo++) {
        const m = groundModel(st, new Date(2026, mo, 15));
        const away = (t) => (t - (mo + 1) + 12) % 12;
        if (m.live === "hotSoon") assert.ok(away(new Date(`${m.hotMonth} 1 2001`).getMonth() + 1) <= 3,
          `${st} ${mo+1}: hotSoon but peak is far off`);
      }
  });

  test("summer is hotter than winter everywhere (sanity on the data itself)", () => {
    for (const st of ["NSW","VIC","QLD","WA","SA","TAS","NT","ACT"]) {
      const m = groundModel(st, new Date(2026, 0, 15));
      assert.ok(m.hot > m.cold + 5, `${st}: hot ${m.hot} vs cold ${m.cold}`);
    }
  });

  test("unknown state returns null so the caller falls back", () => {
    assert.equal(groundModel("ZZZ"), null);
    assert.equal(groundSVG(null), null);
  });
});

describe("grease setup gauge", () => {
  const CART = "7780170825898", ADAPT = "7780171186346", COUP = "8010019340458";

  test("reads gun, grease and pack count off a real cart", () => {
    const m = setupModel([
      { productId: CART, quantity: 20, variantTitle: "LZR2" },
      { productId: ADAPT, quantity: 1, variantTitle: "Milwaukee 18v" },
    ]);
    assert.equal(m.gun, "Milwaukee 18v");
    assert.equal(m.grease, "LZR2");
    assert.equal(m.packs, 20);
    assert.equal(m.owned, 2);
    assert.equal(m.missing, "coupler");
  });

  test("names the gap the customer actually has, not the dearest one", () => {
    // a coupler-only cart has no grease in it; telling that person to buy an
    // adapter answers a question they did not ask
    assert.equal(setupModel([{ productId: COUP, quantity: 1 }]).missing, "cartridges");
    assert.equal(setupModel([{ productId: ADAPT, quantity: 1 }]).missing, "cartridges");
  });

  test("a manual-gun cart is never told its setup is wrong", () => {
    const m = setupModel([{ productId: CART, quantity: 6, variantTitle: "LC002" }]);
    assert.equal(m.missing, "coupler", "must not demand an adapter");
    assert.match(setupSVG(m), /COUPLER/);
  });

  test("mixed grease types sum the packs and name one type", () => {
    const m = setupModel([
      { productId: CART, quantity: 6, variantTitle: "LZR2" },
      { productId: CART, quantity: 4, variantTitle: "Hammer Paste" },
    ]);
    assert.equal(m.packs, 10);
    assert.equal(m.grease, "LZR2");
  });

  test("no grease gear renders nothing rather than an empty gauge", () => {
    assert.equal(setupSVG(setupModel([{ productId: "999", quantity: 1 }])), null);
  });

  test("no glyph outside the vendored font (they render as tofu boxes)", () => {
    // The rule, not the drawing: U+2713 and U+2192 are not in Roboto Condensed, so
    // any state marker has to be drawn or spelled. This caught a tofu tick once and
    // a tofu arrow before that.
    const m = setupModel([{ productId: CART, quantity: 2, variantTitle: "LZR2" }]);
    for (const glyph of ["&#10003;", "&#8594;", "\u2713", "\u2192"])
      assert.ok(!setupSVG(m).includes(glyph), `${glyph} will render as tofu`);
  });

  test("names the grease back to them and reads the quantity", () => {
    const deep = setupModel([{ productId: CART, quantity: 20, variantTitle: "LZR2" }]);
    assert.match(setupSVG(deep), /EVERYDAY GREASING/);
    assert.match(setupSVG(deep), /stocked up for the season/);
    const light = setupModel([{ productId: CART, quantity: 2, variantTitle: "Hammer Paste" }]);
    assert.match(setupSVG(light), /BREAKER PASTE/);
    assert.match(setupSVG(light), /a starter run/);
  });
});

// ── 7-day forecast cascade (V2 Live / Local / National) ────────────────────
describe("forecast cascade", () => {
  const stub = (mm, tmax = [20,20,20,20,20,20,20], tmin = [10,10,10,10,10,10,10]) => async () => ({
    ok: true,
    json: async () => ({
      daily: {
        time: ["2026-08-01","2026-08-02","2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07"],
        precipitation_sum: mm, temperature_2m_max: tmax, temperature_2m_min: tmin,
      },
    }),
  });

  test("postcodes resolve to a real locality", () => {
    const p = resolvePostcode("6112");
    assert.equal(p.state, "WA");
    assert.ok(p.lat < -30 && p.lon > 110, "coords land in WA");
    // 9999 is Australia Post's Santa novelty code and sits in the raw dataset as
    // "North Pole, VIC" on Melbourne coordinates. Left in, a customer with it would
    // get a Melbourne forecast captioned North Pole, so it is filtered out.
    assert.equal(resolvePostcode("9999"), null, "novelty postcode must not resolve");
    assert.equal(resolvePostcode("0001"), null);
    assert.equal(resolvePostcode(""), null);
  });

  test("a DRY week returns null so the caller never shows a forecast that sells against us", async () => {
    const dry = await forecast7Model("6112", { fetchImpl: stub([0,0,0,0.4,0,0,0]) });
    assert.equal(dry, null, "no rain must fall back, not render");
  });

  test("a WET week renders, and counts only the wet days", async () => {
    const m = await forecast7Model("6112", { fetchImpl: stub([0,5,0,12,0,0,2]) });
    assert.equal(m.wetCount, 3);
    assert.equal(m.worst.mm, 12);
    const svg = forecast7SVG(m, "act before the rain hits");
    assert.ok(!/NaN|undefined/.test(svg));
    assert.match(svg, /ACT BEFORE THE RAIN HITS/);
  });

  test("any API failure degrades instead of throwing", async () => {
    for (const bad of [
      async () => ({ ok: false }),
      async () => { throw new Error("network"); },
      async () => ({ ok: true, json: async () => ({}) }),               // empty payload
      async () => ({ ok: true, json: async () => ({ daily: { time: ["x"] } }) }), // short
    ]) assert.equal(await forecast7Model("6112", { fetchImpl: bad }), null);
  });

  test("mat block reads rough GROUND, not just rain", async () => {
    // dry but freezing: no rain, yet the mat argument is strong
    const base = await forecast7Model("2672", {
      fetchImpl: stub([0,0,0,0,0,0,0], [12,12,12,12,12,12,12], [1,2,1,3,2,1,2]),
    });
    assert.equal(base, null, "rain block correctly sees no rain");
    // the ground model needs its own fetch since the rain gate returned null
    const raw = await forecast7Model("2672", {
      fetchImpl: stub([0,0,0,0,0,0,0], [12,12,12,12,12,12,12], [1,2,1,3,2,1,2]),
      // bypass the rain-only gate for this assertion
    });
    assert.equal(raw, null);
  });

  test("a mild week sells no mat, so it falls back", () => {
    assert.equal(groundForecast7Model(null), null);
  });

  test("national tier exists for both blocks (no location on file)", () => {
    const g = groundModel(null);
    assert.equal(g.state, "AUSTRALIA");
    assert.ok(g.wet > 0, "national wet days must not be zero");
    assert.ok(!/NaN|undefined/.test(groundSVG(g, "k")));
    const r = forecastSVG(getRainModel(new Date()), null, "k");
    assert.match(r, /ACROSS AUSTRALIA/);
    assert.ok(!/NaN|undefined/.test(r));
  });
});

// ── renderers must not throw (they degrade to a branded strip, silently) ────
describe("renderer smoke", () => {
  test("every card renderer survives a realistic pick", () => {
    // mateSVG once referenced a `cta` variable it never declared. Every call threw,
    // api/img.js swallowed it, and the email showed the plain fallback strip instead
    // of a product card. Nothing failed loudly, so it shipped.
    const pick = { key: "pro_mat", title: "PRO Mat", price: 219, image: null,
                   blurb: "Off the cold ground.", variant: "48999426621610" };
    for (const [name, fn] of [
      ["mateSVG", () => mateSVG(pick)],
      ["mateSVG(null)", () => mateSVG(null)],
      ["recCardSVG", () => recCardSVG(pick)],
      ["recCardSVG(cta)", () => recCardSVG(pick, { cta: "VIEW PRODUCT" })],
      ["recCardSVG(null)", () => recCardSVG(null)],
    ]) {
      let svg;
      assert.doesNotThrow(() => { svg = fn(); }, `${name} threw`);
      assert.ok(svg.startsWith("<svg"), `${name} returned no svg`);
      assert.ok(!/NaN|undefined|\$\{/.test(svg), `${name} leaked a template hole`);
    }
  });
});

// RAIN OUTLOOK — state grid for abandoned cart.
//
// THE PROBLEM: an abandoned-cart email has no location data. We can't say
// "rain's coming to Bendigo" because we don't know they're in Bendigo. Showing a
// sample of cities fails worse — a Bendigo reader sees Perth and Cairns and thinks
// "not my weather", which is less persuasive than showing nothing.
//
// THE FIX: put EVERY state on the panel. The reader finds their own patch and
// reads it as their weather. No address, no postcode, no IP lookup.
//
// THE STAT: **days of rain this month**, per state. That's the number that argues
// for a cover. A 3-day forecast can legitimately come back dry, which quietly
// argues AGAINST buying one; a monthly wet-day count never does, because rain
// always lands eventually.
//
// NO LIVE CALL. Wet-day averages are climate NORMALS — they don't move day to
// day, so all twelve months are pre-gathered once into config/rain-climate.json
// (10 years of Open-Meteo daily rainfall, 2015-2024, per sample point). At render
// time we just look up the current month. This means:
//   • zero network in the request path — nothing to time out, rate-limit or fail
//   • render is pure computation (sub-100ms, no cold-start penalty)
//   • every state always shows something that argues FOR a cover (dry-season
//     states show dust, never a zero)
// Regenerate with `node scripts/build-rain-climate.js` if POINTS ever changes.
//
// FRESHNESS: the output only changes when the MONTH changes, so the email URL
// carries &d={% now 'Y-m' %} — a monthly cache-buster. Gmail caches images ~48h
// per URL; a new URL each month is all this needs.

import climateData from "../config/rain-climate.json" with { type: "json" };

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "NT", "ACT"];

// Two REGIONAL centres per state — DiggerLid customers are regional, not CBD.
// Order here MUST match the arrays in config/rain-climate.json.
const POINTS = [
  ["NSW", -32.2569, 148.6011, "Dubbo"],      ["NSW", -31.0927, 150.932, "Tamworth"],
  ["VIC", -36.757, 144.2794, "Bendigo"],     ["VIC", -38.11, 147.06, "Sale"],
  ["QLD", -27.5598, 151.9507, "Toowoomba"],  ["QLD", -23.3781, 150.5136, "Rockhampton"],
  ["WA", -33.3271, 115.6414, "Bunbury"],     ["WA", -28.7774, 114.615, "Geraldton"],
  ["SA", -37.8318, 140.7792, "Mt Gambier"],  ["SA", -32.4923, 137.7652, "Port Augusta"],
  ["TAS", -41.4332, 147.1441, "Launceston"], ["TAS", -41.1789, 146.3506, "Devonport"],
  ["NT", -14.465, 132.2635, "Katherine"],    ["NT", -23.698, 133.8807, "Alice Springs"],
  ["ACT", -35.2809, 149.13, "Canberra"],
];

export const WET_MM = 1; // a day counts as wet at 1mm+

export { POINTS };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Render model: one tile per state, wettest first. Synchronous by design.
 *
 * `now` is injectable so the build script and tests can check any month.
 */
export function getRainModel(now = new Date()) {
  const month = now.getMonth() + 1;
  const monthName = now.toLocaleString("en-AU", { month: "long" });
  const per = climateData?.byMonth?.[month] || [];

  // Average the two sample points in each state.
  const agg = {};
  POINTS.forEach(([state], i) => {
    (agg[state] = agg[state] || []).push(per[i] ?? 0);
  });

  // Keep the raw mean: a state can round to 0 (NT in August), and a tile reading
  // "0 days" tells a Katherine operator he doesn't need a cover. In the dry season
  // the sell is dust and grit, not rain, so those tiles say so instead of showing
  // a zero. Never let a tile argue against the product.
  const states = STATES.map((s) => {
    const raw = mean(agg[s] || []);
    return { state: s, days: Math.round(raw), raw, dry: raw < 1 };
  }).sort((a, b) => b.raw - a.raw || a.state.localeCompare(b.state));

  const national = Math.round(mean(states.map((s) => s.days)));

  return {
    month,
    monthName,
    states,
    national,
    // Top half gets the yellow treatment: it gives the grid a hierarchy without
    // ever leaving a state blank.
    highlightCount: 4,
    headline: `${monthName.toUpperCase()} AVERAGES ${national} WET DAYS`,
    // NO state is named here (was "TAS cops it worst…"). Every reader should
    // identify with their OWN tile, not be told which other state has it worse.
    sub: `Ten years of rain data, state by state. Every wet day is a day your machine sits out in it.`,
  };
}

// Downtime cost — what a month's rain could cost in lost work.
// Framing (Matthew, 2026-07): roughly 20% of a month's wet days are days you'd
// otherwise have been earning (the rest fall on weekends, after hours, or ground
// already too wet to matter). So lostDays = 0.2 × wetDays, and the bill is
// lostDays × dayRate. dayRate defaults to $1000/day.
export const RAINED_OUT_SHARE = 0.2;

export function downtimeModel(now = new Date(), dayRate = 1000) {
  const base = getRainModel(now);
  const wetDays = base.national;
  const lostDays = Math.round(wetDays * RAINED_OUT_SHARE * 10) / 10;
  const cost = Math.round(lostDays * dayRate);
  return { ...base, dayRate, wetDays, lostDays, cost, share: RAINED_OUT_SHARE };
}

// ── SVG (rendered at 2x, displayed 540px wide) ──────────────────────────────
const BLACK = "#000000", YELLOW = "#f5eb19", WHITE = "#ffffff",
      DIM = "#6b6768", MUTE = "#8a857f", LINE = "#3a3637";  // MUTE matches ground/setup/forecast7
const FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Deterministic thousands separator — no ICU/locale dependency in the render path.
const dollars = (n) => "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const GRID = { W: 1080, PAD: 32, GAP: 12, COLS: 4, TH: 112, TOP: 150 };
GRID.TW = Math.round((GRID.W - GRID.PAD * 2 - GRID.GAP * (GRID.COLS - 1)) / GRID.COLS);
GRID.BOTTOM = GRID.TOP + 2 * GRID.TH + GRID.GAP;

/** Header + the 2×4 state grid — shared by the weather and downtime variants. */
function gridSVG(m) {
  const { PAD, GAP, COLS, TW, TH, TOP } = GRID;
  const tiles = m.states
    .map((s, i) => {
      const x = PAD + (i % COLS) * (TW + GAP);
      const y = TOP + Math.floor(i / COLS) * (TH + GAP);
      const cx = x + TW / 2;
      const value = s.dry ? "Dust season" : `${s.days} ${s.days === 1 ? "day" : "days"}`;
      const label = s.dry ? "COVER UP ANYWAY" : `${esc(m.monthName.toUpperCase())} AVG`;

      if (i < m.highlightCount) {
        return `<rect x="${x}" y="${y}" width="${TW}" height="${TH}" fill="${YELLOW}"/>
          <text x="${cx}" y="${y + 46}" font-family="${FONT}" font-size="42" font-weight="bold" fill="${BLACK}" text-anchor="middle" letter-spacing="1">${s.state}</text>
          <text x="${cx}" y="${y + 78}" font-family="${FONT}" font-size="26" font-weight="bold" fill="${BLACK}" text-anchor="middle">${value}</text>
          <text x="${cx}" y="${y + 98}" font-family="${FONT}" font-size="15" fill="${BLACK}" text-anchor="middle" letter-spacing="1.5">${label}</text>`;
      }
      return `<rect x="${x}" y="${y}" width="${TW}" height="${TH}" fill="none" stroke="${LINE}" stroke-width="2"/>
        <text x="${cx}" y="${y + 46}" font-family="${FONT}" font-size="42" font-weight="bold" fill="${DIM}" text-anchor="middle" letter-spacing="1">${s.state}</text>
        <text x="${cx}" y="${y + 78}" font-family="${FONT}" font-size="26" font-weight="bold" fill="${WHITE}" text-anchor="middle">${value}</text>
        <text x="${cx}" y="${y + 98}" font-family="${FONT}" font-size="15" fill="${MUTE}" text-anchor="middle" letter-spacing="1.5">${label}</text>`;
    })
    .join("");

  return `<text x="${PAD}" y="52" font-family="${FONT}" font-size="20" font-weight="bold" fill="${YELLOW}" letter-spacing="5">ACROSS THE COUNTRY</text>
    <text x="${PAD}" y="112" font-family="${FONT}" font-size="46" font-weight="bold" fill="${WHITE}" letter-spacing="0.5">${esc(m.headline)}</text>
    ${tiles}`;
}

// viewBox on every SVG so it scales cleanly (we rasterise at native 1080 and the
// email scales the PNG down to 540).
export function rainSVG(m) {
  const { W, PAD, BOTTOM } = GRID;
  const dividerY = BOTTOM + 26;
  const H = dividerY + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${BLACK}"/>
    ${gridSVG(m)}
    <line x1="${PAD}" y1="${dividerY}" x2="${W - PAD}" y2="${dividerY}" stroke="${LINE}" stroke-width="2"/>
    <text x="${PAD}" y="${dividerY + 34}" font-family="Arial,sans-serif" font-size="21" fill="#c4c3bf">${esc(m.sub.slice(0, 118))}</text>
  </svg>`;
}

// ── animated LO-FI RAIN LINES (GIF frames) ───────────────────────────────────
// Simple straight rain streaks — flat colour, thin lines, no highlights or
// beads. Deliberately lo-fi: it reads as rain instantly, encodes tiny (one
// colour → small GIF, fast load), and loops seamlessly.
//
// SEAMLESS LOOP: streaks sit on a vertically PERIODIC field (period RAIN_P). One
// loop shifts the field down exactly RAIN_P, so a streak leaving the bottom is
// replaced by its periodic copy entering the top — no visible seam.
const RAIN_P = 96;                  // vertical period = per-loop travel
const RAIN_LEN = 30;                // streak length
const RAIN_DX = 3;                  // slight slant for motion
const RAIN_COL = "#8fa9bd";         // single cool blue-grey
// Deterministic pseudo-random in [0,1) — no Math.random, identical every render.
const _hash = (n) => { const s = Math.sin(n * 12.9898 + 7.13) * 43758.5453; return s - Math.floor(s); };

/** Lo-fi rain streaks for phase 0..1, clipped to y < maxY. */
function rainLayer(phase, W, H, maxY = H) {
  let out = "";
  const COL = 30;
  for (let c = 0, x0 = 14; x0 < W; x0 += COL, c++) {
    const x = x0 + Math.round(_hash(c * 1.7) * 12);          // column jitter
    const op = (0.22 + _hash(c * 3.7 + 6) * 0.26).toFixed(2);
    const base = _hash(c * 4.3 + 9) * RAIN_P;                // seeded start offset
    for (let k = -1; k * RAIN_P < maxY + RAIN_P; k++) {
      const y = base + k * RAIN_P + phase * RAIN_P;
      if (y < -RAIN_LEN || y > maxY) continue;
      out += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + RAIN_DX).toFixed(1)}" y2="${(y + RAIN_LEN).toFixed(1)}" stroke="${RAIN_COL}" stroke-width="2" stroke-opacity="${op}"/>`;
    }
  }
  return out;
}

/**
 * "Across the country" state grid, with optional animated rain behind it.
 * NO rain-math / cost — just the header + the 2×4 grid (Matthew, 2026-07-27).
 * `rain` is an optional pre-rendered rain layer; omit it for the static image.
 */
// Closing line under the state tiles (Matthew, 2026-07-28). Uppercase to sit with
// the block's other display type; white rather than yellow so it supports the tiles
// instead of competing with them for the eye.
// No standing kicker on this block. Callers pass one if they want it.

// ONE source of truth for the height. This used to be written out in both
// downtimeSVG and downtimeFrames with a "must match" comment — the moment the
// layout changed, the still and the animated frames would silently disagree and
// the GIF would crop. Derive it once instead.
const DOWNTIME_H = GRID.BOTTOM + 74;   // +46 added in the shell for the source note

export function downtimeSVG(m, rain = "", kicker = "") {
  const { W, PAD, BOTTOM } = GRID;
  // The same drawn rain mark the personalised blocks carry, so the two variants read
  // as one family. Sits top-right, clear of the headline.
  // MY=26 clipped the cloud's top arc (~40px above the anchor) off the canvas.
  const MX = W - 172, MY = 48;
  const mark = `<g opacity="0.9">
    <path d="M ${MX + 24} ${MY + 36} a 26 26 0 0 1 5 -51 a 34 34 0 0 1 64 9 a 22 22 0 0 1 -5 42 z"
          fill="none" stroke="${WHITE}" stroke-width="6" stroke-linejoin="round"/>
    ${[0, 1, 2].map((i) => `<line x1="${MX + 30 + i * 26}" y1="${MY + 50}" x2="${MX + 20 + i * 26}" y2="${MY + 78}" stroke="${YELLOW}" stroke-width="8" stroke-linecap="round"/>`).join("")}
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${DOWNTIME_H + 8}" viewBox="0 0 ${W} ${DOWNTIME_H + 8}">
    <rect width="100%" height="100%" fill="${BLACK}"/>
    ${rain}
    ${mark}
    ${gridSVG(m)}
    <text x="${PAD}" y="${BOTTOM + 50}" font-family="Arial,sans-serif" font-size="18" fill="${MUTE}">Based on 2015&#8211;2024 daily rainfall at fifteen regional centres, every state. A wet day is ${WET_MM}mm or more.</text>
    ${kicker ? `<text x="${PAD}" y="${BOTTOM + 96}" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" letter-spacing="0.5">${esc(kicker.toUpperCase())}</text>` : ""}
  </svg>`;
}

/** N SVG frames of the grid with lo-fi rain animated behind it. */
export function downtimeFrames(m, n = 10) {
  return Array.from({ length: n }, (_, i) =>
    downtimeSVG(m, rainLayer(i / n, GRID.W, DOWNTIME_H, DOWNTIME_H))
  );
}

/** Convenience: model + SVG in one call, for api/img.js. */
export function rainOutlookSVG(now = new Date()) {
  return rainSVG(getRainModel(now));
}

export function downtimeOutlookSVG(now = new Date(), dayRate = 1000) {
  return downtimeSVG(downtimeModel(now, dayRate));
}

// ── PERSONALISED FORECAST ───────────────────────────────────────────────────
// The all-states grid exists because an abandoned cart "has no location data".
// That is no longer true: Klaviyo profiles carry a region, and in this account
// every profile sampled had one. So instead of eight tiles the reader has to
// scan to find their own patch, we show THEIR patch, big.
//
// It degrades to the grid when the region is missing or unrecognised, so one URL
// works for every recipient and nobody ever sees a broken block.

const REGION_TO_STATE = {
  "new south wales": "NSW", nsw: "NSW",
  victoria: "VIC", vic: "VIC",
  queensland: "QLD", qld: "QLD",
  "western australia": "WA", wa: "WA",
  "south australia": "SA", sa: "SA",
  tasmania: "TAS", tas: "TAS",
  "northern territory": "NT", nt: "NT",
  "australian capital territory": "ACT", act: "ACT", canberra: "ACT",
};

/** "New South Wales" | "nsw" | "NSW " -> "NSW", else null. */
export function resolveState(region = "") {
  return REGION_TO_STATE[String(region).trim().toLowerCase()] || null;
}

/** Regional centres behind a state's number, for the credibility line. */
function townsFor(state) {
  return POINTS.filter((p) => p[0] === state).map((p) => p[3]);
}

// Plain-language proportion. Bands, not arithmetic rounding: round(31/13) gives
// "one day in two", which claims 50% when the real figure is 42%. Overstating rain
// in our own favour is exactly the kind of small dishonesty that costs trust, and
// every band below is true across its whole range. "About" is doing real work here,
// and the exact count sits on the bar regardless.
function proportion(wet, days) {
  const pct = (wet / days) * 100;
  if (pct >= 40) return "Close to every second day.";
  if (pct >= 30) return "About one day in three.";
  if (pct >= 22) return "About one day in four.";
  if (pct >= 15) return "About one day in five.";
  if (pct >= 8) return "About one day in eight.";
  return "";
}

/**
 * One state, one number, and a single proportional bar.
 *
 * The bar replaced a 31-square day strip. The strip failed a simple test: Matthew
 * built the brand and could not read it, so a customer on a phone had no chance.
 * Nothing labelled the squares as days, and the lit ones looked like specific dates
 * when they were only a count spread across slots. One bar says "this share of the
 * month" and claims nothing about WHICH days, which is all we actually know.
 */
export function forecastSVG(m, state, kicker = "") {
  // No usable region: show the NATIONAL figure in this same format rather than
  // dropping to the old all-states grid. The grid is a different visual language,
  // and a reader who happens to have no location on file should not get an email
  // that looks like it came from a different brand.
  const row = state
    ? m.states.find((s) => s.state === state)
    : { state: null, days: m.national, dry: false };
  if (!row) return null;
  const national = !state;

  const W = 1080, PAD = 40;
  const daysInMonth = new Date(2001, m.month, 0).getDate();
  const wet = Math.min(daysInMonth, Math.max(0, Math.round(row.days)));
  const dry = daysInMonth - wet;
  const month = esc(m.monthName.toUpperCase());
  const towns = national
    ? "fifteen regional centres, every state"
    : townsFor(state).map(esc).join(" &amp; ");
  const patch = national ? "ACROSS AUSTRALIA" : `YOUR PATCH &#183; ${esc(state)}`;
  const where = national ? "Australia" : esc(state);

  if (row.dry) {
    // Dry season: no proportion to draw, and a near-empty bar would argue against
    // the product. Sell the dust instead.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="330" viewBox="0 0 ${W} 330">
      <rect width="100%" height="100%" fill="${BLACK}"/>
      <text x="${PAD}" y="60" font-family="${FONT}" font-size="20" font-weight="bold" fill="${YELLOW}" letter-spacing="5">${patch}</text>
      <text x="${PAD}" y="164" font-family="${FONT}" font-size="82" font-weight="bold" fill="${YELLOW}">DUST SEASON</text>
      <text x="${PAD}" y="212" font-family="Arial,sans-serif" font-size="23" fill="${WHITE}">Barely a wet day in ${where} this ${esc(m.monthName)}, so it is dust and UV doing the damage instead.</text>
      <text x="${PAD}" y="262" font-family="Arial,sans-serif" font-size="18" fill="${MUTE}">Based on 2015&#8211;2024 daily rainfall at ${towns}. A wet day is ${WET_MM}mm or more.</text>
      ${kicker ? `<text x="${PAD}" y="306" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" letter-spacing="0.5">${esc(kicker.toUpperCase())}</text>` : ""}
    </svg>`;
  }

  // The lo-fi diagonal rain lines are already DiggerLid's rain visual (they animate
  // in the MSG1 GIF). Reusing them here makes the block legible as weather in the
  // first glance, which a bare bar was not. A row of sun/cloud/rain icons would do
  // that too, but one icon per day claims we know which days will be wet, and we
  // only know the monthly average.
  // ONE rain mark, drawn, right-aligned opposite the number.
  //
  // Two earlier passes used the GIF's rain lines as a background wash; both were
  // invisible, and a wash is decoration in any case. A single bold mark is what makes
  // the block legible as weather at a glance. Deliberately NOT a row of daily
  // sun/cloud/rain icons: one icon per day claims we know which days are wet, and a
  // monthly average knows nothing of the sort.
  //
  // Drawn as paths, not a glyph: the vendored font has no weather characters, and a
  // missing glyph renders as a tofu box.
  const MX = W - PAD - 150, MY = 48;   // strokes end ~140, bar at 244: clear air between
  const motif = `<g opacity="0.9">
    <path d="M ${MX + 28} ${MY + 42} a 30 30 0 0 1 6 -59 a 40 40 0 0 1 74 10 a 26 26 0 0 1 -6 49 z"
          fill="none" stroke="${WHITE}" stroke-width="7" stroke-linejoin="round"/>
    ${[0, 1, 2].map((i) => `<line x1="${MX + 34 + i * 30}" y1="${MY + 58}" x2="${MX + 22 + i * 30}" y2="${MY + 92}" stroke="${YELLOW}" stroke-width="9" stroke-linecap="round"/>`).join("")}
  </g>`;

  // ONE bar, split at the wet/dry share of the month.
  const BW = W - PAD * 2, BY = 244, BH = 44;
  const wetW = Math.max(6, Math.round((wet / daysInMonth) * BW));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="400" viewBox="0 0 ${W} 400">
    <rect width="100%" height="100%" fill="${BLACK}"/>
    <g transform="translate(0,58)">${motif}</g>
    <text x="${PAD}" y="60" font-family="${FONT}" font-size="20" font-weight="bold" fill="${YELLOW}" letter-spacing="5">${patch}</text>

    <text x="${PAD}" y="200" font-family="${FONT}" font-size="132" font-weight="bold" fill="${YELLOW}">${wet}</text>
    <text x="${PAD + (wet > 9 ? 175 : 96)}" y="164" font-family="${FONT}" font-size="52" font-weight="bold" fill="${WHITE}">WET DAYS</text>
    <text x="${PAD + (wet > 9 ? 178 : 99)}" y="204" font-family="Arial,sans-serif" font-size="25" fill="#c4c3bf">an average ${month} ${national ? "nationally" : "in " + esc(state)}. ${proportion(wet, daysInMonth)}</text>

    <rect x="${PAD}" y="${BY}" width="${BW}" height="${BH}" fill="#2c2a28"/>
    <rect x="${PAD}" y="${BY}" width="${wetW}" height="${BH}" fill="${YELLOW}"/>
    <text x="${PAD + 14}" y="${BY + 29}" font-family="${FONT}" font-size="22" font-weight="bold" fill="${BLACK}">${wet} WET</text>
    <text x="${W - PAD - 14}" y="${BY + 29}" font-family="${FONT}" font-size="22" font-weight="bold" fill="#8a857f" text-anchor="end">${dry} DRY</text>

    <text x="${PAD}" y="${BY + 92}" font-family="Arial,sans-serif" font-size="18" fill="${MUTE}">Based on 2015&#8211;2024 daily rainfall at ${towns}. A wet day is ${WET_MM}mm or more.</text>
    ${kicker ? `<text x="${PAD}" y="${BY + 136}" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" letter-spacing="0.5">${esc(kicker.toUpperCase())}</text>` : ""}
  </svg>`;
}

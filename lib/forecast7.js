// lib/forecast7.js — LIVE 7-day rain forecast, shown only when it is going to rain.
//
// THE OBJECTION THIS ANSWERS: a forecast can come back dry, and a dry forecast in a
// cover email argues against the product. Solved by making the block conditional on
// its own content: if there is no rain in the next seven days this returns null and
// the caller falls back to the climate average, which always argues for a cover.
// We never show a forecast that sells against us.
//
// This is also the one place per-day marks are honest. A row of daily icons over a
// MONTHLY AVERAGE claims we know which days will be wet; over a real forecast we do.
//
// THE TRADE: this is the only live network call in the whole render path. Everything
// else is static or Shopify. So it is wrapped tightly:
//   - 2.5s timeout, any failure returns null and the caller degrades
//   - coordinates come from a STATIC postcode file, so one call, not two
//   - the caller edge-caches, so one fetch serves many opens
// Apple Mail pre-fetches images near delivery, which for a 7-day window is fine:
// the block stays broadly true for days. It would not be for a 3-day forecast.

import postcodes from "../config/au-postcodes.json" with { type: "json" };
import { WET_MM } from "./rain.js";
import { statBlockSVG } from "./ground.js";

const BLACK = "#000000", YELLOW = "#f5eb19", WHITE = "#ffffff",
      MUTE = "#8a857f", TRACK = "#2c2a28";
const FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "6112" | " 6112 " -> {lat, lon, state, locality} | null */
export function resolvePostcode(zip) {
  const pc = String(zip || "").trim().padStart(4, "0");
  const row = postcodes.byPostcode?.[pc];
  if (!row) return null;
  return { lat: row[0], lon: row[1], state: row[2], locality: row[3] };
}

/**
 * Fetch the next 7 days for a postcode.
 * Returns null on ANY failure, or when no rain is coming: both mean "fall back".
 */
export async function forecast7Model(zip, { ms = 2500, fetchImpl = fetch } = {}) {
  const place = resolvePostcode(zip);
  if (!place) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&forecast_days=7` +
      `&timezone=auto`;
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const times = j?.daily?.time || [];
    const mm = j?.daily?.precipitation_sum || [];
    const tmax = j?.daily?.temperature_2m_max || [];
    const tmin = j?.daily?.temperature_2m_min || [];
    if (times.length < 7) return null;

    const days = times.map((iso, i) => {
      const d = new Date(iso + "T00:00:00");
      return {
        iso,
        // en-AU short weekday, uppercased for the column head
        label: d.toLocaleDateString("en-AU", { weekday: "short" }).slice(0, 3).toUpperCase(),
        long: d.toLocaleDateString("en-AU", { weekday: "long" }),
        mm: Math.round((mm[i] ?? 0) * 10) / 10,
        wet: (mm[i] ?? 0) >= WET_MM,
        tmax: Math.round(tmax[i] ?? 0),
        tmin: Math.round(tmin[i] ?? 0),
      };
    });

    const wetDays = days.filter((d) => d.wet);
    // No rain coming: return null so the caller shows the climate average instead.
    if (!wetDays.length) return null;

    const worst = days.reduce((a, b) => (b.mm > a.mm ? b : a), days[0]);
    return {
      place,
      days,
      wetCount: wetDays.length,
      totalMm: Math.round(days.reduce((t, d) => t + d.mm, 0) * 10) / 10,
      worst,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Seven columns, height by rainfall. Yellow = rain due. */
export function forecast7SVG(m, kicker = "") {
  if (!m) return null;
  const W = 1080, PAD = 40, H = 440;
  const colW = (W - PAD * 2 - 6 * 12) / 7;
  const maxMm = Math.max(2, ...m.days.map((d) => d.mm));
  const BASE = 296, MAXH = 104;

  const cols = m.days
    .map((d, i) => {
      const x = PAD + i * (colW + 12);
      const h = Math.max(4, Math.round((d.mm / maxMm) * MAXH));
      const y = BASE - h;
      return `<rect x="${x.toFixed(1)}" y="${y}" width="${colW.toFixed(1)}" height="${h}" fill="${d.wet ? YELLOW : TRACK}"/>
        <text x="${(x + colW / 2).toFixed(1)}" y="${y - 10}" font-family="${FONT}" font-size="19" font-weight="bold" fill="${d.wet ? WHITE : MUTE}" text-anchor="middle">${d.mm >= 0.1 ? d.mm + "mm" : ""}</text>
        <text x="${(x + colW / 2).toFixed(1)}" y="${BASE + 26}" font-family="${FONT}" font-size="20" font-weight="bold" fill="${d.wet ? YELLOW : MUTE}" text-anchor="middle" letter-spacing="1">${d.label}</text>`;
    })
    .join("");

  // the rain mark, drawn (the vendored font has no weather glyphs)
  const MX = W - PAD - 132, MY = 40;
  const mark = `<g opacity="0.95">
    <path d="M ${MX + 24} ${MY + 36} a 26 26 0 0 1 5 -51 a 34 34 0 0 1 64 9 a 22 22 0 0 1 -5 42 z"
          fill="none" stroke="${WHITE}" stroke-width="6" stroke-linejoin="round"/>
    ${[0, 1, 2].map((i) => `<line x1="${MX + 30 + i * 26}" y1="${MY + 50}" x2="${MX + 20 + i * 26}" y2="${MY + 78}" stroke="${YELLOW}" stroke-width="8" stroke-linecap="round"/>`).join("")}
  </g>`;

  const where = `${esc(m.place.locality)}, ${esc(m.place.state)}`;
  const lead = m.wetCount === 1 ? "RAIN DUE THIS WEEK" : `${m.wetCount} WET DAYS COMING`;
  const detail =
    m.worst.mm >= 0.1
      ? `${m.totalMm}mm due across the next seven days, with ${m.worst.mm}mm on ${m.worst.long}.`
      : `Rain due across the next seven days.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${BLACK}"/>
    ${mark}
    <text x="${PAD}" y="58" font-family="${FONT}" font-size="20" font-weight="bold" fill="${YELLOW}" letter-spacing="5">NEXT 7 DAYS &#183; ${where.toUpperCase()}</text>
    <text x="${PAD}" y="126" font-family="${FONT}" font-size="60" font-weight="bold" fill="${WHITE}">${lead}</text>
    <text x="${PAD}" y="166" font-family="Arial,sans-serif" font-size="23" fill="#c4c3bf">${esc(detail)}</text>
    ${cols}
    <text x="${PAD}" y="${BASE + 74}" font-family="Arial,sans-serif" font-size="18" fill="${MUTE}">Live forecast for ${where}. A wet day is ${WET_MM}mm or more.</text>
    ${kicker ? `<text x="${PAD}" y="${H - 22}" font-family="${FONT}" font-size="30" font-weight="bold" fill="${WHITE}" letter-spacing="0.5">${esc(kicker.toUpperCase())}</text>` : ""}
  </svg>`;
}

// ── PRO MAT VARIANT ─────────────────────────────────────────────────────────
// Same seven-day data, different argument. A cover protects the machine from rain;
// a mat protects YOU from the ground, and the ground is punishing in three ways.
// So this reads each day for frost, heat and wet, and talks about what you would be
// lying on rather than what is falling out of the sky.
//
// Same conditional rule as the rain block: if none of the seven days is rough, this
// returns null and the caller falls back to the climate version. A forecast of seven
// mild days is not an argument for a mat.

const FROST_C = 4;   // at or under this overnight, call it frost and mean it
const COLD_C = 8;    // above frost but still miserable to kneel on for an hour
const HOT_C = 32;    // at or over this, steel and concrete are worse than the air

/** Tag each day with the condition that would actually bother you on the ground. */
export function groundForecast7Model(m) {
  if (!m) return null;
  const days = m.days.map((d) => ({
    ...d,
    cond: d.wet ? "wet"
      : d.tmin <= FROST_C ? "frost"
      : d.tmax >= HOT_C ? "hot"
      : d.tmin <= COLD_C ? "cold"      // honest middle tier: 8C ground is still rough
      : null,
  }));
  const rough = days.filter((d) => d.cond);
  if (!rough.length) return null;      // seven mild days sells no mat

  const counts = { wet: 0, frost: 0, cold: 0, hot: 0 };
  rough.forEach((d) => counts[d.cond]++);
  // lead with whichever condition dominates the week
  const lead = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const coldest = days.reduce((a, b) => (b.tmin < a.tmin ? b : a), days[0]);
  const hottest = days.reduce((a, b) => (b.tmax > a.tmax ? b : a), days[0]);
  return { ...m, days, rough: rough.length, counts, lead, coldest, hottest };
}

export function groundForecast7SVG(m, kicker = "", theme = "dark") {
  if (!m) return null;
  // Rendered through the SHARED stat block (Matthew, 2026-08-10) so the live
  // 7-day tier and the climate tier are visually identical. The week's lead
  // condition supplies the number: coldest morning for frost/cold, hottest day
  // for hot, wet-day count for wet. Bodies are sized to the block's two lines.
  const place = `${esc(m.place.locality)}, ${esc(m.place.state)}`.toUpperCase();
  const BLOCK = {
    wet: {
      big: `${m.counts.wet}`, unit: "", icon: "drop",
      title: "GROUNDS WET THIS WEEK",
      body: `${m.totalMm}mm due this week. That's the mud you'd be lying in.`,
    },
    frost: {
      big: `${m.coldest.tmin}`, unit: "&#176;", icon: "snow",
      title: "GROUNDS FROZEN THIS WEEK",
      body: `Down to ${m.coldest.tmin}&#176; ${m.coldest.long} morning, right where your knees go.`,
    },
    cold: {
      big: `${m.coldest.tmin}`, unit: "&#176;", icon: "snow",
      title: "GROUNDS COLD THIS WEEK",
      body: `Down to ${m.coldest.tmin}&#176; ${m.coldest.long} morning, right where your knees go.`,
    },
    hot: {
      big: `${m.hottest.tmax}`, unit: "&#176;", icon: "sun",
      title: "GROUNDS BAKING THIS WEEK",
      body: `Up to ${m.hottest.tmax}&#176; ${m.hottest.long}. Steel and concrete run hotter still.`,
    },
  };
  const b = BLOCK[m.lead] || BLOCK.cold;
  return statBlockSVG({
    title: b.title, big: b.big, unit: b.unit, icon: b.icon,
    label: `NEXT 7 DAYS &#183; ${place}`,
    body: b.body,
    source: `Live 7 day BOM forecast for ${esc(m.place.locality)}, ${esc(m.place.state)}.`,
    theme,
  });
}

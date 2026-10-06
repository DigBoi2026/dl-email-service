// Regenerate config/rain-climate.json — the pre-gathered wet-day averages that
// lib/rain.js reads at render time.
//
//   node scripts/build-rain-climate.js
//
// Pulls 10 years of daily rainfall (Open-Meteo archive) for every sample point,
// counts the days at or above WET_MM in each calendar month, and averages across
// the years. Output is 12 arrays of per-point averages, in POINTS order.
//
// Run this ONLY when POINTS changes or you want to roll the 10-year window
// forward. The email never calls the archive API — that's the whole point: the
// request path stays offline and can't time out.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { POINTS, WET_MM } from "../lib/rain.js";

const START = "2015-01-01";
const END = "2024-12-31";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "rain-climate.json");
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const lats = POINTS.map((p) => p[1]).join(",");
const lons = POINTS.map((p) => p[2]).join(",");

console.log(`Fetching ${START}..${END} for ${POINTS.length} points…`);
const res = await fetch(
  `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lons}` +
    `&start_date=${START}&end_date=${END}&daily=precipitation_sum&timezone=Australia%2FSydney`
);
if (!res.ok) throw new Error(`archive-api ${res.status}`);
const json = await res.json();
const locs = Array.isArray(json) ? json : [json];
if (locs.length !== POINTS.length) {
  throw new Error(`expected ${POINTS.length} locations, got ${locs.length}`);
}

const byMonth = {};
for (let m = 1; m <= 12; m++) {
  byMonth[m] = locs.map((loc) => {
    const perYear = {};
    (loc.daily?.time || []).forEach((iso, i) => {
      const d = new Date(iso);
      if (d.getUTCMonth() + 1 !== m) return;
      const y = d.getUTCFullYear();
      perYear[y] = perYear[y] || 0;
      if ((loc.daily.precipitation_sum[i] || 0) >= WET_MM) perYear[y]++;
    });
    return Math.round(mean(Object.values(perYear)) * 100) / 100;
  });
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _note:
        `Average days with >=${WET_MM}mm rain, per POINTS index per calendar month, ` +
        `from Open-Meteo archive ${START}..${END}. Climate normals, so they ship as ` +
        `static data and lib/rain.js makes NO network call at render time. ` +
        `Regenerate with: node scripts/build-rain-climate.js`,
      _window: { start: START, end: END, wetThresholdMm: WET_MM },
      _points: POINTS.map((p) => `${p[0]} ${p[3]}`),
      byMonth,
    },
    null,
    2
  ) + "\n"
);

console.log(`Wrote ${OUT}`);
for (let m = 1; m <= 12; m++) {
  const name = new Date(2024, m - 1, 1).toLocaleString("en-AU", { month: "short" });
  console.log(`  ${name}: ${byMonth[m].map((v) => v.toFixed(1)).join(", ")}`);
}

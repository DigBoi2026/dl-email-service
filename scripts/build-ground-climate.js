// Regenerate config/ground-climate.json — the pre-gathered temperature averages
// behind the PRO Mat "ground conditions" block.
//
//   node scripts/build-ground-climate.js
//
// The mat argues against three things, so the block has to quantify three things:
// HOT ground, COLD ground and WET ground. Rain already lives in rain-climate.json;
// this adds the mean daily max and min for the same 15 sample points, same 10-year
// window, same POINTS order.
//
// SEPARATE FILE ON PURPOSE: rain-climate.json feeds the shipped covers block. A
// regenerate that touched it could regress a working email for the sake of a new
// one, so temperature lands beside it rather than inside it.
//
// Run only when POINTS changes or to roll the window forward. Nothing calls the
// archive API at render time.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { POINTS } from "../lib/rain.js";

const START = "2015-01-01";
const END = "2024-12-31";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "ground-climate.json");
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (n) => Math.round(n * 10) / 10;

const lats = POINTS.map((p) => p[1]).join(",");
const lons = POINTS.map((p) => p[2]).join(",");

console.log(`Fetching ${START}..${END} temps for ${POINTS.length} points…`);
const res = await fetch(
  `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lons}` +
    `&start_date=${START}&end_date=${END}` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=Australia%2FSydney`
);
if (!res.ok) throw new Error(`archive-api ${res.status}`);
const json = await res.json();
const locs = Array.isArray(json) ? json : [json];
if (locs.length !== POINTS.length) {
  throw new Error(`expected ${POINTS.length} locations, got ${locs.length}`);
}

const maxByMonth = {}, minByMonth = {};
for (let m = 1; m <= 12; m++) {
  const pick = (key) =>
    locs.map((loc) => {
      const vals = [];
      (loc.daily?.time || []).forEach((iso, i) => {
        if (new Date(iso).getUTCMonth() + 1 !== m) return;
        const v = loc.daily[key]?.[i];
        if (typeof v === "number") vals.push(v);
      });
      return r1(mean(vals));
    });
  maxByMonth[m] = pick("temperature_2m_max");
  minByMonth[m] = pick("temperature_2m_min");
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _note:
        `Mean daily max and min air temperature (C), per POINTS index per calendar ` +
        `month, from Open-Meteo archive ${START}..${END}. AIR temperature, not surface: ` +
        `steel and concrete in the sun run well above this, and bare ground overnight ` +
        `runs below it, so copy should never quote these as ground temps. ` +
        `Regenerate with: node scripts/build-ground-climate.js`,
      _window: { start: START, end: END },
      _points: POINTS.map((p) => `${p[0]} ${p[3]}`),
      maxByMonth,
      minByMonth,
    },
    null,
    2
  ) + "\n"
);

console.log(`Wrote ${OUT}`);
for (let m = 1; m <= 12; m++) {
  const name = new Date(2024, m - 1, 1).toLocaleString("en-AU", { month: "short" });
  console.log(`  ${name}  max ${maxByMonth[m][0].toFixed(1)}  min ${minByMonth[m][0].toFixed(1)}  (Dubbo)`);
}

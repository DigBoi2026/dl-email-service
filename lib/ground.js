// lib/ground.js — "THE GROUND YOU WORK ON": the PRO Mat's personalised block.
//
// The mat protects against three things, so the block argues ONE of them: whichever
// is actually biting where the reader is, this month. A three-tile menu makes the
// reader do the work of deciding which column applies to them, and dilutes the
// argument to a third of its strength. A Darwin operator in December should read
// about heat. A Canberra operator in July should read about frost. Same block,
// three faces, chosen by their data.
//
// WHY HOT AND COLD ARE ANNUAL, NOT MONTHLY:
// A monthly figure makes two of the three look ridiculous. In a NSW July the mean
// max is 14C, and a tile reading "HOT 14" argues against the product. So hot and
// cold show the state's ANNUAL extremes (its hottest month's average high, its
// coldest month's average low) while wet stays current-month. That is the true
// shape of the year, and the mat is bought once for all of it.
//
// AIR, NOT SURFACE. The archive gives 2m air temperature. Steel and concrete in
// the sun run well above it and bare ground overnight runs below it, so the copy
// says "air in the shade" and lets the reader do the rest. Overclaiming a surface
// temperature we never measured would be the one number in the block that is not
// checkable.

import ground from "../config/ground-climate.json" with { type: "json" };
import { POINTS } from "./rain.js";
import { getRainModel } from "./rain.js";

const BLACK = "#000000", YELLOW = "#f5eb19", WHITE = "#ffffff",
      MUTE = "#8a857f", TRACK = "#2c2a28";
const FONT = `Roboto Condensed,Bahnschrift,'Arial Narrow',Arial,sans-serif`;
const esc = (s = "") => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Indices into POINTS for one state. */
function idxFor(state) {
  return POINTS.map((p, i) => (p[0] === state ? i : -1)).filter((i) => i >= 0);
}

/**
 * Hot / cold / wet for one state.
 * Returns null for an unknown state so the caller can fall back.
 */
export function groundModel(state, now = new Date()) {
  // state === null is the V2 National tier: average every sample point instead of
  // one state's pair. Without it a profile with no location would have to fall back
  // to the RAIN block, which argues for a cover in an email selling a mat.
  const national = !state;
  const idx = national ? POINTS.map((_, i) => i) : idxFor(state);
  if (!idx.length) return null;

  const monthMean = (table, m) => mean(idx.map((i) => table[m]?.[i] ?? 0));

  // hottest month's mean daily max, coldest month's mean daily min
  let hot = -Infinity, hotMonth = 1, cold = Infinity, coldMonth = 1;
  for (let m = 1; m <= 12; m++) {
    const hi = monthMean(ground.maxByMonth, m);
    const lo = monthMean(ground.minByMonth, m);
    if (hi > hot) { hot = hi; hotMonth = m; }
    if (lo < cold) { cold = lo; coldMonth = m; }
  }

  const rain = getRainModel(now);
  // national has no matching state row, so take the national wet-day figure
  const row = national
    ? { days: rain.national, dry: false }
    : rain.states.find((s) => s.state === state);
  const month = now.getMonth() + 1;
  const nowHigh = monthMean(ground.maxByMonth, month);
  const nowLow = monthMean(ground.minByMonth, month);

  // Which of the three is biting THIS month. Thresholds are deliberately plain:
  // 30C+ is a hot day's work, 8C or under is cold on the knees, 8+ wet days is a
  // wet month. Ties break hot > cold > wet, since heat is the one people
  // underestimate on a steel deck.
  // The copy now says "about to get hot" and "this time of year", so the condition
  // has to be about NOW or the near future. The old annual-signature fallback could
  // point six months away: a QLD reader in July was being sold on a January average,
  // which that wording would make a plain untruth.
  //
  // Cold gate is 11C, not 8C. A QLD July low of 10C is genuinely cold to kneel on for
  // an hour, and at 8C that reader fell through to the hot face in midwinter.
  const monthsUntil = (target) => (target - month + 12) % 12;
  let live =
    nowHigh >= 30 ? "hot"
    : nowLow <= 11 ? "cold"
    : (row?.days ?? 0) >= 8 ? "wet"
    // nothing biting yet: if the hot season is within three months, say so
    : monthsUntil(hotMonth) <= 3 ? "hotSoon"
    : monthsUntil(coldMonth) <= 3 ? "coldSoon"
    : "cold";

  const name = (m) => new Date(2001, m - 1, 1).toLocaleString("en-AU", { month: "long" });

  return {
    state: national ? "AUSTRALIA" : state,
    national,
    hot: Math.round(hot), hotMonth: name(hotMonth),
    cold: Math.round(cold), coldMonth: name(coldMonth),
    wet: row?.days ?? 0,
    dryState: !!row?.dry,
    monthName: now.toLocaleString("en-AU", { month: "long" }),
    nowHigh: Math.round(nowHigh), nowLow: Math.round(nowLow),
    live,
    towns: national
      ? ["fifteen regional centres"]
      : POINTS.filter((p) => p[0] === state).map((p) => p[3]),
  };
}


// Rough word wrap. resvg has no text layout, so a long line silently runs off the
// canvas: the first cut lost "…rather be lying on them" off the right edge. At
// 23px Arial roughly 0.5em per character, ~82 chars fit in the 1000px column.
function wrap(text, max = 82, maxLines = 2) {
  const words = String(text).split(" ");
  const lines = [""];
  for (const w of words) {
    const line = lines[lines.length - 1];
    if ((line + " " + w).trim().length > max) lines.push(w);
    else lines[lines.length - 1] = (line + " " + w).trim();
  }
  return lines.slice(0, maxLines);
}

/**
 * ONE condition, chosen by their state and month, with copy written for it.
 * `variant` forces a face for previewing; omit it in production.
 *
 * MOBILE-FIRST TYPE SCALE, same rule as setup.js: renders at 1080 but displays
 * at ~375px (0.35x), so nothing informative sits under ~30px. The old cut ran
 * the label and body at 21px (~7px on a phone). Fewer, bigger elements: the
 * headline, one huge number, one short argument line. The longer story lives in
 * the email copy around the image. The kicker parameter is accepted but no
 * longer drawn (no kicker text burned into dynamic images).
 */
/**
 * Shared stat-block layout (Matthew's approved design, 2026-08-10). Both ground
 * tiers render through this so the climate fallback and the live 7-day version
 * are visually identical: yellow merged title, temp/count in a solid box LEFT,
 * label + one argument line RIGHT, face icon top-right, source line at the
 * bottom. Themes: "dark" (black bg, production default) and "light" (yellow bg).
 * MOBILE-FIRST: renders 1080 wide, displays ~375px (0.35x); nothing under ~30px.
 */
export function statBlockSVG({ title, big, unit = "", icon = "snow", label, body, source, theme = "dark" }) {
  const W = 1080, PAD = 44;
  const dark = theme !== "light";
  const BG    = dark ? BLACK : YELLOW;
  const TITLE = dark ? YELLOW : BLACK;
  const BOXBG = dark ? YELLOW : BLACK;
  const BOXFG = dark ? BLACK : YELLOW;
  const LABEL = dark ? YELLOW : BLACK;
  const BODY  = dark ? WHITE : BLACK;
  const SRC   = dark ? YELLOW : BLACK;
  const SRCOP = dark ? "0.7" : "0.6";

  // Face icon, stroke style from the approved design (24-unit viewBox, scaled).
  // The snowflake blue is deliberate and from the design; sun/drop follow suit.
  const ICON_PATHS = {
    snow: `<path d="M12.00 2.00L12.00 22.00 M20.66 7.00L3.34 17.00 M20.66 17.00L3.34 7.00 M12.00 5.40L9.63 3.41 M12.00 5.40L14.37 3.41 M17.72 8.70L18.25 5.65 M17.72 8.70L20.63 9.76 M17.72 15.30L20.63 14.24 M17.72 15.30L18.25 18.35 M12.00 18.60L14.37 20.59 M12.00 18.60L9.63 20.59 M6.28 15.30L5.75 18.35 M6.28 15.30L3.37 14.24 M6.28 8.70L3.37 9.76 M6.28 8.70L5.75 5.65"/>`,
    sun:  `<circle cx="12" cy="12" r="4"/>
           <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>`,
    drop: `<path d="M12 3c3.2 4 6 6.9 6 10a6 6 0 0 1-12 0c0-3.1 2.8-6 6-10z"/>`,
    dust: `<path d="M3 8h9a2.5 2.5 0 1 0-2.4-3.2M3 12h13a2.5 2.5 0 1 1-2.4 3.2M3 16h7"/>`,
  };
  const ICON_COL = {
    snow: "#457190",
    sun:  dark ? "#FB923C" : "#EA580C",
    drop: "#457190",
    dust: dark ? "#C4A265" : "#8A6D3B",
  };

  // Title: 56px condensed fits ~45 chars a line; long titles wrap at their
  // balanced midpoint so "...THIS TIME OF / YEAR" can't happen.
  const titleLines = title.length <= 36
    ? [title]
    : wrap(title, Math.ceil(title.length / 2) + 4);

  // LEFT: the number in a solid box. Digit widths measured at 140px (74px a
  // digit, 44px degree mark, 46px minus); a word runs at 84px.
  const isWord = !/^-?\d+$/.test(big);
  const numW = isWord
    ? big.length * 42
    : big.replace("-", "").length * 74 + (big.startsWith("-") ? 46 : 0) + (unit ? 44 : 0);
  const boxW = numW + 56, boxH = 176;

  const titleBase = 100;
  const lastTitle = titleBase + (titleLines.length - 1) * 66;
  const bandTop = lastTitle + 44;
  const numBase = bandTop + 130;
  const rx = PAD + boxW + 34;                            // right column x
  const iconS = 115, iconX = W - PAD - iconS, iconY = bandTop - 8;
  const labelY = bandTop + 52;
  const bodyLines = wrap(body, 30, 3);                   // clears the icon column
  const bodyStart = labelY + 56;
  const bodyEnd = bodyStart + (bodyLines.length - 1) * 54;
  const bandBottom = Math.max(bandTop + boxH, bodyEnd + 16);
  const srcY = bandBottom + 62;
  const H = srcY + 40;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="${BG}"/>
    ${titleLines.map((l, i) => `<text x="${PAD}" y="${titleBase + i * 66}" font-family="${FONT}" font-size="56" font-weight="bold" fill="${TITLE}">${l}</text>`).join("")}
    <g transform="translate(${iconX},${iconY}) scale(${(iconS / 24).toFixed(2)})" fill="none" stroke="${ICON_COL[icon] || ICON_COL.snow}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[icon] || ICON_PATHS.snow}</g>
    <rect x="${PAD}" y="${bandTop}" width="${boxW}" height="${boxH}" fill="${BOXBG}"/>
    <text x="${PAD + 28}" y="${numBase}" font-family="${FONT}" font-size="${isWord ? 84 : 140}" font-weight="bold" fill="${BOXFG}">${big}${unit}</text>
    <text x="${rx}" y="${labelY}" font-family="${FONT}" font-size="40" font-weight="bold" fill="${LABEL}" letter-spacing="1">${label}</text>
    ${bodyLines.map((l, i) => `<text x="${rx}" y="${bodyStart + i * 54}" font-family="Arial,sans-serif" font-size="40" fill="${BODY}">${l}</text>`).join("")}
    <text x="${PAD}" y="${srcY}" font-family="Arial,sans-serif" font-size="30" fill="${SRC}" opacity="${SRCOP}">${source}</text>
  </svg>`;
}

/**
 * Climate tier: ONE condition, chosen by their state and month, rendered as the
 * shared stat block. `variant` forces a face for previewing; omit in production.
 */
export function groundSVG(m, kicker = "", variant = null, theme = "dark") {
  if (!m) return null;
  const face = variant || m.live;

  const FACES = {
    hot: {
      big: `${m.nowHigh}`, unit: "&#176;", icon: "sun",
      title: "GROUNDS HOT RIGHT NOW",
      label: `IN THE SHADE, ${m.monthName.slice(0, 3).toUpperCase()}`,
      body: `Steel and concrete hold that heat long after the air cools.`,
    },
    hotSoon: {
      big: `${m.hot}`, unit: "&#176;", icon: "sun",
      title: "GROUNDS ABOUT TO GET HOT",
      label: `BY ${m.hotMonth.slice(0, 3).toUpperCase()}, IN THE SHADE`,
      body: `Steel and concrete hold that heat long after the air cools.`,
    },
    cold: {
      big: `${m.nowLow}`, unit: "&#176;", icon: "snow",
      title: "GROUNDS PRETTY COLD THIS MONTH",
      label: `BEFORE SUNUP, ${m.monthName.slice(0, 3).toUpperCase()}`,
      body: `That's the gravel your knees go on at six in the morning.`,
    },
    coldSoon: {
      big: `${m.cold}`, unit: "&#176;", icon: "snow",
      title: "GROUNDS ABOUT TO GET COLD",
      label: `BY ${m.coldMonth.slice(0, 3).toUpperCase()}, BEFORE SUNUP`,
      body: `That's the gravel your knees go on at six in the morning.`,
    },
    wet: {
      big: m.dryState ? "DUST" : `${m.wet}`, unit: "", icon: m.dryState ? "dust" : "drop",
      title: m.dryState ? "GROUNDS MORE DUST THAN DIRT" : "GROUNDS WET MORE THAN IT'S DRY",
      label: m.dryState ? `A DRY ${m.monthName.slice(0, 3).toUpperCase()}` : `WET DAYS THIS ${m.monthName.slice(0, 3).toUpperCase()}`,
      body: m.dryState
        ? `So it's dust and grit under your knees instead of mud.`
        : `Every one of those is mud under your knees, not just rain.`,
    },
  };
  const f = FACES[face] || FACES.cold;
  return statBlockSVG({
    title: f.title, big: f.big, unit: f.unit, icon: f.icon,
    label: `${f.label}${m.national ? "" : " &#183; " + esc(m.state)}`,
    body: f.body,
    source: "10 year average temp in your area from BOM.",
    theme,
  });
}

// lib/render.js — SVG → PNG for the dynamic email images.
//
// WHY THIS EXISTS (and why it isn't sharp):
// The serverless runtime ships with NO system fonts. sharp renders SVG through
// librsvg, which resolves fonts via fontconfig — so on Lambda every glyph came
// out as a tofu box (□□□□). It looked perfect locally only because macOS has
// fonts. Rather than fight fontconfig in a container we can't inspect, resvg
// takes the font as an explicit BUFFER: no system lookup, no fontconfig, no
// difference between laptop and production.
//
// FONT CHOICE: the brand face is Bahnschrift, which is a Windows system font and
// not redistributable. Roboto Condensed is the free stand-in already named in the
// DiggerLid brand fallback chain (Bahnschrift → DIN Alternate → Arial Narrow →
// Roboto Condensed), so the rendered images match the CSS stack the HTML uses.
// Vendored under assets/fonts (Apache 2.0, licence alongside).

import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(HERE, "..", "assets", "fonts");

const FONT_FILES = ["RobotoCondensed_400Regular.ttf", "RobotoCondensed_700Bold.ttf"];

// Read once per container, not once per request. A missing font must not take the
// whole endpoint down at import time — record the failure and let /api/img?debug=fonts
// report it, because "text silently vanished" is otherwise very hard to diagnose.
// NOTE: resvg-js 2.6 takes font PATHS (fontFiles/fontDirs), not buffers. Passing an
// unsupported key is silently ignored, which is how this first shipped broken: on
// macOS the ignored options fell through to system fonts and everything looked fine,
// while the font-less Linux container rendered every string as nothing at all.
const fontDiag = [];
const fontFiles = [];
for (const f of FONT_FILES) {
  const path = join(FONT_DIR, f);
  try {
    const bytes = readFileSync(path).length; // existence + integrity check
    fontFiles.push(path);
    fontDiag.push({ file: f, ok: true, bytes });
  } catch (e) {
    fontDiag.push({ file: f, ok: false, path, error: String(e.message || e) });
  }
}

/** Diagnostic for /api/img?debug=fonts — did the TTFs make it into the bundle? */
export function fontStatus() {
  return { fontDir: FONT_DIR, loaded: fontFiles.length, fonts: fontDiag };
}

/** The family name to put in SVG font-family attributes. */
export const RENDER_FONT = "Roboto Condensed";

/**
 * Rasterise an SVG string to a PNG buffer at its intrinsic size.
 * Throws if the SVG is malformed — callers should have a fallback image.
 */
const FONT_OPTS = {
  fontFiles,
  loadSystemFonts: false, // deterministic: never depend on the container
  defaultFontFamily: RENDER_FONT,
  sansSerifFamily: RENDER_FONT,
};

export function svgToPng(svg) {
  return new Resvg(svg, { font: FONT_OPTS }).render().asPng();
}

/** Rasterise an SVG to raw RGBA — for the GIF encoder (lib/gif.js). */
export function svgToRGBA(svg) {
  const r = new Resvg(svg, { font: FONT_OPTS }).render();
  return { data: r.pixels, width: r.width, height: r.height };
}

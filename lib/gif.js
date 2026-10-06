// lib/gif.js — encode a set of RGBA frames into an animated GIF.
//
// Pure JS (gifenc), no native deps, so it runs in the serverless bundle exactly
// like the PNG path. One SHARED palette is quantized from the first frame and
// reused for every frame: smaller output, and no frame-to-frame palette flicker.
//
// EMAIL CONSTRAINT: Outlook (Windows) shows only the FIRST frame of a GIF, so the
// first frame must look complete on its own — it does here (rain is a static-looking
// still on frame 1, the grid + cost are always fully drawn).

import pkg from "gifenc";
const { GIFEncoder, quantize, applyPalette } = pkg;

/**
 * @param {{data:Uint8Array,width:number,height:number}[]} frames  RGBA frames
 * @param {{delay?:number, maxColors?:number}} opts  delay ms/frame; palette size
 * @returns {Buffer} animated GIF (loops forever)
 */
export function framesToGif(frames, { delay = 80, maxColors = 64 } = {}) {
  if (!frames.length) throw new Error("framesToGif: no frames");
  const enc = GIFEncoder();
  const { width, height } = frames[0];
  // Palette from frame 0 — it already contains rain + every UI colour.
  const palette = quantize(frames[0].data, maxColors);
  for (const f of frames) {
    const index = applyPalette(f.data, palette);
    enc.writeFrame(index, width, height, { palette, delay, repeat: 0 });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}

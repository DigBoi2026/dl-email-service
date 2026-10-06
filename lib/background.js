// lib/background.js — run work AFTER the customer has already been redirected.
//
// WHY: a tap on an email button should go straight to the cart. Waiting on a
// Klaviyo profile write (2 sequential API calls, ~400–800ms) before redirecting
// makes the customer pay for OUR bookkeeping. They shouldn't.
//
// Vercel freezes a serverless function once the response is sent, so we use
// `waitUntil` to keep it alive just long enough to finish the writes. If that
// import isn't available (local dev, other host), we fall back to awaiting —
// correct either way, just slower.

let waitUntilFn = null;
try {
  ({ waitUntil: waitUntilFn } = await import("@vercel/functions"));
} catch {
  waitUntilFn = null;
}

/**
 * Fire work without blocking the response.
 * @param {Promise|Function} work - promise (or fn returning one)
 */
export function afterResponse(work) {
  const p = (typeof work === "function" ? work() : work).catch((e) =>
    console.error("background write failed:", e)
  );
  if (waitUntilFn) {
    waitUntilFn(p);
    return null; // response already sent; nothing to await
  }
  return p; // fallback: caller may await
}

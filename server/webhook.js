// Verifies Square webhook signatures per:
// https://developer.squareup.com/docs/webhooks/step3validate
//
// Square signs: HMAC-SHA256(signatureKey, notificationUrl + rawRequestBody), base64-encoded.
 
import crypto from "node:crypto";
 
export function verifySquareSignature({ signatureKey, notificationUrl, rawBody, signatureHeader }) {
  if (!signatureKey || !notificationUrl || !signatureHeader || !rawBody) return false;
 
  const hmac = crypto.createHmac("sha256", signatureKey);
  hmac.update(notificationUrl);
  hmac.update(rawBody);
  const expected = hmac.digest("base64");
 
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== givenBuf.length) return false;
 
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}
 
/**
 * Collapses a burst of near-simultaneous calls (Square often fires
 * order.updated and order.fulfillment.updated for the same change) into a
 * single trailing invocation of `fn`.
 */
export function debounce(fn, waitMs) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
}

/**
 * Short, UI-friendly model errors (long provider strings → one clear line + one link).
 */

const GOOGLE_RATE_DOCS = "https://ai.google.dev/gemini-api/docs/rate-limits";

/**
 * @param {string} raw
 * @param {{ provider?: "google" | "openai" | "anthropic" }} [opts]
 * @returns {string}
 */
export function userFacingModelError(raw, opts = {}) {
  const s = String(raw ?? "").trim();
  if (!s) {
    return "Could not reach the model.";
  }
  if (opts.provider === "google" || looksLikeGoogleModelError(s)) {
    if (shouldSummarizeGoogle(s)) {
      return summarizeGoogleError(s);
    }
  }
  if (s.length > 800) {
    return s.slice(0, 400).trim() + "…";
  }
  return s;
}

function looksLikeGoogleModelError(s) {
  return /generativelanguage\.googleapis|generate_content|gemini-[\w.-]+|ai\.google\.dev|Google Generative|free_tier_requests/i.test(
    s
  );
}

function shouldSummarizeGoogle(s) {
  if (s.length < 120) {
    return false;
  }
  return /quota|exceeded|free_tier|Resource exhausted|rate limit|current quota|billing|generate_content_free_tier/i.test(
    s
  );
}

/**
 * e.g. "You exceeded your current quota… * Quota exceeded for metric: … limit: 20, model: gemini-3-flash Please retry in 11.83s"
 */
function summarizeGoogleError(s) {
  const retryM = s.match(/Please retry in ([0-9.]+)\s*s/i);
  let retry = "";
  if (retryM) {
    const sec = Math.max(1, Math.ceil(parseFloat(retryM[1]) || 0));
    retry = ` Retry in ~${sec}s.`;
  }
  const limitM = s.match(/limit:\s*(\d+)/i);
  const modelM = s.match(/model:\s*([^\s,]+?)(?=\s+Please|\s*$)/i) || s.match(/model:\s*([A-Za-z0-9._/-]+)/i);
  const limit = limitM ? limitM[1] : null;
  const model = modelM ? modelM[1] : null;

  let lead = "Gemini quota or free-tier request limit was hit.";
  if (limit && model) {
    lead = `Gemini free-tier cap reached (${limit} requests, model ${model}).`;
  } else if (model) {
    lead = `Gemini request limit or quota was hit (model ${model}).`;
  } else if (limit) {
    lead = `Gemini free-tier cap reached (${limit} requests in this window).`;
  }
  return `${lead}${retry} Check billing in Google AI Studio if this persists. ${GOOGLE_RATE_DOCS}`;
}

// Eduskunnan avoimen datan rajapinnan asiakas (api.eduskunta.fi).
// Kuvaus: https://api.eduskunta.fi/openapi.json. Käyttöehdot: CC BY 4.0, lähde mainittava
// (https://www.eduskunta.fi/fi/avoin-data/mita-on-avoin-data/). Rajapinta rajoittaa
// GET-pyynnöt 180:een ja POST-pyynnöt 90:een minuutissa IP-osoitetta kohden, joten
// vastaukset välimuistitetaan.

import { FinlexError } from "./finlex.js";

export const EDK_API = "https://api.eduskunta.fi/api/v1";
const USER_AGENT = "finlex-mcp/1.5 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class EduskuntaError extends FinlexError {}

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

// djb2: välimuistiavain POST-pyynnön rungosta.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Hakee rajapinnasta tekstin (GET tai POST JSON-rungolla). Välimuisti Cache API:lla.
 * 404 palauttaa null. Uudelleenohjaukset (asiakirjojen XML S3:sta, suuret hakutulokset)
 * seurataan automaattisesti.
 */
export async function edkFetch(path, { body = null, ttl = 3600 } = {}) {
  const url = EDK_API + path;
  // ttl 0: ei välimuistia (esim. asiakirjan HTML, josta tallennetaan vain jäsennetty hakemisto).
  const cache = ttl > 0 ? cacheApi() : null;
  const payload = body === null ? null : JSON.stringify(body);
  const cacheKey = new Request(payload === null ? url : `${url}${url.includes("?") ? "&" : "?"}_body=${hash(payload)}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.status === 404 ? null : await hit.text();
  }
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: payload === null ? "GET" : "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/html;q=0.9", ...(payload === null ? {} : { "Content-Type": "application/json" }) },
        body: payload ?? undefined,
      });
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) {
      if (cache) await cache.put(cacheKey, new Response("", { status: 404, headers: { "Cache-Control": "max-age=600" } }));
      return null;
    }
    if (res.ok) {
      const text = await res.text();
      if (cache && ttl > 0) {
        await cache.put(cacheKey, new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}` } }));
      }
      return text;
    }
    lastErr = new EduskuntaError(`Eduskunnan rajapinta vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr instanceof EduskuntaError ? lastErr : new EduskuntaError(`Eduskunnan rajapintaan ei saatu yhteyttä: ${lastErr?.message ?? lastErr}`, 0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Haku (POST /search). Palauttaa jäsennetyn vastauksen. */
export async function edkSearch(request, ttl = 3600) {
  const text = await edkFetch("/search", { body: request, ttl });
  return text ? JSON.parse(text) : { results: [], searchMetadata: { totalResultCount: 0 } };
}

// ---------- Tunnukset ----------

// Asiakirja- ja asiatyypit, joita työkalut käsittelevät. Valiokuntien lyhenteet päättyvät
// mietinnöissä VM ja lausunnoissa VL (esim. StVM, PeVL, SuVL, TrVL, UaVM).
const TUNNUS_RE = /^\s*([A-Za-zÅÄÖåäö]{1,8})\s*(\d{1,4})\s*\/\s*(\d{4}|\d{2})\s*(?:vp|rd)?\s*$/;

/**
 * Normalisoi eduskuntatunnuksen muotoon "HE 74/2022 vp". Kaksinumeroinen vuosi
 * tulkitaan 1900- tai 2000-luvuksi. null, jos tunnus ei ole kelvollinen.
 */
export function normTunnus(s) {
  const m = String(s ?? "").replace(/ /g, " ").match(TUNNUS_RE);
  if (!m) return null;
  let year = +m[3];
  if (m[3].length === 2) year += year >= 60 ? 1900 : 2000;
  const type = fixCase(m[1]);
  return `${type} ${+m[2]}/${year} vp`;
}

// Kirjainkoko: lyhenteet kirjoitetaan vakiintuneesti (HE, LA, KAA, EV, PeVL, StVM …).
const UPPER_TYPES = new Set(["HE", "LA", "KAA", "TPA", "LTA", "KK", "SKT", "EV", "EK", "VNS", "VNT", "M", "U", "E", "K", "O", "VAP", "TAA", "VK", "PTK"]);
function fixCase(t) {
  const up = t.toUpperCase();
  if (UPPER_TYPES.has(up)) return up;
  // Valiokunnan asiakirja: kaksikirjaiminen valiokunnan lyhenne + VM/VL/VP, esim. PeVL, StVM, UaVM.
  const m = up.match(/^([A-ZÅÄÖ]{1,3})(VM|VL|VP|VMJ|VLJ)$/);
  if (m) return m[1][0] + m[1].slice(1).toLowerCase() + m[2];
  return t;
}

// ---------- Osoitteet ihmislukijalle ----------

export function matterWebUrl(tunnus) {
  return `https://www.eduskunta.fi/asiat-ja-aanestykset/valtiopaivaasiat/${encodeURIComponent(tunnus)}`;
}

export function docWebUrl(edktunnus) {
  return `https://www.eduskunta.fi/asiat-ja-aanestykset/valtiopaivaasiat/asiakirjat/edktunnus/${encodeURIComponent(edktunnus)}`;
}

// ---------- Valtiopäiväasia ----------

// Asiantuntijalausuntojen luettelo ja asiasanat jätetään pois (suurissa asioissa,
// esim. HE 241/2020 vp, lausuntoluettelo on yli 0,5 Mt eikä sitä näytetä).
const MATTER_EXCLUDE = ["asiantuntijalausunnot", "asiasanat"];

/** Valtiopäiväasia tunnuksella. null, jos ei löydy. */
export async function fetchMatter(tunnus, ttl) {
  const r = await edkSearch(
    {
      category: "valtiopaivaasia",
      maxResults: 1,
      startFromIndex: 0,
      fields: { operation: "exclude", list: MATTER_EXCLUDE },
      expression: { and: [{ property: "eduskuntatunnus", stringValue: tunnus }] },
    },
    ttl,
  );
  return r.results?.[0]?.valtiopaivaasia ?? null;
}

/** Asiakirjan metatiedot tunnuksella (suomenkielinen versio). null, jos ei löydy. */
export async function fetchDocMeta(tunnus, ttl) {
  const r = await edkSearch(
    {
      category: "asiakirja",
      maxResults: 3,
      startFromIndex: 0,
      fields: { operation: "exclude", list: ["fullText", "asiasanat"] },
      expression: {
        and: [
          { property: "eduskuntatunnus", stringValue: tunnus },
          { property: "kielikoodi", stringValue: "fi" },
        ],
      },
    },
    ttl,
  );
  const a = (r.results ?? []).map((x) => x.asiakirja).find((a) => a && a.eduskuntatunnus === tunnus);
  return a ?? null;
}

/** Asiakirjan HTML edktunnuksella. null, jos HTML-muotoa ei ole. */
export function fetchDocHtml(edktunnus) {
  return edkFetch(`/asiakirjat/edktunnus/${encodeURIComponent(edktunnus)}/html`, { ttl: 0 });
}

/** Hakemiston välimuistiavain asiakirjalle. */
export function docIndexUrl(edktunnus) {
  return `${EDK_API}/asiakirjat/edktunnus/${encodeURIComponent(edktunnus)}/html`;
}

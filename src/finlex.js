// Finlexin avoimen datan rajapinnan asiakas.
// Dokumentaatio: https://www.finlex.fi/fi/avoin-data ja
// OpenAPI-kuvaus https://opendata.finlex.fi/Finlex_avoin_data_v0_4_0.yaml

export const API_BASE = "https://opendata.finlex.fi/finlex/avoindata/v1";
const USER_AGENT = "finlex-mcp/1.0 (Claude-liitin; Cloudflare Worker)";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export class FinlexError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function cacheApi() {
  // Cloudflare Workersissa on caches.default; Node-testeissä ei.
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Hakee URL:n tekstinä. Välimuisti Cloudflaren Cache API:lla (ttl sekunteina).
 * 404 palauttaa null.
 */
export async function fetchText(url, { ttl = 3600, accept = "application/xml" } = {}) {
  const cache = cacheApi();
  const cacheKey = new Request(url + (url.includes("?") ? "&" : "?") + "_accept=" + encodeURIComponent(accept));
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (hit.status === 404) return null;
      return await hit.text();
    }
  }

  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Encoding": "gzip" },
      });
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) {
      if (cache) {
        await cache.put(cacheKey, new Response("", { status: 404, headers: { "Cache-Control": "max-age=600" } }));
      }
      return null;
    }
    if (res.ok) {
      const body = await res.text();
      if (cache && ttl > 0) {
        await cache.put(
          cacheKey,
          new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}` } }),
        );
      }
      return body;
    }
    lastErr = new FinlexError(`Finlex vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr instanceof FinlexError ? lastErr : new FinlexError(`Finlexiin ei saatu yhteyttä: ${lastErr?.message ?? lastErr}`, 0);
}

/** Hakee binääritiedoston (esim. PDF). 404 palauttaa null. */
export async function fetchBytes(url, { ttl = 86400 } = {}) {
  const cache = cacheApi();
  const cacheKey = new Request(url + (url.includes("?") ? "&" : "?") + "_bytes=1");
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.status === 404 ? null : new Uint8Array(await hit.arrayBuffer());
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/pdf" } });
    if (res.status === 404) return null;
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (cache && ttl > 0) {
        await cache.put(cacheKey, new Response(buf, { headers: { "Cache-Control": `max-age=${ttl}` } }));
      }
      return buf;
    }
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
      throw new FinlexError(`Finlex vastasi ${res.status}`, res.status);
    }
    await sleep(500 * 2 ** attempt);
  }
  return null;
}

/**
 * Lukee vastauksen alusta vain sen verran, että otsikko ja voimassaolo löytyvät,
 * ja katkaisee latauksen. Säästää kaistaa hakutulosten otsikoissa.
 */
export async function fetchHead(url) {
  const cache = cacheApi();
  const cacheKey = new Request(url + "?_head=1");
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.status === 404 ? null : JSON.parse(await hit.text());
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/xml" } });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new FinlexError(`Finlex vastasi ${res.status}`, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (buf.length < 400_000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("</docTitle>")) break;
    }
    try {
      await reader.cancel();
    } catch {}
    const info = {
      title: decodeXmlText(match(buf, /<docTitle[^>]*>([\s\S]*?)<\/docTitle>/)),
      inForce: match(buf, /<finlex:isInForce value="(true|false)"/),
      version: match(buf, /<FRBRversionNumber value="([^"]*)"/),
    };
    if (cache) {
      await cache.put(cacheKey, new Response(JSON.stringify(info), { headers: { "Cache-Control": "max-age=21600" } }));
    }
    return info;
  }
  return null;
}

function match(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

function decodeXmlText(s) {
  if (!s) return null;
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Polut ---

export function langVersion(lang, version) {
  return `${lang}@${version ?? ""}`;
}

export function consolidatedUrl(year, number, lang = "fin", version = "latest") {
  return `${API_BASE}/akn/fi/act/statute-consolidated/${year}/${encodeURIComponent(number)}/${langVersion(lang, version)}`;
}

export function originalUrl(year, number, lang = "fin") {
  return `${API_BASE}/akn/fi/act/statute/${year}/${encodeURIComponent(number)}/${langVersion(lang, "")}`;
}

export function listUrl(docType, params) {
  const q = new URLSearchParams({ format: "json" });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.set(k, String(v));
  }
  return `${API_BASE}/akn/fi/act/${docType}/list?${q.toString()}`;
}

/** Finlexin verkkosivun osoite ihmislukijalle. */
export function webUrl(year, number, lang = "fin", original = false) {
  const l = lang === "swe" ? "sv" : "fi";
  const base = l === "sv" ? "lagstiftning" : "lainsaadanto";
  if (original) {
    const coll = l === "sv" ? "forfattningssamling" : "saadoskokoelma";
    return `https://www.finlex.fi/${l}/${base}/${coll}/${year}/${number}`;
  }
  return `https://www.finlex.fi/${l}/${base}/${year}/${number}`;
}

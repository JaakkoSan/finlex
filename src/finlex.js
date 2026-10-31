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

/** Lukee välimuistiin tallennetun johdetun tiedon (JSON). Palauttaa undefined, jos ei löydy. */
export async function cacheGetJson(key) {
  const cache = cacheApi();
  if (!cache) return undefined;
  const hit = await cache.match(new Request(key));
  if (!hit) return undefined;
  try {
    return await hit.json();
  } catch {
    return undefined;
  }
}

/** Tallentaa johdetun tiedon (JSON) välimuistiin ttl sekunniksi. */
export async function cachePutJson(key, value, ttl) {
  const cache = cacheApi();
  if (!cache || !(ttl > 0)) return;
  await cache.put(
    new Request(key),
    new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }),
  );
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

/** Hallituksen esitys (Akoma Ntoso -doc). */
export function proposalUrl(year, number, lang = "fin") {
  return `${API_BASE}/akn/fi/doc/government-proposal/${year}/${encodeURIComponent(number)}/${lang}@`;
}

/** Finlexin verkkosivu esitykselle (vain suomenkielinen osoite tiedossa). */
export function proposalWebUrl(year, number) {
  return `https://www.finlex.fi/fi/hallituksen-esitykset/${year}/${number}`;
}

/** Listaustietueen akn_uri lastSeen-muotoon: "/akn/fi/act/statute-consolidated/1992/912". */
export function lastSeenOf(uri) {
  return String(uri ?? "")
    .replace(/^https?:\/\/[^/]+\/finlex\/avoindata\/v1/, "")
    .replace(/\/[a-z]{3}@[^/]*$/, "");
}

/**
 * Listauksen sivut 1..maxPages. Finlex vaihtaa sivutuksen page-parametrista avainpohjaiseen
 * lastSeen-parametriin (ilmoitus finlex.fi/fi/avoin-data: "viikolla 47"; arvo on edellisen sivun
 * viimeisen tietueen akn-URI). Jotta haku toimii kummassakin mallissa, sivut haetaan
 * järjestyksessä ja jokaisessa pyynnössä annetaan sekä page että edellisen sivun lastSeen.
 * Palauttaa sivut taulukkona; lopettaa, kun sivu on vajaa tai ei tuo uusia tietueita.
 */
export async function walkList(url, maxPages, { ttl = 3600 } = {}) {
  const pages = [];
  const seen = new Set();
  let lastSeen = null;
  for (let k = 1; k <= maxPages; k++) {
    const u = `${url}${url.includes("?") ? "&" : "?"}page=${k}${lastSeen ? `&lastSeen=${encodeURIComponent(lastSeen)}` : ""}`;
    const txt = await fetchText(u, { ttl, accept: "application/json" });
    const arr = txt ? JSON.parse(txt) : [];
    // Rajapinta ei tunnistanut sivutusta (palautti saman sivun uudelleen): tuloksia ei enempää.
    if (!arr.some((x) => !seen.has(x.akn_uri))) break;
    for (const x of arr) seen.add(x.akn_uri);
    pages.push(arr);
    if (arr.length < 10) break;
    lastSeen = lastSeenOf(arr[arr.length - 1].akn_uri);
  }
  return pages;
}

/** Listauksen sivu (1-pohjainen); edelliset sivut haetaan välimuistista tai rajapinnasta. Tyhjä, kun tuloksia ei ole. */
export async function fetchListPage(url, page, opts = {}) {
  const pages = await walkList(url, page, opts);
  return pages.length === page ? pages[page - 1] : [];
}

export function docListUrl(docType, params) {
  return listUrl(docType, params).replace("/akn/fi/act/", "/akn/fi/doc/");
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

// Viranomaisten tiedotteet RSS-syötteistä (tarkistettu 1.11.2026):
// - Fimea: https://fimea.fi/etusivu/-/asset_publisher/lVOfm05ujKUa/rss (RSS 1.0, vain otsikot)
// - Tukes: https://tukes.fi/etusivu/-/asset_publisher/j4IpZeX3sdnN/rss (RSS 2.0, vain otsikot)
// - Verohallinto: https://www.vero.fi/api/rss/news/fi ja /api/rss/preciseinformation/fi (vero.fi/en/About-us/newsroom/news/rss-service)
// - Lupa- ja valvontavirasto: STT Infon uutishuone, https://www.sttinfo.fi/rss/releases/latest?publisherId=69821631
// Fimean ja Tukesin verkkosivut torjuvat automaattiset haut (403), joten niiden tiedotteista
// näytetään vain syötteen tiedot. Tiedotteen teksti haetaan vain vero.fi:stä ja sttinfo.fi:stä
// (robots.txt sallii; STT Info pyytää 1 s viivettä, ja haut välimuistitetaan).

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";

const USER_AGENT = "finlex-mcp/1.9 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class TiedoteError extends FinlexError {}

export const FEEDS = {
  fimea: { name: "Fimea (Lääkealan turvallisuus- ja kehittämiskeskus)", short: "Fimea", url: "https://fimea.fi/etusivu/-/asset_publisher/lVOfm05ujKUa/rss", text: false },
  tukes: { name: "Tukes (Turvallisuus- ja kemikaalivirasto)", short: "Tukes", url: "https://tukes.fi/etusivu/-/asset_publisher/j4IpZeX3sdnN/rss", text: false },
  lvv: { name: "Lupa- ja valvontavirasto (tiedotteet STT Infossa)", short: "LVV", url: "https://www.sttinfo.fi/rss/releases/latest?publisherId=69821631", text: true },
  vero: { name: "Verohallinto, uutiset", short: "Vero", url: "https://www.vero.fi/api/rss/news/fi", text: true },
  vero_ohjeet: { name: "Verohallinto, syventävät vero-ohjeet", short: "Vero-ohje", url: "https://www.vero.fi/api/rss/preciseinformation/fi", text: true },
};

const TEXT_HOSTS = new Set(["www.vero.fi", "vero.fi", "www.sttinfo.fi", "sttinfo.fi"]);

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, ttl) {
  const cache = cacheApi();
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.status === 404 ? null : hit.text();
  }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.8" } });
    } catch (e) {
      last = new TiedoteError(`yhteys epäonnistui: ${e?.message ?? e}`, 0);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) {
      const body = await res.text();
      if (cache) await cache.put(key, new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}` } }));
      return body;
    }
    last = new TiedoteError(`palvelin vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(800 * 2 ** attempt);
  }
  throw last;
}

const ENT = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  auml: "ä", ouml: "ö", aring: "å", Auml: "Ä", Ouml: "Ö", Aring: "Å", uuml: "ü", Uuml: "Ü", eacute: "é", Eacute: "É",
  ndash: "–", mdash: "—", hellip: "…", euro: "€", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bdquo: "„", laquo: "«", raquo: "»", sect: "§", deg: "°",
};
export function decode(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
    });
}

const tag = (x, name) => {
  const m = x.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]).replace(/\s+/g, " ").trim() || null : null;
};

function isoDate(item) {
  const dc = tag(item, "dc:date");
  if (dc && !Number.isNaN(Date.parse(dc))) return new Date(dc).toISOString();
  const p = tag(item, "pubDate");
  if (p && !Number.isNaN(Date.parse(p))) return new Date(p).toISOString();
  return null;
}

/** Syötteen tiedotteet: [{ source, title, link, date (ISO), summary }]. Välimuisti 1 h. */
export async function feedItems(key) {
  const f = FEEDS[key];
  const xml = await get(f.url, 3600);
  if (!xml) return [];
  const out = [];
  const seen = new Set();
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const title = tag(it, "title");
    const link = tag(it, "link");
    if (!title || !link) continue;
    // STT Infon syötteessä sama tiedote voi toistua; yhdistetään otsikon ja linkin mukaan.
    const k = `${title}|${link.replace(/\?.*$/, "")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source: key, title, link, date: isoDate(it), summary: tag(it, "description") });
  }
  return out;
}

function htmlText(s) {
  return decode(
    String(s)
      .replace(/<(script|style|noscript|svg|button)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h[1-6]|li|div|tr|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Tiedotteen teksti (vain vero.fi ja sttinfo.fi). Palauttaa { title, date, text } tai null. */
export async function itemText(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !TEXT_HOSTS.has(u.hostname)) return null;
  const key = `${u.href}${u.href.includes("?") ? "&" : "?"}_tiedote=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const html = await get(u.href, 0);
  if (!html) return null;
  let out = null;
  if (u.hostname.endsWith("vero.fi")) {
    const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (m) {
      const title = htmlText(m[1].match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
      const date = htmlText(m[1].match(/<span class="published-date">([\s\S]*?)<\/span>/i)?.[1] ?? "");
      const body = m[1].match(/<div class="main-body">([\s\S]*)$/i)?.[1] ?? m[1];
      out = { title, date, text: htmlText(body) };
    }
  } else {
    const s = html.indexOf("<article>");
    const e = s >= 0 ? html.indexOf("</article>", s) : -1;
    if (s >= 0 && e > s) {
      const seg = html.slice(s, e);
      const title = htmlText(seg.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
      let text = htmlText(seg.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ""));
      // Yhteyshenkilöiden nimet ja puhelinnumerot jätetään pois; jakopainike pois.
      text = text.split(/\n(?:Yhteyshenkilöt|Kontaktpersoner|Contacts)\n/)[0];
      const lines = text.split("\n").filter((l) => l !== "Jaa");
      const date = lines[0] && /\d{1,2}\.\d{1,2}\.\d{4}/.test(lines[0]) ? lines.shift() : "";
      out = { title, date, text: lines.join("\n") };
    }
  }
  if (out && !out.title) out.title = htmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*[-|–]\s*(vero\.fi|STT Info).*$/i, "");
  if (out && out.text) await cachePutJson(key, out, 7 * 86400);
  return out;
}

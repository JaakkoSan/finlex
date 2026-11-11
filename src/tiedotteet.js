// Viranomaisten tiedotteet RSS-syötteistä (tarkistettu 1.11.2026):
// - Fimea: https://fimea.fi/etusivu/-/asset_publisher/lVOfm05ujKUa/rss (RSS 1.0, vain otsikot)
// - Tukes: https://tukes.fi/etusivu/-/asset_publisher/j4IpZeX3sdnN/rss (RSS 2.0, vain otsikot)
// - Verohallinto: https://www.vero.fi/api/rss/news/fi ja /api/rss/preciseinformation/fi (vero.fi/en/About-us/newsroom/news/rss-service)
// - Lupa- ja valvontavirasto: STT Infon uutishuone, https://www.sttinfo.fi/rss/releases/latest?publisherId=69821631
// - Verohallinnon haku: https://www.vero.fi/api/search/results (dokumentoitu: vero.fi/globalassets/
//   tietoa-verohallinnosta/sahkoinen-asiointi/verofi-search-api-documentation.pdf). Vero.fi:n
//   sisältökuvauksen mukaan ohjeita saa hakea koneellisesti myös rajapinnan kautta ja esittää
//   ulkoisissa palveluissa; robots.txt ei rajoita (tarkistettu 11.11.2026).
// Fimean ja Tukesin verkkosivut torjuvat automaattiset haut (403), joten niiden tiedotteista
// näytetään vain syötteen tiedot. Tiedotteen teksti haetaan vain vero.fi:stä ja sttinfo.fi:stä
// (robots.txt sallii; STT Info pyytää 1 s viivettä, ja haut välimuistitetaan).

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";

const USER_AGENT = "finlex-mcp/1.10 (Claude-liitin; Cloudflare Worker)";
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
      .replace(/\s*[\r\n]+\s*/g, " ")
      .replace(/<(script|style|noscript|svg|button)[\s\S]*?<\/\1>/gi, "")
      // Taulukon rivi yhdelle riville: solut erotetaan pystyviivalla.
      .replace(/<t([dh])(\s[^>]*)?>([\s\S]*?)<\/t\1>/gi, (m, a, b, c) => `<t${a}>${c.replace(/<\/?(p|div)[^>]*>|<br\s*\/?>/gi, " ")}</t${a}>`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<\/(p|h[1-6]|li|div|tr|section)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim().replace(/\s*\|$/, ""))
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

// ---------- Verohallinnon haku ja syventävät vero-ohjeet ----------

const VERO = "https://www.vero.fi";
// Sivutyypit (typeId) hakurajapinnan dokumentaation mukaan.
export const VERO_TYPES = {
  ohje: { id: 7, name: "Syventävä vero-ohje" },
  paatos: { id: 8, name: "Verohallinnon päätös" },
  kannanotto: { id: 9, name: "Verohallinnon kannanotto" },
  kvl: { id: 10, name: "KVL:n ennakkoratkaisu" },
};

/** Hakee vero.fi:n hausta. Palauttaa { total, hasMore, hits: [{ title, url, date (ISO), type, latest, excerpt, tags }] }. */
export async function veroSearch({ query = "", types = [7], lang = "fi", sort = 0, page = 1, pageSize = 10, all = false, year } = {}) {
  const q = new URLSearchParams({ query, language: lang, page: String(page), pageSize: String(pageSize) });
  for (const t of types) q.append("typeId", String(t));
  if (sort) q.set("sort", String(sort));
  if (all) q.set("showAllVersions", "true");
  if (year) q.set("year", String(year));
  const body = await get(`${VERO}/api/search/results?${q}`, 3600);
  if (!body) return { total: 0, hasMore: false, hits: [] };
  let d;
  try {
    d = JSON.parse(body);
  } catch {
    throw new TiedoteError("Verohallinnon haku palautti virheellisen vastauksen.", 0);
  }
  const iso = (s) => {
    const m = String(s ?? "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
  };
  const hits = (d.Hits ?? []).map((h) => ({
    title: decode(h.Title ?? "").trim(),
    url: h.FriendlyUrl?.startsWith("http") ? h.FriendlyUrl : `${VERO}${h.FriendlyUrl ?? ""}`,
    date: iso(h.Date),
    type: h.ContentTypeLocalized ?? h.ContentType ?? null,
    latest: h.IsLatestVersion !== false,
    excerpt: h.Text ? htmlText(String(h.Text).replace(/<mark[^>]*>|<\/mark>/g, "")).replace(/\s+/g, " ").trim() : null,
    tags: h.TagNames ?? [],
  }));
  return { total: d.TotalCount ?? hits.length, hasMore: !!d.HasMore, hits };
}

const AUTHOR_RE = /^(johtava |vanhempi |erikois)?(vero)?(asiantuntija|ylitarkastaja|tarkastaja|lakimies|johtaja|päällikkö|neuvos|ylijohtaja|apulaisjohtaja|ryhmäpäällikkö|ohjaus)/i;

/**
 * Syventävän vero-ohjeen (tai Verohallinnon päätöksen, kannanoton tai KVL:n ennakkoratkaisun)
 * rakenne: { title, meta: [[nimi, arvo]], intro, sections: [{ num, title, level, text }] }.
 * null, jos sivu ei ole tällainen ohjesivu.
 */
export async function veroGuide(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/^(www\.)?vero\.fi$/.test(u.hostname)) return null;
  u.hash = "";
  const key = `${u.href}${u.href.includes("?") ? "&" : "?"}_ohje=2`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const html = await get(u.href, 0);
  if (!html) return null;
  const a = html.indexOf("<article");
  const e = a >= 0 ? html.indexOf("</article>", a) : -1;
  if (a < 0 || e < 0) return null;
  const art = html.slice(a, e);
  const mb = art.search(/<div class="main-body">/i);
  if (mb < 0) return null;
  let body = art.slice(mb).replace(/<div class="main-body">/i, "");
  const end = body.search(/<div class="contentarea-main">|<div class="page-modified">/i);
  if (end >= 0) body = body.slice(0, end);

  const title = htmlText(html.match(/<span id="main-heading">([\s\S]*?)<\/span>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const meta = [];
  const pvStart = html.indexOf('<div class="page-version">');
  let pvHtml = pvStart >= 0 ? html.slice(pvStart, pvStart + 6000) : "";
  const pvEnd = pvHtml.search(/page-version__info--summary|<article/);
  if (pvEnd > 0) pvHtml = pvHtml.slice(0, pvEnd);
  for (const m of pvHtml.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
    const k = htmlText(m[1]);
    const v = htmlText(m[2]).replace(/\s+/g, " ");
    if (k && v) meta.push([k, v]);
  }

  const heads = [...body.matchAll(/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const sections = [];
  const intro = htmlText(body.slice(0, heads[0]?.index ?? body.length));
  heads.forEach((h, i) => {
    const t = htmlText(h[2]).replace(/\s+/g, " ").trim();
    const m = t.match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/);
    const chunk = body.slice(h.index + h[0].length, heads[i + 1]?.index ?? body.length);
    sections.push({ num: m ? m[1] : null, title: m ? m[2] : t, level: Number(h[1]), text: htmlText(chunk) });
  });
  // Ohjeen laatijoiden nimet viimeisen luvun lopussa jätetään pois.
  const last = sections[sections.length - 1];
  if (last) {
    const lines = last.text.split("\n");
    while (lines.length && lines[lines.length - 1].length < 90 && AUTHOR_RE.test(lines[lines.length - 1])) lines.pop();
    last.text = lines.join("\n");
  }
  if (!sections.length && !intro) return null;
  const out = { title, meta, intro, sections, url: u.href };
  await cachePutJson(key, out, 86400);
  return out;
}

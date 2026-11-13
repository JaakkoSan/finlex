// Kuluttajariitalautakunnan (KRIL) ratkaisut sivustolta https://www.kuluttajariita.fi sivuston
// julkisella WordPress-rajapinnalla (/wp-json/wp/v2/paatos, teemat ja asiasanat). Avainta ei
// tarvita. robots.txt (tarkistettu 13.11.2026) kieltää vain polun /wp/wp-admin/. Viranomaisen tai
// muun julkisen toimielimen päätöksiin ei ole tekijänoikeutta (tekijänoikeuslaki 404/1961 9 § 1 mom. 4 k).
// Pyynnöt rajataan _fields-parametrilla, ja tulokset ovat välimuistissa (Cache API).

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";
import { decode, htmlText } from "./tiedotteet.js";

export const KRIL_BASE = "https://www.kuluttajariita.fi";
const API = `${KRIL_BASE}/wp-json/wp/v2`;
const USER_AGENT = "finlex-mcp/1.14 (Claude-liitin; Cloudflare Worker)";
const SEARCH_TTL = 86400; // haut 1 vrk
const DECISION_TTL = 30 * 86400; // ratkaisut 30 vrk
const TERM_TTL = 7 * 86400; // teemat 7 vrk
export const KRIL_PAGE_SIZE = 10;

export class KrilError extends FinlexError {}

async function getJson(path, ttl) {
  const url = `${API}${path}`;
  const key = `https://finlex-mcp.cache/kril/v1${path}`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  } catch (e) {
    throw new KrilError(`yhteys epäonnistui (${e.message})`);
  }
  if (res.status === 400) return { status: 400, body: null };
  if (!res.ok) throw new KrilError(`HTTP ${res.status}`);
  const body = await res.json();
  const value = { status: 200, body, total: Number(res.headers.get("x-wp-total") ?? 0), pages: Number(res.headers.get("x-wp-totalpages") ?? 0) };
  await cachePutJson(key, value, ttl);
  return value;
}

/** Teemat: [{ id, name, count }]. */
export async function krilThemes() {
  const r = await getJson("/teemat?per_page=100&_fields=id,name,count", TERM_TTL);
  return (r.body ?? []).map((t) => ({ id: t.id, name: decode(t.name), count: t.count }));
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Teeman nimi tai sen alku -> teema. Palauttaa { theme } tai { candidates }. */
export function matchTheme(themes, want) {
  const w = norm(want);
  const exact = themes.find((t) => norm(t.name) === w);
  if (exact) return { theme: exact };
  const part = themes.filter((t) => norm(t.name).includes(w));
  if (part.length === 1) return { theme: part[0] };
  return { candidates: part };
}

function summaryOf(d, themeNames) {
  return {
    id: d.id,
    title: decode(d.title?.rendered ?? "").replace(/\s+/g, " ").trim(),
    date: d.date ?? null,
    slug: d.slug,
    link: d.link,
    themes: (d.teemat ?? []).map((id) => themeNames.get(id)).filter(Boolean),
  };
}

/** Haku: { items, total, pages }. */
export async function searchDecisions({ query, themeId, from, to, page }) {
  const p = new URLSearchParams({ per_page: String(KRIL_PAGE_SIZE), page: String(page), _fields: "id,date,slug,link,title,teemat", orderby: "date", order: "desc" });
  if (query) p.set("search", query);
  if (themeId) p.set("teemat", String(themeId));
  if (from) p.set("after", `${from - 1}-12-31T23:59:59`);
  if (to) p.set("before", `${to + 1}-01-01T00:00:00`);
  const [r, themes] = await Promise.all([getJson(`/paatos?${p}`, SEARCH_TTL), krilThemes()]);
  const names = new Map(themes.map((t) => [t.id, t.name]));
  if (r.status === 400) return { items: [], total: 0, pages: 0, outOfRange: true };
  return { items: r.body.map((d) => summaryOf(d, names)), total: r.total, pages: r.pages };
}

/** Osoitteen tai tunnuksen loppuosa (slug). */
export function krilSlug(v) {
  const s = String(v ?? "").trim();
  const m = s.match(/^https?:\/\/(?:www\.)?kuluttajariita\.fi\/paatokset\/([a-z0-9-]+)\/?(?:[?#].*)?$/i);
  if (m) return m[1].toLowerCase();
  if (/^[a-z0-9-]{3,200}$/i.test(s)) return s.toLowerCase();
  return null;
}

/** Ratkaisu tunnuksella: { title, date, link, themes, keywords, sections: [{ title, text }], text } tai null. */
export async function decisionBySlug(slug) {
  const p = new URLSearchParams({ slug, _fields: "id,date,modified,slug,link,title,teemat,paatos-asiasanat,content" });
  const r = await getJson(`/paatos?${p}`, DECISION_TTL);
  const d = r.body?.[0];
  if (!d) return null;
  const themes = await krilThemes();
  const s = summaryOf(d, new Map(themes.map((t) => [t.id, t.name])));
  let keywords = [];
  const kw = d["paatos-asiasanat"] ?? [];
  if (kw.length) {
    const k = await getJson(`/paatos-asiasanat?include=${kw.slice(0, 50).join(",")}&per_page=50&_fields=id,name`, DECISION_TTL);
    keywords = (k.body ?? []).map((x) => decode(x.name));
  }
  return { ...s, keywords, ...parseSections(d.content?.rendered ?? "") };
}

// Osien otsikot: kappaleen alun lihavointi (<p><strong>Lautakunnan ratkaisu</strong></p> tai vanhemmissa
// ratkaisuissa <p><b>Vaatimukset</b> teksti...) tai otsikkoelementti.
const HEADING = /<p(?:\s[^>]*)?>\s*<(strong|b)>\s*([^<]{2,90}?)\s*<\/\1>|<(h[1-6])(?:\s[^>]*)?>\s*([^<]{2,90}?)\s*<\/\3>/gi;

export function parseSections(html) {
  const marks = [];
  for (const m of html.matchAll(HEADING)) {
    const title = decode(m[2] ?? m[4]).replace(/\s+/g, " ").trim();
    if (!title || /[.:;,]$/.test(title) || title.split(" ").length > 10) continue;
    marks.push({ index: m.index, end: m.index + m[0].length, title });
  }
  const sections = [];
  const intro = htmlText(html.slice(0, marks[0]?.index ?? html.length));
  for (let i = 0; i < marks.length; i++) {
    const text = htmlText(html.slice(marks[i].end, marks[i + 1]?.index ?? html.length));
    sections.push({ title: marks[i].title, text });
  }
  return { intro, sections, text: htmlText(html) };
}

/** Yleiskuvan osat: asiaselostus, lautakunnan ratkaisu ja lopputulos. */
export const OVERVIEW = /^(asiaselostus|kysymyksenasettelu|lautakunnan ratkaisu|ratkaisu|lopputulos)$/i;

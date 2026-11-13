// Mainonnan eettisen neuvoston (MEN, Keskuskauppakamari) lausunnot kauppakamari.fi:n julkisesta
// WordPress-rajapinnasta (/wp-json/wp/v2/men ja luokittelut men_decision, men_icc, men_media, men_date).
// Avainta ei tarvita. robots.txt sallii kaiken (tarkistettu 13.11.2026). Käyttöehtojen mukaan aineistoa
// saa lainata tekijänoikeuslain mukaisesti lähde mainiten, joten lausunnosta näytetään vain lainaus:
// tiivistelmä, tietorivit ja yksi lohko rajattuna tai hakusanan otteet (käyttäjä 13.11.2026 Ohjaamo J1).
// Pyynnöt rajataan _fields-parametrilla, ja tulokset ovat välimuistissa (Cache API).

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";
import { decode, htmlText } from "./tiedotteet.js";

export const MEN_BASE = "https://kauppakamari.fi";
export const MEN_SEARCH_PAGE = `${MEN_BASE}/palvelut/mainonnan-eettinen-neuvosto/etsi-lausuntoa/`;
const API = `${MEN_BASE}/wp-json/wp/v2`;
const USER_AGENT = "finlex-mcp/1.15 (Claude-liitin; Cloudflare Worker)";
const SEARCH_TTL = 86400; // haut 1 vrk
const STATEMENT_TTL = 30 * 86400; // lausunnot 30 vrk
const TERM_TTL = 7 * 86400; // luokittelut 7 vrk
export const MEN_PAGE_SIZE = 10;

export class MenError extends FinlexError {}

async function getJson(path, ttl) {
  const url = `${API}${path}`;
  const key = `https://finlex-mcp.cache/men/v1${path}`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  } catch (e) {
    throw new MenError(`yhteys epäonnistui (${e.message})`);
  }
  if (res.status === 400) return { status: 400, body: null };
  if (!res.ok) throw new MenError(`HTTP ${res.status}`);
  const body = await res.json();
  const value = { status: 200, body, total: Number(res.headers.get("x-wp-total") ?? 0), pages: Number(res.headers.get("x-wp-totalpages") ?? 0) };
  await cachePutJson(key, value, ttl);
  return value;
}

const clean = (s) => decode(String(s ?? "")).replace(/[ \s]+/g, " ").trim();

async function terms(tax) {
  const r = await getJson(`/${tax}?per_page=100&_fields=id,name,slug,count`, TERM_TTL);
  return (r.body ?? []).map((t) => ({ id: t.id, name: clean(t.name), slug: t.slug, count: t.count }));
}

/** Luokittelut: { decisions, icc, media, years } (kukin [{ id, name, slug, count }]). */
export async function menTaxonomies({ years = false } = {}) {
  const [decisions, icc, media, yr] = await Promise.all([terms("men_decision"), terms("men_icc"), terms("men_media"), years ? terms("men_date") : null]);
  return { decisions, icc, media, years: yr };
}

export async function menYears() {
  return terms("men_date");
}

/** Lausuntojen kokonaismäärä. */
export async function menTotal() {
  const r = await getJson("/men?per_page=1&_fields=id", SEARCH_TTL);
  return r.total;
}

/** ICC-artiklan lyhyt muoto: "7 artikla - Markkinoinnin tunnistettavuus" -> "7 Markkinoinnin tunnistettavuus". */
export function shortArticle(name) {
  const m = name.match(/^([A-Z]?\d+)\s+(?:artikla\s*)?[-–]?\s*(.*)$/i);
  return m ? `${m[1]} ${m[2]}`.trim() : name;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Artiklahaku: "7", "C2", "vaikuttaja"; pilkulla useita (TAI). Palauttaa osuneet termit. */
export function matchArticles(icc, want) {
  const out = new Map();
  for (const raw of String(want).split(",")) {
    const w = raw.trim().toLowerCase().replace(/^art(ikla)?\.?\s*/, "");
    if (!w) continue;
    const isNum = /^[a-z]?\d+$/i.test(w);
    for (const t of icc) {
      const n = t.name.toLowerCase();
      const hit = isNum ? new RegExp(`^${esc(w)}(\\s|$)`).test(n) : n.includes(w);
      if (hit) out.set(t.id, t);
    }
  }
  return [...out.values()];
}

/** Ratkaisu: huomautus, vapauttava, ei toimivaltaa (alkuosa riittää). */
export function matchDecision(decisions, want) {
  const w = String(want).trim().toLowerCase();
  if (!w) return [];
  return decisions.filter((t) => t.name.toLowerCase().startsWith(w) || (w.length >= 3 && t.name.toLowerCase().includes(w)));
}

export function matchMedia(media, want) {
  const w = String(want).trim().toLowerCase();
  if (!w) return [];
  return media.filter((t) => t.name.toLowerCase().includes(w) || t.slug.toLowerCase().includes(w));
}

/** Otsikon lausuntonumero: "MEN 43/2026 Soluni Oy" tai "MEN lausunto 1/2001" -> { num, year }. */
export function titleNumber(title) {
  const m = String(title).match(/^MEN\s+(?:lausunto\s+)?(\d{1,4})\s*\/\s*(\d{4})\b/i);
  return m ? { num: +m[1], year: +m[2] } : null;
}

function nameMaps(tax) {
  const map = (arr) => new Map((arr ?? []).map((t) => [t.id, t.name]));
  return { dec: map(tax.decisions), icc: map(tax.icc), media: map(tax.media), years: map(tax.years) };
}

function summaryOf(d, maps) {
  return {
    id: d.id,
    title: clean(d.title?.rendered ?? ""),
    date: d.date ?? null,
    slug: d.slug,
    link: d.link,
    summary: htmlText(d.excerpt?.rendered ?? "").replace(/\s+/g, " ").trim(),
    decisions: [...new Set((d.men_decision ?? []).map((id) => maps.dec.get(id)).filter(Boolean))],
    articles: (d.men_icc ?? []).map((id) => maps.icc.get(id)).filter(Boolean),
    media: [...new Set((d.men_media ?? []).map((id) => maps.media.get(id)).filter(Boolean))],
    years: (d.men_date ?? []).map((id) => maps.years.get(id)).filter(Boolean),
  };
}

const LIST_FIELDS = "id,date,slug,link,title,excerpt,men_decision,men_icc,men_media,men_date";

/** Haku: { items, total, pages }. Suodattimet ovat termien id-listoja. */
export async function searchStatements({ query, decisionIds, iccIds, mediaIds, yearIds, page, tax }) {
  const p = new URLSearchParams({ per_page: String(MEN_PAGE_SIZE), page: String(page), _fields: LIST_FIELDS, orderby: "date", order: "desc" });
  if (query) p.set("search", query);
  if (decisionIds?.length) p.set("men_decision", decisionIds.join(","));
  if (iccIds?.length) p.set("men_icc", iccIds.join(","));
  if (mediaIds?.length) p.set("men_media", mediaIds.join(","));
  if (yearIds?.length) p.set("men_date", yearIds.join(","));
  const r = await getJson(`/men?${p}`, SEARCH_TTL);
  if (r.status === 400) return { items: [], total: 0, pages: 0, outOfRange: true };
  const maps = nameMaps(tax);
  return { items: r.body.map((d) => summaryOf(d, maps)), total: r.total, pages: r.pages };
}

/**
 * Tunnus -> { slug } tai { num, year }. Hyväksyy "MEN 43/2026", "MEN lausunto 1/2001", "43/2026",
 * osoitteen https://kauppakamari.fi/<slug>/ ja pelkän slugin.
 */
export function parseMenId(v) {
  const s = String(v ?? "").trim();
  const n = s.match(/^(?:MEN\s+)?(?:lausunto\s+)?(\d{1,4})\s*\/\s*(\d{4})$/i);
  if (n) return { num: +n[1], year: +n[2] };
  const u = s.match(/^https?:\/\/(?:www\.)?kauppakamari\.fi\/([a-z0-9-]+)\/?(?:[?#].*)?$/i);
  if (u) return { slug: u[1].toLowerCase() };
  if (/^men-[a-z0-9-]{3,200}$/i.test(s)) return { slug: s.toLowerCase() };
  return null;
}

/** Lausuntonumero -> slug tai null. */
export async function slugByNumber(num, year) {
  const years = await menYears();
  const yt = years.find((t) => t.name === String(year));
  const tries = yt ? [yt.id, null] : [null];
  for (const yid of tries) {
    const p = new URLSearchParams({ search: `${num}/${year}`, per_page: "20", _fields: "slug,title" });
    if (yid) p.set("men_date", String(yid));
    const r = await getJson(`/men?${p}`, STATEMENT_TTL);
    const hit = (r.body ?? []).find((d) => {
      const t = titleNumber(clean(d.title?.rendered));
      return t && t.num === num && t.year === year;
    });
    if (hit) return hit.slug;
  }
  return null;
}

/** Lausunto slugilla: { title, date, link, slug, summary, decisions, articles, media, years, ...parseStatement } tai null. */
export async function statementBySlug(slug) {
  const p = new URLSearchParams({ slug, _fields: `${LIST_FIELDS},content` });
  const [r, tax] = await Promise.all([getJson(`/men?${p}`, STATEMENT_TTL), menTaxonomies({ years: true })]);
  const d = r.body?.[0];
  if (!d) return null;
  const s = summaryOf(d, nameMaps(tax));
  const parsed = parseStatement(d.content?.rendered ?? "");
  return { ...s, ...parsed, summary: parsed.summary || s.summary };
}

const INFO = /^(ASIASANAT|ARTIKLAT|Lausunto|Markkinoija|Mainostaja|Mainostettava tuote|Mainos|Media|Alusta|Päätös|Annettu)\s*:\s*(.*)$/i;
const SIGNATURE = /^Asian käsittelyyn ovat (ottaneet osaa|osallistuneet)/i;
const wholeIn = (frag, tags) => {
  const f = frag.trim();
  const re = new RegExp(`^(?:<(?:${tags})(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:${tags})>\\s*)+$`, "i");
  return re.test(f.replace(/&nbsp;| /g, " "));
};

/**
 * Lausunnon HTML lohkoiksi. Lihavoitu kappale on päälohko, kursivoitu kappale alalohko.
 * Tietorivit (ASIASANAT, ARTIKLAT, Lausunto, Markkinoija, Media, Alusta, Päätös) erotetaan,
 * ja allekirjoitusosa (käsittelyyn osallistuneet ja allekirjoitukset) jätetään pois.
 * Palauttaa { summary, info: [{ label, value }], sections: [{ title, level, parent, text }] }.
 */
export function parseStatement(html) {
  const blocks = String(html).match(/<(p|h[1-6])(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
  const info = [];
  const sections = [];
  let summary = "";
  let cur = { title: "Alku", level: 1, parent: null, lines: [] };
  let main = null;
  let signature = false;
  const push = () => {
    if (cur.lines.length || cur.title !== "Alku") sections.push(cur);
  };
  for (const block of blocks) {
    const inner = block.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
    for (const part of inner.split(/<br\s*\/?>/i)) {
      const frag = part.replace(/^\s*(<\/[^>]+>\s*)+/, "");
      const text = clean(htmlText(frag)).replace(/\s*\n\s*/g, " ");
      if (!text) continue;
      const bold = /^\s*<(strong|b)[\s>]/i.test(frag.replace(/&nbsp;/g, " "));
      const im = text.match(INFO);
      if (bold && im) {
        info.push({ label: im[1].charAt(0).toUpperCase() + im[1].slice(1).toLowerCase(), value: im[2].trim() });
        continue;
      }
      const sm = text.match(/^LAUSUNTOTIIVISTELMÄ\s*:\s*(.*)$/i);
      if (sm) {
        summary = sm[1].trim();
        continue;
      }
      if (SIGNATURE.test(text)) signature = true;
      if (signature) continue;
      const short = text.length <= 90 && !/[.:;,]$/.test(text) && text.split(" ").length <= 10;
      if (short && wholeIn(frag, "strong|b")) {
        if (text === text.toUpperCase()) continue; // otsikko tai MAINONNAN EETTINEN NEUVOSTO / KESKUSKAUPPAKAMARI
        push();
        cur = { title: text, level: 1, parent: null, lines: [] };
        main = cur;
        continue;
      }
      if (short && wholeIn(frag, "em|i")) {
        push();
        cur = { title: text, level: 2, parent: main?.title ?? null, lines: [] };
        if (main) main.lines.push(text);
        continue;
      }
      cur.lines.push(text);
      if (cur.level === 2 && main) main.lines.push(text);
    }
  }
  push();
  return {
    summary,
    info,
    sections: sections.map((x) => ({ title: x.title, level: x.level, parent: x.parent, text: x.lines.join("\n") })).filter((x) => x.text),
  };
}

/** Yleiskuvan lohko: Asian arviointi, muuten neuvoston lausunto. */
export function overviewSection(sections) {
  return sections.find((x) => /^asian arviointi$/i.test(x.title)) ?? sections.find((x) => /neuvoston lausunto/i.test(x.title) && x.level === 1) ?? null;
}

/** Lohko nimellä: tarkka, alkuosa, sisältää. */
export function findSection(sections, want) {
  const w = String(want).trim().toLowerCase();
  const rank = (t) => (t === w ? 0 : t.startsWith(w) ? 1 : t.includes(w) ? 2 : 9);
  const c = sections.map((x, i) => [x, i, rank(x.title.toLowerCase())]).filter((c) => c[2] < 9).sort((a, b) => a[2] - b[2] || a[1] - b[1]);
  return c.length ? c[0][0] : null;
}

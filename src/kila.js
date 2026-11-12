// Kirjanpitolautakunnan (KILA) lausunnot, poikkeusluvat ja yleisohjeet sivustolta
// https://kirjanpitolautakunta.fi (työ- ja elinkeinoministeriön Liferay). Rajapintaa, syötettä
// tai avointa dataa ei ole, joten haetaan sivuston omalla hakulomakkeella (GET) ja asiakirjan
// sivulta. robots.txt (tarkistettu 12.11.2026) kieltää polut /-/q/, /haku/, /sv/sok/,
// /en/search/, /web/ ja /*/web/ ja pyytää Crawl-delay 5: haetaan vain sallituista poluista,
// enintään kaksi sivuston hakua työkalukutsua kohden ja vähintään 5 s välein.
// Viranomaisen päätöksiin ja lausumiin ei ole tekijänoikeutta (tekijänoikeuslaki 404/1961 9 §);
// TEM:n sivuston ehdot edellyttävät lähteen mainintaa.

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";
import { decode, htmlText } from "./tiedotteet.js";

export const KILA_BASE = "https://kirjanpitolautakunta.fi";
const USER_AGENT = "finlex-mcp/1.11 (Claude-liitin; Cloudflare Worker)";
const CRAWL_DELAY_MS = 5000;
const MAX_FETCHES_PER_CALL = 2;
const MAX_QUEUE_WAIT_MS = 20_000;
const SEARCH_TTL = 86400; // haut 1 vrk
const STATEMENT_TTL = 30 * 86400; // lausunnot 30 vrk
const GUIDE_TTL = 7 * 86400; // yleisohjeet 7 vrk
const NS = "_fi_yja_asset_search_web_AssetSearch_";
const PAGE_SIZE = 25;

export class KilaError extends FinlexError {}

// ---------- Osoitteet ja robots.txt ----------

const DISALLOW = [/^\/-\/q\//i, /^\/haku\//i, /^\/sv\/sok\//i, /^\/en\/search\//i, /^\/web\//i, /^\/.*\/web\//i];
const ALLOW = [/^\/-\/[^/]+$/, /^\/documents\//, /^\/lausunnot-ja-poikkeusluvat$/, /^\/voimassaolevat$/, /^\/aikaisemmat$/];

/** Onko osoite sallittu: vain https://kirjanpitolautakunta.fi, robots.txt:n sallimat ja liittimen käyttämät polut. */
export function kilaUrlAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || !/^(www\.)?kirjanpitolautakunta\.fi$/i.test(u.hostname)) return false;
  let path;
  try {
    path = decodeURI(u.pathname);
  } catch {
    path = u.pathname;
  }
  if (DISALLOW.some((r) => r.test(u.pathname) || r.test(path))) return false;
  return ALLOW.some((r) => r.test(u.pathname));
}

export function searchUrl({ term = "", yearStart, yearEnd, page = 0 } = {}) {
  const q = new URLSearchParams({ p_p_id: "fi_yja_asset_search_web_AssetSearch", p_p_lifecycle: "0", p_p_state: "normal", p_p_mode: "view" });
  q.set(`${NS}searchTerm`, term);
  if (yearStart) q.set(`${NS}yearStart`, String(yearStart));
  if (yearEnd) q.set(`${NS}yearEnd`, String(yearEnd));
  if (page) q.set(`${NS}page`, String(page));
  return `${KILA_BASE}/lausunnot-ja-poikkeusluvat?${q}`;
}

// ---------- Haku sivustolta: kutsukohtainen kiintiö ja Crawl-delay ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0; // isolaatin yhteinen: seuraava sallittu hakuhetki

/** Kutsukohtainen hakuistunto: enintään kaksi hakua sivustolle. */
export function kilaSession() {
  return { used: 0 };
}

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Hakee sivun (text) tai tiedoston (bytes) sivustolta. ttl > 0: raakavastaus välimuistiin.
 * cacheOnly: palauttaa vain välimuistista (undefined, jos ei ole).
 */
async function kilaFetch(sess, url, { ttl = 0, binary = false, cacheOnly = false } = {}) {
  if (!kilaUrlAllowed(url)) throw new KilaError("osoite ei ole sallittu (vain kirjanpitolautakunta.fi:n lausunto-, ohje- ja asiakirjasivut)", 0);
  const cache = cacheApi();
  const key = new Request(`${url}${url.includes("?") ? "&" : "?"}_kila=1`);
  if (cache && ttl > 0) {
    const hit = await cache.match(key);
    if (hit) return binary ? new Uint8Array(await hit.arrayBuffer()) : hit.text();
  }
  if (cacheOnly) return undefined;
  if (sess.used >= MAX_FETCHES_PER_CALL) throw new KilaError("kirjanpitolautakunta.fi:stä haetaan enintään kaksi sivua kutsua kohden", 0);
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  if (wait > MAX_QUEUE_WAIT_MS) throw new KilaError("liian monta samanaikaista hakua", 429);
  nextSlot = Math.max(now, nextSlot) + CRAWL_DELAY_MS;
  if (wait) await sleep(wait);
  sess.used++;
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: binary ? "application/pdf,*/*;q=0.5" : "text/html,*/*;q=0.5" } });
  } catch (e) {
    throw new KilaError(`yhteys epäonnistui: ${e?.message ?? e}`, 0);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new KilaError(`palvelin vastasi ${res.status}`, res.status);
  const body = binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  if (cache && ttl > 0) {
    await cache.put(key, new Response(body, { headers: { "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}` } }));
  }
  return body;
}

// ---------- Hakutulokset ja yleisohjeluettelot ----------

const isoFi = (s) => {
  const m = String(s ?? "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};
const absUrl = (href) => (href.startsWith("http") ? href : `${KILA_BASE}${href}`);
const clean = (s) => decode(String(s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

export function isExemption(title) {
  return /^poikkeuslupa|poikkeusluvan|poikkeuslupa(?:a|hakemus)/i.test(String(title ?? "").trim());
}

/** Hakulomakkeen tai yleisohjeluettelon tulokset: { items: [{ url, title, year, num, date }], pages, page }. */
export function parseList(html) {
  const items = [];
  const box = html.indexOf("assetSearchContainer");
  const seg = box >= 0 ? html.slice(box) : html;
  for (const m of seg.matchAll(/<a href="(\/-\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*(?:<span class="documentNumber">([^<]*)<\/span>\s*)?<span class="time">([^<]*)<\/span>/g)) {
    const title = clean(m[2]);
    if (!title) continue; // ruotsinkieliset rinnakkaisversiot ovat luettelossa ilman otsikkoa
    const n = String(m[3] ?? "").match(/(\d{4})\s*\/\s*(\d+)/);
    items.push({ url: absUrl(m[1]), title, year: n ? +n[1] : null, num: n ? n[2] : null, date: isoFi(m[4]) });
  }
  // Sivumäärä näkyy vain ilman hakusanaa; hakusanalla täysi sivu tarkoittaa, että lisää voi olla.
  const pg = html.match(/class="pageOfTotal">\s*(\d+)\s*\/\s*(\d+)/);
  return { items, page: pg ? +pg[1] : null, pages: pg ? +pg[2] : null };
}

/** Lausuntojen ja poikkeuslupien haku sivuston lomakkeella (sivu 1 = ensimmäinen). */
export async function searchStatements(sess, { term = "", yearStart, yearEnd, page = 1 } = {}) {
  const html = await kilaFetch(sess, searchUrl({ term, yearStart, yearEnd, page: page - 1 }), { ttl: SEARCH_TTL });
  if (!html) return { items: [], page, pages: 0, hasMore: false };
  const r = parseList(html);
  const hasMore = r.pages ? r.pages > page : r.items.length >= PAGE_SIZE;
  return { ...r, page, hasMore, pageSize: PAGE_SIZE };
}

export const GUIDE_LISTS = {
  voimassa: { url: `${KILA_BASE}/voimassaolevat`, name: "voimassa oleva" },
  aiempi: { url: `${KILA_BASE}/aikaisemmat`, name: "aiempi (korvattu)" },
};

/** Yleisohjeluettelo (voimassa tai aiempi). cacheOnly: vain välimuistista. */
export async function guideList(sess, which, { cacheOnly = false } = {}) {
  const html = await kilaFetch(sess, GUIDE_LISTS[which].url, { ttl: SEARCH_TTL, cacheOnly });
  if (html === undefined) return undefined;
  if (!html) return [];
  return parseList(html).items.map((x) => ({ ...x, status: which }));
}

// ---------- Asiakirjan sivu ----------

function attachments(bodyHtml) {
  const out = [];
  for (const m of bodyHtml.matchAll(/<a\s[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(decode(m[1]));
    if (!kilaUrlAllowed(url)) continue;
    out.push({ name: clean(m[2]) || decodeURIComponent(url.split("/").slice(-2, -1)[0] ?? ""), url });
  }
  return out;
}

/** Leikkaa HTML:n otsikoittain: { intro, sections: [{ num, title, level, text }] }. */
export function htmlSections(bodyHtml) {
  const heads = [...bodyHtml.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].filter((h) => clean(h[2]));
  const intro = htmlText(bodyHtml.slice(0, heads[0]?.index ?? bodyHtml.length));
  const sections = heads.map((h, i) => {
    const t = clean(h[2]);
    const m = t.match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/);
    const chunk = bodyHtml.slice(h.index + h[0].length, heads[i + 1]?.index ?? bodyHtml.length);
    return { num: m ? m[1] : null, title: m ? m[2] : t, level: m ? m[1].split(".").length : Number(h[1]), text: htmlText(chunk) };
  });
  return { intro, sections };
}

/**
 * Lausunnon, poikkeusluvan tai yleisohjeen sivu:
 * { url, title, date, number, keywords, intro, sections, pdfs: [{ name, url }], kind }.
 */
export function parseDocPage(html, url) {
  const title = clean(html.match(/<h1 itemprop="name">([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*-\s*Kirjanpitolautakunta.*$/i, "");
  const date = isoFi(html.match(/<span class="date">([^<]*)<\/span>/i)?.[1]);
  const a = html.indexOf('itemprop="articleBody"');
  if (a < 0) return null;
  let body = html.slice(html.indexOf(">", a) + 1);
  const end = body.search(/<div class="links margin-bottom">|<div class="attachments margin-bottom">|<div class="meta bottom-meta"/i);
  if (end >= 0) body = body.slice(0, end);
  body = body.replace(/<\/span>\s*$/, "");
  // Numero ja asiasanat: vanhoissa <dl><dt>Numero</dt><dd>..</dd></dl>, uusissa <p><strong>Numero</strong></p><p>..</p>.
  let number = null;
  let keywords = null;
  body = body.replace(/<div>\s*<dl>([\s\S]*?)<\/dl>\s*<\/div>/i, (m, dl) => {
    for (const d of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
      const k = clean(d[1]).toLowerCase();
      if (k === "numero") number = clean(d[2]);
      else if (k === "asiasanat") keywords = clean(d[2]);
    }
    return "";
  });
  body = body.replace(/<p>\s*<strong>\s*(Numero|Asiasanat)\s*<\/strong>\s*<\/p>\s*<p>([\s\S]*?)<\/p>/gi, (m, k, v) => {
    if (/numero/i.test(k)) number = number ?? clean(v);
    else keywords = keywords ?? clean(v).replace(/\s*\|\s*/g, ", ");
    return "";
  });
  const pdfs = attachments(body);
  const { intro, sections } = htmlSections(body);
  const textLen = sections.reduce((s, x) => s + x.text.length, 0) + intro.length;
  let kind;
  if (number && /^\d+$/.test(number)) kind = isExemption(title) ? "poikkeuslupa" : "lausunto";
  else if (pdfs.length && (textLen < 3000 || /yleisohje/i.test(title))) kind = "yleisohje";
  else kind = /yleisohje/i.test(title) ? "yleisohje" : "lausunto";
  return { url, title, date, number: number && /^\d+$/.test(number) ? number : null, keywords, intro, sections, pdfs, kind };
}

/** Hakee ja jäsentää asiakirjan sivun (välimuistissa lausunnot 30 vrk, yleisohjeet 7 vrk). */
export async function docPage(sess, url) {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  const href = u.href;
  if (!kilaUrlAllowed(href) || !u.pathname.startsWith("/-/")) throw new KilaError("anna kirjanpitolautakunta.fi:n asiakirjan osoite (muotoa https://kirjanpitolautakunta.fi/-/...)", 0);
  const key = `${href}?_kiladoc=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const html = await kilaFetch(sess, href);
  if (!html) return null;
  const d = parseDocPage(html, href);
  if (d) await cachePutJson(key, d, d.kind === "yleisohje" ? GUIDE_TTL : STATEMENT_TTL);
  return d;
}

/** Hakee lausunnon numerolla (esim. 1516, vuosi valinnainen). Palauttaa hakutuloksen tai null. */
export async function findByNumber(sess, num, year) {
  const n = String(Number.parseInt(num, 10));
  const term = n.length < 3 ? n.padStart(3, "0") : n;
  const r = await searchStatements(sess, { term, yearStart: year, yearEnd: year });
  const hits = r.items.filter((x) => x.num && Number.parseInt(x.num, 10) === +n && (!year || x.year === year));
  return hits;
}

// ---------- Yleisohjeen PDF ----------

function tidy(t) {
  return String(t ?? "")
    .replace(/­/g, "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Poistaa sivujen toistuvat ylätunnisteet (otsikkorivi ja "4 (39)"). */
function stripRunningHeads(pages) {
  const firsts = new Map();
  for (const p of pages) {
    const l = p.split("\n")[0]?.trim();
    if (l) firsts.set(l, (firsts.get(l) ?? 0) + 1);
  }
  const head = [...firsts].filter(([, c]) => c >= Math.max(3, pages.length / 2)).map(([l]) => l);
  return pages.map((p) =>
    p
      .split("\n")
      .filter((l, i) => !(i < 3 && (head.includes(l.trim()) || /^\d+\s*\(\d+\)$/.test(l.trim()))))
      .join("\n"),
  );
}

async function pdfText(sess, url) {
  const bytes = await kilaFetch(sess, url, { binary: true });
  if (!bytes) return null;
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return stripRunningHeads((Array.isArray(text) ? text : [text]).map(tidy));
}

const LEADER = /\s*(?:\.\s*){3,}\s*\d+\s*$/;
const NUM_HEAD = /^(\d+(?:\.\d+){0,5})\.?\s+(\S.*)$/;
const fold = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Sisällysluettelon numeroidut otsikot: [{ num, title }] ja viimeinen sisällysluettelorivin sivu. */
function pdfToc(pages) {
  const toc = [];
  let lastPage = -1;
  let pending = null;
  pages.slice(0, 12).forEach((p, pi) => {
    for (const raw of p.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (LEADER.test(line)) {
        const t = line.replace(LEADER, "").trim();
        const full = pending && !NUM_HEAD.test(t) ? `${pending} ${t}` : t;
        pending = null;
        const m = full.match(NUM_HEAD);
        if (m) toc.push({ num: m[1], title: m[2].trim() });
        lastPage = pi;
      } else if (NUM_HEAD.test(line) && line.length < 140 && lastPage >= 0) {
        pending = line;
      } else {
        pending = null;
      }
    }
  });
  return { toc, tocEnd: lastPage };
}

/** Jakaa yleisohjeen tekstin luvuiksi: { sections: [{ num, title, level, text, page }], pages }. */
export function pdfSections(pages) {
  const { toc, tocEnd } = pdfToc(pages);
  const lines = [];
  pages.forEach((p, pi) => {
    if (toc.length && pi <= tocEnd) return;
    for (const l of p.split("\n")) lines.push({ l: l.trim(), page: pi + 1 });
  });
  const heads = [];
  if (toc.length >= 3) {
    let k = 0;
    lines.forEach((x, i) => {
      const m = x.l.match(NUM_HEAD);
      if (!m) return;
      for (let j = k; j < Math.min(toc.length, k + 6); j++) {
        const e = toc[j];
        if (e.num !== m[1]) continue;
        const a = fold(m[2]);
        const b = fold(e.title);
        const n = Math.min(12, a.length, b.length);
        if (n >= 3 && a.slice(0, n) === b.slice(0, n)) {
          heads.push({ i, num: e.num, title: e.title });
          k = j + 1;
          break;
        }
      }
    });
  } else {
    // Ei sisällysluetteloa: numeroidut lyhyet rivit, jotka jatkavat numerointia.
    let prev = [0];
    lines.forEach((x, i) => {
      const m = x.l.match(NUM_HEAD);
      if (!m || x.l.length > 110 || /[.,;:]$/.test(x.l) || !/^\p{Lu}/u.test(m[2])) return;
      const n = m[1].split(".").map(Number);
      const ok = n.length <= prev.length + 1 && n.every((v, d) => (d < n.length - 1 ? v === (prev[d] ?? 0) : v === (prev[d] ?? 0) + 1 || (d === prev.length && v === 1)));
      if (ok) {
        heads.push({ i, num: m[1], title: m[2].trim() });
        prev = n;
      }
    });
  }
  const sections = heads.map((h, k) => {
    const end = heads[k + 1]?.i ?? lines.length;
    // Monirivinen otsikko: ohitetaan rivit, jotka kuuluvat sisällysluettelon otsikkoon.
    let start = h.i + 1;
    let got = fold(lines[h.i].l.replace(NUM_HEAD, "$2"));
    const want = fold(h.title);
    while (start < end && got.length < want.length && want.startsWith(got + fold(lines[start].l))) {
      got += fold(lines[start].l);
      start++;
    }
    const text = lines
      .slice(start, end)
      .map((x) => x.l)
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
    return { num: h.num, title: h.title, level: h.num.split(".").length, text, page: lines[h.i].page };
  });
  const intro = lines
    .slice(0, heads[0]?.i ?? lines.length)
    .map((x) => x.l)
    .filter(Boolean)
    .join("\n");
  return { intro, sections };
}

/** Yleisohjeen pääteksti PDF:stä luvuittain (välimuisti 7 vrk). */
export async function guideText(sess, pdfUrl) {
  const key = `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}_kilaohje=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const pages = await pdfText(sess, pdfUrl);
  if (!pages) return null;
  const { intro, sections } = pdfSections(pages);
  const out = { pages: sections.length ? null : pages, intro, sections, pageCount: pages.length };
  await cachePutJson(key, out, GUIDE_TTL);
  return out;
}

/** Liitteen teksti sivuittain (välimuisti 7 vrk). */
export async function attachmentText(sess, pdfUrl) {
  const key = `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}_kilaliite=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const pages = await pdfText(sess, pdfUrl);
  if (!pages) return null;
  await cachePutJson(key, pages, GUIDE_TTL);
  return pages;
}

/** Yleisohjeen pääteksti ja liitteet: ensimmäinen PDF, joka ei ole liite tai sisällysluettelo. */
export function splitGuidePdfs(pdfs) {
  const isAnnex = (p) => /liite|sisällys|bilaga|innehåll/i.test(p.name);
  const main = pdfs.find((p) => !isAnnex(p)) ?? pdfs[0] ?? null;
  return { main, annexes: pdfs.filter((p) => p !== main) };
}

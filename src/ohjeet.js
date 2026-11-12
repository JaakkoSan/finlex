// Viranomaisten ohjeet verkkosivuilta (selvitetty 12.11.2026):
// - Traficom: Kyberturvallisuuskeskuksen sivusto (kyberturvallisuuskeskus.fi), osiot
//   viestintaverkkojen ja -palveluiden sääntely, tunnistus- ja luottamuspalveluiden sääntely sekä
//   ohjeet ja oppaat. robots.txt sallii kaiken; sivut luetellaan sivukartasta.
// - Tietosuojavaltuutetun toimisto (tietosuoja.fi): robots.txt kieltää /haku/, /-/q/ ja /web/ ja
//   pyytää 5 sekunnin viivettä (Crawl-delay), joten tietosuoja.fi:stä haetaan enintään yksi sivu
//   kutsua kohden. Ohjesivut luetellaan etusivun valikosta.
// - KKV (kkv.fi): robots.txt kieltää vain /wp-admin/. Haku WordPressin vakiorajapinnalla
//   (/wp-json/wp/v2/search, joka hakee sivujen otsikoista), päätökset sivukartasta.
// - PRH (prh.fi): ei robots.txt:tä, sivukarttaa eikä RSS:ää. Sivuvalikko ladataan sisäisestä
//   taustapalvelusta, jota ei käytetä; sivut ovat valmiissa lähtölistassa (prhPages.js).
// Avointa ohjerajapintaa ei ole millään. Haetaan vain valkoisen listan verkkotunnuksista,
// robots.txt:tä noudattaen ja rehellisellä User-Agentilla. Fimean ja Tukesin sivuja ei haeta.

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";
import { decode } from "./tiedotteet.js";
import { PRH_PAGES } from "./prhPages.js";

const USER_AGENT = "finlex-mcp/1.12 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const DAY = 86400;
const MAX_BYTES = 15_000_000;

export class OhjeError extends FinlexError {}
/** Käyttäjälle näytettävä virhe (väärä osoite, torjuttu sivu). */
export class OhjeUserError extends Error {}

export const AUTHORITIES = {
  traficom: { name: "Liikenne- ja viestintävirasto Traficom, Kyberturvallisuuskeskus", short: "Traficom", base: "https://www.kyberturvallisuuskeskus.fi" },
  tietosuoja: { name: "Tietosuojavaltuutetun toimisto", short: "Tietosuojavaltuutettu", base: "https://tietosuoja.fi" },
  kkv: { name: "Kilpailu- ja kuluttajavirasto (KKV)", short: "KKV", base: "https://www.kkv.fi" },
  prh: { name: "Patentti- ja rekisterihallitus (PRH)", short: "PRH", base: "https://www.prh.fi" },
};

const HOSTS = {
  "www.kyberturvallisuuskeskus.fi": "traficom",
  "kyberturvallisuuskeskus.fi": "traficom",
  "tietosuoja.fi": "tietosuoja",
  "www.tietosuoja.fi": "tietosuoja",
  "www.kkv.fi": "kkv",
  "kkv.fi": "kkv",
  "www.prh.fi": "prh",
  "prh.fi": "prh",
};

/** Viranomainen osoitteen verkkotunnuksesta tai null. */
export function authorityOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? HOSTS[u.hostname] ?? null : null;
  } catch {
    return null;
  }
}

export const isBlockedHost = (host) => /(^|\.)(fimea|tukes)\.fi$/i.test(host);

const KYBER_SECTIONS = ["/fi/viestintaverkkojen-ja-palveluiden-saantely", "/fi/tunnistus-ja-luottamuspalveluiden-saantely", "/fi/ohjeet-ja-oppaat"];

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- robots.txt ----------

const ROBOTS_MEM = new Map();

/** robots.txt:n User-agent: * -ryhmä: { rules: [{ allow, path }], delay }. */
export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(txt ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!lastWasAgent) {
        cur = { agents: [], rules: [], delay: 0 };
        groups.push(cur);
      }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "disallow" && v) cur.rules.push({ allow: false, path: v });
    else if (k === "allow" && v) cur.rules.push({ allow: true, path: v });
    else if (k === "crawl-delay") cur.delay = Number.parseFloat(v) || 0;
  }
  const g = groups.find((x) => x.agents.some((a) => a.startsWith("finlex-mcp"))) ?? groups.find((x) => x.agents.includes("*"));
  return g ? { rules: g.rules, delay: g.delay } : { rules: [], delay: 0 };
}

function ruleMatch(rule, path) {
  const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`, "i");
  return re.test(path);
}

/** RFC 9309: pisin täsmäävä sääntö ratkaisee; tasatilanteessa Allow. */
export function robotsAllows(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!ruleMatch(r.path, pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function robotsFor(origin) {
  const mem = ROBOTS_MEM.get(origin);
  if (mem && mem.exp > Date.now()) return mem.value;
  const key = `${origin}/robots.txt?_robots=1`;
  let value = await cacheGetJson(key);
  if (!value) {
    let txt = "";
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT, Accept: "text/plain" }, redirect: "follow" });
      // 4xx: ei rajoituksia (RFC 9309 2.3.1.3). 5xx tai yhteysvirhe: ei haeta.
      if (res.status >= 500) throw new OhjeError(`robots.txt: palvelin vastasi ${res.status}`, res.status);
      if (res.ok) txt = await res.text();
    } catch (e) {
      if (e instanceof OhjeError) throw e;
      throw new OhjeError(`robots.txt:tä ei saatu (${e?.message ?? e})`, 0);
    }
    value = parseRobots(txt);
    await cachePutJson(key, value, DAY);
  }
  ROBOTS_MEM.set(origin, { value, exp: Date.now() + 3600_000 });
  return value;
}

// ---------- Haku ----------

// Hakusivuja ei haeta, vaikka robots.txt kieltää vain kauttaviivaan päättyvän muodon (/haku/).
const EXTRA_DISALLOW = [["tietosuoja.fi", /^\/(haku|sv\/sok|en\/search)(\/|$)/i]];

const LAST_FETCH = new Map(); // verkkotunnus -> viimeisimmän haun aika (ms), Crawl-delay-viivettä varten

/**
 * Hakukerran laskuri. Jos sivusto pyytää viivettä (Crawl-delay), siltä haetaan enintään yksi
 * sivu kutsua kohden; robots.txt ei ole sivu.
 */
export function newBudget() {
  return { hosts: new Map() };
}

async function checkUrl(u, budget) {
  if (u.protocol !== "https:") throw new OhjeUserError("Vain https-osoitteet.");
  if (isBlockedHost(u.hostname)) throw new OhjeUserError("Fimean ja Tukesin sivut torjuvat automaattiset haut, joten niitä ei haeta. Lue sivu viraston sivustolta.");
  if (!HOSTS[u.hostname]) {
    throw new OhjeUserError(`Verkkotunnusta ${u.hostname} ei haeta. Ohjeita luetaan vain sivustoilta kyberturvallisuuskeskus.fi (Traficom), tietosuoja.fi, kkv.fi ja prh.fi.`);
  }
  const robots = await robotsFor(u.origin);
  if (!robotsAllows(robots, `${u.pathname}${u.search}`) || EXTRA_DISALLOW.some(([h, re]) => h === u.hostname && re.test(u.pathname))) {
    throw new OhjeUserError(`Sivuston robots.txt kieltää automaattisen haun osoitteesta ${u.pathname}. Lue sivu selaimella: ${u.href}`);
  }
  if (robots.delay > 0) {
    const n = budget.hosts.get(u.hostname) ?? 0;
    if (n >= 1) {
      throw new OhjeUserError(`${u.hostname} pyytää ${robots.delay} sekunnin viivettä hakujen väliin (robots.txt), joten siltä haetaan yksi sivu kutsua kohden. Tee seuraava haku uudella kutsulla.`);
    }
    const last = LAST_FETCH.get(u.hostname) ?? 0;
    const wait = last + robots.delay * 1000 - Date.now();
    if (wait > 0) await sleep(Math.min(wait, robots.delay * 1000));
  }
  return robots;
}

/**
 * Hakee sivun tai tiedoston valkoisen listan sivustolta. Uudelleenohjaukset tarkistetaan
 * jokainen erikseen. Palauttaa { url, type, text | bytes } tai null (404).
 */
export async function fetchOhje(url, { ttl = 0, binary = false, budget = newBudget() } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new OhjeUserError("Virheellinen osoite.");
  }
  u.hash = "";
  const cache = cacheApi();
  const key = new Request(`${u.href}${u.search ? "&" : "?"}_ohjeraw=1`);
  if (cache && ttl > 0 && !binary) {
    const hit = await cache.match(key);
    if (hit) return { url: hit.headers.get("X-Final-Url") ?? u.href, type: hit.headers.get("X-Type") ?? "text/html", text: await hit.text() };
  }
  for (let hop = 0; hop < 5; hop++) {
    const robots = await checkUrl(u, budget);
    budget.hosts.set(u.hostname, (budget.hosts.get(u.hostname) ?? 0) + 1);
    let res;
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        LAST_FETCH.set(u.hostname, Date.now());
        res = await fetch(u.href, {
          headers: { "User-Agent": USER_AGENT, "Accept-Language": "fi", Accept: binary ? "application/pdf,*/*;q=0.5" : "text/html,application/json;q=0.9,application/xml;q=0.8,*/*;q=0.5" },
          redirect: "manual",
        });
      } catch (e) {
        last = new OhjeError(`yhteys epäonnistui: ${e?.message ?? e}`, 0);
        res = null;
        if (robots.delay > 0) break;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      // Viivettä pyytävälle sivustolle ei yritetä uudelleen samassa kutsussa.
      if (!RETRY_STATUS.has(res.status) || robots.delay > 0) break;
      last = new OhjeError(`palvelin vastasi ${res.status}`, res.status);
      await sleep(800 * 2 ** attempt);
    }
    if (!res) throw last;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      // Palvelin voi lähettää osoitteen UTF-8-tavuina (esim. ä); otsakkeet luetaan latin1-merkkeinä.
      let loc = res.headers.get("Location");
      if (loc && /[\x80-\xff]/.test(loc) && ![...loc].some((c) => c.charCodeAt(0) > 0xff)) {
        try {
          loc = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(loc, (c) => c.charCodeAt(0)));
        } catch {
          // ei UTF-8:aa: käytetään sellaisenaan
        }
      }
      if (!loc) throw new OhjeError("uudelleenohjaus ilman osoitetta", res.status);
      const next = new URL(loc, u);
      // Sama sivusto: uudelleenohjaus ei ole uusi sivu Crawl-delay-laskennassa.
      if (next.hostname === u.hostname) budget.hosts.set(u.hostname, budget.hosts.get(u.hostname) - 1);
      u = next;
      continue;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (res.status === 403) throw new OhjeUserError(`Sivusto torjui haun (403): ${u.href}`);
    if (!res.ok) throw new OhjeError(`palvelin vastasi ${res.status}`, res.status);
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    const len = Number(res.headers.get("Content-Length") ?? 0);
    if (len > MAX_BYTES) throw new OhjeUserError(`Tiedosto on liian suuri luettavaksi (${Math.round(len / 1e6)} Mt). Avaa se selaimella: ${u.href}`);
    if (binary || type === "application/pdf") {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { url: u.href, type, bytes };
    }
    const text = await res.text();
    if (cache && ttl > 0) {
      await cache.put(key, new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": `max-age=${ttl}`, "X-Final-Url": u.href, "X-Type": type } }));
    }
    return { url: u.href, type, text };
  }
  throw new OhjeError("liian monta uudelleenohjausta", 0);
}

// ---------- HTML tekstiksi ----------

const TAG = /<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;

// Linkkien saavutettavuustekstit pois.
const JUNK = /\s*\(?(Ulkoinen verkkopalvelu|Avautuu uuteen (?:ikkunaan|välilehteen))\.?\)?/gi;

function stripTags(s) {
  return decode(String(s).replace(/<!--[\s\S]*?-->/g, "").replace(TAG, " "))
    .replace(/[\u00ad\u200b]/g, "")
    .replace(JUNK, "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeElements(html, names) {
  let out = html;
  for (const n of names) out = out.replace(new RegExp(`<${n}\\b[\\s\\S]*?<\\/${n}>`, "gi"), " ");
  return out;
}

const H_MARK = "\u0001";

/** HTML-alue riveiksi; otsikot merkitään H_MARK + taso + teksti. */
function htmlLines(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s*[\r\n]+\s*/g, " ");
  s = removeElements(s, ["script", "style", "noscript", "svg", "template", "nav", "form", "select"]);
  s = s.replace(/<span class="subtitle">([\s\S]*?)<\/span>/gi, (m, t) => ` (${stripTags(t)})`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, t) => {
    const txt = stripTags(t);
    return txt ? `\n${H_MARK}${l}${txt}\n` : "\n";
  });
  s = s
    .replace(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi, (m, a, c) => `${stripTags(c)} | `)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|div|tr|section|ul|ol|table|blockquote|dd|dt|header|article|main)>/gi, "\n")
    .replace(/<(p|div|tr|section|ul|ol|table|blockquote|dd|dt)\b[^>]*>/gi, "\n")
    .replace(TAG, "");
  return decode(s)
    .replace(/[\u00ad\u200b]/g, "")
    .replace(JUNK, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim().replace(/\s*\|$/, ""))
    .filter((l) => l && l !== "-" && !/^((Avaa kaikki|Sulje kaikki|Kuuntele|Jaa|Tulosta|Sivun alkuun)\s*)+$/i.test(l));
}

function sliceBetween(html, startRe, endRe) {
  let a = html.search(startRe);
  if (a < 0) return null;
  if (html[a] !== "<") a = Math.max(0, html.lastIndexOf("<", a));
  const rest = html.slice(a);
  const e = endRe ? rest.search(endRe) : -1;
  return e > 0 ? rest.slice(0, e) : rest;
}

/** Sivun sisältöalue viranomaisen sivupohjan mukaan. */
function contentArea(auth, html) {
  if (auth === "traficom") return sliceBetween(html, /<main\b/i, /<\/main>/i);
  // KKV: tiedot (päivämäärä, diaarinumero) luetaan erikseen sivun otsakkeesta, teksti artikkelista.
  if (auth === "kkv") return sliceBetween(html, /<article\b/i, /<\/article>/i) ?? sliceBetween(html, /<main\b/i, /<\/main>/i);
  if (auth === "prh") return sliceBetween(html, /class="[^"]*prh-sisaltoalue/i, /<\/main>/i);
  if (auth === "tietosuoja") {
    let a = sliceBetween(html, /<h1\b/i, /<footer\b/i);
    if (!a) return null;
    // Sivun lopun oikopolut ja sivuvalikot eivät kuulu ohjeeseen.
    const cut = a.search(/data-analytics-asset-title="Alasivut - Oikopolkuja"|class="[^"]*portlet-navigation/i);
    if (cut > 0) a = a.slice(0, Math.max(0, a.lastIndexOf("<", cut)));
    return a;
  }
  return null;
}

function metaPairs(auth, html) {
  const meta = [];
  if (auth === "kkv") {
    for (const m of html.matchAll(/<p class="[^"]*meta-title[^"]*">([\s\S]*?)<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const k = stripTags(m[1]);
      const v = stripTags(m[2]);
      if (k && v) meta.push([k, v]);
    }
  }
  const mod = html.match(/<meta\s+property="article:modified_time"\s+content="([^"]+)"/i)?.[1];
  if (mod && !meta.some(([k]) => /päivitetty/i.test(k))) meta.push(["Sivu päivitetty", mod.slice(0, 10).split("-").reverse().map((x) => x.replace(/^0/, "")).join(".")]);
  return meta;
}

const SKIP_HEADINGS = /^(Sisällysluettelo|Sisällys|Tällä sivulla|Alatunniste|Osoitetiedot|Jaa sivu|Ota yhteyttä|Lue myös|Aiheeseen liittyvää|Kehitä osaamista.*)$/i;

/**
 * Ohjesivun rakenne: { url, authority, title, meta, intro, sections: [{ num, title, level, text }], pdfs: [{ title, url }] }.
 */
export function parseOhjePage(url, html) {
  const auth = authorityOf(url);
  const area = contentArea(auth, html) ?? html;
  const title = stripTags(area.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s*[|–-]\s*(Traficom|Kilpailu- ja kuluttajavirasto|Tietosuojavaltuutetun toimisto|PRH)\s*$/i, "");
  const pdfs = [];
  const seen = new Set();
  for (const m of area.matchAll(/<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href;
    try {
      href = new URL(decode(m[1]), url);
    } catch {
      continue;
    }
    if (!/\.pdf$/i.test(href.pathname) || seen.has(href.href)) continue;
    seen.add(href.href);
    let t = stripTags(m[2]);
    if (!t || /^(pdf|lataa|tästä|linkki)$/i.test(t)) t = decodeURIComponent(href.pathname.split("/").pop()).replace(/\.pdf$/i, "");
    pdfs.push({ title: t, url: href.href });
  }
  const lines = htmlLines(area);
  const sections = [];
  const intro = [];
  let cur = null;
  let skip = false;
  let seenTitle = false;
  for (const l of lines) {
    if (l[0] === H_MARK) {
      const level = Number(l[1]);
      const t = l.slice(2).trim();
      if (level === 1 && !seenTitle) {
        seenTitle = true;
        continue;
      }
      skip = SKIP_HEADINGS.test(t);
      if (skip) {
        cur = null;
        continue;
      }
      const m = t.match(/^(\d+(?:\.\d+)*)\.?\s+(.+)$/);
      cur = { num: m ? m[1] : null, title: m ? m[2] : t, level: Math.max(2, level), text: [] };
      sections.push(cur);
      continue;
    }
    if (skip) continue;
    (cur ? cur.text : intro).push(l);
  }
  // Sisällysluettelon numeroidut rivit (kkv) poistetaan johdannosta, jos ne toistavat otsikot.
  const out = {
    url,
    authority: auth,
    title: title || null,
    meta: metaPairs(auth, html),
    intro: intro.join("\n"),
    sections: sections.map((x) => ({ ...x, text: x.text.join("\n") })).filter((x, i, a) => x.text || a[i + 1]?.level > x.level),
    pdfs: pdfs.slice(0, 60),
  };
  return out;
}

/** Ohjesivu jäsennettynä (välimuisti 7 vrk). */
export async function ohjePage(url, budget) {
  const key = `${url}${url.includes("?") ? "&" : "?"}_ohje=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const r = await fetchOhje(url, { budget });
  if (!r) return null;
  if (r.bytes) return { pdf: true, url: r.url, bytes: r.bytes };
  if (!/html/.test(r.type) && !/^\s*</.test(r.text)) throw new OhjeUserError("Osoite ei ole verkkosivu eikä PDF-tiedosto.");
  const doc = parseOhjePage(r.url, r.text);
  if (doc.sections.length || doc.intro) await cachePutJson(key, doc, 7 * DAY);
  return doc;
}

// ---------- PDF ----------

function tidy(t) {
  return String(t ?? "")
    .replace(/\u00ad/g, "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PDF:n teksti sivuittain (välimuisti 7 vrk): { url, pages: [string] } tai null. */
export async function ohjePdf(url, budget, bytes) {
  const key = `${url}${url.includes("?") ? "&" : "?"}_ohjepdf=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  let finalUrl = url;
  if (!bytes) {
    const r = await fetchOhje(url, { binary: true, budget });
    if (!r) return null;
    bytes = r.bytes;
    finalUrl = r.url;
  }
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new OhjeUserError("Osoite ei ole PDF-tiedosto.");
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const out = { url: finalUrl, pages: (Array.isArray(text) ? text : [text]).map(tidy) };
  await cachePutJson(key, out, 7 * DAY);
  return out;
}

// ---------- Luettelot hakua varten ----------

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[äå]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Osoitteen viimeisestä osasta luettava otsikko (sivukartassa ei ole otsikoita). */
export function slugTitle(url) {
  const p = new URL(url).pathname.replace(/\/$/, "").split("/").pop().replace(/\.html$/, "");
  const t = decodeURIComponent(p).replace(/[-_]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : url;
}

async function sitemapLocs(url, budget) {
  const r = await fetchOhje(url, { ttl: DAY, budget });
  if (!r) return [];
  return [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decode(m[1]));
}

/** Traficom (Kyberturvallisuuskeskus): valittujen osioiden suomenkieliset sivut sivukartasta. */
async function traficomList(budget) {
  const key = "https://www.kyberturvallisuuskeskus.fi/sitemap.xml?_ohjelista=1";
  let list = await cacheGetJson(key);
  if (!list) {
    const locs = await sitemapLocs("https://www.kyberturvallisuuskeskus.fi/sitemap.xml", budget);
    list = locs
      .filter((u) => KYBER_SECTIONS.some((s) => new URL(u).pathname.startsWith(s)))
      .map((u) => ({ url: u, title: slugTitle(u), type: "ohje", slug: true }));
    if (list.length) await cachePutJson(key, list, DAY);
  }
  return list;
}

// Tietosuoja.fi:n valikon sivut, jotka eivät ole ohjeita (viraston omat asiat).
const TS_SKIP = /\/(etusivu|fi|haku|ajankohtaista|uutiset-tiedotteet|blogi|medialle|uutiskirje|sahkoinen-asiointi.*|yhteystiedot|puhelinneuvonta|kirjaamo|tietosuojavastaava|luentopyynnot|saavutettavuusseloste|tietosuojakaytantomme|evasteet|asiointi-.*|tyohakemuksen-jattaminen|tietosuojavaltuutetun-toimisto-tyopaikkana|tyontekijatarinoita|toimintakertomus-\d+|arkisto|asiakirjajulkisuuskuvaus|tietojen-luovuttaminen|tietosuojavastaavien-henkilotietojen-kasittely|toimivaltaamme-kuuluvien-asioiden-kasittely|tietosuojaoikeutesi-ja-oikeusturva|toiminta-ja-tavoitteet)$/;

/** Tietosuojavaltuutettu: ohjesivut etusivun valikosta (yksi haku). */
async function tietosuojaList(budget) {
  const key = "https://tietosuoja.fi/etusivu?_ohjelista=1";
  let list = await cacheGetJson(key);
  if (!list) {
    const r = await fetchOhje("https://tietosuoja.fi/etusivu", { ttl: DAY, budget });
    const seen = new Set();
    list = [];
    for (const m of (r?.text ?? "").matchAll(/<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let u;
      try {
        u = new URL(decode(m[1]), "https://tietosuoja.fi/");
      } catch {
        continue;
      }
      if (u.hostname !== "tietosuoja.fi" || u.search || u.pathname.startsWith("/-/") || u.pathname === "/" || TS_SKIP.test(u.pathname)) continue;
      if (/^\/(sv|en|web|haku)(\/|$)/.test(u.pathname)) continue;
      const t = stripTags(m[2]);
      if (!t || seen.has(u.pathname)) continue;
      seen.add(u.pathname);
      const type = /^\/usein-kysyttya/.test(u.pathname) ? "ohje" : /ratkaisut|euroopan-tietosuojaneuvoston-ohjeet|yleistiedoksiannot/.test(u.pathname) ? "paatos" : "ohje";
      list.push({ url: `https://tietosuoja.fi${u.pathname}`, title: t, type });
    }
    if (list.length) await cachePutJson(key, list, DAY);
  }
  return list;
}

const KKV_LINJAUS = /\/kuluttaja-asiamiehen-(linjaukset|ohjeistukset)\//;
const KKV_TYPES = { linjaus: "Kuluttaja-asiamiehen linjaus tai ohjeistus", paatos: "Päätös", ohje: "Ohje" };
const kkvType = (u) => (/\/paatokset\//.test(u) ? "paatos" : KKV_LINJAUS.test(u) ? "linjaus" : "ohje");

/** KKV: päätökset ja ohjesivut sivukartasta (otsikko osoitteesta). */
async function kkvSitemap(budget) {
  const key = "https://www.kkv.fi/sitemap.xml?_ohjelista=1";
  let list = await cacheGetJson(key);
  if (!list) {
    const locs = await sitemapLocs("https://www.kkv.fi/sitemap.xml", budget);
    list = locs
      .filter((u) => /^https:\/\/www\.kkv\.fi\/(paatokset|kuluttaja-asiat|kilpailuasiat)\/.+/.test(u))
      .map((u) => ({ url: u, title: slugTitle(u), type: kkvType(u), slug: true }));
    if (list.length) await cachePutJson(key, list, DAY);
  }
  return list;
}

/** KKV:n WordPress-haku (vakiorajapinta /wp-json/wp/v2/search; hakee sivujen otsikoista). */
async function kkvSearch(query, budget) {
  const q = new URLSearchParams({ search: query, per_page: "50", type: "post", subtype: "page", _fields: "title,url" });
  const r = await fetchOhje(`https://www.kkv.fi/wp-json/wp/v2/search?${q}`, { ttl: 6 * 3600, budget });
  if (!r) return [];
  let d;
  try {
    d = JSON.parse(r.text);
  } catch {
    throw new OhjeError("KKV:n haku palautti virheellisen vastauksen.", 0);
  }
  return (Array.isArray(d) ? d : [])
    .filter((x) => typeof x.url === "string" && /^https:\/\/www\.kkv\.fi\/(kuluttaja-asiat|kilpailuasiat|paatokset)\//.test(x.url))
    .map((x) => ({ url: x.url, title: decode(x.title ?? "").trim() || slugTitle(x.url), type: kkvType(x.url) }));
}

function prhList() {
  return PRH_PAGES.map(([path, title]) => ({ url: `https://www.prh.fi${path}`, title, type: "ohje" }));
}

/** Diaarinumero osoitteen muotoon: KKV/1613/14.00.10/2026 -> kkv-1613-14-00-10-2026. */
const diaariSlug = (s) => (/^[A-ZÅÄÖ]{2,10}\/\d+\/[\d.]+\/\d{4}$/i.test(String(s).trim()) ? fold(s).replace(/ /g, "-") : null);

function matches(item, words, slugQ) {
  const hay = fold(`${item.title} ${new URL(item.url).pathname}`);
  if (slugQ) return new URL(item.url).pathname.toLowerCase().includes(slugQ);
  return words.every((w) => hay.includes(w));
}

/**
 * Hakee ohjeita. Palauttaa { hits: [{ authority, url, title, type, slug }], notes: [string], errors: [string] }.
 * Koko tekstin haku vain KKV:n WordPress-rajapinnasta (sekin hakee otsikoista); muissa otsikko ja osoite.
 */
export async function searchOhjeet({ query = "", authorities, type = "kaikki" }) {
  const words = fold(query).split(" ").filter(Boolean);
  const slugQ = diaariSlug(query);
  const hits = [];
  const errors = [];
  const typeOk = (t) => type === "kaikki" || t === type || (type === "ohje" && t === "linjaus");
  const add = (auth, items) => {
    for (const it of items) if (typeOk(it.type) && (!words.length || matches(it, words, slugQ))) hits.push({ authority: auth, ...it });
  };
  await Promise.all(
    authorities.map(async (a) => {
      const budget = newBudget();
      try {
        if (a === "traficom") add(a, await traficomList(budget));
        else if (a === "tietosuoja") add(a, await tietosuojaList(budget));
        else if (a === "prh") add(a, prhList());
        else if (a === "kkv") {
          const api = query && !slugQ && type !== "paatos" ? await kkvSearch(query, budget) : [];
          for (const it of api) if (typeOk(it.type)) hits.push({ authority: a, ...it });
          const sm = await kkvSitemap(budget);
          const have = new Set(api.map((x) => x.url));
          // Päätökset ovat vain sivukartassa; ohjesivut haetaan sivukartasta, jos hakusana puuttuu tai rajapinta ei löytänyt.
          add(a, sm.filter((x) => !have.has(x.url) && (x.type === "paatos" || !query || !api.length || slugQ)));
        }
      } catch (e) {
        if (e instanceof OhjeUserError) errors.push(`${AUTHORITIES[a].short}: ${e.message}`);
        else errors.push(`${AUTHORITIES[a].short}: haku epäonnistui (${e?.message ?? e})`);
      }
    }),
  );
  // Järjestys: otsikkoon osuvat ensin, sitten lyhyempi osoite (yleisempi sivu).
  const score = (h) => {
    if (!words.length) return 0;
    const t = fold(h.title);
    return (words.every((w) => t.includes(w)) ? 0 : 10) + (t.startsWith(words[0]) ? 0 : 1);
  };
  const order = Object.keys(AUTHORITIES);
  hits.sort((x, y) => score(x) - score(y) || order.indexOf(x.authority) - order.indexOf(y.authority) || (x.type === "paatos") - (y.type === "paatos") || x.url.length - y.url.length);
  return { hits, errors };
}

export { KKV_TYPES };

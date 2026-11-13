// Viranomaisten tiedotteet RSS-syötteistä (tarkistettu 1.11.2026):
// - Fimea: https://fimea.fi/etusivu/-/asset_publisher/lVOfm05ujKUa/rss (RSS 1.0, vain otsikot)
// - Tukes: https://tukes.fi/etusivu/-/asset_publisher/j4IpZeX3sdnN/rss (RSS 2.0, vain otsikot)
// - Verohallinto: https://www.vero.fi/api/rss/news/fi ja /api/rss/preciseinformation/fi (vero.fi/en/About-us/newsroom/news/rss-service)
// - Lupa- ja valvontavirasto: STT Infon uutishuone, https://www.sttinfo.fi/rss/releases/latest?publisherId=69821631
// - Verohallinnon haku: https://www.vero.fi/api/search/results (dokumentoitu: vero.fi/globalassets/
//   tietoa-verohallinnosta/sahkoinen-asiointi/verofi-search-api-documentation.pdf). Vero.fi:n
//   sisältökuvauksen mukaan ohjeita saa hakea koneellisesti myös rajapinnan kautta ja esittää
//   ulkoisissa palveluissa; robots.txt ei rajoita (tarkistettu 11.11.2026).
// - Tietosuojavaltuutettu: https://tietosuoja.fi/etusivu/-/asset_publisher/GcYqYm2ssJIz/rss (etusivun RSS-linkki)
// - Kyberturvallisuuskeskus (Traficom): https://www.kyberturvallisuuskeskus.fi/feed/rss/fi (kaikki ajankohtaiset)
// - KKV: https://www.kkv.fi/feed/?post_type=current-cpt&post_parent=1392 (ajankohtaista-sivun RSS-linkki)
//   (lisätty 12.11.2026; tekstit luetaan ohjeet.js:n kautta, joka noudattaa robots.txt:tä)
// - Hyvinvointialueet (lisätty ja tarkistettu 12.11.2026): 12 aluetta, HUS ja Helsingin sote
//   STT Infon uutishuoneista (STT Info: RSS-tilaus kaikille, aineisto vapaasti julkaistavissa,
//   ellei toisin mainita; robots.txt Crawl-delay 1, joten STT Infon haut tehdään 1 s välein) ja
//   7 aluetta omasta RSS-syötteestä. robots.txt sallii syötteet ja tiedotesivut kaikilla
//   (ekhva.fi ja siunsote.fi: ei robots.txt-tiedostoa). Lappi (ei syötettä) ja Keski-Pohjanmaa
//   (soite.fi kieltää tekoälyrobotit) puuttuvat.
// - Pohjois-Savo (lisätty 13.11.2026, käyttäjä Ohjaamo B1): Liferayn asset publisher -syöte
//   https://pshyvinvointialue.fi/fi/ajankohtaiset/-/asset_publisher/inTIi74Lb5G8/rss (ajankohtaiset-sivun
//   link rel=alternate). robots.txt sallii kaiken (User-agent: *, tyhjä Disallow); sivustolla ei ole
//   käyttöehtoja (tarkistettu 13.11.2026).
// Fimean ja Tukesin verkkosivut torjuvat automaattiset haut (403), joten niiden tiedotteista
// näytetään vain syötteen tiedot. Tiedotteen teksti haetaan vain vero.fi:stä ja sttinfo.fi:stä
// (robots.txt sallii; STT Info pyytää 1 s viivettä, ja haut välimuistitetaan).

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";

const USER_AGENT = "finlex-mcp/1.16 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class TiedoteError extends FinlexError {}

export const FEEDS = {
  fimea: { name: "Fimea (Lääkealan turvallisuus- ja kehittämiskeskus)", short: "Fimea", url: "https://fimea.fi/etusivu/-/asset_publisher/lVOfm05ujKUa/rss", text: false },
  tukes: { name: "Tukes (Turvallisuus- ja kemikaalivirasto)", short: "Tukes", url: "https://tukes.fi/etusivu/-/asset_publisher/j4IpZeX3sdnN/rss", text: false },
  lvv: { name: "Lupa- ja valvontavirasto (tiedotteet STT Infossa)", short: "LVV", url: "https://www.sttinfo.fi/rss/releases/latest?publisherId=69821631", text: true },
  vero: { name: "Verohallinto, uutiset", short: "Vero", url: "https://www.vero.fi/api/rss/news/fi", text: true },
  vero_ohjeet: { name: "Verohallinto, syventävät vero-ohjeet", short: "Vero-ohje", url: "https://www.vero.fi/api/rss/preciseinformation/fi", text: true },
  tietosuoja: { name: "Tietosuojavaltuutetun toimisto, ajankohtaista", short: "Tietosuoja", url: "https://tietosuoja.fi/etusivu/-/asset_publisher/GcYqYm2ssJIz/rss", text: true },
  kyber: { name: "Traficomin Kyberturvallisuuskeskus, ajankohtaista", short: "Kyber", url: "https://www.kyberturvallisuuskeskus.fi/feed/rss/fi", text: true },
  kkv: { name: "Kilpailu- ja kuluttajavirasto (KKV), ajankohtaista", short: "KKV", url: "https://www.kkv.fi/feed/?post_type=current-cpt&post_parent=1392", text: true },
};

// Hyvinvointialueiden tiedotteet. page = tiedotesivun tekstin rajaus: start-merkit haetaan
// peräkkäin, ja teksti päättyy ensimmäiseen end-merkkiin. head = merkki, jonka jälkeen otsikko (h1) ja
// päivä haetaan (jos sivun alussa on muita h1-elementtejä).
const STT = (id) => `https://www.sttinfo.fi/rss/releases/latest?publisherId=${id}`;
const WP_ARTICLE = { start: ["<article", "</header>"], end: ["Jaa tämä sivu", "</article>"] };
const WP_BLOCKS = { start: ['<div class="entry-content'], end: ["Lisää tiedot", "</main>"] };
export const HVA_FEEDS = {
  ita_uusimaa: { name: "Itä-Uudenmaan hyvinvointialue", short: "HVA Itä-Uusimaa", url: STT(69819601) },
  keski_uusimaa: { name: "Keski-Uudenmaan hyvinvointialue (Keusote)", short: "HVA Keski-Uusimaa", url: STT(69819221) },
  lansi_uusimaa: { name: "Länsi-Uudenmaan hyvinvointialue", short: "HVA Länsi-Uusimaa", url: STT(69818831) },
  vantaa_kerava: { name: "Vantaan ja Keravan hyvinvointialue", short: "HVA Vantaa-Kerava", url: STT(69819818) },
  helsinki: { name: "Helsingin kaupunki, sosiaali-, terveys- ja pelastustoimiala", short: "Helsingin sote", url: STT(60590302) },
  hus: { name: "HUS-yhtymä", short: "HUS", url: STT(23980819) },
  varsinais_suomi: { name: "Varsinais-Suomen hyvinvointialue (Varha)", short: "HVA Varsinais-Suomi", url: STT(69820130) },
  satakunta: { name: "Satakunnan hyvinvointialue", short: "HVA Satakunta", url: "https://satakunnanhyvinvointialue.fi/ajankohtaista/feed/", page: WP_ARTICLE },
  kanta_hame: { name: "Kanta-Hämeen hyvinvointialue (Oma Häme)", short: "HVA Kanta-Häme", url: STT(69820726) },
  pirkanmaa: { name: "Pirkanmaan hyvinvointialue", short: "HVA Pirkanmaa", url: STT(69818823) },
  paijat_hame: { name: "Päijät-Hämeen hyvinvointialue", short: "HVA Päijät-Häme", url: STT(69820870) },
  kymenlaakso: { name: "Kymenlaakson hyvinvointialue", short: "HVA Kymenlaakso", url: STT(69820505) },
  etela_karjala: { name: "Etelä-Karjalan hyvinvointialue", short: "HVA Etelä-Karjala", url: "https://www.ekhva.fi/kategoria/mediatiedotteet/feed/", page: WP_BLOCKS },
  pohjois_savo: { name: "Pohjois-Savon hyvinvointialue", short: "HVA Pohjois-Savo", url: "https://pshyvinvointialue.fi/fi/ajankohtaiset/-/asset_publisher/inTIi74Lb5G8/rss", page: { head: '<div class="pshva_topic-page">', start: ['<div class="pshva_topic-page">', "</h1>"], end: ["</main>"] } },
  etela_savo: { name: "Etelä-Savon hyvinvointialue (Eloisa)", short: "HVA Etelä-Savo", url: "https://etelasavonha.fi/category/uutiset/feed/", page: WP_ARTICLE },
  pohjois_karjala: { name: "Pohjois-Karjalan hyvinvointialue (Siun sote)", short: "HVA Pohjois-Karjala", url: "https://www.siunsote.fi/kategoria/tiedote/feed/", page: WP_BLOCKS },
  keski_suomi: { name: "Keski-Suomen hyvinvointialue", short: "HVA Keski-Suomi", url: STT(69821063) },
  etela_pohjanmaa: { name: "Etelä-Pohjanmaan hyvinvointialue", short: "HVA Etelä-Pohjanmaa", url: "https://www.hyvaep.fi/feed/?post_type=notices", page: { start: ["<div class=wysiwyg-content>"], end: ['<div class="container article-tags">', '<section class="notice-highlights', "</main>"] } },
  pohjanmaa: { name: "Pohjanmaan hyvinvointialue", short: "HVA Pohjanmaa", url: STT(69820565) },
  // Keski-Pohjanmaa (Soite) jätetty pois 12.11.2026, kunnes käyttäjä päättää: soite.fi:n robots.txt kieltää nimetyt tekoälyrobotit (ClaudeBot, GPTBot).
  // keski_pohjanmaa: { name: "Keski-Pohjanmaan hyvinvointialue (Soite)", short: "HVA Keski-Pohjanmaa", url: "https://soite.fi/category/tiedote/feed/", page: { start: ['<div class="main-content-area readspeaker-read'], end: ['<section class="rekai', "Sisältö liittyy seuraaviin", "</article>"] } },
  pohjois_pohjanmaa: { name: "Pohjois-Pohjanmaan hyvinvointialue (Pohde)", short: "HVA Pohjois-Pohjanmaa", url: STT(69817636) },
  kainuu: { name: "Kainuun hyvinvointialue", short: "HVA Kainuu", url: "https://hyvinvointialue.kainuu.fi/ajankohtaista/rss.xml", page: { start: ['<div class="content-body">'], end: ["</article>"] } },
};
for (const [k, f] of Object.entries(HVA_FEEDS)) FEEDS[k] = { ...f, text: true, hva: true };
/** Alueet, joilta ei ole syötettä. */
export const HVA_MISSING = "Keski-Pohjanmaa (sivuston robots.txt kieltää tekoälyrobotit) ja Lappi (ei tiedotesyötettä)";
/** Hyvinvointialueen oma sivusto: isäntänimi -> syötteen avain. */
const HVA_HOSTS = new Map(Object.entries(HVA_FEEDS).filter(([, f]) => f.page).map(([k, f]) => [new URL(f.url).hostname, k]));
const hvaKeyOf = (u) => HVA_HOSTS.get(u.hostname) ?? HVA_HOSTS.get(u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`) ?? null;

const TEXT_HOSTS = new Set(["www.vero.fi", "vero.fi", "www.sttinfo.fi", "sttinfo.fi"]);

function cacheApi() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// STT Infon robots.txt: Crawl-delay 1. Saman isolaatin haut sttinfo.fi:hin vähintään 1 s välein.
let sttNext = 0;
async function polite(url) {
  if (!/(^|\.)sttinfo\.fi$/.test(new URL(url).hostname)) return;
  const now = Date.now();
  const at = Math.max(now, sttNext);
  sttNext = at + 1000;
  if (at > now) await sleep(at - now);
}

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
      await polite(url);
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "fi", Accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.8" } });
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
    // Seurantaparametrit (mtm_) ja Liferayn paluuosoite (redirect) pois linkistä.
    const link = tag(it, "link")?.replace(/[?&](mtm_|redirect=)[^#]*$/, "") ?? null;
    if (!title || !link) continue;
    // STT Infon syötteessä sama tiedote voi toistua; yhdistetään otsikon ja linkin mukaan.
    const k = `${title}|${link.replace(/\?.*$/, "")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const summary = tag(it, "description")?.replace(/<[^>]+>/g, " ").replace(/\s*Source\s*$/, "").replace(/\s+/g, " ").trim() || null;
    out.push({ source: key, title, link, date: isoDate(it), summary });
  }
  return out;
}

export function htmlText(s) {
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
    .map((l) => l.replace(/[\u00ad\u200b]/g, "").replace(/[ \t ]+/g, " ").trim().replace(/\s*\|$/, ""))
    .filter(Boolean)
    .join("\n");
}

/** Rajaa tekstin merkeillä: start-merkit peräkkäin, loppu ensimmäiseen end-merkkiin. */
function cut(html, { start, end }) {
  let i = 0;
  for (const m of start) {
    const j = html.indexOf(m, i);
    if (j < 0) return null;
    i = j + m.length;
  }
  i = html.indexOf(">", i - 1) + 1;
  let e = html.length;
  for (const m of end) {
    const j = html.indexOf(m, i);
    if (j >= 0 && j < e) e = j;
  }
  return { body: html.slice(i, e), at: i };
}

const fiDate = (iso) => {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[3]}.${+m[2]}.${m[1]}` : "";
};

// Yhteyshenkilöiden nimet, puhelinnumerot ja sähköpostit jätetään pois (kuten STT Infon tiedotteista).
// Jokainen Lisätietoja-osio käsitellään, myös tekstin keskellä. Otsikko on lyhyt rivi, joka alkaa
// sanalla Lisätietoja, Lisätiedot, Lisätietoa, Yhteyshenkilöt, Yhteystiedot, Tiedustelut tai
// Tarvittaessa lisätietoja, ja siinä voi olla täydennys ("Lisätietoja medialle:", "Lisätietoa voi kysyä
// myös ryhmän ohjaajilta:") tai nimi samalla rivillä ("Lisätiedot: Nimi"). Otsikon jälkeen poistetaan
// yhteystietorivit (puhelin, sähköposti) ja niitä edeltävät lyhyet nimi- ja tittelirivit (enintään 3).
// Asiarivit (virkkeet, linkit ilman yhteystietoa) jäävät. Otsikko poistetaan vain, jos osiossa oli
// yhteystieto. Organisaation palvelunumerot muualla tekstissä jäävät.
const CONTACT_HEAD = /^(tarvittaessa\s+)?(lisätie|yhteyshenkilö|yhteystied|tiedustelu|haastattelupyyn)/i;
const CONTACT_INFO = /\b0\d{1,3}(?:[\s-]?\d){5,8}\b|\+358|@|\(at\)|\[email protected\]|\bp\.\s*\d|\bpuh\.?\s*\d/i;
const isContactHead = (l) => l.length <= 120 && CONTACT_HEAD.test(l) && !/[.!?]$/.test(l);
// Nimi-, titteli- tai organisaatiorivi: lyhyt eikä virke.
const isPersonLine = (l) => l.length <= 100 && !/[.!?]$/.test(l) && !/https?:\/\//.test(l);
export function dropContacts(text) {
  const lines = text.split("\n");
  const drop = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!isContactHead(lines[i])) continue;
    let pending = [];
    let found = CONTACT_INFO.test(lines[i]);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (CONTACT_INFO.test(l)) {
        for (const k of pending) drop.add(k);
        pending = [];
        drop.add(j);
        found = true;
      } else if (isPersonLine(l) && !isContactHead(l) && pending.length < 3) pending.push(j);
      else break;
    }
    if (found) drop.add(i);
    // Seuraava otsikko voi olla osion jälkeen jääneiden rivien joukossa.
    i = found ? Math.max(i, (pending[0] ?? j) - 1) : i;
  }
  return drop.size ? lines.filter((_, k) => !drop.has(k)).join("\n") : text;
}

/** Hyvinvointialueen oman sivuston tiedotesivu: { title, date, text } tai null. */
function hvaPage(html, page) {
  const c = cut(html, page);
  if (!c) return null;
  const from = page.head ? Math.max(0, html.indexOf(page.head)) : 0;
  const h1m = html.slice(from).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1m ? { 1: h1m[1], index: from + h1m.index } : null;
  const title = htmlText(h1?.[1] ?? "").replace(/\s+/g, " ");
  // Päivä: julkaisuaika metatiedoista, otsikon ja tekstin välistä <time>-elementistä tai päivämäärärivistä,
  // JSON-LD:n datePublished-kentästä tai otsikkoa edeltävästä päivämäärärivistä. Otsikko (h1) ja sitä
  // toistava murupolku ohitetaan ensin, koska otsikossa voi olla muu päivä (esim. "Kurikan akuuttiosasto
  // sulkeutuu 15.11.2026").
  const head = html.slice(h1 ? h1.index : 0, c.at);
  const textDate = (s) =>
    htmlText(s.replace(/<(svg|script|style|h1)\b[\s\S]*?<\/\1>/gi, "")).match(/\b\d{1,2}\.\d{1,2}\.20\d{2}\b/)?.[0] ?? "";
  const date =
    fiDate(head.match(/datetime="([^"]+)"/i)?.[1]) ||
    fiDate(html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i)?.[1]) ||
    textDate(head) ||
    fiDate(html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]) ||
    textDate(html.slice(page.head ? from : Math.max(0, (h1?.index ?? 0) - 1500), c.at));
  const body = c.body.replace(/<!--[\s\S]*?-->/g, "").replace(/<(nav|figure|form|aside)\b[\s\S]*?<\/\1>/gi, "");
  return { title, date, text: dropContacts(htmlText(body)) };
}

/** Tiedotteen teksti (vero.fi, sttinfo.fi ja hyvinvointialueiden omat sivustot). Palauttaa { title, date, text, source } tai null. */
export async function itemText(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hva = u.protocol === "https:" ? hvaKeyOf(u) : null;
  if (u.protocol !== "https:" || (!TEXT_HOSTS.has(u.hostname) && !hva)) return null;
  const key = `${u.href}${u.href.includes("?") ? "&" : "?"}_tiedote=3`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const html = await get(u.href, 0);
  if (!html) return null;
  let out = null;
  if (hva) {
    out = hvaPage(html, HVA_FEEDS[hva].page);
    if (out) out.source = HVA_FEEDS[hva].name;
  } else if (u.hostname.endsWith("vero.fi")) {
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
      const first = lines[0] && /\d{1,2}\.\d{1,2}\.\d{4}/.test(lines[0]) ? lines.shift() : "";
      // Päivärivi on muotoa "12.11.2026 08:30:00 EET | HUS | Tiedote": julkaisija keskellä.
      const parts = first.split("|").map((x) => x.trim());
      out = { title, date: first, text: lines.join("\n"), source: parts.length >= 2 ? parts[1] : null };
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

/** Ohjesivun versiotiedot (Antopäivä, Diaarinumero, Voimassaolo, Korvaa ohjeen ...) pareina [nimi, arvo]. */
function pageVersionMeta(html) {
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
  return meta;
}

// ---------- Haku diaarinumerolla ----------
// Vero.fi:n haku ei indeksoi diaarinumeroa, eikä hakurajapinnassa ole sille parametria
// (12.11.2026: "VH/7418/00.01.00/2025" osui vain sanaan 2025, "7418" antoi 0 osumaa).
// Diaarinumero on vain ohjesivun versiotiedoissa, joten ehdokkaat luetaan sivuilta
// todennäköisimmästä alkaen. Sivusta luetaan vain alku versiotietoihin asti, ja löydetyt
// diaarinumerot tallennetaan yhteen hakemistoon välimuistiin.

/** Diaarinumero, esim. VH/7418/00.01.00/2025 tai vanha muoto A152/200/2012. */
const DIAARI_RE = /^([A-ZÅÄÖ]{1,4})\s*\/?\s*(\d{1,6})\s*\/\s*(\d{1,4}(?:\.\d{1,4}){0,3})\s*\/\s*((?:19|20)\d{2})$/i;
const DIAARI_ANY = /\b[A-ZÅÄÖ]{1,4}\s*\/?\s*\d{1,6}\s*\/\s*\d{1,4}(?:\.\d{1,4}){0,3}\s*\/\s*(?:19|20)\d{2}\b/gi;
const normDiaari = (s) => String(s).replace(/\s+/g, "").toUpperCase();

/** Palauttaa normalisoidun diaarinumeron, jos teksti on pelkkä diaarinumero, muuten null. */
export function asDiaari(text) {
  const m = String(text ?? "").trim().match(DIAARI_RE);
  return m ? normDiaari(m[0]) : null;
}

const DIAARI_INDEX_KEY = `${VERO}/api/search/results?_diaarihakemisto=1`;
const DIAARI_MEM = new Map(); // osoite -> [diaarinumero | null, antopäivä | null, korvatut diaarinumerot[]]

/** Lukee sivun alun, kunnes versiotiedot ovat mukana, ja katkaisee latauksen. */
async function getHead(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "fi", Accept: "text/html" } });
    } catch (e) {
      last = new TiedoteError(`yhteys epäonnistui: ${e?.message ?? e}`, 0);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let html = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
        const pv = html.indexOf('<div class="page-version">');
        if ((pv >= 0 && /page-version__info--summary|<article/.test(html.slice(pv))) || html.length > 400000) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      return html;
    }
    last = new TiedoteError(`palvelin vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(800 * 2 ** attempt);
  }
  throw last;
}

async function pageDiaari(url) {
  const html = await getHead(url);
  if (!html) return [null, null, []];
  const meta = pageVersionMeta(html);
  const val = (re) => meta.find(([k]) => re.test(k))?.[1] ?? null;
  const d = val(/^Diaarinumero$/i);
  return [d ? normDiaari(d) : null, val(/^Antopäivä$/i), (val(/^Korvaa ohjeen$/i)?.match(DIAARI_ANY) ?? []).map(normDiaari)];
}

/** Kaikki hakutulokset tyypeittäin (vero.fi palauttaa enintään 50 sivua kohden). */
async function listAll(types, lang, all) {
  const one = (page) => veroSearch({ query: "", types, lang, sort: 1, page, pageSize: 50, all });
  const first = await one(1);
  const out = [...first.hits];
  const pages = first.hasMore ? Math.min(100, Math.ceil(first.total / 50)) : 1;
  for (let p = 2; p <= pages; p += 8) {
    const rs = await Promise.all(Array.from({ length: Math.min(8, pages - p + 1) }, (_, k) => one(p + k)));
    for (const r of rs) out.push(...r.hits);
  }
  return out;
}

/**
 * Etsii ohjeen diaarinumerolla. Ehdokkaat järjestetään arvioidun antopäivän mukaan
 * (numerot juoksevat vuoden mittaan, n. 8 000 vuodessa); ensin voimassa olevat versiot, sitten
 * korvatut. Yhdellä kutsulla luetaan enintään `budget` uutta sivua.
 * Palauttaa { hit, meta, replacedBy: [{ hit, meta }], checked, complete }; complete = kaikki ehdokkaat käyty läpi.
 */
export async function veroFindDiaari(diaari, { types = [7, 8, 9], lang = "fi", budget = 200 } = {}) {
  const want = normDiaari(diaari);
  const m = want.match(DIAARI_RE);
  const year = Number(m[4]);
  const est = Date.UTC(year, 0, 1) + (Number(m[2]) / 8000) * 365 * 86400000 + 30 * 86400000;
  const stored = await cacheGetJson(DIAARI_INDEX_KEY);
  if (stored) for (const [u, v] of Object.entries(stored)) if (!DIAARI_MEM.has(u)) DIAARI_MEM.set(u, v);
  let fetched = 0;
  let checked = 0;
  let complete = true;
  const replacedBy = [];
  const seen = new Set();
  let found = null;
  for (const all of [false, true]) {
    const cands = (await listAll(types, lang, all)).filter((h) => !seen.has(h.url));
    for (const h of cands) seen.add(h.url);
    const dist = (h) => (h.date ? Math.abs(Date.parse(h.date) - est) : Infinity);
    cands.sort((a, b) => dist(a) - dist(b));
    // Välimuistissa olevat ensin: ne eivät maksa hakua.
    const known = cands.filter((h) => DIAARI_MEM.has(h.url));
    const unknown = cands.filter((h) => !DIAARI_MEM.has(h.url));
    const look = (h) => {
      const v = DIAARI_MEM.get(h.url);
      checked++;
      if (v[0] === want) found = { hit: h, meta: v };
      else if (v[2]?.includes(want) && !replacedBy.some((r) => r.hit.url === h.url)) replacedBy.push({ hit: h, meta: v });
    };
    for (const h of known) {
      look(h);
      if (found) break;
    }
    // Jos voimassa oleva ohje korvaa haetun, haettu on korvattujen versioiden joukossa.
    const skip = () => !all && replacedBy.length > 0;
    for (let i = 0; !found && !skip() && i < unknown.length; i += 8) {
      if (fetched >= budget) {
        complete = false;
        break;
      }
      const batch = unknown.slice(i, i + 8);
      const res = await Promise.allSettled(batch.map((h) => pageDiaari(h.url)));
      batch.forEach((h, k) => {
        fetched++;
        if (res[k].status === "fulfilled") {
          DIAARI_MEM.set(h.url, res[k].value);
          look(h);
        }
      });
    }
    if (found || !complete) break;
  }
  if (fetched) await cachePutJson(DIAARI_INDEX_KEY, Object.fromEntries(DIAARI_MEM), 30 * 86400);
  return { hit: found?.hit ?? null, meta: found?.meta ?? null, replacedBy, checked, complete: !!found || complete };
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
  const meta = pageVersionMeta(html);

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

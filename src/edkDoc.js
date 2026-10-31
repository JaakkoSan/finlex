// Eduskunnan asiakirjat (valiokunnan mietintö ja lausunto, eduskunnan vastaus):
// HTML-esityksen jäsennys kappaleiksi ja hakemistoksi.
//
// Rajapinta (api.eduskunta.fi) palauttaa asiakirjan HTML:nä kahdessa muodossa:
//   - vuodesta 2015 (Vaski): luokat vastaavat XML-elementtejä (KappaleKooste,
//     PerusteluLuku, PykalaViite, Saados, MomenttiKooste, MuutosTeksti …)
//   - vanhemmat (1999–2014): otsikot h2–h6 ja luokat PERUSTE, PYKALA, LA …
// Molemmissa rakenne näkyy otsikoista, joten jäsennys perustuu niihin:
// otsikko aloittaa lohkon, ja lohkon taso määräytyy sisäkkäisistä div-elementeistä
// ja otsikkotasosta. Pykäläkohtaiset perustelut tunnistetaan PykalaViite-kappaleista
// (vanhoissa h6-otsikoista "3 §. Otsikko.") ja muutosehdotusten tai hyväksyttyjen
// lakien pykälät pykälän otsikosta.
//
// Hakemisto tallennetaan välimuistiin osina kuten hallituksen esityksissä:
//   base   tunnistetiedot, lohkot, pykälähakemistot
//   p0..pN kappaleet [{ t, b, k }] (k: "pv" = perusteltava pykälä, "pt" = lakitekstin pykälä)

export const EDK_INDEX_VERSION = 1;

const SHARD_CHARS = 40_000;
const MAX_PARTS = 16;

// Elementit, joiden koko teksti on yksi kappale (sisäkkäiset elementit eivät katkaise).
const ATOMIC_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "caption"]);
const ATOMIC_CLASSES = /(^|\s)(SisennettyKappaleKooste|Toimija|Allekirjoittaja|MomenttiKooste|SaadosKappaleKooste|AjankohtaTeksti|KappaleKooste)(\s|$)/;
// Lohkoelementit, jotka katkaisevat tekstin mutta eivät ole kappaleita.
const BLOCK_TAGS = new Set(["div", "section", "article", "ul", "ol", "table", "tbody", "thead", "tr", "blockquote", "dl", "dd", "dt", "body", "main"]);
const SKIP_TAGS = new Set(["script", "style", "svg", "nav", "head", "noscript", "button"]);
const SKIP_CLASSES = /(^|\s)(sr-only|DocumentBreadCrumbContainer|ViimeksiJulkaistuContainer|akversio)(\s|$)/;
const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "col", "area", "base", "source"]);

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", sect: "§", shy: "", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "„", bull: "•", middot: "·", deg: "°", euro: "€", times: "×" };
const LATIN = "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ";
const LATIN_NAMES = ["Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil", "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml"];
LATIN_NAMES.forEach((n, i) => (ENT[n] ??= LATIN[i]));

export function decodeEntities(s) {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

const clean = (s) => s.replace(/[\s\u00a0]+/g, " ").trim();
const classOf = (attrs) => {
  const i = attrs.indexOf("class=");
  if (i === -1) return "";
  const q = attrs[i + 6];
  if (q !== '"' && q !== "'") return "";
  const j = attrs.indexOf(q, i + 7);
  return j === -1 ? "" : attrs.slice(i + 7, j);
};
const hasClass = (cls, name) => cls !== "" && (" " + cls + " ").includes(" " + name + " ");

// Lakitekstin säiliöt: pykälän otsikko näiden sisällä on lakitekstin pykälä, ei perustelun otsikko.
const LAW_CONTAINER = /(^|\s)(edk-pykala|Pykalisto|PYKALA|SAADOSTEKSTI)(\s|$)/;
// Tekstitason elementit, joilla ei ole merkitystä rakenteelle (avaus ja sulkeminen ohitetaan).
const PLAIN_INLINE = new Set(["a", "b", "i", "em", "strong", "sup", "sub", "u", "small", "font", "abbr", "cite", "q", "s", "mark", "time"]);

/**
 * HTML → kappaleet. Palauttaa [{ t, tag, cls, h, law, container }], jossa h = otsikon taso
 * (1–6) ja law = kappale on lakitekstin säiliössä (pykälän tunnistusta varten).
 *
 * Suorituskyky: suurimmat mietinnöt ovat ~2 Mt, joten silmukka välttää turhia olioita
 * (pelkät tekstitason tagit ohitetaan, span-pino on lukupino) ja säännöllisiä lausekkeita.
 */
function htmlParas(html) {
  const out = [];
  const stack = []; // { tag, kind: "atomic"|"block"|"skip", spans } – spans = span-pinon pituus avattaessa
  const spans = []; // avoimet span-elementit: 0 = tavallinen, 1 = MuutosTeksti, 2 = ohitettava
  let atomic = null; // avoin atominen elementti
  let skip = 0;
  let loose = ""; // lohkon suora teksti ilman atomista elementtiä
  let law = 0; // avoimet lakitekstin säiliöt
  const containers = []; // avoimet lohkosäiliöt (otsikkotasojen laskentaan)

  const flushLoose = () => {
    if (loose === "") return;
    const t = clean(loose);
    loose = "";
    if (t) out.push({ t, tag: "", cls: "", h: 0, law: law > 0, container: null });
  };
  const add = (text) => {
    if (atomic) atomic.buf.push(text);
    else loose += text;
  };
  const closeSpan = () => {
    const v = spans.pop();
    if (v === 2) skip--;
    else if (v === 1) add("»");
    // 3 = atominen span, suljetaan kutsujassa.
  };

  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[5];
    if (text !== undefined) {
      if (skip) continue;
      // Sisennystä tagien välissä: riittää yksi välilyönti.
      if (text.trim() === "") add(" ");
      else add(text.indexOf("&") === -1 ? text : decodeEntities(text));
      continue;
    }
    const name = m[2];
    if (name === undefined) continue; // kommentti
    const tag = name.length <= 2 || name !== name.toLowerCase() ? name.toLowerCase() : name;
    if (PLAIN_INLINE.has(tag)) continue;
    const closing = m[1] === "/";
    if (tag === "span") {
      if (closing) {
        if (spans.length) closeSpan();
        if (atomic && atomic.tag === "span" && spans.length <= atomic.spans) {
          const at = stack.lastIndexOf(atomic);
          stack.length = at;
          finishAtomic(atomic);
        }
        continue;
      }
      const cls = classOf(m[3]);
      if (skip || hasClass(cls, "sr-only")) {
        spans.push(2);
        skip++;
      } else if (hasClass(cls, "MuutosTeksti")) {
        spans.push(1);
        add("«");
      } else if (ATOMIC_CLASSES.test(cls) && !atomic) {
        // Atominen span (esim. SisennettyKappaleKooste): käsitellään kuten kappale.
        flushLoose();
        atomic = { tag: "span", cls, kind: "atomic", buf: [], law: law > 0, container: containers.at(-1) ?? null, spans: spans.length };
        stack.push(atomic);
        spans.push(3);
      } else spans.push(0);
      continue;
    }
    if (!closing) {
      if (VOID_TAGS.has(tag) || m[4] === "/") {
        if (!skip && tag === "br") add(" ");
        continue;
      }
      const cls = m[3] ? classOf(m[3]) : "";
      if (skip || SKIP_TAGS.has(tag) || (cls && SKIP_CLASSES.test(cls))) {
        stack.push({ tag, kind: "skip", spans: spans.length });
        skip++;
        continue;
      }
      if (atomic) {
        // Atomisen elementin sisällä lohkot erotetaan välilyönnillä.
        if (BLOCK_TAGS.has(tag) || ATOMIC_TAGS.has(tag)) atomic.buf.push(" ");
        stack.push({ tag, kind: "inline", spans: spans.length });
        continue;
      }
      if (ATOMIC_TAGS.has(tag) || (cls && ATOMIC_CLASSES.test(cls))) {
        flushLoose();
        atomic = { tag, cls, kind: "atomic", buf: [], law: law > 0, container: containers.at(-1) ?? null, spans: spans.length };
        stack.push(atomic);
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        flushLoose();
        const isLaw = cls !== "" && LAW_CONTAINER.test(cls);
        if (isLaw) law++;
        const e = { tag, kind: "block", hs: [], up: containers.at(-1) ?? null, spans: spans.length, isLaw };
        stack.push(e);
        containers.push(e);
        continue;
      }
      stack.push({ tag, kind: "inline", spans: spans.length });
      continue;
    }
    // Sulkeva tagi: pura pino vastaavaan avaukseen asti (sietää virheellisen HTML:n).
    let k = stack.length - 1;
    while (k >= 0 && stack[k].tag !== tag) k--;
    if (k < 0) continue;
    while (stack.length > k) {
      const e = stack.pop();
      while (spans.length > e.spans) closeSpan();
      if (e.kind === "skip") skip--;
      else if (e.kind === "atomic") finishAtomic(e);
      else if (e.kind === "block") {
        flushLoose();
        containers.pop();
        if (e.isLaw) law--;
      }
    }
  }
  flushLoose();
  return out;

  function finishAtomic(e) {
    const t = clean(e.buf.join(""));
    // ValiotsikkoTeksti on samalla h-tasolla kuin LukuOtsikko mutta sen alaotsikko.
    const h = e.tag.length === 2 && e.tag[0] === "h" ? +e.tag[1] + (hasClass(e.cls, "ValiotsikkoTeksti") ? 0.5 : 0) : 0;
    if (t) out.push({ t, tag: e.tag, cls: e.cls, h, law: e.law, container: e.container });
    atomic = null;
  }
}

// Otsikko, jossa on numero: "1. Laki …", "2.1 Arvio", "3 Yleisperustelut".
const NUM_RE = /^(\d+(?:\.\d+)*\.?)\s+(.*)$/;
const LAW_HEAD = /^(?:(\d+)\s*[.)]?\s*)?(?:Laki|Lag)\b/;

/**
 * Pykälämerkintä otsikon alusta: "51 a §. Otsikko." → "51 a §", "8 (7) §." → "8 §"
 * (suluissa hallituksen esityksen numerointi), "51 a—c, 54, 55, 69 §" → "51 a–c, 54, 55, 69 §",
 * "«27 §» (Uusi)" → "27 §". null, jos otsikko ei ala pykälämerkinnällä.
 */
export function sectionLabel(t) {
  const s = t.replace(/[«»]/g, "");
  const i = s.indexOf("§");
  if (i <= 0) return null;
  let pre = s.slice(0, i).replace(/\(\s*\d+\s*[a-zåäö]?\s*\)/gi, " ");
  if (!/^\s*\d/.test(pre) || !/^[\d\s,a-zåäö–—-]*$/i.test(pre)) return null;
  if (/[a-zåäö]{3,}/i.test(pre.replace(/\bja\b/gi, ""))) return null;
  pre = pre.replace(/\s*[-–—]\s*/g, "–").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim().toLowerCase();
  return `${pre} §`;
}

/** Pykälämerkinnän kohteet: "51 a–c, 54 §" → [{n:51,from:"a",to:"c"}, {n:54}] tai välit {n, to}. */
function labelItems(label) {
  const out = [];
  for (const part of label.replace(/§/, "").split(/,|\bja\b/)) {
    const m = part.trim().match(/^(\d+)\s*([a-zåäö])?(?:\s*–\s*(\d+)?\s*([a-zåäö])?)?$/i);
    if (!m) continue;
    if (m[3]) out.push({ n: +m[1], toN: +m[3] }); // numeroväli 5–7 §
    else if (m[4]) out.push({ n: +m[1], from: m[2] ?? "", to: m[4] }); // kirjainväli 51 a–c §
    else out.push({ n: +m[1], from: m[2] ?? "", to: m[2] ?? "" });
  }
  return out;
}

/**
 * Rakentaa hakemiston asiakirjan HTML:stä.
 * Palauttaa { base, shards } tai null, jos tekstiä ei löytynyt.
 */
export function buildEdkIndex(html, meta = {}) {
  // Uusissa asiakirjoissa sisältö alkaa Vaski-säiliöstä, vanhoissa col-lg-9-säiliöstä.
  let body = html;
  const i2015 = html.indexOf('class="VaskiPage');
  if (i2015 >= 0) body = html.slice(i2015 - 5);
  const raw = htmlParas(body);
  if (!raw.length) return null;

  const legacy = i2015 < 0;
  const paras = [];
  const blocks = [];
  let title = meta.title ?? "";
  let matter = null;
  // Otsikkopino säiliöittäin: säiliön hs = [{ lvl, idx }].
  const depthOf = (idx) => (idx >= 0 ? blocks[idx].depth : 0);

  for (const p of raw) {
    // Vanhojen asiakirjojen alkuosa: h1 (asiakirjan nimi), h5 (tunnus), h2 (nimeke) ennen ensimmäistä lohkoa.
    if (legacy && !blocks.length && (p.h === 1 || p.h === 5 || (p.h === 2 && !/^[A-ZÅÄÖ\s,.-]+$/.test(p.t)))) {
      if (p.h === 2 && !title) title = p.t;
      // "TyVM 3/2001 vp - HE 75/2000 vp": käsitelty asia.
      const am = p.h === 5 ? p.t.match(/[-–]\s*([A-ZÅÄÖ][A-Za-zÅÄÖ]*\s+\d+\/\d{4}\s+vp)/) : null;
      if (am) matter = am[1];
      continue;
    }
    if (!legacy && p.h === 1) continue;
    const inLawText = p.law;
    // Lakitekstin pykälän otsikko (uusi: h5 edk-pykala-säiliössä; vanha: h6 PYKALA-säiliössä).
    if (p.h && inLawText) {
      const l = sectionLabel(p.t);
      if (l) {
        paras.push({ t: p.t, b: blocks.length - 1, k: "pt", l });
        continue;
      }
    }
    // Pykälän perustelun otsikko.
    if (hasClass(p.cls, "PykalaViite") || (legacy && p.h === 6 && !inLawText)) {
      const l = sectionLabel(p.t);
      if (l) {
        paras.push({ t: p.t, b: blocks.length - 1, k: "pv", l });
        continue;
      }
    }
    if (p.h && p.h <= 6) {
      // Otsikkotaso: säiliön otsikkopinosta (tai lähimmästä ylemmästä säiliöstä, jossa on otsikko).
      const c = p.container;
      let parent = -1;
      if (c) {
        while (c.hs.length && c.hs.at(-1).lvl >= p.h) c.hs.pop();
        if (c.hs.length) parent = c.hs.at(-1).idx;
        else {
          // Säiliöllä ei vielä otsikkoa: lohko kuuluu lähimmän ylemmän säiliön viimeisimmän otsikon alle.
          for (let u = c.up; u; u = u.up) {
            if (u.hs.length) {
              parent = u.hs.at(-1).idx;
              break;
            }
          }
        }
      }
      const nm = p.t.match(NUM_RE);
      const idx = blocks.length;
      blocks.push({
        num: nm ? nm[1] : "",
        heading: nm ? nm[2] : p.t,
        depth: depthOf(parent) + 1,
        parent,
        start: paras.length,
        end: 0,
        len: 0,
      });
      if (c) c.hs.push({ lvl: p.h, idx });
      continue;
    }
    paras.push({ t: p.t, b: blocks.length - 1 });
  }

  // Lohkon loppu: seuraava lohko, jonka syvyys on sama tai pienempi.
  for (let i = 0; i < blocks.length; i++) {
    let j = i + 1;
    while (j < blocks.length && blocks[j].depth > blocks[i].depth) j++;
    blocks[i].end = j < blocks.length ? blocks[j].start : paras.length;
  }
  for (const p of paras) if (p.b >= 0) blocks[p.b].len += p.t.length;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].parent >= 0) blocks[blocks[i].parent].len += blocks[i].len;

  // Pykälähakemistot.
  const headOf = (j) => blockLabel(blocks[j]);
  const normTitle = (h) => h.replace(LAW_HEAD, "").replace(/[\s.]+/g, " ").trim().toLowerCase();
  // Numeroimattoman lakiotsikon numero toisesta saman nimisestä otsikosta (vanhoissa asiakirjoissa
  // perusteluissa "Laki …", muutosehdotuksissa "1. Laki …").
  const lawNums = new Map();
  for (let j = 0; j < blocks.length; j++) {
    const lm = headOf(j).match(LAW_HEAD);
    if (lm && lm[1]) lawNums.set(normTitle(headOf(j)), +lm[1]);
  }
  const lawOf = (bi) => {
    for (let j = bi; j >= 0; j = blocks[j].parent) {
      const lm = headOf(j).match(LAW_HEAD);
      if (lm) return lm[1] ? +lm[1] : (lawNums.get(normTitle(headOf(j))) ?? null);
    }
    return null;
  };
  // Vastalauseen numero (1, 2 …), jos kohta on vastalauseessa.
  const dissentOf = (bi) => {
    for (let j = bi; j >= 0; j = blocks[j].parent) {
      const vm = blocks[j].heading.match(/^vastalause\s*(\d+)?/i);
      if (vm) return vm[1] ? +vm[1] : 1;
    }
    return 0;
  };
  // Luku, jos pykälä on luvun alla (esim. "3 luku. Rikosoikeudellisen …" → "3", "48 a luku" → "48 a").
  const chapterOf = (bi) => {
    for (let j = bi; j >= 0; j = blocks[j].parent) {
      if (LAW_HEAD.test(headOf(j))) return null;
      const cm = blockLabel(blocks[j]).match(/^(\d+\s*[a-zåäö]?)\s*\.?\s*luku\b/i);
      if (cm) return cm[1].replace(/\s+/g, " ").trim().toLowerCase();
    }
    return null;
  };
  const rationale = [];
  const sections = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (!p.k) continue;
    let j = i + 1;
    while (j < paras.length && !paras[j].k && paras[j].b === p.b) j++;
    const entry = { l: p.l, s: i, e: j, b: p.b, law: lawOf(p.b) };
    const ch = chapterOf(p.b);
    if (ch) entry.ch = ch;
    const vl = dissentOf(p.b);
    if (vl) entry.vl = vl;
    (p.k === "pv" ? rationale : sections).push(entry);
    delete p.l;
  }
  // Lait, joiden pykäliä muutosehdotuksissa tai hyväksytyissä laeissa on (ylimmät lakiotsikot).
  const withSections = new Set();
  for (const sec of sections) {
    if (sec.vl) continue;
    for (let j = sec.b; j >= 0 && !withSections.has(j); j = blocks[j].parent) withSections.add(j);
  }
  const laws = [];
  for (let i = 0; i < blocks.length; i++) if (withSections.has(i) && LAW_HEAD.test(headOf(i))) laws.push(i);

  const { starts, parts } = pack(paras);
  const base = {
    v: EDK_INDEX_VERSION,
    format: legacy ? "html" : "vaski",
    title,
    matter,
    blocks,
    nParas: paras.length,
    shardStarts: starts,
    rationale,
    sections,
    laws,
    marks: paras.some((p) => p.t.includes("«")),
  };
  return { base, shards: parts };
}

function isAncestor(blocks, a, i) {
  for (let j = i; j >= 0; j = blocks[j].parent) if (j === a) return true;
  return false;
}

function pack(items) {
  const starts = [0];
  const parts = [[]];
  let n = 0;
  for (const it of items) {
    if (n >= SHARD_CHARS && parts.length < MAX_PARTS) {
      starts.push(starts.at(-1) + parts.at(-1).length);
      parts.push([]);
      n = 0;
    }
    parts.at(-1).push(it);
    n += it.t.length;
  }
  return { starts, parts };
}

// ---------- Haut hakemistosta ----------

export function partOf(starts, i) {
  let k = 0;
  while (k + 1 < starts.length && starts[k + 1] <= i) k++;
  return k;
}

export function shardsFor(base, start, end) {
  const out = [];
  for (let s = 0; s < base.shardStarts.length; s++) {
    const a = base.shardStarts[s];
    const b = s + 1 < base.shardStarts.length ? base.shardStarts[s + 1] : base.nParas;
    if (a < end && b > start) out.push(s);
  }
  return out;
}

export const blockLabel = (b) => [b.num, b.heading].filter(Boolean).join(" ") || "(otsikoton lohko)";

export function blockPath(base, i) {
  const parts = [];
  for (let j = i; j >= 0; j = base.blocks[j].parent) parts.unshift(blockLabel(base.blocks[j]));
  return parts.join(" > ");
}

export function descendants(base, i) {
  const out = [];
  for (let j = i + 1; j < base.blocks.length && base.blocks[j].depth > base.blocks[i].depth; j++) out.push(j);
  return out;
}

/** Lohkot numerolla, otsikolla tai tunnisteella "#n". */
export function findBlocks(base, osa) {
  const q = String(osa ?? "").trim();
  const m = q.match(/^#(\d+)$/);
  if (m) return base.blocks[+m[1]] ? [+m[1]] : [];
  const norm = (s) => String(s).replace(/\.$/, "").replace(/\s+/g, "").toLowerCase();
  const byNum = base.blocks.map((b, i) => (b.num && norm(b.num) === norm(q) ? i : -1)).filter((i) => i >= 0);
  if (byNum.length) return byNum;
  const ql = q.toLowerCase();
  const exact = base.blocks.map((b, i) => (b.heading.toLowerCase() === ql ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact;
  return base.blocks.map((b, i) => (b.heading.toLowerCase().includes(ql) ? i : -1)).filter((i) => i >= 0);
}

/** Pykälän tunniste vertailumuotoon: "12a" → { n: 12, letter: "a" }. */
export function parseSection(s) {
  const m = String(s ?? "").replace(/§/g, "").trim().match(/^(\d+)\s*([a-zåäö])?$/i);
  return m ? { n: +m[1], letter: (m[2] ?? "").toLowerCase() } : null;
}

/** Osuuko hakemiston merkintä ("51 a §", "1–3 §", "1 ja 2 §", "51 a–c, 54 §") haettuun pykälään. */
export function labelMatches(label, want) {
  for (const it of labelItems(label)) {
    if (it.toN !== undefined) {
      if (want.n >= it.n && want.n <= it.toN) return true;
    } else if (it.n === want.n) {
      if (it.from === it.to ? it.from === want.letter : want.letter >= it.from && want.letter <= it.to) return true;
    }
  }
  return false;
}

/**
 * Ratkaisuosan lohko: mietinnön päätösehdotus, lausunnon päätösesitys (vanhoissa lausunnoissa
 * viimeinen ylimmän tason "Lausunto"-lohko) tai eduskunnan vastauksen "Päätös". -1, jos ei löydy.
 */
export function decisionBlock(base) {
  const i = base.blocks.findIndex((b) => /päätösehdotus|päätösesitys|beslutsförslag|^päätös$/i.test(b.heading));
  if (i >= 0) return i;
  for (let j = base.blocks.length - 1; j >= 0; j--) if (base.blocks[j].depth === 1 && /^lausunto$/i.test(base.blocks[j].heading)) return j;
  return -1;
}

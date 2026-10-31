// Säädöksen valmiiksi jäsennetty hakemisto.
//
// XML:n jäsentäminen on Workersin ilmaistason CPU-rajaan (10 ms) nähden raskasta:
// suuren lain jäsennys vie kylmässä isolaatissa 30–60 ms. Siksi säädös jäsennetään
// kerran, ja välimuistiin tallennetaan tästä muodostettu JSON-hakemisto. JSON.parse
// on natiivia koodia, mutta sekin vie noin 6–7 ms megatavua kohden, joten hakemisto
// on jaettu osiin ja kukin työkalu lukee vain tarvitsemansa:
//   base   metatiedot, sisällysluettelo, luvut ja pykälien tunnistetiedot (pieni)
//   texts  pykälien teksti hakua varten
//   shards muotoillut pykäläryhmät, jaettuna osiin pykälänumeron mukaan
//
// Muotoiltu teksti sisältää aikaan sidotut merkinnät merkkeinä; ne korvataan
// pyynnön hetkellä funktiolla finalize() (ks. statute.js).

import { findAll, elements, textOf } from "./xml.js";
import { metadata, normNum, render, renderGroup, tableOfContents, provisionsRoot, numOf, headingOf } from "./statute.js";

/** Kasvata, kun hakemiston rakenne muuttuu (vanhat välimuistiavaimet ohitetaan). */
export const INDEX_VERSION = 1;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tavoitekoko yhdelle pykäläryhmien osalle (merkkiä) ja osien enimmäismäärä. */
const SHARD_CHARS = 40_000;
const MAX_SHARDS = 12;

/** Osa, johon pykälänumero (normNum) kuuluu. */
export function shardOf(key, n) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h % n;
}

/**
 * Muodostaa hakemiston jäsennetystä säädöksestä (parseStatute).
 * Palauttaa { base, texts, shards }.
 */
export function buildIndex(doc) {
  const rootEl = provisionsRoot(doc.act);
  const base = { v: INDEX_VERSION, meta: metadata(doc), toc: tableOfContents(doc), chapters: [], secs: [], n: 1 };
  const idx = { base, texts: [], shards: [[]] };
  if (!rootEl) return idx;

  const chapNodes = findAll(rootEl, "chapter");
  const chapIdx = new Map(chapNodes.map((c, i) => [c, i]));
  base.chapters = chapNodes.map((c) => ({ n: numOf(c), k: normNum(numOf(c)), l: [numOf(c), headingOf(c)].filter(Boolean).join(" ") }));

  const chapterChain = (node) => {
    const out = [];
    for (let p = node.parent; p; p = p.parent) if (p.name === "chapter" && chapIdx.has(p)) out.push(chapIdx.get(p));
    return out;
  };

  const all = findAll(rootEl, "section", [], true);
  const secNo = new Map(all.map((s, i) => [s, i]));
  for (const sec of all) {
    const chain = chapterChain(sec);
    base.secs.push({
      n: numOf(sec),
      h: headingOf(sec),
      vl: sec.attrs["finlex:originalVersionLabel"] ?? null,
      c: chain.length ? chain[0] : -1,
      cs: chain,
    });
    idx.texts.push(textOf(sec));
  }

  // Pykäläryhmät kuten statute.findSections: peräkkäiset sisarukset, joissa sama
  // pykälä ja siihen liittyvät huomautukset. Ryhmän jäsenyys riippuu vain pykälän
  // omasta numerosta, joten ryhmät voidaan muodostaa etukäteen kaikille numeroille.
  const groups = [];
  const used = new Set();
  for (const sec of all) {
    if (used.has(sec)) continue;
    const key = normNum(numOf(sec));
    const sibs = elements(sec.parent);
    const run = [sec];
    used.add(sec);
    for (let j = sibs.indexOf(sec) + 1; j < sibs.length; j++) {
      const s = sibs[j];
      if (s.name === "hcontainer" && s.attrs.name === "noteAuthorial") run.push(s);
      else if (s.name === "section" && normNum(numOf(s)) === key) {
        run.push(s);
        used.add(s);
      } else break;
    }
    while (run.length > 1 && run[run.length - 1].name === "hcontainer") {
      const t = textOf(run[run.length - 1]);
      if (new RegExp(`\\b${escapeRe(numOf(sec).replace(/\s*§/, ""))}\\s*§`).test(t)) break;
      run.pop();
    }
    const s = base.secs[secNo.get(sec)];
    const lines = render(sec, 0);
    groups.push({ k: key, c: s.c, h1: lines[0] ?? "", r: renderGroup({ chapter: s.c >= 0 ? chapNodes[s.c] : null, nodes: run }, { node: sec, lines }) });
  }

  // Saman numeron ryhmät päätyvät samaan osaan ja säilyttävät keskinäisen järjestyksensä.
  const chars = groups.reduce((a, g) => a + g.r.length, 0);
  base.n = Math.min(MAX_SHARDS, Math.max(1, Math.ceil(chars / SHARD_CHARS)));
  idx.shards = Array.from({ length: base.n }, () => []);
  for (const g of groups) idx.shards[shardOf(g.k, base.n)].push(g);
  return idx;
}

/** Lukujen muotoiltu teksti (erillinen välimuistiavain: tarvitaan harvoin). */
export function buildChapters(doc) {
  const rootEl = provisionsRoot(doc.act);
  if (!rootEl) return [];
  return findAll(rootEl, "chapter").map((c) => render(c, 0).join("\n"));
}

// ---------- Haut hakemistosta ----------

const wantChapter = (luku) => (luku != null && luku !== "" ? normNum(luku) : null);

/** Pykäläryhmät numerolle. shard = shards[shardOf(normNum(pykala), base.n)]. */
export function findGroups(base, shard, pykala, luku) {
  const wantS = normNum(pykala);
  const wantC = wantChapter(luku);
  return shard.filter((g) => g.k === wantS && (wantC === null || (g.c >= 0 && base.chapters[g.c].k === wantC)));
}

export function chapterIndex(base, luku) {
  const want = normNum(luku);
  return base.chapters.findIndex((c) => c.k === want);
}

export function sectionNumbers(base, luku) {
  let secs = base.secs;
  if (luku) {
    const ci = chapterIndex(base, luku);
    if (ci !== -1) secs = secs.filter((s) => s.cs.includes(ci));
  }
  return [...new Set(secs.map((s) => s.n))];
}

export function searchIndex(base, texts, query, maxHits = 30) {
  const q = query.toLowerCase();
  const hits = [];
  for (let j = 0; j < base.secs.length; j++) {
    const s = base.secs[j];
    const t = texts[j];
    const i = t.toLowerCase().indexOf(q);
    if (i === -1) continue;
    const start = Math.max(0, i - 120);
    hits.push({
      chapter: s.c >= 0 ? base.chapters[s.c].n : null,
      section: s.n,
      heading: s.h,
      versionLabel: s.vl,
      snippet: (start > 0 ? "…" : "") + t.slice(start, i + q.length + 160) + "…",
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

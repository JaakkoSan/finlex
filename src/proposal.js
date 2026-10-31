// Hallituksen esitykset (Finlexin avoin data, /akn/fi/doc/government-proposal).
//
// Esitys jäsennetään kerran hakemistoksi, joka tallennetaan välimuistiin osina
// (ks. statuteIndex.js:n perustelut):
//   base     tunnistetiedot, pääasiallinen sisältö, perustelujen lohkot,
//            lakiehdotusten ja liitteiden nimet
//   p0..pN   perustelujen kappaleet järjestyksessä, jaettuna osiin
//   b0..bN   lakiehdotusten muotoiltu teksti (useampi lakiehdotus samassa osassa)
//   a0..aN   liitteiden muotoiltu teksti
// Osien määrä on rajattu, koska jokainen välimuistiin tallennus on alipyyntö
// (ilmaistasolla enintään 50 kutsua kohden).

import { find, findAll, child, elements, textOf } from "./xml.js";
import { render, tableText } from "./statute.js";

export const PROPOSAL_INDEX_VERSION = 1;

const SHARD_CHARS = 40_000;
const MAX_PARA_PARTS = 16;
const MAX_BILL_PARTS = 8;
const MAX_ATTACHMENT_PARTS = 4;

/**
 * Jakaa listan peräkkäisiin osiin (enintään maxParts, tavoitekoko SHARD_CHARS).
 * Palauttaa { starts, parts }: osa k sisältää alkiot starts[k]..starts[k+1]-1.
 */
function pack(items, size, maxParts) {
  const starts = [0];
  const parts = [[]];
  let n = 0;
  for (const it of items) {
    if (n >= SHARD_CHARS && parts.length < maxParts) {
      starts.push(starts.at(-1) + parts.at(-1).length);
      parts.push([]);
      n = 0;
    }
    parts.at(-1).push(it);
    n += size(it);
  }
  return { starts, parts };
}

/** Osa, jossa alkio i on (starts kuten pack()). */
export function partOf(starts, i) {
  let k = 0;
  while (k + 1 < starts.length && starts[k + 1] <= i) k++;
  return k;
}

const hc = (node, name) => (node ? findAll(node, "hcontainer").find((h) => h.attrs.name === name) ?? null : null);
const labelOf = (node) =>
  [child(node, "num"), child(node, "heading")]
    .filter(Boolean)
    .map((n) => textOf(n))
    .filter(Boolean)
    .join(" ");

/** Lohkon numeron vertailumuoto: "2.1." ja "2.1" ovat sama. */
export const normBlockNum = (s) => String(s ?? "").trim().replace(/\.$/, "").replace(/\s+/g, "").toLowerCase();

function paragraphText(el) {
  if (el.name === "table") return tableText(el);
  return textOf(el);
}

/** Lakiehdotuksen tai liitteen teksti: johtolause, pykälät ja voimaantulo. */
function renderBill(bill) {
  const lines = [];
  const intro = hc(bill, "enactingClause");
  if (intro) lines.push(textOf(intro), "");
  const wrapper = hc(bill, "statuteProvisionsWrapper");
  if (wrapper) {
    for (const el of elements(wrapper)) lines.push(...render(el, 0));
  }
  const eif = hc(bill, "entryIntoForce");
  if (eif && textOf(eif)) lines.push("", textOf(eif));
  if (!wrapper && !intro) lines.push(textOf(bill));
  return lines.join("\n").trim();
}

/** Muodostaa hakemiston esityksen XML:n jäsennetystä puusta. Palauttaa { base, shards, billParts, attachmentParts } tai null. */
export function buildProposalIndex(root) {
  const doc = find(root, "doc");
  if (!doc) return null;
  const meta = child(doc, "meta");
  const work = meta ? find(meta, "FRBRWork") : null;
  const dateIssued = work ? (elements(work).find((e) => e.name === "FRBRdate" && e.attrs.name === "dateIssued")?.attrs.date ?? null) : null;
  const branch = meta ? find(meta, "finlex:administrativeBranch")?.attrs.refersTo?.replace(/^#/, "") : null;
  const ministry = branch && meta ? (findAll(meta, "TLCOrganization").find((o) => o.attrs.eId === branch)?.attrs.showAs ?? null) : null;
  const preface = child(doc, "preface");
  const body = child(doc, "mainBody") ?? doc;

  const base = {
    v: PROPOSAL_INDEX_VERSION,
    docNumber: preface ? textOf(find(preface, "docNumber")) : "",
    title: preface ? textOf(find(preface, "docTitle")) : "",
    dateIssued,
    ministry,
    intro: "",
    blocks: [],
    nParas: 0,
    shardStarts: [0],
    bills: [],
    billStarts: [0],
    attachments: [],
    attachmentStarts: [0],
  };

  // Osasta esityksistä (esim. ruotsinkieliset) avoimessa datassa on vain otsikko.
  base.absent = !!hc(body, "contentAbsent");

  const intro = hc(body, "introduction");
  if (intro) {
    base.intro = findAll(intro, "p")
      .map((p) => textOf(p))
      .filter(Boolean)
      .join("\n\n");
  }

  // Perustelut: lohkot esijärjestyksessä ja kappaleet yhtenä listana. Lohkon
  // kappaleet (myös alalohkojen) ovat välillä [start, end).
  const paras = [];
  const walk = (node, depth, parent) => {
    for (const el of elements(node)) {
      if (el.name === "tblock") {
        const idx = base.blocks.length;
        const b = { num: textOf(child(el, "num") ?? { children: [] }), heading: textOf(child(el, "heading") ?? { children: [] }), depth, parent, start: paras.length, end: 0 };
        base.blocks.push(b);
        walk(el, depth + 1, idx);
        b.end = paras.length;
      } else if (el.name === "num" || el.name === "heading") {
        // Lohkon otsikko on jo b.num/b.heading; perusteluosan oma otsikko
        // ("PERUSTELUT") ei ole kappale.
        continue;
      } else if (el.name === "content" || el.name === "hcontainer") {
        walk(el, depth, parent);
      } else {
        const t = paragraphText(el);
        if (t) paras.push({ t, b: parent });
      }
    }
  };
  const rationale = hc(body, "rationale");
  if (rationale) walk(rationale, 0, -1);
  base.nParas = paras.length;
  const prefix = [0];
  for (const p of paras) prefix.push(prefix.at(-1) + p.t.length);
  for (const b of base.blocks) b.len = prefix[b.end] - prefix[b.start];

  const ps = pack(paras, (p) => p.t.length, MAX_PARA_PARTS);
  base.shardStarts = ps.starts;
  base.rationaleIndex = buildRationaleIndex(base, (i) => paras[i]);

  const billsNode = hc(body, "bills");
  const bills = billsNode ? elements(billsNode).filter((e) => e.name === "hcontainer" && e.attrs.name === "bill") : [];
  // Lakiehdotuksen nimi ilman järjestysnumeroa (numero näytetään erikseen).
  base.bills = bills.map((b) => textOf(child(b, "heading") ?? { children: [] }) || labelOf(b));
  const attNode = hc(body, "attachments");
  const atts = attNode ? findAll(attNode, "hcontainer").filter((h) => h.attrs.name === "attachment") : [];
  base.attachments = atts.map((a) => labelOf(a) || labelOf(findAll(a, "hcontainer").find((h) => h.attrs.name === "bill") ?? a) || "Liite");

  const billTexts = bills.map(renderBill);
  const attTexts = atts.map((a) => {
    const bill = findAll(a, "hcontainer").find((h) => h.attrs.name === "bill");
    return bill ? renderBill(bill) : elements(a).map((e) => textOf(e)).filter(Boolean).join("\n\n");
  });
  const bp = pack(billTexts, (t) => t.length, MAX_BILL_PARTS);
  const ap = pack(attTexts, (t) => t.length, MAX_ATTACHMENT_PARTS);
  base.billStarts = bp.starts;
  base.attachmentStarts = ap.starts;
  return { base, shards: ps.parts, billParts: billTexts.length ? bp.parts : [], attachmentParts: attTexts.length ? ap.parts : [] };
}

// ---------- Haut hakemistosta ----------

/** Lohkon ja sen alalohkojen indeksit (esijärjestys: jälkeläiset ovat peräkkäin). */
export function descendants(base, i) {
  const out = [];
  for (let j = i + 1; j < base.blocks.length && base.blocks[j].depth > base.blocks[i].depth; j++) out.push(j);
  return out;
}

/** Osien numerot, jotka kattavat kappalevälin [start, end). */
export function shardsFor(base, start, end) {
  const out = [];
  for (let s = 0; s < base.shardStarts.length; s++) {
    const a = base.shardStarts[s];
    const b = s + 1 < base.shardStarts.length ? base.shardStarts[s + 1] : base.nParas;
    if (a < end && b > start) out.push(s);
  }
  return out;
}

/** Lohkon polku otsikkoina, esim. "7 Säännöskohtaiset perustelut > 7.1 Laki …". */
export function blockPath(base, i) {
  const parts = [];
  for (let j = i; j >= 0; j = base.blocks[j].parent) parts.unshift([base.blocks[j].num, base.blocks[j].heading].filter(Boolean).join(" "));
  return parts.join(" > ");
}

/** Etsii lohkot numerolla, otsikolla tai tunnisteella "#n". */
export function findBlocks(base, osa) {
  const q = String(osa ?? "").trim();
  const m = q.match(/^#(\d+)$/);
  if (m) return base.blocks[+m[1]] ? [+m[1]] : [];
  const wantNum = normBlockNum(q);
  const byNum = base.blocks.map((b, i) => (b.num && normBlockNum(b.num) === wantNum ? i : -1)).filter((i) => i >= 0);
  if (byNum.length) return byNum;
  const ql = q.toLowerCase();
  const exact = base.blocks.map((b, i) => (b.heading.toLowerCase() === ql ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact;
  return base.blocks.map((b, i) => (b.heading.toLowerCase().includes(ql) ? i : -1)).filter((i) => i >= 0);
}

const SK_RE = /säännöskohtaiset perustelut|yksityiskohtaiset perustelut|detaljmotivering|specialmotivering/i;

/** Säännöskohtaisten perustelujen lohkot (ylin osuva lohko, ei sen alalohkoja). */
export function detailBlocks(base) {
  const out = [];
  base.blocks.forEach((b, i) => {
    if (SK_RE.test(b.heading) && !out.some((o) => isAncestor(base, o, i))) out.push(i);
  });
  return out;
}

function isAncestor(base, a, i) {
  for (let j = base.blocks[i].parent; j >= 0; j = base.blocks[j].parent) if (j === a) return true;
  return false;
}

// Pykälän perustelujen alku: "3 §.", "12 a §.", "5–7 §." (kappaleen alussa).
// Sopimusten hyväksymistä koskevissa esityksissä perustellaan artikloittain: "3 artikla.".
const SEC_START = /^(\d+)(?:\s*([a-zåäö]))?(?:\s*[-–—―]\s*(\d+)(?:\s*[a-zåäö])?)?\s*§\s*\./i;
const ART_START = /^(\d+)(?:\s*([a-zåäö]))?(?:\s*[-–—―]\s*(\d+)(?:\s*[a-zåäö])?)?\s*artikla\s*\./i;
const CHAPTER_START = /^\d+\s*[a-zåäö]?\s*(?:luku|kap\.)\s*[.:]/i;
const isStart = (t) => SEC_START.test(t) || ART_START.test(t);

/** Perusteluissa käsitellyt pykälät ja artiklat kappaleen alusta, esim. "12 a §" tai "3 artikla". */
export function startLabel(t) {
  const m = t.match(/^(\d+(?:\s*[a-zåäö])?(?:\s*[-–—―]\s*\d+(?:\s*[a-zåäö])?)?)\s*(§|artikla)\s*\./i);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null;
}

function parsePykala(s) {
  const raw = String(s ?? "").trim();
  const art = /artikla/i.test(raw);
  const m = raw.replace(/§|artikla/gi, "").trim().match(/^(\d+)\s*([a-zåäö])?$/i);
  return m ? { n: +m[1], letter: (m[2] ?? "").toLowerCase(), art } : null;
}

/**
 * Säännöskohtaisten perustelujen hakemisto: jokaisen pykälän tai artiklan perustelun
 * kappaleväli [s, e) ja lohko b. Perustelu päättyy seuraavan pykälän tai luvun
 * alkuun tai lohkon (esim. seuraavan lakiehdotuksen) vaihtumiseen.
 */
function buildRationaleIndex(base, paraAt) {
  const out = [];
  for (const d of detailBlocks(base)) {
    const { start, end } = base.blocks[d];
    for (let i = start; i < end; i++) {
      const p = paraAt(i);
      const label = startLabel(p.t);
      if (!label) continue;
      let j = i + 1;
      while (j < end) {
        const q = paraAt(j);
        if (q.b !== p.b || isStart(q.t) || CHAPTER_START.test(q.t)) break;
        j++;
      }
      out.push({ l: label, s: i, e: j, b: p.b });
      i = j - 1;
    }
  }
  return out;
}

function labelMatches(label, want) {
  const m = label.match(/^(\d+)(?:\s*([a-zåäö]))?(?:\s*[-–—―]\s*(\d+)(?:\s*[a-zåäö])?)?\s*(§|artikla)$/i);
  if (!m || (m[4].toLowerCase() === "artikla") !== want.art) return false;
  if (m[3]) return want.n >= +m[1] && want.n <= +m[3];
  return +m[1] === want.n && (m[2] ?? "").toLowerCase() === want.letter;
}

/** Pykälän tai artiklan perustelujen kappalevälit hakemistosta. null = virheellinen pykälä. */
export function findRationale(base, pykala, maxHits = 5) {
  const want = parsePykala(pykala);
  if (!want) return null;
  return base.rationaleIndex.filter((r) => labelMatches(r.l, want)).slice(0, maxHits);
}

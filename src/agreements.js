// Yleissitovat työehtosopimukset ja viranomaisten määräykset Finlexin avoimesta datasta.
//
// Työehtosopimukset: aineistotyyppi collective-agreement-general-applicability-decision
// (työehtosopimuksen yleissitovuuden vahvistamislautakunnan päätökset). Päätöksen metatiedoissa
// ovat sopijaosapuolet ja sopimusversiot voimassaoloaikoineen; itse sopimukset ovat PDF-liitteitä.
// Viranomaisten määräykset: aineistotyyppi authority-regulation, teksti PDF:nä (main.pdf).

import { API_BASE, fetchText, fetchBytes, fetchListPage, walkList, cacheGetJson, cachePutJson } from "./finlex.js";
import { parseXml, find, findAll, child, childrenNamed, textOf } from "./xml.js";

export const TES_TYPE = "collective-agreement-general-applicability-decision";
const TES_BASE = `${API_BASE}/akn/fi/doc/${TES_TYPE}`;
const REG_BASE = `${API_BASE}/akn/fi/doc/authority-regulation`;
const CATALOG_V = 1;
const CATALOG_TTL = 86400;

export const tesUrl = (y, n) => `${TES_BASE}/${y}/${n}/fin@`;
export const tesWebUrl = (y, n) => `https://www.finlex.fi/fi/viranomaiset/tyoehtosopimukset/${y}/${n}`;
export const tesFileUrl = (y, n, ref) => `${tesUrl(y, n)}/${String(ref).replace(/^\.?\//, "")}`;

const proprietary = (root) => {
  const meta = find(root, "meta");
  return meta ? child(meta, "proprietary") : null;
};
const dateAttr = (el) => (el ? el.attrs.date ?? null : null);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Yleissitovuuspäätöksen metatiedot ja rungon kappaleet. */
export function parseTes(xml) {
  const root = parseXml(xml);
  const prop = proprietary(root);
  if (!prop) return null;
  const versions = [];
  const list = child(prop, "finlex:collectiveAgreements");
  for (const ca of list ? childrenNamed(list, "finlex:collectiveAgreement") : []) {
    const ref = child(ca, "finlex:ref");
    versions.push({
      a: dateAttr(child(ca, "finlex:dateEntryIntoForce")),
      l: dateAttr(child(ca, "finlex:dateInForceEnd")),
      t: norm(textOf(child(ca, "finlex:title"))) || "Työehtosopimus",
      f: ref?.attrs?.href ?? null,
    });
  }
  const uni = child(prop, "finlex:isUniversallyApplicable");
  const body = find(root, "mainBody");
  const paras = body ? findAll(body, "p").map((p) => norm(textOf(p))).filter(Boolean) : [];
  return {
    title: norm(textOf(find(root, "docTitle"))) || null,
    employer: norm(textOf(child(prop, "finlex:agreementPartyEmployer"))) || null,
    employee: norm(textOf(child(prop, "finlex:agreementPartyEmployee"))) || null,
    uni: uni ? uni.attrs.value === "true" : null,
    signed: dateAttr(child(prop, "finlex:dateSigned")),
    start: dateAttr(child(prop, "finlex:dateEntryIntoForce")),
    end: dateAttr(child(prop, "finlex:dateInForceEnd")),
    versions,
    paras,
  };
}

async function listAll(base) {
  const pages = await walkList(`${base}/list?format=json&limit=10&langAndVersion=fin@`, 100, { ttl: CATALOG_TTL });
  return pages.flat().map((x) => x.akn_uri);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

let catalogMemo = null;

/**
 * Kaikkien yleissitovuuspäätösten luettelo (n. 200). Muodostetaan listauksesta ja päätösten
 * metatiedoista, välimuistissa vuorokauden.
 */
export async function tesCatalog() {
  if (catalogMemo && catalogMemo.exp > Date.now()) return catalogMemo.value;
  const key = `${TES_BASE}/list?_catalog=${CATALOG_V}`;
  let value = await cacheGetJson(key);
  if (!value) {
    const uris = await listAll(TES_BASE);
    const ids = [];
    const seen = new Set();
    for (const u of uris) {
      const m = String(u).match(/decision\/(\d{4})\/([^/]+)\/fin@/);
      if (m && !seen.has(`${m[1]}/${m[2]}`)) {
        seen.add(`${m[1]}/${m[2]}`);
        ids.push({ y: +m[1], n: m[2] });
      }
    }
    const docs = await mapLimit(ids, 12, async ({ y, n }) => {
      const xml = await fetchText(tesUrl(y, n), { ttl: CATALOG_TTL });
      const d = xml ? parseTes(xml) : null;
      if (!d) return null;
      const { paras, ...rest } = d;
      return { y, n, ...rest };
    });
    value = docs.filter(Boolean);
    if (value.length) await cachePutJson(key, value, CATALOG_TTL);
  }
  catalogMemo = { value, exp: Date.now() + 3600_000 };
  return value;
}

export async function tesDoc(y, n) {
  const xml = await fetchText(tesUrl(y, n), { ttl: CATALOG_TTL });
  return xml ? parseTes(xml) : null;
}

// ---------- Viranomaisten määräykset ----------

export const regUrl = (authority, y, n) => `${REG_BASE}/${authority}/${y}/${n}/fin@`;

export function regListUrl(params) {
  const q = new URLSearchParams({ format: "json", limit: "10", langAndVersion: "fin@" });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  return `${REG_BASE}/list?${q.toString()}`;
}

/** akn_uri → { authority, y, n } */
export function regIdOf(uri) {
  const m = String(uri).match(/authority-regulation\/([^/]+)\/(\d{4})\/([^/]+)\/fin@/);
  return m ? { authority: m[1], y: +m[2], n: m[3] } : null;
}

export async function regList(params, page = 1) {
  const arr = await fetchListPage(regListUrl(params), page, { ttl: 6 * 3600 });
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const id = regIdOf(x.akn_uri);
    if (id && !seen.has(`${id.authority}/${id.y}/${id.n}`)) {
      seen.add(`${id.authority}/${id.y}/${id.n}`);
      out.push(id);
    }
  }
  return { ids: out, full: arr.length >= 10 };
}

export function parseReg(xml) {
  const root = parseXml(xml);
  const meta = find(root, "meta");
  if (!meta) return null;
  const work = find(meta, "FRBRWork");
  const orgs = new Map(findAll(meta, "TLCOrganization").map((o) => [`#${o.attrs.eId}`, o.attrs.showAs]));
  const concepts = new Map(findAll(meta, "TLCConcept").map((c) => [`#${c.attrs.eId}`, c.attrs.showAs]));
  const prop = child(meta, "proprietary");
  const inForce = prop ? child(prop, "finlex:inForce") : null;
  const pdfs = [];
  const body = find(root, "mainBody");
  if (body) {
    for (const c of findAll(body, "componentRef")) if (/\.pdf$/i.test(c.attrs.src ?? "")) pdfs.push(c.attrs.src);
    for (const a of findAll(body, "a")) if (/\.pdf$/i.test(a.attrs.href ?? "")) pdfs.push(a.attrs.href);
  }
  const bodyText = body ? findAll(body, "p").map((p) => norm(textOf(p))).filter(Boolean) : [];
  const authorRef = prop ? child(prop, "finlex:authorative")?.attrs?.refersTo : null;
  return {
    title: norm(textOf(find(root, "docTitle"))) || null,
    authority: (authorRef && orgs.get(authorRef)) || null,
    number: prop ? norm(textOf(child(prop, "finlex:regulationNumber"))) || null : null,
    type: prop ? concepts.get(child(prop, "finlex:regulationType")?.attrs?.refersTo) ?? null : null,
    issued: work ? childrenNamed(work, "FRBRdate").find((d) => d.attrs.name === "dateIssued")?.attrs.date ?? null : null,
    diary: work ? childrenNamed(work, "FRBRalias").find((a) => a.attrs.name === "diaryNumber")?.attrs.value ?? null : null,
    entry: inForce ? dateAttr(child(inForce, "finlex:dateEntryIntoForce")) : null,
    endDate: inForce ? dateAttr(child(inForce, "finlex:dateInForceEnd")) ?? dateAttr(child(inForce, "finlex:dateRepealed")) : null,
    keywords: findAll(meta, "keyword").map((k) => k.attrs.showAs).filter(Boolean),
    pdfs: [...new Set(pdfs)],
    bodyText,
  };
}

export async function regDoc(id) {
  const xml = await fetchText(regUrl(id.authority, id.y, id.n), { ttl: 7 * 86400 });
  return xml ? parseReg(xml) : null;
}

// ---------- PDF sivuittain ----------

/** PDF:n teksti sivuittain (välimuisti 30 vrk). Palauttaa { pages: [string] } tai null. */
export async function pdfPages(url) {
  const key = `${url}${url.includes("?") ? "&" : "?"}_pages=1`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const bytes = await fetchBytes(url, { ttl: 0 });
  if (!bytes) return null;
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const out = { pages: (Array.isArray(text) ? text : [text]).map(tidy) };
  await cachePutJson(key, out, 30 * 86400);
  return out;
}

function tidy(t) {
  return String(t ?? "")
    .replace(/­/g, "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LEADER = /\s*(?:\.\s*){3,}\s*(\d+)\s*$/;

/** Sisällysluettelo: pistejohteiset rivit ensimmäisiltä sivuilta ("1 § Otsikko (s. 8)"). */
export function tocLines(pages) {
  const out = [];
  let pending = "";
  for (const p of pages.slice(0, 15)) {
    for (const raw of p.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(LEADER);
      if (m) {
        const title = `${pending} ${line.replace(LEADER, "")}`.trim();
        pending = "";
        if (title) out.push(`${title} (s. ${m[1]})`);
      } else if (out.length && line.length < 90 && !/^\d+$/.test(line) && !/^sisällys/i.test(line)) {
        // Monirivinen otsikko: ensimmäiset rivit ilman pistejohdetta.
        pending = pending ? `${pending} ${line}` : line;
        if (pending.length > 200) pending = "";
      }
    }
  }
  return out;
}

// Pykäläotsikko: "5 § Palkat", "6 a § Paikallinen…" tai vanha muoto "§ 5 Palkat". Ei "7 §:n mukaisesti".
const SECTION_RE = /^(?:(\d{1,3})\s*([a-z])?\s*§|§\s*(\d{1,3})\s*([a-z])?)\.?(?:\s+([A-ZÅÄÖ0-9].*))?$/;

export function sectionOf(line) {
  const m = line.match(SECTION_RE);
  if (!m || LEADER.test(line)) return null;
  const num = m[1] ?? m[3];
  const letter = m[2] ?? m[4] ?? "";
  return { key: `${num}${letter}`, title: (m[5] ?? "").trim() };
}

/** Pykälän esiintymät: [{ page, header, text }]. Teksti jatkuu seuraavaan pykäläotsikkoon. */
export function findSections(pages, pykala, maxChars = 12_000) {
  const want = String(pykala).toLowerCase().replace(/§/g, "").replace(/\s+/g, "");
  const lines = [];
  pages.forEach((p, pi) => {
    for (const l of p.split("\n")) lines.push({ t: l.trim(), p: pi });
  });
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const s = sectionOf(lines[i].t);
    if (!s || s.key !== want) continue;
    const buf = [lines[i].t];
    let len = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (sectionOf(lines[j].t)) break;
      buf.push(lines[j].t);
      len += lines[j].t.length;
      if (len > maxChars) {
        buf.push("…");
        break;
      }
    }
    const first = pages[lines[i].p].split("\n").find((x) => x.trim() && !/^\d+$/.test(x.trim()));
    hits.push({ page: lines[i].p + 1, header: first ? first.trim().replace(/\s*\d+$/, "") || null : null, text: buf.filter(Boolean).join("\n") });
    if (hits.length >= 4) break;
  }
  return hits;
}

/** Sivualue "49" tai "49-55" → [alku, loppu] (1-pohjainen). */
export function parsePages(v, total) {
  const m = String(v).trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!m) return null;
  const a = Math.max(1, +m[1]);
  const b = Math.min(total, m[2] ? +m[2] : a);
  return a <= b ? [a, b] : null;
}

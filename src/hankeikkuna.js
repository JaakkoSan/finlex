// Valtioneuvoston Hankeikkunan julkinen rajapinta (api.hankeikkuna.fi), lisenssi CC BY 4.0
// (rajapintakuvaus https://api.hankeikkuna.fi/api/api-docs). Ministeriöiden lainvalmistelu- ja
// muut hankkeet: valmisteluvaihe, lausuntokierrokset, hallituksen esityksen tiedot ja asiakirjat.
// Hakuvastaukset ovat suuria (hanke asiakirjaluetteloineen 30–400 kt), joten välimuistiin
// tallennetaan vain tiivistetyt tiedot.

import { FinlexError, cacheGetJson, cachePutJson } from "./finlex.js";

export const HK_API = "https://api.hankeikkuna.fi/api/v2";
export const HK_DOC_PREFIX = "https://api.hankeikkuna.fi/asiakirjat/";
const USER_AGENT = "finlex-mcp/1.6 (Claude-liitin; Cloudflare Worker)";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const CACHE_V = 1;

export class HankeikkunaError extends FinlexError {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// djb2: välimuistiavain hakulomakkeesta.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function hkRequest(path, body = null) {
  const url = HK_API + path;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: body === null ? "GET" : "POST",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(body === null ? {} : { "Content-Type": "application/json" }) },
        body: body === null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return await res.json();
    lastErr = new HankeikkunaError(`Hankeikkunan rajapinta vastasi ${res.status}`, res.status);
    if (!RETRY_STATUS.has(res.status)) break;
    await sleep(500 * 2 ** attempt);
  }
  throw lastErr instanceof HankeikkunaError ? lastErr : new HankeikkunaError(`Hankeikkunan rajapintaan ei saatu yhteyttä: ${lastErr?.message ?? lastErr}`, 0);
}

const fi = (o) => {
  const s = o && typeof o === "object" ? (o.fi ?? o.sv ?? o.en ?? null) : (o ?? null);
  return typeof s === "string" && s.trim() ? s.trim() : null;
};

// ---------- Tiivistys ----------

function compactEtappi(e) {
  return {
    t: e.tyyppi ?? null,
    n: fi(e.nimi),
    a: e.alku ?? null,
    l: e.loppu ?? null,
    v: e.valmisteluvaihe ?? null,
    k: fi(e.kuvaus),
    id: e.uuid ?? null,
  };
}

/** "HE 231/2021", "HE 231/2021 vp" ja vanhoissa hankkeissa pelkkä "304/2010" → "HE 231/2021". */
export function normHe(s) {
  const m = String(s ?? "").match(/^\s*(?:HE\s*)?(\d{1,4})\s*\/\s*(\d{4})(?:\s*vp)?\s*$/i);
  return m ? `HE ${+m[1]}/${m[2]}` : String(s ?? "").trim();
}

function compactLain(l) {
  if (!l) return null;
  const h = l.heTiedot ?? {};
  const tt = Array.isArray(h.tilatiedot) && h.tilatiedot.length ? h.tilatiedot[h.tilatiedot.length - 1] : null;
  return {
    luokka: l.tehtavaluokka ?? null,
    lan: !!l.lainsaadannonArviointineuvosto,
    he: (h.heNumerot ?? []).map(normHe),
    sk: h.skNumerot ?? [],
    ev: (h.evNumerot ?? []).map((e) => String(e).replace(/^\s*(\d{1,4}\/\d{4})\s*$/, "EV $1")),
    ministeri: fi(h.vastuuministeri),
    otsikko: fi(h.otsikko),
    sisalto: fi(h.sisalto),
    kiire: !!h.kiireellinen,
    pev: h.perustuslakivaliokunnanLausuntoVaaditaan ?? null,
    rauennut: !!h.rauennut,
    heTila: tt ? { kuvaus: fi(tt.heTila?.kuvaus), tila: tt.heTila?.tila ?? null, vuosi: tt.esittelyvuosi ?? null, viikko: tt.esittelyviikko ?? null } : null,
  };
}

/** Hakutuloksen rivi: vain listauksessa tarvittavat tiedot. */
function compactRow(x) {
  const k = x.kohde ?? {};
  return {
    tunnus: k.tunnus ?? null,
    tyyppi: k.tyyppi ?? null,
    nimi: fi(k.nimi) ?? fi(k.alias),
    tila: k.tila ?? null,
    vaihe: k.valmisteluvaihe ?? null,
    asettaja: k.asettajaUuid ?? null,
    asetettu: k.asettamisPaiva ?? null,
    muokattu: k.muokattu ?? null,
    lain: compactLain(x.lainsaadanto),
    lk: (x.etapit ?? []).filter((e) => e.tyyppi === "LAUSUNTOKIERROS").map(compactEtappi),
  };
}

function compactDoc(a, groups) {
  return {
    t: a.tyyppi ?? null,
    n: fi(a.nimi),
    l: fi(a.laatija),
    d: a.laatimispaiva ?? (a.luotu ? a.luotu.slice(0, 10) : null),
    c: a.luotu ?? null,
    u: a.url ?? null,
    s: a.sisaltoTyyppi ?? null,
    k: fi(a.kuvaus),
    g: (a.asiakirjaryhmaUuids ?? []).map((id) => groups.get(id)).filter(Boolean),
    id: a.uuid ?? null,
  };
}

/** Koko hanke: perustiedot, lainsäädäntötiedot, etapit, linkit ja asiakirjat numeroituina. */
function compactKohde(x) {
  const k = x.kohde ?? {};
  const groups = new Map((x.asiakirjaryhmat ?? []).map((g) => [g.uuid, fi(g.nimi)]));
  const docs = (x.asiakirjat ?? []).map((a) => compactDoc(a, groups));
  // Pysyvä numerointi: luontiaika, sitten tunniste. Uudet asiakirjat tulevat yleensä loppuun.
  docs.sort((a, b) => cmp(a.c ?? a.d ?? "", b.c ?? b.d ?? "") || cmp(a.id ?? "", b.id ?? ""));
  return {
    ...compactRow(x),
    uuid: k.uuid ?? null,
    aloitus: k.aloitusPaiva ?? null,
    valmistuminen: k.valmistumisPaiva ?? null,
    tiivistelma: fi(k.tiivistelma),
    tavoitteet: fi(k.tavoitteet),
    tilanne: fi(k.tilanne),
    vaikutukset: fi(k.vaikutukset),
    kuvaus: fi(k.kuvaus),
    asianumerot: k.asianumerot ?? [],
    etapit: (x.etapit ?? []).map(compactEtappi).sort((a, b) => cmp(a.a ?? "", b.a ?? "")),
    linkit: (x.linkit ?? []).map((l) => ({ n: fi(l.nimi), u: fi(l.url), e: l.etappiUuid ?? null })).filter((l) => l.u),
    docs,
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- Haut ----------

const TTL = 3600;

/** Hakee kohteita. Palauttaa { total, rows }. size enintään 300. */
export async function searchProjects(form, size) {
  const body = { ...form, size };
  const key = `${HK_API}/kohteet/haku?_c=${hash(JSON.stringify(body))}&_v=${CACHE_V}`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const res = await hkRequest("/kohteet/haku", body);
  const out = { total: res.totalHits ?? 0, rows: (res.result ?? []).map(compactRow) };
  await cachePutJson(key, out, TTL);
  return out;
}

/** Hanke tunnuksella (esim. "STM006:00/2020"). null, jos ei löydy. */
export async function projectByTunnus(tunnus) {
  const key = `${HK_API}/kohteet/tunnus/${encodeURIComponent(tunnus)}?_v=${CACHE_V}`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const res = await hkRequest("/kohteet/haku", { tunnus: [tunnus], size: 1 });
  const x = (res.result ?? []).find((r) => r.kohde?.tunnus === tunnus) ?? null;
  if (!x) return null;
  const out = compactKohde(x);
  await cachePutJson(key, out, TTL);
  return out;
}

/** Hallituksen esityksen ("HE 231/2021") valmisteluhankkeiden tunnukset. */
export async function projectsForProposal(he) {
  const target = normHe(he);
  const m = target.match(/^HE (\d+\/\d{4})$/);
  // Vanhoissa hankkeissa numero on ilman HE-etuliitettä, joten haetaan tarvittaessa myös pelkällä numerolla.
  for (const q of m ? [target, m[1]] : [target]) {
    const { rows } = await searchProjects({ teksti: q, tyyppi: ["LAINSAADANTO"] }, 20);
    const hits = rows.filter((r) => (r.lain?.he ?? []).includes(target)).map((r) => r.tunnus);
    if (hits.length) return hits;
  }
  return [];
}

let asettajatMemo = null;

/** Asettajat (ministeriöt): [{ uuid, lyhenne, nimi, aktiivinen }]. */
export async function asettajat() {
  if (asettajatMemo && asettajatMemo.exp > Date.now()) return asettajatMemo.value;
  const key = `${HK_API}/asettajat?_v=${CACHE_V}`;
  let value = await cacheGetJson(key);
  if (!value) {
    const res = await hkRequest("/asettajat");
    value = (res.result ?? []).map((a) => ({ uuid: a.uuid, lyhenne: fi(a.lyhenne), nimi: fi(a.nimi), aktiivinen: !!a.aktiivinen }));
    await cachePutJson(key, value, 86400);
  }
  asettajatMemo = { value, exp: Date.now() + 3600_000 };
  return value;
}

export const projectWebUrl = (tunnus) => `https://valtioneuvosto.fi/hanke?tunnus=${encodeURIComponent(tunnus).replace(/%3A/gi, ":").replace(/%2F/gi, "/")}`;

// ---------- Asiakirjan teksti ----------

const TEXT_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export function docKind(d) {
  if (TEXT_TYPES[d.s]) return TEXT_TYPES[d.s];
  const ext = String(d.u ?? "").toLowerCase().match(/\.(pdf|docx)$/);
  return ext ? ext[1] : null;
}

/**
 * Asiakirjan teksti PDF:stä tai DOCX:stä. Palauttaa { text, pages } tai null.
 * Vain Hankeikkunan asiakirjaosoitteet hyväksytään.
 */
export async function docText(d) {
  const url = d.u;
  if (typeof url !== "string" || !url.startsWith(HK_DOC_PREFIX)) return null;
  const kind = docKind(d);
  if (!kind) return null;
  const key = `${url}?_text=${CACHE_V}`;
  const hit = await cacheGetJson(key);
  if (hit) return hit;
  const bytes = await fetchDocBytes(url);
  if (!bytes) return null;
  let out;
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    out = { text: tidy(text), pages: totalPages };
  } else {
    const xml = await zipEntry(bytes, "word/document.xml");
    if (xml === null) return null;
    out = { text: tidy(docxText(xml)), pages: null };
  }
  await cachePutJson(key, out, 30 * 86400);
  return out;
}

async function fetchDocBytes(url) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1) throw new HankeikkunaError(`Asiakirjaa ei saatu ladattua: ${e?.message ?? e}`, 0);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS - 1) throw new HankeikkunaError(`Asiakirjan lataus: palvelin vastasi ${res.status}`, res.status);
    await sleep(500 * 2 ** attempt);
  }
  return null;
}

function tidy(t) {
  return String(t ?? "")
    .replace(/­/g, "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // tavutus rivin lopussa
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lukee ZIP-arkistosta (DOCX) yhden tiedoston tekstinä. null, jos ei löydy. */
export async function zipEntry(bytes, name) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: allekirjoitus 0x06054b50 tiedoston lopussa (kommentti enintään 64 kt).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const entryName = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + csize);
      if (method === 0) return dec.decode(data);
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Word-dokumentin (document.xml) kappaleet tekstinä. */
export function docxText(xml) {
  const out = [];
  for (const m of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0]
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<[^>]+>/g, (_, t) => t ?? "")
      .replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (_, e, d, h) => (e ? XML_ENT[e.toLowerCase()] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
    out.push(p.replace(/[ \t]+/g, (s) => (s.includes("\t") ? "\t" : " ")).trim());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

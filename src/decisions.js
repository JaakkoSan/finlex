// Viranomaisratkaisut Finlexin avoimesta datasta:
// tietosuojavaltuutettu, eduskunnan oikeusasiamies ja oikeuskansleri.

import { API_BASE, fetchBytes } from "./finlex.js";
import { parseXml, find, findAll, child, childrenNamed, elements, textOf } from "./xml.js";

export const SOURCES = {
  tietosuojavaltuutettu: {
    type: "data-protection-ombudsman-decision",
    label: "Tietosuojavaltuutettu",
    web: "tietosuojavaltuutettu",
  },
  oikeusasiamies: {
    type: "parliamentary-ombudsman-decision",
    label: "Eduskunnan oikeusasiamies",
    web: "eduskunnan-oikeusasiamies",
  },
  oikeuskansleri: {
    type: "chancellor-of-justice-decision",
    label: "Oikeuskansleri",
    web: "oikeuskansleri",
  },
};

export function source(name) {
  const s = SOURCES[name];
  if (!s) throw new Error(`Tuntematon lähde: ${name}. Vaihtoehdot: ${Object.keys(SOURCES).join(", ")}`);
  return s;
}

export function decisionUrl(src, year, number, lang = "fin") {
  return `${API_BASE}/akn/fi/judgment/${src.type}/${year}/${encodeURIComponent(number)}/${lang}@`;
}

export function decisionWebUrl(src, year, number, lang = "fin") {
  const l = lang === "swe" ? "sv" : "fi";
  return `https://www.finlex.fi/${l}/viranomaiset/${src.web}/${year}/${number}`;
}

export function decisionListUrl(src, params) {
  const q = new URLSearchParams({ format: "json" });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  return `${API_BASE}/akn/fi/judgment/${src.type}/list?${q.toString()}`;
}

/** Finlexin asiasana-arvo: pienet kirjaimet, välilyönnit alaviivoiksi. */
export function keywordValue(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/** Lukee ratkaisun XML:n perustiedot ja tekstirungon. */
export function parseDecision(xml) {
  const root = parseXml(xml);
  const j = find(root, "judgment");
  if (!j) return null;
  const meta = child(j, "meta");
  const work = meta ? find(meta, "FRBRWork") : null;
  const header = child(j, "header");
  const body = child(j, "judgmentBody");
  const concepts = new Map(
    (meta ? findAll(meta, "TLCConcept") : []).map((c) => [`#${c.attrs.eId}`, c.attrs.showAs]),
  );
  const prop = meta ? child(meta, "proprietary") : null;
  const conceptOf = (name) => {
    const el = prop ? child(prop, name) : null;
    return el ? concepts.get(el.attrs.refersTo) ?? null : null;
  };
  const dateIssued = work ? childrenNamed(work, "FRBRdate").find((d) => d.attrs.name === "dateIssued")?.attrs.date : null;
  const diary = work ? childrenNamed(work, "FRBRalias").find((a) => a.attrs.name === "diaryNumber")?.attrs.value : null;

  // PDF-linkit: componentRef src tai a href, suhteellisina.
  const pdfs = [];
  if (body) {
    for (const c of findAll(body, "componentRef")) if (/\.pdf$/i.test(c.attrs.src ?? "")) pdfs.push(c.attrs.src);
    for (const a of findAll(body, "a")) if (/\.pdf$/i.test(a.attrs.href ?? "")) pdfs.push(a.attrs.href);
  }

  return {
    title: header ? textOf(find(header, "docTitle")) : null,
    docNumber: header ? textOf(find(header, "docNumber")) : null,
    dateIssued: dateIssued ?? null,
    diaryNumber: diary ?? null,
    keywords: meta ? findAll(meta, "keyword").map((k) => k.attrs.showAs).filter(Boolean) : [],
    decisionMaker: conceptOf("finlex:decisionMaker"),
    caseType: conceptOf("finlex:caseType"),
    typeOfMeasure: conceptOf("finlex:typeOfMeasure"),
    legalBasis: conceptOf("finlex:legalBasis"),
    administrativeBranch: conceptOf("finlex:administrativeBranch"),
    presentingOfficial: prop ? textOf(child(prop, "finlex:presentingOfficial")) || null : null,
    body,
    pdfs: [...new Set(pdfs)],
  };
}

/** Muotoilee ratkaisun rungon tekstiksi (otsikot ja kappaleet). */
export function renderDecisionBody(body) {
  if (!body) return "";
  const lines = [];
  const walk = (node, depth) => {
    for (const el of elements(node)) {
      if (el.name === "heading") {
        const t = textOf(el);
        if (t) lines.push("", `${"#".repeat(Math.min(depth, 4))} ${t}`);
      } else if (el.name === "p") {
        const t = paragraphText(el);
        if (t) lines.push(t);
      } else if (el.name === "componentRef") {
        // PDF käsitellään erikseen.
      } else if (el.name === "table") {
        for (const tr of findAll(el, "tr")) {
          lines.push(
            elements(tr)
              .filter((c) => c.name === "td" || c.name === "th")
              .map((c) => textOf(c))
              .join(" | "),
          );
        }
      } else {
        walk(el, el.name === "tblock" ? depth + 1 : depth);
      }
    }
  };
  walk(body, 1);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function paragraphText(p) {
  // Säilytä rivinvaihdot (br), muuten normalisoi välilyönnit.
  let s = "";
  const walk = (n) => {
    for (const c of n.children) {
      if (typeof c === "string") s += c;
      else if (c.name === "br") s += "\n";
      else walk(c);
    }
  };
  walk(p);
  return s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Hakee PDF:n ja purkaa siitä tekstin. Palauttaa { text, pages } tai null. */
export async function pdfText(url) {
  const bytes = await fetchBytes(url, { ttl: 30 * 86400 });
  if (!bytes) return null;
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: tidyPdfText(text), pages: totalPages };
}

function tidyPdfText(t) {
  return String(t ?? "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // tavutus rivin lopussa
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

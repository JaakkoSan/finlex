// Akoma Ntoso -säädösdokumentin tulkinta ja muotoilu tekstiksi.

import { parseXml, find, findAll, child, childrenNamed, elements, textOf } from "./xml.js";

const STRUCT = new Set(["part", "chapter", "title", "subchapter", "division", "subdivision", "book", "subtitle"]);
const ITEMS = new Set(["paragraph", "subparagraph", "point", "item", "indent", "list", "alinea", "clause", "subclause"]);
const TEXTUAL = new Set(["intro", "content", "wrapUp", "wrap"]);

export function parseStatute(xml) {
  const root = parseXml(xml);
  const act = find(root, "act");
  if (!act) return null;
  return { root, act };
}

// ---------- Metatiedot ----------

export function metadata(doc) {
  const { act } = doc;
  const meta = child(act, "meta");
  const work = meta ? find(meta, "FRBRWork") : null;
  const expr = meta ? find(meta, "FRBRExpression") : null;
  const prop = meta ? child(meta, "proprietary") : null;
  const preface = child(act, "preface");

  const frbrDate = (node, name) => {
    if (!node) return null;
    const d = childrenNamed(node, "FRBRdate").find((x) => x.attrs.name === name);
    return d ? d.attrs.date : null;
  };
  const alias = (node) => {
    const a = node ? childrenNamed(node, "FRBRalias").find((x) => x.attrs.name === "eli") : null;
    return a ? a.attrs.value : null;
  };

  const out = {
    contains: act.attrs.contains ?? null,
    title: preface ? textOf(find(preface, "docTitle")) : null,
    docNumber: preface ? textOf(find(preface, "docNumber")) : null,
    subtype: work ? child(work, "FRBRsubtype")?.attrs.value ?? null : null,
    dateIssued: frbrDate(work, "dateIssued"),
    eliWork: alias(work),
    eliExpression: alias(expr),
    versionNumber: expr ? child(expr, "FRBRversionNumber")?.attrs.value ?? null : null,
    dateConsolidated: frbrDate(expr, "dateConsolidated"),
    language: expr ? child(expr, "FRBRlanguage")?.attrs.language ?? null : null,
    keywords: meta ? findAll(meta, "keyword").map((k) => k.attrs.showAs).filter(Boolean) : [],
    isInForce: null,
    dateEntryIntoForce: null,
    relations: {},
    preliminaryWork: null,
  };

  if (prop) {
    const inForceFlag = child(prop, "finlex:isInForce");
    if (inForceFlag) out.isInForce = inForceFlag.attrs.value === "true";
    const inForce = child(prop, "finlex:inForce");
    if (inForce) out.dateEntryIntoForce = find(inForce, "finlex:dateEntryIntoForce")?.attrs.date ?? null;
    for (const el of elements(prop)) {
      const refs = childrenNamed(el, "finlex:statuteReference");
      if (!refs.length) continue;
      const key = el.name.replace(/^finlex:/, "");
      out.relations[key] = refs.map((r) => {
        const ref = find(r, "finlex:ref");
        const date = find(r, "finlex:dateEntryIntoForce");
        const note = find(r, "finlex:noteEditorial");
        return {
          id: ref ? textOf(ref) : null,
          href: ref ? ref.attrs.href : null,
          entryIntoForce: date ? date.attrs.date ?? null : null,
          note: note ? textOf(note) : null,
        };
      });
    }
  }

  const prelim = findAll(act, "hcontainer").find((h) => h.attrs.name === "preliminaryWork");
  if (prelim) out.preliminaryWork = textOf(prelim);
  return out;
}

// ---------- Rakenne ----------

export function provisionsRoot(act) {
  const body = child(act, "body");
  if (!body) return null;
  const wrapper = findAll(body, "hcontainer").find((h) => h.attrs.name === "statuteProvisionsWrapper");
  return wrapper ?? body;
}

export function normNum(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/§|luku|kap\.?|kapitel|osa|avd\.?|mom\.?/g, "")
    .replace(/\s+/g, "")
    .replace(/\.$/, "")
    .trim();
}

export function numOf(node) {
  const n = child(node, "num");
  return n ? textOf(n) : "";
}

export function headingOf(node) {
  const h = child(node, "heading");
  return h ? textOf(h) : "";
}

/** Sisällysluettelo: osat, luvut ja pykälät otsikoineen. */
export function tableOfContents(doc, maxChars = 30000) {
  const rootEl = provisionsRoot(doc.act);
  if (!rootEl) return "(Säädöksessä ei ole jäsenneltyä tekstiosaa.)";
  const lines = [];
  const walk = (node, depth) => {
    let pending = []; // otsikottomat pykälät tiiviisti
    const seen = new Map();
    const flush = () => {
      if (pending.length) {
        lines.push("  ".repeat(depth) + pending.join(", "));
        pending = [];
      }
    };
    for (const el of elements(node)) {
      if (STRUCT.has(el.name)) {
        flush();
        const label = [numOf(el), headingOf(el)].filter(Boolean).join(" ");
        lines.push("  ".repeat(depth) + (label || el.name));
        walk(el, depth + 1);
      } else if (el.name === "section") {
        const num = numOf(el);
        const key = normNum(num);
        if (seen.has(key)) {
          seen.get(key).multi = true;
          continue;
        }
        const entry = { num, heading: headingOf(el), multi: false };
        seen.set(key, entry);
        if (entry.heading) {
          flush();
          lines.push("  ".repeat(depth) + `${num} ${entry.heading}`);
          entry.line = lines.length - 1;
        } else {
          pending.push(num);
        }
      } else if (el.name === "hcontainer" && el.attrs.name !== "noteAuthorial") {
        flush();
        walk(el, depth);
      }
    }
    flush();
    for (const e of seen.values()) {
      if (e.multi && e.line !== undefined) lines[e.line] += " (useampi sanamuoto, ks. pykälä)";
    }
  };
  walk(rootEl, 0);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (sisällysluettelo katkaistu)";
  return out;
}

// ---------- Tekstin muotoilu ----------

// Aikaan sidotut merkinnät jätetään muotoiluun merkeiksi, jotta muotoiltu teksti
// voidaan tallentaa välimuistiin. finalize() korvaa merkit pyynnön hetkellä.
// Ohjausmerkit (U+0001, U+0002) eivät ole sallittuja XML 1.0 -tekstissä, joten
// ne eivät voi esiintyä säädöstekstissä.
const MARK_FUT = "\u0001";
const MARK_WARN = "\u0002";

function versionLabel(el) {
  const l = el.attrs["finlex:originalVersionLabel"];
  if (!l) return "";
  let extra = "";
  const lm = l.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\/(\d+)/);
  if (lm) extra = `${MARK_FUT}${lm[4]}/${lm[3]}${MARK_FUT}`;
  return ` [sanamuoto: ${l}${extra}]`;
}

const FUT_RE = /\u0001([^\u0001]*)\u0001/g;
const WARN_RE = /\n( *)\u0002(\d+)\|(\d+)\|(\d+)\u0002/g;

/**
 * Korvaa muotoillun tekstin aikamerkit.
 * future: Map muutossäädös ("597/2026") -> voimaantulopäivä tekstinä.
 */
export function finalize(text, future = new Map(), today = new Date()) {
  if (text.indexOf(MARK_FUT) !== -1) {
    text = text.replace(FUT_RE, (_, id) => {
      const d = future.get(id);
      return d ? `, EI VIELÄ VOIMASSA, voimaan ${d}` : "";
    });
  }
  if (text.indexOf(MARK_WARN) !== -1) {
    text = text.replace(WARN_RE, (_, pad, d, m, y) => {
      const w = futureWarning(`tulee voimaan ${d}.${m}.${y}`, today);
      return w ? `\n${pad}${w}` : "";
    });
  }
  return text;
}

function paragraphsText(node) {
  const ps = elements(node).filter((c) => c.name === "p" || c.name === "block" || c.name === "table");
  if (!ps.length) return [textOf(node)].filter(Boolean);
  return ps.map((p) => (p.name === "table" ? tableText(p) : textOf(p))).filter(Boolean);
}

function tableText(table) {
  return findAll(table, "tr")
    .map((tr) =>
      elements(tr)
        .filter((c) => c.name === "td" || c.name === "th")
        .map((c) => textOf(c))
        .join(" | "),
    )
    .join("\n");
}

/** Muotoilee yhden elementin tekstiriveiksi. */
export function render(node, depth = 0, ctx = { mom: 0 }) {
  const pad = "  ".repeat(depth);
  const lines = [];
  const name = node.name;

  if (STRUCT.has(name)) {
    const label = [numOf(node), headingOf(node)].filter(Boolean).join(" ");
    if (label) lines.push(`${pad}${label}`);
    for (const el of elements(node)) {
      if (el.name === "num" || el.name === "heading") continue;
      lines.push(...render(el, depth, ctx));
    }
    return lines;
  }

  if (name === "section") {
    const label = [numOf(node), headingOf(node)].filter(Boolean).join(" ");
    lines.push(`${pad}${label}${versionLabel(node)}`);
    let mom = 0;
    for (const el of elements(node)) {
      if (el.name === "num" || el.name === "heading") continue;
      if (el.name === "subsection") {
        mom++;
        lines.push(...renderSubsection(el, mom, depth + 1));
      } else {
        lines.push(...render(el, depth + 1, ctx));
      }
    }
    return lines;
  }

  if (name === "subsection") {
    ctx.mom = (ctx.mom ?? 0) + 1;
    return renderSubsection(node, ctx.mom, depth);
  }

  if (ITEMS.has(name)) {
    const num = numOf(node);
    const head = headingOf(node);
    const sub = [];
    let first = true;
    for (const el of elements(node)) {
      if (el.name === "num" || el.name === "heading") continue;
      if (TEXTUAL.has(el.name)) {
        const texts = paragraphsText(el);
        texts.forEach((t) => {
          if (first) {
            sub.push(`${pad}${[num, head, t].filter(Boolean).join(" ")}${versionLabel(node)}`);
            first = false;
          } else sub.push(`${pad}  ${t}`);
        });
      } else {
        if (first) {
          sub.push(`${pad}${[num, head].filter(Boolean).join(" ")}${versionLabel(node)}`);
          first = false;
        }
        sub.push(...render(el, depth + 1, ctx));
      }
    }
    if (first) sub.push(`${pad}${[num, head].filter(Boolean).join(" ")}${versionLabel(node)}`);
    return sub;
  }

  if (TEXTUAL.has(name)) {
    return paragraphsText(node).map((t) => pad + t);
  }

  if (name === "hcontainer") {
    if (node.attrs.name === "noteAuthorial") {
      const t = textOf(node);
      const m = futureDate(t);
      return [`${pad}Huomautus (Finlex): ${t}`, ...(m ? [`${pad}${MARK_WARN}${m[1]}|${m[2]}|${m[3]}${MARK_WARN}`] : [])];
    }
    const label = [numOf(node), headingOf(node)].filter(Boolean).join(" ");
    if (label) lines.push(pad + label);
    for (const el of elements(node)) {
      if (el.name === "num" || el.name === "heading") continue;
      lines.push(...render(el, depth, ctx));
    }
    return lines;
  }

  if (name === "crossHeading") return [`${pad}Väliotsikko: ${textOf(node)}`];
  if (name === "num" || name === "heading") return [];
  if (name === "table") return [pad + tableText(node)];
  if (name === "p" || name === "block") {
    const t = textOf(node);
    return t ? [pad + t] : [];
  }

  // Tuntematon elementti: lapset läpi, tai teksti jos lapsia ei ole.
  const els = elements(node);
  if (!els.length) {
    const t = textOf(node);
    return t ? [pad + t] : [];
  }
  for (const el of els) lines.push(...render(el, depth, ctx));
  return lines;
}

function renderSubsection(node, mom, depth) {
  const pad = "  ".repeat(depth);
  const out = [];
  const prefix = `(${mom} mom.)`;
  let first = true;
  for (const el of elements(node)) {
    if (el.name === "num") continue;
    if (TEXTUAL.has(el.name)) {
      for (const t of paragraphsText(el)) {
        if (first) {
          out.push(`${pad}${prefix}${versionLabel(node)} ${t}`);
          first = false;
        } else out.push(`${pad}${t}`);
      }
    } else {
      if (first) {
        out.push(`${pad}${prefix}${versionLabel(node)}`);
        first = false;
      }
      out.push(...render(el, depth + 1));
    }
  }
  if (first) out.push(`${pad}${prefix}${versionLabel(node)}`);
  return out;
}

/** Huomautuksen tuleva voimaantulopäivä (vastaavuus d, m, v) tai null. */
function futureDate(text) {
  return text.match(/tulee voimaan (\d{1,2})\.(\d{1,2})\.(\d{4})/) || text.match(/träder i kraft (?:den )?(\d{1,2})\.(\d{1,2})\.(\d{4})/);
}

/** Jos huomautus kertoo tulevasta voimaantulosta, palauttaa varoituksen. */
export function futureWarning(text, today = new Date()) {
  const m = futureDate(text);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (d > today) {
    return `HUOM: muutos tulee voimaan vasta ${m[1]}.${m[2]}.${m[3]}. Tarkista, kumpi sanamuoto on voimassa tarkasteltavana ajankohtana.`;
  }
  return null;
}

// ---------- Pykäläryhmän muotoilu ----------

/** pre: valinnainen { node, lines } jo muotoillulle solmulle (ei muotoilla kahdesti). */
export function renderGroup(group, pre) {
  const lines = [];
  if (group.chapter) {
    lines.push([numOf(group.chapter), headingOf(group.chapter)].filter(Boolean).join(" "));
  }
  let secCount = 0;
  for (const n of group.nodes) {
    if (n.name === "section") {
      secCount++;
      if (secCount > 1) lines.push("", "Toinen sanamuoto samasta pykälästä (katso huomautus yllä, joka kertoo kumpi on aiempi):");
      lines.push(...(pre && pre.node === n ? pre.lines : render(n, 0)));
    } else {
      lines.push("", ...render(n, 0));
    }
  }
  return lines.join("\n");
}

// MCP-työkalut: määrittelyt ja toteutukset.

import { fetchText, fetchHead, consolidatedUrl, originalUrl, listUrl, webUrl, FinlexError } from "./finlex.js";
import {
  parseStatute,
  metadata,
  tableOfContents,
  findSections,
  findChapter,
  renderGroup,
  render,
  searchText,
  sectionNumbers,
  futureWarning,
  setFutureAmendments,
} from "./statute.js";

const MAX_OUTPUT = 90_000;

const commonProps = {
  vuosi: { type: "integer", description: "Säädöksen vuosi, esim. 1993 (säädösnumerosta 1501/1993)." },
  numero: { type: "string", description: "Säädöksen numero, esim. \"1501\" (säädösnumerosta 1501/1993)." },
  kieli: { type: "string", enum: ["fin", "swe"], description: "Kieliversio: fin (oletus) tai swe." },
  versio: {
    type: "string",
    description:
      "Valinnainen. Ajantasaisen tekstin aiempi versio muutossäädöksen numerolla, esim. \"448/2024\" = teksti sellaisena kuin se oli tuon muutoksen jälkeen. Oletus on uusin versio.",
  },
  teksti: {
    type: "string",
    enum: ["ajantasainen", "alkuperainen"],
    description:
      "ajantasainen (oletus) = muutokset sisältävä teksti. alkuperainen = säädös sellaisena kuin se alun perin annettiin säädöskokoelmassa.",
  },
};

export const TOOLS = [
  {
    name: "hae_saadoksia",
    description:
      "Hakee Finlexistä säädöksiä otsikon tai asiasanan perusteella ja palauttaa säädösnumerot ja nimet. Käytä tätä, kun säädöksen numero ei ole tiedossa. Haku kohdistuu ajantasaistettuun lainsäädäntöön. Otsikkohaku etsii merkkijonoa säädöksen nimestä, ei tekstistä (esim. \"arvonlisävero\", \"työaika\", \"osakeyhtiö\").",
    inputSchema: {
      type: "object",
      properties: {
        otsikko: { type: "string", description: "Merkkijono, jonka säädöksen nimi sisältää. Kirjainkoolla ei ole väliä." },
        asiasana: { type: "string", description: "Finlexin asiasana, esim. \"Arvonlisävero\". Valinnainen." },
        vain_voimassa: { type: "boolean", description: "Vain voimassa olevat säädökset (oletus true)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
        kieli: commonProps.kieli,
      },
    },
  },
  {
    name: "saados_tiedot",
    description:
      "Palauttaa säädöksen perustiedot ja sisällysluettelon: nimi, voimassaolo, voimaantulo, mihin muutokseen asti teksti on ajantasaistettu, muutossäädökset voimaantulopäivineen, esityöt ja luvut/pykälät otsikoineen. Käytä ennen pykälien hakemista, jos rakenne ei ole tiedossa.",
    inputSchema: {
      type: "object",
      properties: {
        vuosi: commonProps.vuosi,
        numero: commonProps.numero,
        kieli: commonProps.kieli,
        versio: commonProps.versio,
        teksti: commonProps.teksti,
        muutoksia_enintaan: { type: "integer", description: "Kuinka monta uusinta muutossäädöstä listataan (oletus 20)." },
      },
      required: ["vuosi", "numero"],
    },
  },
  {
    name: "hae_pykala",
    description:
      "Palauttaa pykälän tai koko luvun sanatarkan tekstin Finlexistä momentteineen ja kohtineen sekä Finlexin huomautukset (esim. muutosten voimaantulo ja aiempi sanamuoto). Anna pykälä (esim. \"3\", \"3 a\") ja tarvittaessa luku, jos laissa pykälänumerointi alkaa joka luvussa alusta (esim. osakeyhtiölaki: luku \"13\", pykälä \"2\"). Pelkällä luvulla palautetaan koko luku.",
    inputSchema: {
      type: "object",
      properties: {
        vuosi: commonProps.vuosi,
        numero: commonProps.numero,
        pykala: { type: "string", description: "Pykälän numero, esim. \"3\" tai \"149 a\"." },
        luku: { type: "string", description: "Luvun numero, esim. \"2\" tai \"2 a\". Valinnainen." },
        kieli: commonProps.kieli,
        versio: commonProps.versio,
        teksti: commonProps.teksti,
      },
      required: ["vuosi", "numero"],
    },
  },
  {
    name: "etsi_saadoksesta",
    description:
      "Etsii yhden säädöksen tekstistä sanaa tai sanontaa ja palauttaa pykälät, joissa se esiintyy, lyhyine otteineen. Käytä tätä löytääksesi oikean pykälän, ja hae sen jälkeen koko teksti hae_pykala-työkalulla. Haku on kirjaimellinen: käytä sanan vartaloa (esim. \"maksuperust\").",
    inputSchema: {
      type: "object",
      properties: {
        vuosi: commonProps.vuosi,
        numero: commonProps.numero,
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä)." },
        kieli: commonProps.kieli,
        versio: commonProps.versio,
        teksti: commonProps.teksti,
      },
      required: ["vuosi", "numero", "hakusana"],
    },
  },
];

// ---------- Apufunktiot ----------

class UserError extends Error {}

function asYear(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1700 || n > 2200) throw new UserError("Anna vuosi nelinumeroisena, esim. 1993.");
  return n;
}

function asNumber(v) {
  const s = String(v ?? "").trim();
  if (!/^[0-9]{1,5}[a-zA-Z]?$/.test(s)) throw new UserError("Anna säädöksen numero, esim. \"1501\".");
  return s.replace(/^0+(?=\d)/, "");
}

function asLang(v) {
  return v === "swe" ? "swe" : "fin";
}

function versionToken(v) {
  if (v === undefined || v === null || v === "") return "latest";
  const s = String(v).trim();
  let m = s.match(/^(\d{1,5})\s*\/\s*(\d{4})$/);
  if (m) return `${m[2]}${m[1].padStart(4, "0")}`;
  m = s.match(/^(\d{4})(\d{4})$/);
  if (m) return s;
  if (s === "latest" || s === "uusin") return "latest";
  throw new UserError("Versio annetaan muutossäädöksen numerona, esim. \"448/2024\".");
}

function fmtDate(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[3]}.${+m[2]}.${m[1]}` : iso;
}

function versionTokenToId(tok) {
  const m = String(tok ?? "").match(/^(\d{4})(\d{4})$/);
  return m ? `${+m[2]}/${m[1]}` : null;
}

async function loadStatute(args) {
  const year = asYear(args.vuosi);
  const number = asNumber(args.numero);
  const lang = asLang(args.kieli);
  const original = args.teksti === "alkuperainen";
  let url;
  let fellBack = false;
  if (original) {
    url = originalUrl(year, number, lang);
  } else {
    url = consolidatedUrl(year, number, lang, versionToken(args.versio));
  }
  const ttl = original || (args.versio && args.versio !== "latest") ? 30 * 86400 : 6 * 3600;
  let xml = await fetchText(url, { ttl });
  if (xml === null && !original) {
    if (args.versio) {
      throw new UserError(
        `Versiota ${args.versio} ei löytynyt säädökselle ${number}/${year}. Tarkista muutossäädösten numerot saados_tiedot-työkalulla.`,
      );
    }
    // Ajantasaistettua versiota ei ole: käytä alkuperäistä ja kerro siitä.
    url = originalUrl(year, number, lang);
    xml = await fetchText(url, { ttl: 30 * 86400 });
    fellBack = true;
  }
  if (xml === null) throw new UserError(`Säädöstä ${number}/${year} ei löytynyt Finlexistä (${lang}).`);
  const doc = parseStatute(xml);
  if (!doc) throw new UserError(`Finlexin vastausta säädökselle ${number}/${year} ei voitu tulkita.`);
  const meta = metadata(doc);
  const today = new Date().toISOString().slice(0, 10);
  const future = new Map();
  for (const r of meta.relations.amendedBy ?? []) {
    if (r.id && r.entryIntoForce && r.entryIntoForce > today) future.set(r.id, fmtDate(r.entryIntoForce));
  }
  return { doc, meta, year, number, lang, original: original || fellBack, fellBack, apiUrl: url, future };
}

function header(s) {
  const { meta, year, number, lang, original, fellBack } = s;
  const lines = [];
  lines.push(`${meta.title ?? "(nimetön säädös)"} (${meta.docNumber ?? `${number}/${year}`})`);
  if (original) {
    lines.push("Teksti: ALKUPERÄINEN säädöskokoelman versio, EI sisällä myöhempiä muutoksia.");
    if (fellBack) lines.push("Syy: Finlexissä ei ole tälle säädökselle ajantasaistettua versiota.");
  } else {
    const lastAmend = versionTokenToId(meta.versionNumber);
    const parts = ["Teksti: AJANTASAINEN"];
    if (lastAmend) parts.push(`viimeisin huomioitu muutos ${lastAmend}`);
    if (meta.dateConsolidated) parts.push(`Finlexin ajantasaistuspäivä ${fmtDate(meta.dateConsolidated)}`);
    lines.push(parts.join(", ") + ".");
  }
  if (meta.isInForce === false) lines.push("VOIMASSAOLO: säädös EI ole voimassa (Finlexin merkintä).");
  if (!original && s.future.size) {
    const list = [...s.future].map(([id, d]) => `${id} (voimaan ${d})`).join(", ");
    lines.push(
      `HUOM: säädökseen on tehty muutoksia, jotka eivät ole vielä voimassa: ${list}. ` +
        "Ajantasainen teksti voi jo sisältää niiden sanamuodon. Muutetut kohdat on merkitty \"EI VIELÄ VOIMASSA\", ja aiempi sanamuoto näkyy Finlexin huomautuksen jälkeen.",
    );
  }
  lines.push(`Lähde: ${webUrl(year, number, lang, original)}`);
  if (meta.eliExpression || meta.eliWork) lines.push(`ELI: ${meta.eliExpression ?? meta.eliWork}`);
  return lines.join("\n");
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return (
    text.slice(0, MAX_OUTPUT) +
    "\n\n… (Tuloste katkaistu pituuden vuoksi. Hae tarvittaessa yksittäiset pykälät tai luvut erikseen.)"
  );
}

// ---------- Toteutukset ----------

async function haeSaadoksia(args) {
  const lang = asLang(args.kieli);
  if (!args.otsikko && !args.asiasana) throw new UserError("Anna otsikko tai asiasana.");
  const page = Math.max(1, Number(args.sivu) || 1);
  const params = {
    langAndVersion: `${lang}@latest`,
    titleContains: args.otsikko,
    keyword: args.asiasana,
    limit: 10,
    page,
    sortBy: "number",
  };
  if (args.vain_voimassa !== false) params.isInForce = "true";
  const raw = await fetchText(listUrl("statute-consolidated", params), { ttl: 3600, accept: "application/json" });
  const list = raw ? JSON.parse(raw) : [];
  if (!list.length) {
    return page > 1 ? "Ei enempää tuloksia." : "Ei osumia. Kokeile lyhyempää otsikon osaa (esim. \"työaika\" eikä \"työaikalaki 2019\") tai vain_voimassa=false.";
  }
  const seen = new Set();
  const items = [];
  for (const it of list) {
    const m = String(it.akn_uri).match(/statute-consolidated\/(\d{4})\/([^/]+)\//);
    if (!m) continue;
    const key = `${m[2]}/${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ year: m[1], number: m[2], uri: it.akn_uri, id: key });
  }
  const heads = await Promise.all(
    items.map((it) => fetchHead(consolidatedUrl(it.year, it.number, lang, "latest")).catch(() => null)),
  );
  const lines = items.map((it, i) => {
    const h = heads[i];
    const title = h?.title ?? "(nimi ei saatavilla)";
    const force = h?.inForce === "false" ? " (ei voimassa)" : "";
    return `${it.id} ${title}${force}`;
  });
  let out = `Hakutulokset (sivu ${page}):\n` + lines.join("\n");
  if (list.length >= 10) out += `\n\nLisää tuloksia voi olla: hae sivu ${page + 1}.`;
  out += "\n\nHae teksti työkaluilla saados_tiedot tai hae_pykala (vuosi ja numero).";
  return out;
}

async function saadosTiedot(args) {
  const s = await loadStatute(args);
  const { meta } = s;
  const lines = [header(s), ""];
  if (meta.dateIssued) lines.push(`Annettu: ${fmtDate(meta.dateIssued)}`);
  if (meta.dateEntryIntoForce) lines.push(`Voimaantulo: ${fmtDate(meta.dateEntryIntoForce)}`);
  if (meta.isInForce !== null) lines.push(`Voimassa: ${meta.isInForce ? "kyllä" : "ei"}`);
  if (meta.keywords.length) lines.push(`Asiasanat: ${meta.keywords.join(", ")}`);
  if (meta.preliminaryWork) lines.push(`Esityöt: ${meta.preliminaryWork}`);

  const labels = {
    amendedBy: "Muutossäädökset",
    repeals: "Kumoaa",
    repealedBy: "Kumottu säädöksellä",
    issuedUnderActs: "Annettu seuraavien säädösten nojalla",
    issuedUnderThisAct: "Tämän säädöksen nojalla annetut säädökset",
    issuedUnderAmendmentsOfThisAct: "Tämän säädöksen muutosten nojalla annetut säädökset",
  };
  const today = new Date();
  const max = Math.max(1, Number(args.muutoksia_enintaan) || 20);
  for (const [key, refs] of Object.entries(meta.relations)) {
    const label = labels[key] ?? key;
    let list = refs;
    let note = "";
    const cap = key === "amendedBy" ? max : 15;
    if (key === "amendedBy") {
      list = [...refs].sort((a, b) => (b.entryIntoForce ?? "").localeCompare(a.entryIntoForce ?? ""));
    }
    if (list.length > cap) {
      note = key === "amendedBy" ? ` (näytetään ${cap} uusinta / ${list.length})` : ` (näytetään ${cap} / ${list.length})`;
      list = list.slice(0, cap);
    }
    lines.push("", `${label}${note}:`);
    for (const r of list) {
      const d = r.entryIntoForce ? ` voimaan ${fmtDate(r.entryIntoForce)}` : "";
      const fut = r.entryIntoForce && new Date(r.entryIntoForce) > today ? " (EI VIELÄ VOIMASSA)" : "";
      const n = r.note ? ` – ${r.note}` : "";
      lines.push(`- ${r.id ?? r.href}${d}${fut}${n}`);
    }
  }
  lines.push("", "Sisällysluettelo:", tableOfContents(s.doc));
  return clip(lines.join("\n"));
}

async function haePykala(args) {
  if (!args.pykala && !args.luku) throw new UserError("Anna pykälä, luku tai molemmat.");
  const s = await loadStatute(args);
  setFutureAmendments(s.future);
  const out = [header(s), ""];
  if (args.pykala) {
    const groups = findSections(s.doc, args.pykala, args.luku);
    if (!groups.length) {
      const nums = sectionNumbers(s.doc, args.luku);
      const where = args.luku ? ` luvusta ${args.luku}` : "";
      throw new UserError(
        `Pykälää ${args.pykala}${where} ei löytynyt. ` +
          (nums.length ? `Pykälät${where}: ${nums.slice(0, 200).join(", ")}` : "Säädöksessä ei ole pykäliä.") +
          (args.luku ? "" : " Jos laissa numerointi alkaa joka luvussa alusta, anna myös luku."),
      );
    }
    if (groups.length > 3 && !args.luku) {
      const rows = groups.map((g) => {
        const sec = g.nodes.find((n) => n.name === "section");
        const chap = g.chapter ? renderGroup({ chapter: g.chapter, nodes: [] }) : "(ei lukua)";
        const head = sec ? renderGroup({ chapter: null, nodes: [sec] }).split("\n")[0] : "";
        return `- ${chap}: ${head}`;
      });
      out.push(
        `Pykälä ${args.pykala} on ${groups.length} luvussa, koska tässä laissa numerointi alkaa joka luvussa alusta. Anna luku. Vaihtoehdot:`,
        ...rows,
      );
      return clip(out.join("\n"));
    }
    if (groups.length > 1 && !args.luku) {
      out.push(
        `Pykälä ${args.pykala} löytyi ${groups.length} luvusta. Kaikki näytetään; tarkenna luvulla tarvittaessa.`,
        "",
      );
    }
    out.push(groups.map(renderGroup).join("\n\n----\n\n"));
  } else {
    const chap = findChapter(s.doc, args.luku);
    if (!chap) throw new UserError(`Lukua ${args.luku} ei löytynyt säädöksestä.`);
    out.push(render(chap, 0).join("\n"));
  }
  return clip(out.join("\n"));
}

async function etsiSaadoksesta(args) {
  const q = String(args.hakusana ?? "").trim();
  if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
  const s = await loadStatute(args);
  const hits = searchText(s.doc, q);
  const futureOf = (label) => {
    const m = label && label.match(/(\d{4})\/(\d+)$/);
    const d = m ? s.future.get(`${m[2]}/${m[1]}`) : null;
    return d ? `, EI VIELÄ VOIMASSA, voimaan ${d}` : "";
  };
  const out = [header(s), ""];
  if (!hits.length) {
    out.push(`Hakusanaa "${q}" ei löytynyt pykälien tekstistä. Kokeile sanan vartaloa tai synonyymiä.`);
  } else {
    out.push(`Osumat hakusanalle "${q}" (${hits.length}${hits.length >= 30 ? "+, näytetään 30" : ""}):`);
    for (const h of hits) {
      const loc = [h.chapter, h.section].filter(Boolean).join(" ");
      const head = h.heading ? ` ${h.heading}` : "";
      const ver = h.versionLabel ? ` [sanamuoto: ${h.versionLabel}${futureOf(h.versionLabel)}]` : "";
      out.push("", `${loc}${head}${ver}`, `  ${h.snippet}`);
    }
  }
  return clip(out.join("\n"));
}

const HANDLERS = {
  hae_saadoksia: haeSaadoksia,
  saados_tiedot: saadosTiedot,
  hae_pykala: haePykala,
  etsi_saadoksesta: etsiSaadoksesta,
};

export async function callTool(name, args = {}) {
  const fn = HANDLERS[name];
  if (!fn) return { isError: true, content: [{ type: "text", text: `Tuntematon työkalu: ${name}` }] };
  try {
    const text = await fn(args ?? {});
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg =
      e instanceof UserError
        ? e.message
        : e instanceof FinlexError
          ? `Finlex-haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : `Odottamaton virhe: ${e?.message ?? e}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

export { futureWarning };

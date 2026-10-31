// MCP-työkalut: määrittelyt ja toteutukset.

import {
  fetchText,
  fetchHead,
  cacheGetJson,
  cachePutJson,
  consolidatedUrl,
  originalUrl,
  listUrl,
  docListUrl,
  webUrl,
  proposalUrl,
  proposalWebUrl,
  FinlexError,
} from "./finlex.js";
import { parseXml } from "./xml.js";
import {
  PROPOSAL_INDEX_VERSION,
  buildProposalIndex,
  partOf,
  descendants,
  shardsFor,
  blockPath,
  findBlocks,
  detailBlocks,
  findRationale,
} from "./proposal.js";
import { parseStatute, futureWarning, finalize, normNum } from "./statute.js";
import { INDEX_VERSION, buildIndex, buildChapters, shardOf, findGroups, chapterIndex, sectionNumbers, searchIndex } from "./statuteIndex.js";
import {
  SOURCES,
  decisionUrl,
  decisionWebUrl,
  decisionListUrl,
  keywordValue,
  parseDecision,
  renderDecisionBody,
  pdfText,
} from "./decisions.js";

// Claude rajaa työkalun vastauksen 25 000 tokeniin; suomenkielinen teksti
// vie noin 3 merkkiä/token, joten 50 000 merkkiä jättää varaa.
const MAX_OUTPUT = 50_000;

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
  {
    name: "hae_ratkaisuja",
    description:
      "Hakee Finlexistä viranomaisratkaisuja: tietosuojavaltuutettu, eduskunnan oikeusasiamies tai oikeuskansleri. Haku otsikon osalla, asiasanalla ja/tai vuosilla. Palauttaa ratkaisujen numerot, päivämäärät ja otsikot. Tuomioistuinten (KKO, KHO) ratkaisuja Finlexin avoimessa datassa ei ole.",
    inputSchema: {
      type: "object",
      properties: {
        lahde: {
          type: "string",
          enum: ["tietosuojavaltuutettu", "oikeusasiamies", "oikeuskansleri"],
          description: "Ratkaisija.",
        },
        otsikko: { type: "string", description: "Merkkijono, jonka ratkaisun otsikko sisältää (esim. \"kameravalvonta\", \"terveys\")." },
        asiasana: { type: "string", description: "Finlexin asiasana, esim. \"kameravalvonta\", \"terveystiedot\", \"oikeus tulla unohdetuksi\"." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
      required: ["lahde"],
    },
  },
  {
    name: "hae_ratkaisu",
    description:
      "Palauttaa yhden viranomaisratkaisun (tietosuojavaltuutettu, oikeusasiamies, oikeuskansleri) tiedot ja tekstin: päivämäärä, diaarinumero, ratkaisija, asiasanat ja koko teksti. Jos ratkaisu on Finlexissä vain PDF:nä, teksti puretaan PDF:stä.",
    inputSchema: {
      type: "object",
      properties: {
        lahde: {
          type: "string",
          enum: ["tietosuojavaltuutettu", "oikeusasiamies", "oikeuskansleri"],
          description: "Ratkaisija.",
        },
        vuosi: { type: "integer", description: "Ratkaisun vuosi hakutuloksesta, esim. 2025." },
        numero: { type: "string", description: "Ratkaisun numero hakutuloksesta, esim. \"2443\"." },
      },
      required: ["lahde", "vuosi", "numero"],
    },
  },
  {
    name: "hae_hallituksen_esityksia",
    description:
      "Hakee Finlexistä hallituksen esityksiä otsikon osalla ja/tai vuosilla. Palauttaa tunnukset (HE numero/vuosi) ja otsikot. Säädöksen oman esityksen tunnus löytyy myös saados_tiedot-työkalun Esityöt-rivistä. Finlexin avoimessa datassa ovat esitykset vuodesta 1992.",
    inputSchema: {
      type: "object",
      properties: {
        otsikko: { type: "string", description: "Merkkijono, jonka esityksen otsikko sisältää, esim. \"arvonlisäverolain\" tai \"sosiaalihuoltolain\"." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta. Tulokset ovat antopäivän mukaan vanhimmasta uusimpaan." },
      },
    },
  },
  {
    name: "hallituksen_esitys",
    description:
      "Palauttaa hallituksen esityksen tekstiä Finlexistä. Ilman lisäparametreja: otsikko, antopäivä, ministeriö, esityksen pääasiallinen sisältö, perustelujen sisällysluettelo, lakiehdotukset ja liitteet. Parametrilla osa yksi perustelujen lohko (esim. \"7.1\" tai \"Nykytila\"), parametrilla pykala lakiehdotuksen pykälän säännöskohtaiset (yksityiskohtaiset) perustelut, parametrilla lakiehdotus lakiehdotuksen teksti ja parametrilla liite liitteen teksti (esim. rinnakkaisteksti tai asetusluonnos).",
    inputSchema: {
      type: "object",
      properties: {
        vuosi: { type: "integer", description: "Esityksen vuosi, esim. 1993 tunnuksesta HE 88/1993. Kaksinumeroinen vuosi (HE 88/93) tulkitaan 1900- tai 2000-luvuksi." },
        numero: { type: "string", description: "Esityksen numero, esim. \"88\"." },
        osa: { type: "string", description: "Perustelujen lohko numerolla (\"2.1\"), otsikolla tai sisällysluettelon tunnisteella (\"#12\"). Valinnainen." },
        pykala: { type: "string", description: "Pykälä, jonka säännöskohtaiset perustelut haetaan, esim. \"3\" tai \"12 a\". Sopimusesityksissä artikla, esim. \"3 artikla\". Valinnainen." },
        lakiehdotus: { type: "integer", description: "Lakiehdotuksen järjestysnumero (1 = ensimmäinen). Valinnainen." },
        liite: { type: "integer", description: "Liitteen järjestysnumero (1 = ensimmäinen). Valinnainen." },
      },
      required: ["vuosi", "numero"],
    },
  },
  {
    name: "etsi_hallituksen_esityksesta",
    description:
      "Etsii yhden hallituksen esityksen tekstistä (pääasiallinen sisältö, perustelut ja lakiehdotukset) sanaa tai sanontaa ja palauttaa osumat lohkoittain lyhyine otteineen. Hae sen jälkeen koko lohko hallituksen_esitys-työkalun osa-parametrilla. Haku on kirjaimellinen: käytä sanan vartaloa.",
    inputSchema: {
      type: "object",
      properties: {
        vuosi: { type: "integer", description: "Esityksen vuosi, esim. 1993." },
        numero: { type: "string", description: "Esityksen numero, esim. \"88\"." },
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä)." },
      },
      required: ["vuosi", "numero", "hakusana"],
    },
  },
];

// Työkalujen merkinnät (MCP tool annotations): kaikki työkalut vain lukevat
// julkista dataa eivätkä muuta mitään.
const TITLES = {
  hae_saadoksia: "Hae säädöksiä",
  saados_tiedot: "Säädöksen tiedot",
  hae_pykala: "Hae pykälä",
  etsi_saadoksesta: "Etsi säädöksen tekstistä",
  hae_ratkaisuja: "Hae viranomaisratkaisuja",
  hae_ratkaisu: "Hae viranomaisratkaisu",
  hae_hallituksen_esityksia: "Hae hallituksen esityksiä",
  hallituksen_esitys: "Hallituksen esitys",
  etsi_hallituksen_esityksesta: "Etsi hallituksen esityksestä",
};
for (const t of TOOLS) {
  t.annotations = {
    title: TITLES[t.name] ?? t.name,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

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

// Hakemiston osat välimuistissa (ks. statuteIndex.js). Lisäksi isolaatin muistissa
// pidetään viimeksi käytetyt osat: peräkkäiset kutsut samaan säädökseen (yleistä)
// eivät tarvitse edes JSON-jäsennystä.
const MEMO_MAX = 32;
const memo = new Map();

function memoGet(key) {
  const e = memo.get(key);
  if (!e) return undefined;
  memo.delete(key);
  if (e.exp < Date.now()) return undefined;
  memo.set(key, e);
  return e.value;
}

function memoSet(key, value, ttl) {
  memo.delete(key);
  memo.set(key, { value, exp: Date.now() + ttl * 1000 });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

const partKey = (url, part, v = INDEX_VERSION) => `${url}?_index=${v}&_part=${part}`;

/** Lukee hakemiston osan muistista tai välimuistista. undefined, jos ei löydy. */
async function getPart(url, part, ttl, version = INDEX_VERSION) {
  const key = partKey(url, part, version);
  let v = memoGet(key);
  if (v !== undefined) return v;
  v = await cacheGetJson(key);
  if (v !== undefined) memoSet(key, v, ttl);
  return v;
}

async function putParts(url, ttl, parts, version = INDEX_VERSION) {
  await Promise.all(
    Object.entries(parts).map(([part, v]) => {
      memoSet(partKey(url, part, version), v, ttl);
      return cachePutJson(partKey(url, part, version), v, ttl);
    }),
  );
}

async function loadStatute(args) {
  const year = asYear(args.vuosi);
  const number = asNumber(args.numero);
  const lang = asLang(args.kieli);
  const original = args.teksti === "alkuperainen";
  const requestedUrl = original ? originalUrl(year, number, lang) : consolidatedUrl(year, number, lang, versionToken(args.versio));
  const ttl = original || (args.versio && args.versio !== "latest") ? 30 * 86400 : 6 * 3600;

  // Hakemisto tallennetaan pyydetyllä osoitteella; base kertoo, käytettiinkö alkuperäistä.
  let base = await getPart(requestedUrl, "base", ttl);
  let built = null;
  if (!base || base.v !== INDEX_VERSION) {
    let url = requestedUrl;
    let fellBack = false;
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
    built = { ...buildIndex(doc), doc };
    base = { ...built.base, apiUrl: url, fellBack };
    const parts = { base, texts: built.texts };
    built.shards.forEach((sh, i) => (parts[`g${i}`] = sh));
    await putParts(requestedUrl, ttl, parts);
  }
  const meta = base.meta;
  const today = new Date().toISOString().slice(0, 10);
  const future = new Map();
  for (const r of meta.relations.amendedBy ?? []) {
    if (r.id && r.entryIntoForce && r.entryIntoForce > today) future.set(r.id, fmtDate(r.entryIntoForce));
  }
  const fellBack = !!base.fellBack;
  return { base, built, meta, year, number, lang, original: original || fellBack, fellBack, apiUrl: base.apiUrl, requestedUrl, ttl, future };
}

/** Säädöksen XML jäsennettynä (vain kun hakemiston osa puuttuu välimuistista). */
async function loadDoc(s) {
  if (s.built) return s.built.doc;
  const xml = await fetchText(s.apiUrl, { ttl: s.ttl });
  const doc = xml === null ? null : parseStatute(xml);
  if (!doc) throw new UserError(`Säädöksen ${s.number}/${s.year} tekstiä ei saatu Finlexistä.`);
  return doc;
}

/**
 * Hakemiston osa. partOf(base) antaa osan nimen. Jos osa on poistunut välimuistista,
 * hakemisto muodostetaan uudelleen ja kaikki osat tallennetaan (myös base, koska
 * Finlexin päivittämässä tekstissä osien määrä voi olla eri).
 */
async function loadPart(s, partOf) {
  if (s.built) {
    const name = partOf(s.base);
    return name === "texts" ? s.built.texts : s.built.shards[Number(name.slice(1))];
  }
  const v = await getPart(s.requestedUrl, partOf(s.base), s.ttl);
  if (v !== undefined) return v;
  const idx = buildIndex(await loadDoc(s));
  const base = { ...idx.base, apiUrl: s.apiUrl, fellBack: s.fellBack };
  const parts = { base, texts: idx.texts };
  idx.shards.forEach((sh, i) => (parts[`g${i}`] = sh));
  await putParts(s.requestedUrl, s.ttl, parts);
  s.base = base;
  return parts[partOf(base)];
}

const loadTexts = (s) => loadPart(s, () => "texts");
const loadShard = (s, pykala) => loadPart(s, (base) => `g${shardOf(normNum(pykala), base.n)}`);

/** Lukujen muotoiltu teksti. Erillinen osa; tarvitaan harvoin. */
async function loadChapters(s) {
  let chapters = await getPart(s.requestedUrl, "ch", s.ttl);
  if (Array.isArray(chapters)) return chapters;
  chapters = buildChapters(await loadDoc(s));
  await putParts(s.requestedUrl, s.ttl, { ch: chapters });
  return chapters;
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
      // ISO-päivämäärät: tavallinen merkkijonovertailu. localeCompare alustaisi
      // ensimmäisellä kutsulla ICU-lajittelun, mikä vie useita millisekunteja CPU-aikaa.
      list = [...refs].sort((a, b) => {
        const x = b.entryIntoForce ?? "";
        const y = a.entryIntoForce ?? "";
        return x < y ? -1 : x > y ? 1 : 0;
      });
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
  lines.push("", "Sisällysluettelo:", s.base.toc);
  return clip(lines.join("\n"));
}

async function haePykala(args) {
  if (!args.pykala && !args.luku) throw new UserError("Anna pykälä, luku tai molemmat.");
  const s = await loadStatute(args);
  const fin = (t) => finalize(t, s.future);
  const out = [header(s), ""];
  if (args.pykala) {
    const groups = findGroups(s.base, await loadShard(s, args.pykala), args.pykala, args.luku);
    if (!groups.length) {
      const nums = sectionNumbers(s.base, args.luku);
      const where = args.luku ? ` luvusta ${args.luku}` : "";
      throw new UserError(
        `Pykälää ${args.pykala}${where} ei löytynyt. ` +
          (nums.length ? `Pykälät${where}: ${nums.slice(0, 200).join(", ")}` : "Säädöksessä ei ole pykäliä.") +
          (args.luku ? "" : " Jos laissa numerointi alkaa joka luvussa alusta, anna myös luku."),
      );
    }
    if (groups.length > 3 && !args.luku) {
      const rows = groups.map((g) => `- ${g.c >= 0 ? s.base.chapters[g.c].l : "(ei lukua)"}: ${fin(g.h1)}`);
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
    out.push(fin(groups.map((g) => g.r).join("\n\n----\n\n")));
  } else {
    const ci = chapterIndex(s.base, args.luku);
    if (ci === -1) throw new UserError(`Lukua ${args.luku} ei löytynyt säädöksestä.`);
    const chapters = await loadChapters(s);
    out.push(fin(chapters[ci]));
  }
  return clip(out.join("\n"));
}

async function etsiSaadoksesta(args) {
  const q = String(args.hakusana ?? "").trim();
  if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
  const s = await loadStatute(args);
  const hits = searchIndex(s.base, await loadTexts(s), q);
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

// ---------- Hallituksen esitykset ----------

const PROPOSAL_TTL = 30 * 86400; // Annettu esitys ei muutu.

function asProposalYear(v) {
  let n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n < 100) n += n >= 60 ? 1900 : 2000;
  if (!Number.isInteger(n) || n < 1900 || n > 2200) throw new UserError("Anna esityksen vuosi, esim. 1993 tunnuksesta HE 88/1993.");
  return n;
}

function asProposalNumber(v) {
  const s = String(v ?? "").trim();
  if (!/^[0-9]{1,4}$/.test(s)) throw new UserError("Anna esityksen numero, esim. \"88\" tunnuksesta HE 88/1993.");
  return s.replace(/^0+(?=\d)/, "");
}

function proposalParts(idx) {
  const parts = { base: idx.base };
  idx.shards.forEach((p, i) => (parts[`p${i}`] = p));
  idx.billParts.forEach((p, i) => (parts[`b${i}`] = p));
  idx.attachmentParts.forEach((p, i) => (parts[`a${i}`] = p));
  return parts;
}

async function loadProposal(args) {
  const year = asProposalYear(args.vuosi);
  const number = asProposalNumber(args.numero);
  // Vain suomenkielinen: ruotsinkielisistä esityksistä avoimessa datassa on vain otsikko.
  const lang = "fin";
  const url = proposalUrl(year, number, lang);
  const s = { url, year, number, lang, built: null };
  let base = await getPart(url, "base", PROPOSAL_TTL, PROPOSAL_INDEX_VERSION);
  if (!base || base.v !== PROPOSAL_INDEX_VERSION) {
    s.built = await buildProposal(s);
    base = s.built.base;
  }
  s.base = base;
  if (base.absent && !base.intro && !base.blocks.length && !base.bills.length) {
    throw new UserError(
      `Esityksestä ${base.docNumber || `HE ${number}/${year}`} on Finlexin avoimessa datassa vain otsikko: ${base.title}. Teksti: ${proposalWebUrl(year, number)}`,
    );
  }
  return s;
}

async function buildProposal(s) {
  const xml = await fetchText(s.url, { ttl: PROPOSAL_TTL });
  if (xml === null) {
    throw new UserError(
      `Hallituksen esitystä HE ${s.number}/${s.year} ei löytynyt Finlexistä (${s.lang}). Finlexin avoimessa datassa ovat esitykset vuodesta 1992 alkaen.`,
    );
  }
  const idx = buildProposalIndex(parseXml(xml));
  if (!idx) throw new UserError(`Finlexin vastausta esitykselle HE ${s.number}/${s.year} ei voitu tulkita.`);
  await putParts(s.url, PROPOSAL_TTL, proposalParts(idx), PROPOSAL_INDEX_VERSION);
  return idx;
}

/** Hakemiston osa ("p3", "b0", "a1"). Jos osa on poistunut välimuistista, esitys jäsennetään uudelleen. */
async function proposalPart(s, name) {
  const fromBuilt = (idx) => {
    const k = Number(name.slice(1));
    return name[0] === "p" ? idx.shards[k] : name[0] === "b" ? idx.billParts[k] : idx.attachmentParts[k];
  };
  if (s.built) return fromBuilt(s.built);
  const v = await getPart(s.url, name, PROPOSAL_TTL, PROPOSAL_INDEX_VERSION);
  if (v !== undefined) return v;
  s.built = await buildProposal(s);
  s.base = s.built.base;
  return fromBuilt(s.built);
}

/** Kappaleet väliltä [start, end): palauttaa paraAt(i). */
async function proposalParas(s, start, end) {
  const loaded = new Map();
  for (const k of shardsFor(s.base, start, end)) loaded.set(k, await proposalPart(s, `p${k}`));
  return (i) => {
    const k = partOf(s.base.shardStarts, i);
    return loaded.get(k)[i - s.base.shardStarts[k]];
  };
}

function proposalHeader(s) {
  const b = s.base;
  const lines = [`${b.docNumber || `HE ${s.number}/${s.year}`} ${b.title}`.trim()];
  const info = [];
  if (b.dateIssued) info.push(`Annettu ${fmtDate(b.dateIssued)}`);
  if (b.ministry) info.push(`ministeriö: ${b.ministry}`);
  if (info.length) lines.push(info.join(", ") + ".");
  lines.push(`Lähde: ${proposalWebUrl(s.year, s.number)}`);
  return lines.join("\n");
}

const blockLabel = (b) => [b.num, b.heading].filter(Boolean).join(" ") || "(otsikoton lohko)";

async function haeHallituksenEsityksia(args) {
  if (!args.otsikko && !args.alkaen_vuosi && !args.paattyen_vuosi) throw new UserError("Anna otsikko tai vuosi.");
  const page = Math.max(1, Number(args.sivu) || 1);
  const params = {
    langAndVersion: "fin@",
    titleContains: args.otsikko,
    startYear: args.alkaen_vuosi,
    endYear: args.paattyen_vuosi,
    limit: 10,
    page,
    sortBy: "dateIssued",
  };
  const raw = await fetchText(docListUrl("government-proposal", params), { ttl: 3600, accept: "application/json" });
  const list = raw ? JSON.parse(raw) : [];
  if (!list.length) return page > 1 ? "Ei enempää tuloksia." : "Ei osumia. Kokeile lyhyempää otsikon osaa (esim. sanan vartaloa \"arvonlisävero\").";
  const items = [];
  const seen = new Set();
  for (const it of list) {
    const m = String(it.akn_uri).match(/government-proposal\/(\d{4})\/(\d+)\//);
    if (!m || seen.has(`${m[2]}/${m[1]}`)) continue;
    seen.add(`${m[2]}/${m[1]}`);
    items.push({ year: m[1], number: m[2] });
  }
  const heads = await Promise.all(items.map((it) => fetchHead(proposalUrl(it.year, it.number, "fin")).catch(() => null)));
  const lines = items.map((it, i) => `HE ${it.number}/${it.year} ${heads[i]?.title ?? "(otsikko ei saatavilla)"}`);
  let out = `Hallituksen esitykset (sivu ${page}, vanhimmasta uusimpaan):\n` + lines.join("\n");
  if (list.length >= 10) out += `\n\nLisää tuloksia voi olla: hae sivu ${page + 1}.`;
  out += "\n\nHae esitys työkalulla hallituksen_esitys (vuosi ja numero).";
  return out;
}

async function hallituksenEsitys(args) {
  const s = await loadProposal(args);
  const b = s.base;
  const out = [proposalHeader(s), ""];

  if (args.lakiehdotus !== undefined || args.liite !== undefined) {
    const isBill = args.lakiehdotus !== undefined;
    const n = Number(isBill ? args.lakiehdotus : args.liite);
    const names = isBill ? b.bills : b.attachments;
    const what = isBill ? "Lakiehdotus" : "Liite";
    if (!Number.isInteger(n) || n < 1 || n > names.length) {
      throw new UserError(names.length ? `${what} ${n} ei ole olemassa. Esityksessä on ${names.length} ${isBill ? "lakiehdotusta" : "liitettä"}.` : `Esityksessä ei ole ${isBill ? "lakiehdotuksia" : "liitteitä"}.`);
    }
    const starts = isBill ? b.billStarts : b.attachmentStarts;
    const k = partOf(starts, n - 1);
    const texts = await proposalPart(s, `${isBill ? "b" : "a"}${k}`);
    out.push(`${what} ${n}: ${names[n - 1]}`, "", finalize(texts[n - 1 - starts[k]]));
    return clip(out.join("\n"));
  }

  if (args.pykala !== undefined && args.pykala !== "") {
    const details = detailBlocks(b);
    if (!details.length) {
      out.push("Esityksessä ei ole erillisiä säännöskohtaisia (yksityiskohtaisia) perusteluja. Etsi pykälää etsi_hallituksen_esityksesta-työkalulla.");
      return out.join("\n");
    }
    const found = findRationale(b, args.pykala);
    if (found === null) throw new UserError("Anna pykälä numerona, esim. \"3\" tai \"12 a\", tai artikla, esim. \"3 artikla\".");
    if (!found.length) {
      const labels = [...new Set(b.rationaleIndex.map((r) => r.l))].slice(0, 300);
      out.push(
        `${/artikla/i.test(String(args.pykala)) ? `Kohdan ${args.pykala}` : `Pykälän ${args.pykala}`} perusteluja ei löytynyt säännöskohtaisista perusteluista.` +
          (labels.length ? ` Perusteluissa käsitellyt pykälät ja artiklat: ${labels.join(", ")}.` : "") +
          " Kaikkia pykäliä ei aina perustella erikseen. Kokeile etsi_hallituksen_esityksesta-työkalua.",
      );
      return clip(out.join("\n"));
    }
    const hits = [];
    for (const r of found) {
      const paraAt = await proposalParas(s, r.s, r.e);
      const parts = [];
      for (let i = r.s; i < r.e; i++) parts.push(paraAt(i).t);
      hits.push({ path: r.b >= 0 ? blockPath(b, r.b) : "", text: parts.join("\n\n") });
    }
    out.push(`${/artikla/i.test(String(args.pykala)) ? `Kohdan ${args.pykala}` : `Pykälän ${args.pykala}`} säännöskohtaiset perustelut${hits.length > 1 ? ` (${hits.length} osumaa, esim. eri lakiehdotuksista)` : ""}:`);
    for (const h of hits) out.push("", `Lohko: ${h.path}`, "", h.text);
    out.push("", "Perustelu on rajattu pykälän tai artiklan aloittavasta kappaleesta seuraavan alkuun. Tarkista tarvittaessa koko lohko osa-parametrilla.");
    return clip(out.join("\n"));
  }

  if (args.osa !== undefined && args.osa !== "") {
    const found = findBlocks(b, args.osa);
    if (!found.length) throw new UserError(`Lohkoa "${args.osa}" ei löytynyt. Katso sisällysluettelo hakemalla esitys ilman osa-parametria.`);
    if (found.length > 1) {
      out.push(`"${args.osa}" vastaa useaa lohkoa. Valitse tunnisteella:`);
      for (const i of found.slice(0, 20)) out.push(`- osa "#${i}": ${blockPath(b, i)}`);
      return out.join("\n");
    }
    const i = found[0];
    const blk = b.blocks[i];
    const paraAt = await proposalParas(s, blk.start, blk.end);
    out.push(blockPath(b, i), "");
    const subs = descendants(b, i);
    let cursor = blk.start;
    const body = [];
    for (const d of subs) {
      for (; cursor < b.blocks[d].start; cursor++) body.push(paraAt(cursor).t);
      body.push(`${"#".repeat(Math.min(6, b.blocks[d].depth - blk.depth + 1))} ${blockLabel(b.blocks[d])}`);
    }
    for (; cursor < blk.end; cursor++) body.push(paraAt(cursor).t);
    out.push(body.join("\n\n") || "(lohkossa ei ole tekstiä)");
    return clip(out.join("\n"));
  }

  // Yleiskuva.
  if (b.intro) out.push("ESITYKSEN PÄÄASIALLINEN SISÄLTÖ", "", b.intro, "");
  if (b.blocks.length) {
    out.push('Perustelujen sisällys (hae lohko osa-parametrilla, esim. osa: "2.1"; suluissa tekstin pituus merkkeinä):');
    for (const blk of b.blocks) out.push(`${"  ".repeat(blk.depth)}${blockLabel(blk)} (${fmtCount(blk.len)})`);
    const details = detailBlocks(b);
    if (details.length) out.push("", `Säännöskohtaiset perustelut: ${details.map((d) => blockLabel(b.blocks[d])).join(", ")}. Yksittäisen pykälän perustelut saa pykala-parametrilla.`);
    out.push("");
  }
  if (b.bills.length) {
    out.push("Lakiehdotukset (teksti lakiehdotus-parametrilla, esim. lakiehdotus: 1):");
    b.bills.forEach((t, i) => out.push(`${i + 1}. ${t}`));
    out.push("");
  }
  if (b.attachments.length) {
    out.push("Liitteet (teksti liite-parametrilla):");
    b.attachments.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  }
  return clip(out.join("\n").trimEnd());
}

// Tuhaterotin ilman Intl.NumberFormatia (sen luonti alustaa ICU:n, mikä vie kylmänä
// isolaatissa yli 10 ms CPU-aikaa).
const fmtCount = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");

async function etsiHallituksenEsityksesta(args) {
  const q = String(args.hakusana ?? "").trim();
  if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
  const s = await loadProposal(args);
  const b = s.base;
  const ql = q.toLowerCase();
  const MAX = 30;
  const hits = [];
  const snippet = (t, i) => {
    const start = Math.max(0, i - 120);
    return (start > 0 ? "…" : "") + t.slice(start, i + q.length + 160) + "…";
  };
  const i0 = b.intro.toLowerCase().indexOf(ql);
  if (i0 !== -1) hits.push({ where: "Esityksen pääasiallinen sisältö", text: snippet(b.intro, i0) });
  if (b.nParas) {
    const paraAt = await proposalParas(s, 0, b.nParas);
    for (let i = 0; i < b.nParas && hits.length < MAX; i++) {
      const p = paraAt(i);
      const j = p.t.toLowerCase().indexOf(ql);
      if (j === -1) continue;
      hits.push({ where: p.b >= 0 ? `${blockPath(b, p.b)} [osa "#${p.b}"]` : "Perustelut", text: snippet(p.t, j) });
    }
  }
  for (let n = 0; n < b.bills.length && hits.length < MAX; n++) {
    const k = partOf(b.billStarts, n);
    const t = (await proposalPart(s, `b${k}`))[n - b.billStarts[k]];
    const j = t.toLowerCase().indexOf(ql);
    if (j !== -1) hits.push({ where: `Lakiehdotus ${n + 1}: ${b.bills[n]}`, text: snippet(finalize(t), j) });
  }
  const out = [proposalHeader(s), ""];
  if (!hits.length) {
    out.push(`Hakusanaa "${q}" ei löytynyt esityksestä. Kokeile sanan vartaloa tai synonyymiä.`);
  } else {
    out.push(`Osumat hakusanalle "${q}" (${hits.length}${hits.length >= MAX ? "+, näytetään 30" : ""}):`);
    for (const h of hits) out.push("", h.where, `  ${h.text}`);
    out.push("", 'Hae koko lohko hallituksen_esitys-työkalulla, esim. osa: "#12".');
  }
  return clip(out.join("\n"));
}

// ---------- Viranomaisratkaisut ----------

function asSource(v) {
  if (!SOURCES[v]) throw new UserError(`Anna lahde: ${Object.keys(SOURCES).join(", ")}.`);
  return SOURCES[v];
}

async function loadDecision(src, year, number) {
  const xml = await fetchText(decisionUrl(src, year, number), { ttl: 7 * 86400 });
  if (xml === null) return null;
  return parseDecision(xml);
}

async function haeRatkaisuja(args) {
  const src = asSource(args.lahde);
  const page = Math.max(1, Number(args.sivu) || 1);
  let start = args.alkaen_vuosi ? asYear(args.alkaen_vuosi) : undefined;
  let end = args.paattyen_vuosi ? asYear(args.paattyen_vuosi) : undefined;
  let note = "";
  if (!args.otsikko && !args.asiasana && !start && !end) {
    const y = new Date().getUTCFullYear();
    start = y - 1;
    end = y;
    note = ` (ei hakuehtoja, näytetään vuodet ${start}–${end})`;
  }
  const params = {
    titleContains: args.otsikko,
    keyword: args.asiasana ? keywordValue(args.asiasana) : undefined,
    startYear: start,
    endYear: end,
    limit: 10,
    page,
    sortBy: "dateIssued",
  };
  const raw = await fetchText(decisionListUrl(src, params), { ttl: 3600, accept: "application/json" });
  const list = raw ? JSON.parse(raw) : [];
  if (!list.length) {
    return page > 1
      ? "Ei enempää tuloksia."
      : "Ei osumia. Kokeile lyhyempää otsikon osaa, toista asiasanaa tai laajempaa vuosiväliä.";
  }
  const items = [];
  const seen = new Set();
  for (const it of list) {
    const m = String(it.akn_uri).match(/judgment\/[^/]+\/(\d{4})\/([^/]+)\//);
    if (!m || seen.has(`${m[1]}/${m[2]}`)) continue;
    seen.add(`${m[1]}/${m[2]}`);
    items.push({ year: m[1], number: m[2] });
  }
  const docs = await Promise.all(items.map((it) => loadDecision(src, it.year, it.number).catch(() => null)));
  const rows = items.map((it, i) => {
    const d = docs[i];
    const date = d?.dateIssued ? fmtDate(d.dateIssued) : "?";
    const diary = d?.diaryNumber ? ` (${d.diaryNumber})` : "";
    return `vuosi ${it.year}, numero ${it.number}: ${date} ${d?.title ?? "(otsikko ei saatavilla)"}${diary}`;
  });
  let out = `${src.label}, hakutulokset (sivu ${page})${note}. Järjestys: vanhimmasta uusimpaan.\n` + rows.join("\n");
  if (list.length >= 10) out += `\n\nLisää tuloksia voi olla: hae sivu ${page + 1} tai rajaa vuosilla.`;
  out += "\n\nHae ratkaisun teksti työkalulla hae_ratkaisu (lahde, vuosi, numero).";
  return out;
}

async function haeRatkaisu(args) {
  const src = asSource(args.lahde);
  const year = asYear(args.vuosi);
  const number = asNumber(args.numero);
  const d = await loadDecision(src, year, number);
  if (!d) throw new UserError(`Ratkaisua ${number}/${year} (${src.label}) ei löytynyt Finlexistä.`);
  const lines = [`${src.label}: ${d.title ?? "(otsikoton ratkaisu)"}`];
  if (d.dateIssued) lines.push(`Päivämäärä: ${fmtDate(d.dateIssued)}`);
  if (d.diaryNumber) lines.push(`Diaarinumero: ${d.diaryNumber}`);
  if (d.decisionMaker) lines.push(`Ratkaisija: ${d.decisionMaker}`);
  if (d.presentingOfficial) lines.push(`Esittelijä: ${d.presentingOfficial}`);
  if (d.typeOfMeasure) lines.push(`Toimenpide: ${d.typeOfMeasure}`);
  if (d.legalBasis) lines.push(`Peruste: ${d.legalBasis}`);
  if (d.administrativeBranch) lines.push(`Hallinnonala: ${d.administrativeBranch}`);
  if (d.keywords.length) lines.push(`Asiasanat: ${d.keywords.join(", ")}`);
  lines.push(`Lähde: ${decisionWebUrl(src, year, number)}`);

  const bodyText = renderDecisionBody(d.body);
  if (bodyText) lines.push("", bodyText);

  for (const rel of d.pdfs.slice(0, 2)) {
    const url = `${decisionUrl(src, year, number)}/${rel.replace(/^\.?\//, "")}`;
    try {
      const pdf = await pdfText(url);
      if (pdf?.text) {
        lines.push("", `--- Ratkaisun teksti PDF:stä (${pdf.pages} s., automaattisesti purettu, muotoilu voi poiketa alkuperäisestä) ---`, pdf.text);
      } else {
        lines.push("", `PDF: ${url} (tekstiä ei saatu purettua)`);
      }
    } catch (e) {
      lines.push("", `PDF: ${url} (purku epäonnistui: ${e?.message ?? e})`);
    }
  }
  if (!bodyText && !d.pdfs.length) lines.push("", "(Ratkaisulle ei ole tekstiä Finlexin avoimessa datassa.)");
  return clip(lines.join("\n"));
}

const HANDLERS = {
  hae_saadoksia: haeSaadoksia,
  saados_tiedot: saadosTiedot,
  hae_pykala: haePykala,
  etsi_saadoksesta: etsiSaadoksesta,
  hae_ratkaisuja: haeRatkaisuja,
  hae_ratkaisu: haeRatkaisu,
  hae_hallituksen_esityksia: haeHallituksenEsityksia,
  hallituksen_esitys: hallituksenEsitys,
  etsi_hallituksen_esityksesta: etsiHallituksenEsityksesta,
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

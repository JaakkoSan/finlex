// Savutesti: kutsuu Workerin fetch-käsittelijää suoraan Nodessa oikeaa Finlexiä vasten.
// Ajo: node test/smoke.mjs   (vaatii Node 20+)

import worker from "../src/index.js";
import { excerpts } from "../src/tools.js";
import { kilaUrlAllowed } from "../src/kila.js";
import { HVA_FEEDS, feedItems } from "../src/tiedotteet.js";
import { menCacheTtl, menSearchTerms, menQueryMatch } from "../src/men.js";
import { readFileSync } from "node:fs";

const env = {};
let id = 0;

async function rpc(method, params) {
  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const res = await worker.fetch(req, env);
  return res.json();
}

async function tool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result.content.map((c) => c.text).join("\n");
  return { isError: !!r.result.isError, text };
}

function check(cond, label) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
check(init.result?.serverInfo?.name === "finlex", "initialize");
const list = await rpc("tools/list", {});
check(list.result?.tools?.length === 32, "tools/list (32 työkalua)");

const show = process.argv.includes("-v");
const cases = [
  ["hae_saadoksia", { otsikko: "arvonlisäverolaki" }, (t) => t.includes("1501/1993") && t.includes("Arvonlisäverolaki")],
  ["hae_saadoksia", { otsikko: "osakeyhtiölaki" }, (t) => t.includes("624/2006")],
  ["hae_hallituksen_esityksia", { otsikko: "sosiaalihuolto", sivu: 2 }, (t) => t.includes("sivu 2") && t.includes("HE ")],
  ["saados_tiedot", { vuosi: 2018, numero: "1050" }, (t) => t.includes("Tietosuojalaki") && t.includes("AJANTASAINEN")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "3" }, (t) => t.includes("3 §") && t.includes("Huomautus")],
  ["hae_pykala", { vuosi: 2006, numero: "624", luku: "13", pykala: "2" }, (t) => t.includes("13 luku") && t.includes("2 §")],
  ["hae_pykala", { vuosi: 2006, numero: "624", pykala: "1" }, (t) => t.includes("Anna luku")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "999" }, (t) => t.includes("ei löytynyt")],
  ["etsi_saadoksesta", { vuosi: 1993, numero: "1501", hakusana: "maksuperust" }, (t) => t.includes("Osumat")],
  ["hae_pykala", { vuosi: 2018, numero: "1050", pykala: "1", teksti: "alkuperainen" }, (t) => t.includes("ALKUPERÄINEN")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "3", versio: "448/2024" }, (t) => t.includes("3 §")],
  ["hae_pykala", { vuosi: 2019, numero: "872", pykala: "1", kieli: "swe" }, (t) => t.includes("1 §")],
  ["hae_hallituksen_esityksia", { otsikko: "arvonlisäverolaiksi", paattyen_vuosi: 1995 }, (t) => t.includes("HE 88/1993")],
  ["hallituksen_esitys", { vuosi: 2024, numero: "1" }, (t) => t.includes("PÄÄASIALLINEN SISÄLTÖ") && t.includes("7.1 Laki rajavartiolaitoksen hallinnosta")],
  ["hallituksen_esitys", { vuosi: 93, numero: "88", pykala: "3" }, (t) => t.includes("3 §. Hallinnollisista syistä")],
  ["hallituksen_esitys", { vuosi: 2024, numero: "1", osa: "2.3.1" }, (t) => t.includes("Tarve poiketa julkisesta hakumenettelystä")],
  ["hallituksen_esitys", { vuosi: 2024, numero: "1", lakiehdotus: 2 }, (t) => t.includes("34 g §")],
  ["etsi_hallituksen_esityksesta", { vuosi: 2024, numero: "1", hakusana: "kadet" }, (t) => t.includes("Osumat")],
  ["eduskuntakasittely", { asia: "HE 74/2022 vp" }, (t) => t.includes("PeVL 38/2022 vp") && t.includes("säädös 116/2023") && t.includes("16.11.2022 Toinen käsittely") && t.includes("vastalause")],
  ["eduskuntakasittely", { asia: "HE 44/2002" }, (t) => t.includes("LaVM 28/2002 vp") && t.includes("1. Laki rikoslain muuttamisesta")],
  ["eduskunnan_aanestykset", { aanestys: "2026-71-3" }, (t) => t.includes("Tulos: jaa 100, ei 22, tyhjiä 52, poissa 25") && t.includes("Hallitusryhmät")],
  ["eduskunnan_aanestykset", { asia: "HE 151/2026 vp", edustaja: "Petteri Orpo" }, (t) => t.includes("2026-104-1") && t.includes("Petteri Orpo (kok)")],
  ["eduskunnan_aanestykset", { hakusana: "alkoholilain" }, (t) => t.includes("osumaa") && t.includes("HE 131/2025 vp")],
  ["viranomaistiedotteet", {}, (t) => t.includes("Syötteissä nyt:") && t.includes("Fimea") && t.includes("LVV")],
  ["viranomaistiedotteet", { viranomainen: "tukes", hakusana: "kosmet" }, (t) => t.includes("Tukes ·") && t.includes("tukes.fi/-/")],
  ["viranomaistiedote", { osoite: "https://www.sttinfo.fi/tiedote/72460137/perintayhtio-ei-voi-peria-riitautettua-saatavaa?lang=fi" }, (t) => t.includes("Perintäyhtiö ei voi periä") && !t.includes("Yhteyshenkilöt")],
  ["hae_vero_ohjeita", { hakusana: "vuokratulojen verotus" }, (t) => t.includes("Vuokratulojen verotus") && t.includes("https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/")],
  ["hae_vero_ohjeita", { hakusana: "VH/7418/00.01.00/2025" }, (t) => t.includes("Diaarinumero: VH/7418/00.01.00/2025") && t.includes("https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/") && !t.includes("KORVATTU")],
  ["hae_vero_ohjeita", { hakusana: "VH/6000/00.01.00/2024" }, (t) => t.includes("KORVATTU VERSIO") && t.includes("vuokratulojen-verotus7/") && t.includes("Korvaava ohje") && t.includes("vuokratulojen-verotus8/")],
  ["hae_vero_ohjeita", { tyyppi: "kvl", jarjestys: "uusin" }, (t) => t.includes("KVL:n ennakkoratkaisu") && t.includes("vero.fi/")],
  ["viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/" }, (t) => t.includes("Diaarinumero: VH/") && t.includes("Sisällysluettelo") && t.includes("3.7.3 Korjausmenot")],
  ["viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/", luku: "3.7.3" }, (t) => t.includes("3.7.3 Korjausmenot asunnon tai rakennuksen hankinnan yhteydessä") && t.includes("KHO 2000:51") && !t.includes("3.7.4 Oman")],
  ["viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/", luku: "3.9.2" }, (t) => t.includes("3.9.2 Poiston määrä ja edellytykset") && !t.includes("3.9.3 Vastikkeellisesti")],
  ["viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/", luku: "3.9" }, (t) => t.includes("3.9.1 Yleistä") && t.includes("3.9.6 Lisäpoisto") && !t.includes("3.10 Maatilan")],
  ["viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/", hakusana: "remont" }, (t) => t.includes("3.7.3 Korjausmenot") && t.includes("osumaa")],
  ["viranomaistiedotteet", { viranomainen: "tietosuoja,kyber,kkv" }, (t) => t.includes("Tietosuoja ") && t.includes("Kyber ") && t.includes("KKV ") && !t.includes("HUOM")],
  ["hae_viranomaisohjeita", { hakusana: "eväste", viranomainen: "traficom" }, (t) => t.includes("kyberturvallisuuskeskus.fi/fi/viestintaverkkojen-ja-palveluiden-saantely/evasteet")],
  ["hae_viranomaisohjeita", { hakusana: "oikeutettu etu", viranomainen: "tietosuoja" }, (t) => t.includes("https://tietosuoja.fi/rekisterinpitajan-oikeutettu-etu")],
  ["hae_viranomaisohjeita", { hakusana: "vaikuttajamarkkinointi", viranomainen: "kkv" }, (t) => t.includes("kuluttaja-asiamiehen-linjaukset/vaikuttajamarkkinointi-sosiaalisessa-mediassa/") && t.includes("linjaus")],
  ["hae_viranomaisohjeita", { hakusana: "KKV/2071/14.08.01.02/2014", viranomainen: "kkv" }, (t) => t.includes("/paatokset/kuluttaja-asiat/kkv-2071-14-08-01-02-2014/") && t.includes("Päätös")],
  ["hae_viranomaisohjeita", { hakusana: "tilinpäätös", viranomainen: "prh" }, (t) => t.includes("https://www.prh.fi/fi/yrityksetjayhteisot/tilinpaatokset.html")],
  ["viranomaisohje", { osoite: "https://www.kkv.fi/kuluttaja-asiat/tietoa-ja-ohjeita-yrityksille/kuluttaja-asiamiehen-linjaukset/vaikuttajamarkkinointi-sosiaalisessa-mediassa/", luku: "4.1" }, (t) => t.includes("4.1 Pääsääntö") && t.includes("kaupallinen yhteistyö") && !t.includes("4.2 Alustojen") && t.includes("ei lakia")],
  ["viranomaisohje", { osoite: "https://www.kkv.fi/paatokset/kuluttaja-asiat/kuluttaja-asiamiehen-seuraamusmaksuesitykset/perustajaosakkaan-velvollisuus-suorituskyvyttomyysvakuuden-asettamiseen/" }, (t) => t.includes("Diaarinumero: KKV/1424/14.08.01.02/2025") && t.includes("Päivämäärä: 30.10.2026") && t.includes("Lähde: https://www.kkv.fi/")],
  ["viranomaisohje", { osoite: "https://www.kyberturvallisuuskeskus.fi/fi/viestintaverkkojen-ja-palveluiden-saantely/evasteet" }, (t) => t.includes("Evästeohjeistus palveluntarjoajille") && t.includes("Evästeisiin liittyvät valvontapäätökset") && t.includes(".pdf")],
  ["viranomaisohje", { osoite: "https://www.kyberturvallisuuskeskus.fi/sites/default/files/media/file/Ev%C3%A4steohjeistus_palveluntarjoajille.pdf", luku: "2" }, (t) => t.includes("2 Soveltamisala") && t.includes("PDF:n sivut") && !t.includes("3 Evästeiden käytön edellytyksistä")],
  ["viranomaisohje", { osoite: "https://tietosuoja.fi/rekisterinpitajan-oikeutettu-etu", luku: "Tasapainotesti" }, (t) => t.includes("Tasapainotesti") && t.includes("Tietosuojavaltuutetun toimisto")],
  ["viranomaisohje", { osoite: "https://www.prh.fi/fi/yrityksetjayhteisot/tilinpaatokset/osakeyhtio_ja_osuuskunta_tilinpaatos_kaupparekisteriin.html", hakusana: "8 kuukauden" }, (t) => t.includes("Milloin ilmoitat?") && t.includes("osumaa")],
  ["viranomaisohje", { osoite: "https://www.traficom.fi/fi/" }, (t) => t.includes("Ohjeita luetaan vain sivustoilta")],
  ["viranomaisohje", { osoite: "https://tietosuoja.fi/haku/?q=evaste" }, (t) => t.includes("robots.txt kieltää")],
  ["viranomaisohje", { osoite: "https://fimea.fi/etusivu" }, (t) => t.includes("torjuvat automaattiset haut")],
  ["viranomaisohje", { osoite: "https://tukes.fi/etusivu" }, (t) => t.includes("torjuvat automaattiset haut")],
  ["kirjallinen_kysymys", { kysymys: "KK 365/2026 vp" }, (t) => t.includes("Kysyjä: Mia Laiho") && t.includes("Kysymys:") && t.includes("Vastaus KKV 365/2026 vp")],
  ["hae_eduskunnan_asiakirjoja", { tyyppi: "kysymys", hakusana: "kauneudenhoito" }, (t) => t.includes("KK 365/2026 vp") && t.includes("Kysyjä:")],
  ["eduskunnan_asiakirja", { asiakirja: "PeVL 38/2022 vp" }, (t) => t.includes("VALIOKUNNAN PÄÄTÖSESITYS") && t.includes("tavallisen lain säätämisjärjestyksessä")],
  ["eduskunnan_asiakirja", { asiakirja: "StVM 21/2022 vp", pykala: "51 a", laki: "1" }, (t) => t.includes("VALIOKUNNAN PERUSTELUT") && t.includes("«enimmäisajat»")],
  ["eduskunnan_asiakirja", { asiakirja: "LaVM 28/2002 vp", pykala: "3", luku: "3", laki: "1" }, (t) => t.includes("Laiminlyönnin rangaistavuus")],
  ["eduskunnan_asiakirja", { asiakirja: "EV 150/2022 vp", pykala: "55" }, (t) => t.includes("HYVÄKSYTTY LAKITEKSTI") && t.includes("Tietojen julkaiseminen")],
  ["eduskunnan_asiakirja", { asiakirja: "PeVL 38/2022 vp", hakusana: "perusoikeu" }, (t) => t.includes("Osumat")],
  ["hae_eduskunnan_asiakirjoja", { valiokunta: "perustuslakivaliokunta", tyyppi: "lausunto", alkaen_vuosi: 2022, paattyen_vuosi: 2022 }, (t) => t.includes("PeVL") && t.includes("2022 vp")],
  ["hae_lainvalmisteluhankkeita", { hakusana: "kotihoito" }, (t) => t.includes("STM006:00/2020") && t.includes("HE 231/2021")],
  ["hae_lainvalmisteluhankkeita", { lausuntokierros_auki: true }, (t) => t.includes("lähin määräaika ensin") && t.includes("lausuntokierros")],
  ["hae_lainvalmisteluhankkeita", { ministerio: "STM", laji: "he", tila: "paattynyt" }, (t) => t.includes("STM") && t.includes("hallituksen esityksen valmistelu")],
  ["lainvalmisteluhanke", { hanke: "HE 231/2021" }, (t) => t.includes("STM006:00/2020") && t.includes("Lausuntokierros") && t.includes("Lausunnot: ")],
  ["lainvalmisteluhanke", { hanke: "STM006:00/2020", laatija: "Kymenlaakso" }, (t) => t.includes("Kymenlaakson sosiaali- ja terveyspalvelujen kuntayhtymä")],
  ["lainvalmisteluhanke", { hanke: "HE 304/2010" }, (t) => t.includes("STM118:00/2010") && t.includes("EV 262/2010")],
  ["lainvalmistelun_asiakirja", { hanke: "STM006:00/2020", asiakirja: 198 }, (t) => t.includes("Lausuntoyhteenveto") && t.includes("120 lausuntoa")],
  ["lainvalmistelun_asiakirja", { hanke: "STM006:00/2020", asiakirja: 89, hakusana: "mitoitus" }, (t) => t.includes("Osumat") && t.includes("henkilöstömitoitus")],
  ["hae_tyoehtosopimuksia", { hakusana: "sosiaalipalvelu" }, (t) => t.includes("2020/19") && t.includes("Hyvinvointiala HALI ry")],
  ["hae_tyoehtosopimuksia", {}, (t) => t.includes("Kaupan työehtosopimus") && t.includes("Yleissitovat työehtosopimukset")],
  ["tyoehtosopimus", { sopimus: "2020/19" }, (t) => t.includes("Soveltamisala") && t.includes("Sisällysluettelo") && t.includes("14 § Ilta- ja yötyö")],
  ["tyoehtosopimus", { sopimus: "2020/19", pykala: "14" }, (t) => t.includes("iltatyölisänä") && t.includes("PDF:n sivu")],
  ["tyoehtosopimus", { sopimus: "2020/19", versio: "2024-01-01", hakusana: "koeaika" }, (t) => t.includes("Yksosala2305.pdf") && t.includes("Osumat")],
  ["hae_viranomaismaarayksia", { otsikko: "omavalvont", alkaen_vuosi: 2024 }, (t) => t.includes("national-supervisory-authority-for-welfare-and-health/2024/50504")],
  ["viranomaismaarays", { maarays: "national-supervisory-authority-for-welfare-and-health/2024/50504", sivut: "1" }, (t) => t.includes("Määräys: 1/2024") && t.includes("Valtuutussäännös")],
  ["viranomaismaarays", { maarays: "1", vuosi: 2026 }, (t) => t.includes("useita määräyksiä")],
  ["hae_ratkaisuja", { lahde: "tietosuojavaltuutettu", asiasana: "kameravalvonta" }, (t) => t.includes("numero") && t.includes("Tietosuojavaltuutettu")],
  ["hae_ratkaisuja", { lahde: "oikeusasiamies", otsikko: "kotihoito" }, (t) => t.includes("numero")],
  ["hae_ratkaisu", { lahde: "tietosuojavaltuutettu", vuosi: 2025, numero: "2443" }, (t) => t.includes("TSV/61/2021") && t.includes("Asia")],
  ["hae_ratkaisu", { lahde: "oikeusasiamies", vuosi: 2025, numero: "231" }, (t) => t.includes("PDF:stä") && t.includes("EOAK/231/2025")],
  ["hae_ratkaisu", { lahde: "oikeuskansleri", vuosi: 2025, numero: "10961" }, (t) => t.includes("KANTELU")],
];

for (const [name, args, pred] of cases) {
  const t0 = Date.now();
  const r = await tool(name, args);
  check(pred(r.text), `${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  if (show || !pred(r.text)) console.log(r.text.slice(0, 2500), "\n------");
}

// Hakusanan otteet: lähekkäiset osumat eivät toista samaa otetta.
{
  const near = `${"a".repeat(300)} poisto ja poisto ${"b".repeat(300)} ${"c".repeat(400)} poisto ${"d".repeat(300)}`;
  const r = excerpts(near, "poisto");
  check(r.n === 3 && r.ex.length === 2 && r.ex[1].includes("c") && !r.ex[1].includes("ja poisto"), "excerpts: osuma edellisen otteen sisällä ohitetaan (3 osumaa, 2 eri otetta)");
  const one = excerpts(`${"x".repeat(50)} sana sana sana ${"y".repeat(50)}`, "sana");
  check(one.n === 3 && one.ex.length === 1, "excerpts: kaikki osumat samassa otteessa, yksi ote");
  const t = (await tool("viranomaistiedote", { osoite: "https://www.vero.fi/syventavat-vero-ohjeet/ohje-hakusivu/49336/vuokratulojen-verotus8/", hakusana: "poisto" })).text;
  const lines = t.split("\n").filter((l) => l.startsWith("  …") || l.startsWith("  "));
  const dup = t.split("\n\n").some((blk) => { const ex = blk.split("\n").slice(1); return new Set(ex).size < ex.length; });
  check(t.includes("osumaa") && lines.length > 0 && !dup, "viranomaistiedote vero-ohje hakusana: ei samaa otetta kahdesti luvussa");
}

// Hyvinvointialueet: kaikki 21 syötettä, tunnukset ja aliakset sekä tiedotteen teksti jokaiselta omalta sivustolta ja STT Infosta.
{
  const t0 = Date.now();
  const r = await tool("viranomaistiedotteet", { viranomainen: "hyvinvointialueet", enintaan: 60 });
  const shorts = Object.values(HVA_FEEDS).map((f) => f.short);
  const missing = shorts.filter((s) => !r.text.includes(`${s} `));
  check(!r.isError && !missing.length && !r.text.includes("HUOM") && r.text.includes("puuttuvat Pohjois-Savo") && r.text.includes("Lähteet, hyvinvointialueet:") && !r.text.includes("· Fimea ·"), `viranomaistiedotteet hyvinvointialueet: kaikki ${shorts.length} syötettä (${Date.now() - t0} ms)`);
  if (show || missing.length) console.log("Puuttuvat:", missing, r.text.slice(0, 2500), "\n------");
}
{
  const r = await tool("viranomaistiedotteet", { viranomainen: "Etelä-Savo, varha, hus" });
  check(!r.isError && r.text.includes("HVA Etelä-Savo ") && r.text.includes("HVA Varsinais-Suomi ") && r.text.includes("HUS ") && !r.text.includes("HVA Kainuu"), "viranomaistiedotteet: alueen nimi ja aliakset (Etelä-Savo, varha, hus)");
  const l = await tool("viranomaistiedotteet", { viranomainen: "lappi" });
  check(l.isError && l.text.includes("Lappi"), "viranomaistiedotteet: Lappi kerrotaan puuttuvaksi");
  const v = await tool("viranomaistiedotteet", { viranomainen: "ei_ole" });
  check(v.isError && v.text.includes("hyvinvointialueet"), "viranomaistiedotteet: tuntematon tunnus hylätään");
  const k = await tool("viranomaistiedotteet", { viranomainen: "kaikki", enintaan: 5 });
  check(!k.isError && k.text.includes("Fimea ") && k.text.includes("HVA Kainuu "), "viranomaistiedotteet kaikki: valtion viranomaiset ja hyvinvointialueet");
}
for (const key of [...Object.keys(HVA_FEEDS).filter((k) => HVA_FEEDS[k].page), "hus", "pirkanmaa"]) {
  const items = await feedItems(key);
  const it = items.find((i) => i.date) ?? items[0];
  const t0 = Date.now();
  const r = await tool("viranomaistiedote", { osoite: it.link });
  const name = HVA_FEEDS[key].page ? HVA_FEEDS[key].name : "STT Info";
  const body = r.text.split("\nLähde:")[0];
  const ok = !r.isError && r.text.includes(`Lähde: ${it.link} (`) && r.text.includes(name) && body.length > 300 && !/Jaa tämä sivu|Lisää tiedot|-->/.test(body);
  check(ok, `viranomaistiedote ${key}: ${it.title.slice(0, 60)} (${body.length} merkkiä, ${Date.now() - t0} ms)`);
  if (show || !ok) console.log(r.text.slice(0, 1500), "\n...\n", r.text.slice(-600), "\n------");
}

// Kirjanpitolautakunta: oikea sivusto, robots.txt:n Crawl-delay 5 s, joten tapausten välillä tauko.
const POISTOT = "https://kirjanpitolautakunta.fi/-/kirjanpitolautakunnan-yleisohje-suunnitelman-mukaisista-poistoista-6.10.2026";
check(
  kilaUrlAllowed("https://kirjanpitolautakunta.fi/-/ns-cross-border-leasing-jarjeste-1") &&
    !kilaUrlAllowed("https://kirjanpitolautakunta.fi/-/q/leasing") &&
    !kilaUrlAllowed("https://kirjanpitolautakunta.fi/haku/?q=leasing") &&
    !kilaUrlAllowed("https://kirjanpitolautakunta.fi/web/guest/etusivu") &&
    !kilaUrlAllowed("https://kirjanpitolautakunta.fi/fi/web/x") &&
    !kilaUrlAllowed("https://kirjanpitolautakunta.fi/sv/sok/x") &&
    !kilaUrlAllowed("https://example.com/-/x"),
  "kilaUrlAllowed (robots.txt:n kiellot ja vieras osoite hylätään)",
);
{
  const r = await tool("kila_lausunto", { osoite: "https://kirjanpitolautakunta.fi/-/q/leasing" });
  check(r.isError && r.text.includes("robots.txt"), "kila_lausunto hylkää robots.txt:n kieltämän polun");
}
const kilaCases = [
  ["hae_kila_lausuntoja", { hakusana: "leasing" }, (t) => t.includes("1998/1516") && t.includes("cross-border leasing") && t.includes("Lähde: https://kirjanpitolautakunta.fi/")],
  ["hae_kila_lausuntoja", { numero: "2010/1861" }, (t) => t.includes("2010/1861") && t.includes("Investointiavustusten")],
  ["kila_lausunto", { numero: "1998/1516" }, (t) => t.includes("lausunto 1998/1516, annettu 26.1.1998") && t.includes("3 Kirjanpitolautakunnan lausunto") && t.includes("bruttomääräisinä") && t.includes("hakijan kuvaamaa tapausta") && t.includes("Lähde: https://kirjanpitolautakunta.fi/-/ns-cross-border-leasing-jarjeste-1")],
  ["kila_lausunto", { numero: "2010/1861", hakusana: "avustu" }, (t) => t.includes("Investointiavustusten") && t.includes("osumaa")],
  ["hae_kila_lausuntoja", { tyyppi: "yleisohje", hakusana: "poisto", voimassa: true }, (t) => t.includes("suunnitelman mukaisista poistoista 6.10.2026") && !t.includes("aiempi ·")],
  ["kila_lausunto", { osoite: POISTOT, luku: "2.4" }, (t) => t.includes("2.4 Jäännösarvo") && t.includes("Jäännösarvon määrittelyssä") && !t.includes("2.5 Avustuksella") && t.includes("ei lakia")],
  ["kila_lausunto", { osoite: POISTOT, liite: "1" }, (t) => t.includes("Liite: ") && t.includes("liite 1.pdf") && t.includes("Lähde: https://kirjanpitolautakunta.fi/documents/")],
];
for (const [name, args, pred] of kilaCases) {
  await new Promise((r) => setTimeout(r, 5000));
  const t0 = Date.now();
  const r = await tool(name, args);
  check(!r.isError && pred(r.text), `${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  if (show || r.isError || !pred(r.text)) console.log(r.text.slice(0, 2500), "\n------");
}

// Kuluttajariitalautakunta (kuluttajariita.fi, WordPressin julkinen rajapinta)
const HIERONTA = "hieronta-varatun-ajan-peruutus-peruutuksen-syy-peruutusehtojen-kohtuullisuus-kohtuullisuuden-arviointi";
const krilCases = [
  ["hae_kril_ratkaisuja", {}, (t) => t.includes("teemat") && t.includes("- Muut palvelut:") && t.includes("Lähde: https://www.kuluttajariita.fi/paatokset/")],
  ["hae_kril_ratkaisuja", { hakusana: "hieronta" }, (t) => t.includes(`tunnus: ${HIERONTA}`) && t.includes("Muut palvelut") && t.includes("ei sitova")],
  ["hae_kril_ratkaisuja", { teema: "muut palv", vuosi: 2024 }, (t) => t.includes("teema Muut palvelut, julkaistu 2024") && t.includes("tunnus: lahjakortin-voimassaolo") && !/· \d+\.\d+\.2025 ·/.test(t)],
  ["hae_kril_ratkaisuja", { teema: "olematon teema" }, (t) => t.includes("ei löytynyt") && t.includes("Etämyynti")],
  ["kril_ratkaisu", { tunnus: "lahjakortin-voimassaolo" }, (t) => t.includes("julkaistu 21.10.2024, teema Muut palvelut") && t.includes("Asiasanat: Lahjakortti") && t.includes("Lautakunnan ratkaisu\nKuluttajariitalautakunta suosittaa") && !t.includes("Kuluttajan vaatimukset perusteluineen\nKuluttaja on vaatinut") && t.includes("suositus, ei sitova") && t.includes("Lähde: https://www.kuluttajariita.fi/paatokset/lahjakortin-voimassaolo/")],
  ["kril_ratkaisu", { tunnus: `https://www.kuluttajariita.fi/paatokset/${HIERONTA}/`, osa: "vastaus" }, (t) => t.includes("Osat: Vaatimukset | Vastaus | Ratkaisu") && t.includes("kiistää") && !t.includes("Vaatimukset\nPP vaatii")],
  ["kril_ratkaisu", { tunnus: HIERONTA, hakusana: "peruutusehto" }, (t) => /Hakusana "peruutusehto": \d+ osumaa/.test(t) && t.includes("Ratkaisu (")],
  ["kril_ratkaisu", { tunnus: "ei-tallaista-ratkaisua-xyz" }, (t) => t.includes("ei löytynyt")],
];
for (const [name, args, pred] of krilCases) {
  const t0 = Date.now();
  const r = await tool(name, args);
  const ok = pred(r.text) && (r.isError === r.text.includes("ei löytynyt"));
  check(ok, `${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  if (show || !ok) console.log(r.text.slice(0, 2500), "\n------");
}

// Mainonnan eettinen neuvosto (kauppakamari.fi, WordPressin julkinen rajapinta). Lainausmuoto:
// tiivistelmä, tietorivit ja yksi lohko enintään noin 4 000 merkkiä tai hakusanan otteet.
const MEN_SRC = "(Mainonnan eettinen neuvosto, Keskuskauppakamari)";
const menBlock = (t, title) => {
  const i = t.indexOf(`\n\n${title}\n`);
  const j = t.indexOf("\n(Lohko katkaistu", i);
  return i >= 0 && j > i ? t.slice(i + title.length + 3, j) : null;
};
const menCases = [
  ["hae_men_lausuntoja", {}, (t) => t.includes("Ratkaisut:") && t.includes("- huomautus:") && t.includes("- 7 Markkinoinnin tunnistettavuus: ") && !t.includes("7 artikla - ") && t.includes(MEN_SRC)],
  ["hae_men_lausuntoja", { hakusana: "vaikuttaja" }, (t) => /: \d+ osumaa, sivu 1\/\d+/.test(t) && t.includes("tunnus: men-") && t.includes("tiivistelmä:") && t.includes("ei sitova eikä viranomaispäätös") && t.includes(MEN_SRC)],
  // Haku osui jäsenluetteloon (jäsenen titteli "vaikuttaja"); MEN 40/2026 Sports Lady suodatetaan pois (Ohjaamo C1).
  ["hae_men_lausuntoja", { hakusana: "vaikuttaja", ratkaisu: "huomautus" }, (t) => t.includes("ennen suodatusta (arvio)") && /Tältä sivulta \d+ osumaa suodatettiin pois, koska hakusana oli vain jäsenluettelossa\./.test(t) && !t.includes("Sports Lady") && !t.includes("Kouvolan Lakritsi") && t.includes("MEN 43/2026 Soluni Oy") && t.includes("Lisää tuloksia: sivu 2.")],
  ["hae_men_lausuntoja", { ratkaisu: "vapauttava", vuosi: 2026 }, (t) => t.includes("ratkaisu vapauttava, vuosi 2026") && t.includes("MEN 44/2026 Sinituote Oy") && !t.includes("· huomautus") && !/MEN \d+\/2025/.test(t)],
  ["hae_men_lausuntoja", { ratkaisu: "ei toimivaltaa" }, (t) => t.includes("· ei toimivaltaa") && !t.includes("· vapauttava")],
  ["hae_men_lausuntoja", { artikla: "C2", vuosi: 2026 }, (t) => t.includes("artikla C2 Markkinoinnin tunnistettavuus") && t.includes("C2 Markkinoinnin tunnistettavuus") && t.includes("MEN 43/2026")],
  ["hae_men_lausuntoja", { artikla: "18", media: "sovellus", alkaen_vuosi: 2025 }, (t) => t.includes("18 Lapset ja nuoret tai 18 Todistus ja suositus") && t.includes("media sovellus")],
  ["hae_men_lausuntoja", { artikla: "olematon" }, (t) => t.includes("ei löytynyt") && t.includes("7 artikla - Markkinoinnin tunnistettavuus")],
  ["men_lausunto", { tunnus: "MEN 43/2026" }, (t) => t.startsWith("MEN 43/2026 Soluni Oy") && t.includes("Ratkaisu: huomautus") && t.includes("Tiivistelmä: Väkivaltaan viittaavia") && t.includes("- Markkinoija: Soluni Oy") && t.includes("- Päätös: Huomautus") && t.includes("- Asiasanat: PIILOMAINONTA") && t.includes("Lohkot: Lausuntopyyntö | Markkinointi") && t.includes("\nAsian arviointi\nMainonnan eettinen neuvosto toteaa") && !t.includes("Markkinoijan mukaan lapseen") && !t.includes("Paula Paloranta") && !t.includes("Asian käsittelyyn") && t.includes("ei ole sitova eikä viranomaispäätös") && t.includes("ota kantaa lainvastaisuuteen") && t.includes("kuluttajansuojalain") && t.includes("Koko teksti on lähteen sivulla: https://kauppakamari.fi/men-43-2026-soluni-oy/") && t.includes(`Lähde: https://kauppakamari.fi/men-43-2026-soluni-oy/ ${MEN_SRC}`)],
  ["men_lausunto", { tunnus: "MEN lausunto 1/2001" }, (t) => t.startsWith("MEN lausunto 1/2001") && t.includes("- Mainostaja: Luottokunta, Helsinki") && t.includes("Mainonnan eettisen neuvoston lausunto\nMainonnan eettinen neuvosto toteaa") && !t.includes("Outi Antila") && t.includes("Lähde: https://kauppakamari.fi/men-lausunto-1-2001/")],
  ["men_lausunto", { tunnus: "https://kauppakamari.fi/men-43-2026-soluni-oy/", lohko: "neuvoston lausunto" }, (t) => { const b = menBlock(t, "Mainonnan eettisen neuvoston lausunto"); return b && b.length <= 4002 && b.length > 3500 && t.includes("Koko teksti: https://kauppakamari.fi/men-43-2026-soluni-oy/") && t.includes("Alalohkot voi lukea erikseen") && !t.includes("Markkinoijan mukaan lapseen"); }],
  ["men_lausunto", { tunnus: "men-43-2026-soluni-oy", lohko: "vastaus" }, (t) => t.includes("\nMarkkinoijan vastaus\nMarkkinoijan mukaan lapseen") && !t.includes("Lohko katkaistu") && !t.includes("Asian arviointi\nMainonnan eettinen")],
  ["men_lausunto", { tunnus: "MEN 43/2026", hakusana: "mainostunnist" }, (t) => /Hakusana "mainostunnist": \d+ osumaa \d+ lohkossa/.test(t) && t.includes("Asian arviointi (") && t.includes("…") && !t.includes("Markkinoijan mukaan lapseen")],
  ["men_lausunto", { tunnus: "MEN 999/2026" }, (t) => t.includes("ei löytynyt")],
  ["men_lausunto", { tunnus: "men-ei-tallaista-lausuntoa-xyz" }, (t) => t.includes("ei löytynyt")],
  ["men_lausunto", { tunnus: "jotain muuta" }, (t) => t.includes("Anna lausunnon numero")],
  ["hae_men_lausuntoja", { hakusana: "x".repeat(101) }, (t) => t.includes("enintään 100 merkkiä")],
];
for (const [name, args, pred] of menCases) {
  const t0 = Date.now();
  const r = await tool(name, args);
  const expectErr = r.text.includes("ei löytynyt") || r.text.startsWith("Anna lausunnon numero") || r.text.includes("enintään 100 merkkiä");
  const ok = pred(r.text) && r.isError === expectErr;
  check(ok, `${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)`);
  if (show || !ok) console.log(r.text.slice(0, 2500), "\n------");
}

// Tyhjä MEN-tulos ei saa pitkää välimuistiaikaa (korvike: menCacheTtl).
check(menCacheTtl([], 30 * 86400) === 3600 && menCacheTtl(null, 86400) === 3600 && menCacheTtl({}, 86400) === 3600 && menCacheTtl([{ id: 1 }], 30 * 86400) === 30 * 86400, "MEN: tyhjä tulos välimuistiin enintään 1 h");

// MEN-haun suodatus: WordPressin hakusanat ja osuma ilman allekirjoitusosaa (jäsenluettelo).
{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(same(menSearchTerms("Vaikuttaja"), ["vaikuttaja"]) && same(menSearchTerms('vaikuttaja "lapsi nuori" -alkoholi a, x+y'), ["vaikuttaja", "lapsi nuori"]) && same(menSearchTerms("vaikuttaja,lapsi"), ["vaikuttaja", "lapsi"]), "MEN: hakusanat WordPressin tapaan");
  const html = (body) => `<p><strong>Markkinointi</strong></p><p>${body}</p><p><strong>Mainonnan eettisen neuvoston lausunto</strong></p><p>Neuvosto toteaa asian.</p><p>Asian käsittelyyn ovat ottaneet osaa puheenjohtaja X, jäsenet General Counsel Y, vaikuttaja Z.</p><p><strong>ASIASANAT: PIILOMAINONTA</strong></p>`;
  const doc = (title, body, excerpt = "") => ({ title: { rendered: title }, excerpt: { rendered: excerpt }, content: { rendered: html(body) } });
  const t = menSearchTerms("vaikuttaja");
  check(menQueryMatch(doc("MEN 40/2026 Oy", "Mainos verkossa."), t) === "signature", "MEN: osuma vain jäsenluettelossa suodatetaan");
  check(menQueryMatch(doc("MEN 1/2026 Oy", "Vaikuttaja julkaisi kuvan."), t) === "ok" && menQueryMatch(doc("MEN 2/2026 Vaikuttaja", "Mainos."), t) === "ok" && menQueryMatch(doc("MEN 3/2026 Oy", "Mainos.", "<p>vaikuttajamarkkinointi</p>"), t) === "ok", "MEN: osuma tekstissä, otsikossa tai otteessa säilyy");
  check(menQueryMatch(doc("MEN 4/2026 Oy", "Mainos."), menSearchTerms("piilomainonta")) === "ok", "MEN: tietorivit (ASIASANAT) ovat haettavaa tekstiä");
  check(menQueryMatch(doc("MEN 5/2026 Oy", "Vaikuttaja julkaisi."), menSearchTerms("vaikuttaja counsel")) === "signature" && menQueryMatch(doc("MEN 6/2026 Oy", "Mainos."), menSearchTerms("olematon")) === "other", "MEN: jokainen sana vaaditaan (JA)");
}

// Versio kolmessa paikassa (src/index.js, package.json, package-lock.json) ja MCP-palvelimen tiedoissa.
{
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const idx = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").match(/SERVER_INFO = \{ name: "finlex", version: "([^"]+)" \}/)?.[1];
  check(pkg === "1.15.1" && lock.version === pkg && lock.packages?.[""]?.version === pkg && idx === pkg && init.result?.serverInfo?.version === pkg, `versio ${pkg} kolmessa paikassa`);
}

// Savutesti: kutsuu Workerin fetch-käsittelijää suoraan Nodessa oikeaa Finlexiä vasten.
// Ajo: node test/smoke.mjs   (vaatii Node 20+)

import worker from "../src/index.js";

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
check(list.result?.tools?.length === 21, "tools/list (21 työkalua)");

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

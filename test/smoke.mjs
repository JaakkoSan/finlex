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
check(list.result?.tools?.length === 6, "tools/list (6 työkalua)");

const show = process.argv.includes("-v");
const cases = [
  ["hae_saadoksia", { otsikko: "arvonlisäverolaki" }, (t) => t.includes("1501/1993") && t.includes("Arvonlisäverolaki")],
  ["hae_saadoksia", { otsikko: "osakeyhtiölaki" }, (t) => t.includes("624/2006")],
  ["saados_tiedot", { vuosi: 2018, numero: "1050" }, (t) => t.includes("Tietosuojalaki") && t.includes("AJANTASAINEN")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "3" }, (t) => t.includes("3 §") && t.includes("Huomautus")],
  ["hae_pykala", { vuosi: 2006, numero: "624", luku: "13", pykala: "2" }, (t) => t.includes("13 luku") && t.includes("2 §")],
  ["hae_pykala", { vuosi: 2006, numero: "624", pykala: "1" }, (t) => t.includes("Anna luku")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "999" }, (t) => t.includes("ei löytynyt")],
  ["etsi_saadoksesta", { vuosi: 1993, numero: "1501", hakusana: "maksuperust" }, (t) => t.includes("Osumat")],
  ["hae_pykala", { vuosi: 2018, numero: "1050", pykala: "1", teksti: "alkuperainen" }, (t) => t.includes("ALKUPERÄINEN")],
  ["hae_pykala", { vuosi: 1993, numero: "1501", pykala: "3", versio: "448/2024" }, (t) => t.includes("3 §")],
  ["hae_pykala", { vuosi: 2019, numero: "872", pykala: "1", kieli: "swe" }, (t) => t.includes("1 §")],
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

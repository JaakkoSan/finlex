// reklamaation_lainkohdat (issue JaakkoSan/liittimet#14, Tonyn sessio 22.11.2026): kuluttajansuojalain pykälät
// reklamaatiotilanteeseen sopimustyypin ja tilanteen mukaan. Kartta sisältää vain pykälänumerot, otsikot ja
// soveltumisen; lakiteksti haetaan aina Finlexistä ajantasaisena (tools.js antaa hakufunktion), ei kovakoodata.
//
// Kartta: Liittimet-keskusrepo suunnitelmat/2026-11-22-reklamaatio-kartta.md. Pykälien numerot ja otsikot
// tarkistettu Finlexistä 22.11.2026 (38/1978, ajantasainen, viimeisin muutos 835/2026, ajantasaistus 4.9.2026);
// sanatarkasti 4:1, 5:16 a, 8:1, 8:16, 8:26, 8:30 ja 6:16.
//
// Peruutus kauneus- ja hyvinvointipalveluissa: työkalu antaa vain pykälät lähteiksi eikä tee omaa tulkintaa
// (Tony 22.11.2026; Soklon linjaus on ajanvarauksessa, issue JaakkoSan/liittimet#16).
//
// Koodiajo-valmius: logiikka on puhtaina funktioina (lainkohdat, lainkohdatTeksti), joita voi testata ilman verkkoa.

export const KSL = { vuosi: 1978, numero: "38", nimi: "Kuluttajansuojalaki", tunnus: "38/1978" };
export const KARTTA_TARKISTETTU = "2026-11-22";
/** Yhden pykälän tekstin enimmäispituus tuloksessa; koko teksti hae_pykala-työkalulla. */
export const TEKSTI_MAX = 1500;

export const SOPIMUSTYYPIT = {
  tavara: "tavara (5 luku)",
  digitaalinen: "digitaalinen sisältö tai palvelu (5 a luku)",
  esinepalvelu: "esineeseen, rakennukseen tai kiinteistöön kohdistuva palvelu (8 luku)",
  muu_palvelu: "ihmiseen kohdistuva tai muu palvelu, esimerkiksi kauneushoito (8 luku periaatteena)",
  etamyynti: "etämyynti tai kotimyynti (6 luku)",
};
export const TILANTEET = { virhe: "virhe", viivastys: "viivästys", peruutus: "peruutus" };

const p = (luku, pykala, otsikko) => ({ luku, pykala, otsikko });

const ESINE_VIRHE = [
  p("8", "12", "Yleinen virhesäännös"),
  p("8", "15", "Virheellisyyden määräävä ajankohta ja takuu"),
  p("8", "16", "Virheilmoitus"),
  p("8", "17", "Oikeus pidättyä maksusta"),
  p("8", "18", "Virheen oikaisu"),
  p("8", "19", "Hinnanalennus ja sopimuksen purku"),
  p("8", "20", "Vahingonkorvaus"),
];
const ESINE_VIIVASTYS = [
  p("8", "4", "Luovutuksen ajankohta"),
  p("8", "7", "Oikeus pidättyä maksusta"),
  p("8", "8", "Tilaajan oikeus vaatia sopimuksen täyttämistä"),
  p("8", "9", "Sopimuksen purku"),
  p("8", "10", "Vahingonkorvaus"),
  p("8", "11", "Ilmoitus sopimuksen purkamisesta ja korvausvaatimuksesta"),
];
const ESINE_PERUUTUS = [
  p("8", "26", "Palveluksen peruuttaminen"),
  p("8", "30", "Toimeksisaajan oikeus vahingonkorvaukseen"),
  p("8", "33", "Vahingon rajoittaminen ja vahingonkorvauksen sovittelu"),
];
const ETAMYYNTI_PERUUTUS = [
  p("6", "14", "Peruuttamisoikeus"),
  p("6", "15", "Palvelun suorittaminen ennen peruuttamisajan päättymistä"),
  p("6", "16", "Peruuttamisoikeuden rajoitukset"),
  p("6", "17", "Suoritusten palauttaminen"),
  p("6", "19", "Korvaus ennen peruuttamista suoritetusta palvelusta"),
];
/** Sovittelu: aina mukana. */
export const SOVITTELU = p("4", "1", "Sopimuksen sovittelu (kohtuuton ehto)");

const PERIAATE =
  "Ihmiseen kohdistuvat palvelut (esimerkiksi kauneushoito, hieronta, valmennus) eivät kuulu 8 lukuun sellaisenaan (8 luku 1 §). Kuluttajariitalautakunta on soveltanut 8 luvun yleisiä periaatteita myös muihin palveluihin tapauskohtaisesti, joten pykälät ovat periaatteita, eivät suoraan sovellettavia sääntöjä. Hae vastaavat ratkaisut.";
// Yleinen liitin: ei viittausta Soklo-ajanvaraukseen. Avustajan taito ohjaa Soklon asiakkaat ajanvarauksen
// peruutuslinjaukseen (issue JaakkoSan/liittimet#16).
const PERUUTUS_AJANVARAUS =
  "Varatun ajan peruutuksessa arvioidaan sovittuja peruutusehtoja ja niiden kohtuullisuutta (4 luku 1 §).";

/** Kartta: sopimustyyppi -> tilanne -> { pykalat, soveltuminen, huomautus?, ohjaus? }. */
export const KARTTA = {
  tavara: {
    virhe: { soveltuminen: "suoraan", pykalat: [
      p("5", "12", "Tavaran ominaisuudet"), p("5", "13", "Yleinen virhesäännös"),
      p("5", "15", "Virheellisyyden määräävä ajankohta"), p("5", "16", "Ostajan oikeudet"),
      p("5", "16 a", "Virheilmoitus"), p("5", "18", "Virheen oikaisu"),
      p("5", "19", "Hinnanalennus ja kaupan purku"), p("5", "20", "Vahingonkorvaus tavaran virheestä"),
    ] },
    viivastys: { soveltuminen: "suoraan", pykalat: [
      p("5", "4", "Luovutuksen ajankohta"), p("5", "7", "Oikeus pidättyä maksusta"),
      p("5", "8", "Oikeus vaatia sopimuksen täyttämistä"), p("5", "9", "Kaupan purku"),
      p("5", "10", "Vahingonkorvaus"), p("5", "11", "Ilmoitus kaupan purkamisesta ja korvausvaatimuksesta"),
    ] },
    peruutus: { soveltuminen: "ohjaus", pykalat: [],
      ohjaus: "Tavarankaupan 5 luvussa ei ole yleistä peruutussäännöstä. Jos kauppa tehtiin etä- tai kotimyynnissä, käytä sopimustyyppiä etamyynti; muuten peruutus riippuu sovituista ehdoista." },
  },
  digitaalinen: {
    virhe: { soveltuminen: "suoraan", pykalat: [
      p("5 a", "10", "Digitaalisen sisällön tai palvelun ominaisuudet"), p("5 a", "11", "Yleinen virhesäännös"),
      p("5 a", "15", "Virheellisyyden määräävä ajankohta"), p("5 a", "16", "Virheolettama"),
      p("5 a", "17", "Kuluttajan oikeudet virhetilanteessa"), p("5 a", "19", "Virheen oikaisu"),
      p("5 a", "20", "Hinnanalennus ja sopimuksen purku"), p("5 a", "22", "Vahingonkorvaus virheestä"),
    ] },
    viivastys: { soveltuminen: "suoraan", pykalat: [
      p("5 a", "5", "Digitaalisen sisällön tai palvelun toimittaminen"), p("5 a", "6", "Oikeus pidättyä maksusta"),
      p("5 a", "7", "Oikeus vaatia sopimuksen täyttämistä"), p("5 a", "8", "Sopimuksen purku"),
      p("5 a", "9", "Vahingonkorvaus viivästyksestä"),
    ] },
    peruutus: { soveltuminen: "ohjaus", pykalat: [],
      ohjaus: "5 a luvussa ei ole peruutussäännöstä. Etämyynnissä käytä sopimustyyppiä etamyynti (huomaa 6 luvun 16 §:n 1 momentin 12 kohta digitaalisesta sisällöstä)." },
  },
  esinepalvelu: {
    virhe: { soveltuminen: "suoraan", pykalat: ESINE_VIRHE },
    viivastys: { soveltuminen: "suoraan", pykalat: ESINE_VIIVASTYS },
    peruutus: { soveltuminen: "suoraan", pykalat: ESINE_PERUUTUS },
  },
  muu_palvelu: {
    virhe: { soveltuminen: "periaatteena", pykalat: ESINE_VIRHE, huomautus: PERIAATE },
    viivastys: { soveltuminen: "periaatteena", pykalat: ESINE_VIIVASTYS, huomautus: PERIAATE },
    peruutus: { soveltuminen: "periaatteena", pykalat: ESINE_PERUUTUS, huomautus: `${PERIAATE} ${PERUUTUS_AJANVARAUS}` },
  },
  etamyynti: {
    peruutus: { soveltuminen: "suoraan", pykalat: ETAMYYNTI_PERUUTUS,
      huomautus: `6 luvun 16 § luettelee tilanteet, joissa peruuttamisoikeutta ei ole. ${PERUUTUS_AJANVARAUS}` },
    virhe: { soveltuminen: "ohjaus", pykalat: [],
      ohjaus: "Etämyynnin 6 luku koskee tietoja ja peruuttamisoikeutta. Virheestä käytä sopimustyyppiä, joka vastaa ostettua (tavara, digitaalinen, esinepalvelu tai muu_palvelu)." },
    viivastys: { soveltuminen: "ohjaus", pykalat: [],
      ohjaus: "Viivästyksestä käytä sopimustyyppiä, joka vastaa ostettua (tavara, digitaalinen, esinepalvelu tai muu_palvelu)." },
  },
};

/** Ehdotetut hakusanat Kuluttajariitalautakunnan ratkaisuihin (hae_kril_ratkaisuja). */
const KRIL_HAKUSANAT = { virhe: ["virhe", "hinnanalennus"], viivastys: ["viivästys"], peruutus: ["peruutus", "peruutusmaksu"] };

export class ReklamaatioVirhe extends Error {}

function valinta(args, kentta, sallitut) {
  const v = typeof args[kentta] === "string" ? args[kentta].trim().toLowerCase() : "";
  if (!Object.hasOwn(sallitut, v)) {
    throw new ReklamaatioVirhe(`Kenttä ${kentta}: sallitut arvot ${Object.keys(sallitut).join(", ")}.`);
  }
  return v;
}

const katkaise = (t) => (t.length > TEKSTI_MAX ? { teksti: `${t.slice(0, TEKSTI_MAX).trimEnd()} [...]`, katkaistu: true } : { teksti: t, katkaistu: false });

/**
 * Datafunktio. haeTeksti(luku, pykala) palauttaa pykälän tekstin (Finlexistä, tools.js) ja saados-tiedot
 * { otsikko, lahde } kerran: saados(). Virheellinen syöte -> ReklamaatioVirhe.
 */
export async function lainkohdat(args, { haeTeksti, saados }) {
  const sopimustyyppi = valinta(args, "sopimustyyppi", SOPIMUSTYYPIT);
  const tilanne = valinta(args, "tilanne", TILANTEET);
  const rivi = KARTTA[sopimustyyppi][tilanne];
  const kohteet = [...rivi.pykalat, SOVITTELU];
  const pykalat = [];
  for (const k of kohteet) {
    const t = await haeTeksti(k.luku, k.pykala);
    pykalat.push({ luku: k.luku, pykala: k.pykala, otsikko: k.otsikko, ...katkaise(String(t ?? "").trim()) });
  }
  const s = await saados();
  return {
    saados: { nimi: KSL.nimi, tunnus: KSL.tunnus, teksti: s.otsikko, lahde: s.lahde },
    sopimustyyppi,
    tilanne,
    soveltuminen: rivi.soveltuminen,
    ...(rivi.huomautus ? { huomautus: rivi.huomautus } : {}),
    ...(rivi.ohjaus ? { ohjaus: rivi.ohjaus } : {}),
    pykalat,
    kril_hakusanat: KRIL_HAKUSANAT[tilanne],
    kartta_tarkistettu: KARTTA_TARKISTETTU,
  };
}

const SOVELTUMINEN_FI = {
  suoraan: "Pykälät soveltuvat suoraan.",
  periaatteena: "Pykälät soveltuvat vain periaatteina (ks. huomautus).",
  ohjaus: "Tälle yhdistelmälle ei ole omia pykäliä (ks. ohjaus).",
};

/** Tekstituloste datasta. */
export function lainkohdatTeksti(d) {
  const rivit = [
    `Reklamaation lainkohdat: ${SOPIMUSTYYPIT[d.sopimustyyppi]}, ${TILANTEET[d.tilanne]}.`,
    SOVELTUMINEN_FI[d.soveltuminen],
  ];
  if (d.huomautus) rivit.push(`Huomautus: ${d.huomautus}`);
  if (d.ohjaus) rivit.push(`Ohjaus: ${d.ohjaus}`);
  rivit.push("", d.saados.teksti, "");
  for (const k of d.pykalat) {
    // Finlexin teksti alkaa luvun ja pykälän otsikolla; oma otsikko vain, jos tekstiä ei saatu.
    rivit.push(k.teksti || `${k.luku} luku ${k.pykala} § ${k.otsikko}: tekstiä ei saatu, hae hae_pykala-työkalulla.`, "");
  }
  if (d.pykalat.some((k) => k.katkaistu)) rivit.push(`Pitkät pykälät on katkaistu ${TEKSTI_MAX} merkkiin ([...]); koko teksti hae_pykala-työkalulla (vuosi 1978, numero 38, luku ja pykälä).`, "");
  rivit.push(
    `Seuraavaksi: hae_kril_ratkaisuja (esim. hakusana ${d.kril_hakusanat.map((h) => `"${h}"`).join(" tai ")} ja palvelun tai tuotteen nimi) ja kril_ratkaisu.`,
    "Tämä on yleistä tietoa lain sisällöstä, ei oikeudellista neuvontaa yksittäistapauksessa. Kuluttajariitalautakunnan ratkaisut ovat suosituksia.",
    `Kartta tilanteesta pykäliin tarkistettu ${d.kartta_tarkistettu.split("-").reverse().map(Number).join(".")}; lakiteksti haettu nyt Finlexistä.`,
    `Lähde: ${d.saados.lahde}`,
  );
  return rivit.join("\n");
}

const S = { type: "string" };
export const LAINKOHDAT_SKEEMA = {
  type: "object",
  required: ["saados", "sopimustyyppi", "tilanne", "soveltuminen", "pykalat", "kril_hakusanat", "kartta_tarkistettu"],
  properties: {
    saados: { type: "object", required: ["nimi", "tunnus", "lahde"], properties: { nimi: S, tunnus: S, teksti: S, lahde: S } },
    sopimustyyppi: { type: "string", enum: Object.keys(SOPIMUSTYYPIT) },
    tilanne: { type: "string", enum: Object.keys(TILANTEET) },
    soveltuminen: { type: "string", enum: ["suoraan", "periaatteena", "ohjaus"] },
    huomautus: S,
    ohjaus: S,
    pykalat: {
      type: "array",
      items: {
        type: "object",
        required: ["luku", "pykala", "otsikko", "teksti", "katkaistu"],
        properties: { luku: S, pykala: S, otsikko: S, teksti: S, katkaistu: { type: "boolean" } },
      },
    },
    kril_hakusanat: { type: "array", items: S },
    kartta_tarkistettu: S,
  },
};

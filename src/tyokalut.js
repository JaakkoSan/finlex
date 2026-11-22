// Rakenteiset hakulistat yhteisen rungon tyokalu()-muodossa (koodiajo-valmius): logiikka on tools.js:n funktioissa,
// ja työkalu on ohut kuori niiden päällä. Kaikki vain lukevat (oikeus "luku").
//
// Tekstituloste on sama kuin ennen; sen rinnalla annetaan rakenteinen tulos (structuredContent ja outputSchema) ja
// sivutus (sivu, sivuja, seuraava). Muut työkalut ovat yhä tools.js:n TOOLS-listassa (sanatarkka teksti pysyy tekstinä).

import { tyokalu, NaytettavaVirhe, LAHDE_SKEEMA, VIRHE_SKEEMA } from "./mcp-runko.js";
import {
  commonProps,
  virheTeksti,
  haeSaadoksia,
  haeSaadoksiaTeksti,
  haeHallituksenEsityksia,
  haeHallituksenEsityksiaTeksti,
  haeRatkaisuja,
  haeRatkaisujaTeksti,
  haeTyoehtosopimuksia,
  haeTyoehtosopimuksiaTeksti,
  viranomaistiedotteet,
  viranomaistiedotteetTeksti,
} from "./tools.js";

// ---------- tulosskeemat ----------

const merkkijono = (description) => ({ type: "string", description });
const kokonaisluku = (description) => ({ type: "integer", description });
const lista = (items, description) => ({ type: "array", items, description });

/** Sivutus: Finlex ei kerro kokonaismäärää, joten sivuja on alaraja (sivu + 1, kun sivu on täysi). */
const SIVUTUS = {
  sivu: { type: "integer", minimum: 1, description: "Tämän tuloksen sivu." },
  sivuja: {
    type: "integer",
    minimum: 1,
    description: "Vähintään näin monta sivua: sivu + 1, jos sivu on täysi (10 riviä) ja seuraava voi olla olemassa; tyhjällä liian suurella sivulla sivu - 1 (vähintään 1). Kokonaismäärää lähde ei kerro.",
  },
  seuraava: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Seuraavan sivun numero (parametri sivu) tai null." },
};
const SIVUTUS_PAKOLLISET = ["sivu", "sivuja", "seuraava"];

/** Onnistunut tulos tai rakenteinen virhe { virhe }, jotta isError-tuloskin noudattaa outputSchemaa. */
const taiVirhe = (onnistunut) => ({
  type: "object",
  oneOf: [onnistunut, { type: "object", properties: { virhe: VIRHE_SKEEMA }, required: ["virhe"] }],
});

const SAADOKSET_SKEEMA = {
  type: "object",
  properties: {
    saadokset: lista(
      {
        type: "object",
        properties: {
          tunnus: merkkijono("Säädösnumero, esim. \"1501/1993\"."),
          vuosi: kokonaisluku("Säädöksen vuosi (parametri vuosi muissa työkaluissa)."),
          numero: merkkijono("Säädöksen numero (parametri numero muissa työkaluissa)."),
          nimi: merkkijono("Säädöksen nimi (puuttuu, jos nimeä ei saatu)."),
          voimassa: { type: "boolean", description: "Onko säädös voimassa (puuttuu, jos tieto puuttuu)." },
          linkki: merkkijono("Lähde-linkki: ajantasainen säädös Finlexissä."),
        },
        required: ["tunnus", "vuosi", "numero", "linkki"],
      },
      "Säädökset säädösnumeron mukaan, enintään 10.",
    ),
    ...SIVUTUS,
    lahde: LAHDE_SKEEMA,
  },
  required: ["saadokset", ...SIVUTUS_PAKOLLISET, "lahde"],
};

const ESITYKSET_SKEEMA = {
  type: "object",
  properties: {
    esitykset: lista(
      {
        type: "object",
        properties: {
          tunnus: merkkijono("Esityksen tunnus, esim. \"HE 88/1993\"."),
          vuosi: kokonaisluku("Esityksen vuosi."),
          numero: merkkijono("Esityksen numero."),
          otsikko: merkkijono("Esityksen otsikko (puuttuu, jos otsikkoa ei saatu)."),
          linkki: merkkijono("Lähde-linkki Finlexiin."),
        },
        required: ["tunnus", "vuosi", "numero", "linkki"],
      },
      "Esitykset vuoden ja numeron mukaan vanhimmasta uusimpaan, enintään 10.",
    ),
    ...SIVUTUS,
    lahde: LAHDE_SKEEMA,
  },
  required: ["esitykset", ...SIVUTUS_PAKOLLISET, "lahde"],
};

const RATKAISUT_SKEEMA = {
  type: "object",
  properties: {
    ratkaisija: merkkijono("Ratkaisija, esim. \"Tietosuojavaltuutettu\"."),
    ratkaisut: lista(
      {
        type: "object",
        properties: {
          vuosi: kokonaisluku("Ratkaisun vuosi (parametri vuosi työkalussa hae_ratkaisu)."),
          numero: merkkijono("Ratkaisun numero (parametri numero työkalussa hae_ratkaisu)."),
          paiva: merkkijono("Ratkaisun päivä (VVVV-KK-PP)."),
          otsikko: merkkijono("Ratkaisun otsikko."),
          diaarinumero: merkkijono("Diaarinumero."),
          linkki: merkkijono("Lähde-linkki Finlexiin."),
        },
        required: ["vuosi", "numero", "linkki"],
      },
      "Ratkaisut vuoden ja numeron mukaan vanhimmasta uusimpaan, enintään 10.",
    ),
    oletusvuodet: {
      type: "object",
      description: "Vuodet, joilta haettiin, kun hakuehtoja ei annettu (edellinen ja kuluva vuosi).",
      properties: { alkaen: { type: "integer" }, paattyen: { type: "integer" } },
      required: ["alkaen", "paattyen"],
    },
    ...SIVUTUS,
    lahde: LAHDE_SKEEMA,
  },
  required: ["ratkaisija", "ratkaisut", ...SIVUTUS_PAKOLLISET, "lahde"],
};

const TES_SKEEMA = {
  type: "object",
  properties: {
    sopimukset: lista(
      {
        type: "object",
        properties: {
          tunnus: merkkijono("Tunniste, esim. \"2017/3\" (parametri sopimus työkalussa tyoehtosopimus)."),
          nimi: merkkijono("Sopimuksen nimi."),
          tyonantajat: merkkijono("Työnantajapuolen sopijaliitot."),
          tyontekijat: merkkijono("Työntekijäpuolen sopijaliitot."),
          yleissitova: { type: "boolean", description: "false, jos päätöksen mukaan ei yleissitova." },
          tila: merkkijono("Yleissitovuus ja sopimuskausi tekstinä."),
          voimassa_oleva_kausi: merkkijono("Tänään voimassa olevan sopimuksen kausi tekstinä (puuttuu, jos voimassa olevaa ei ole)."),
          kausi_alkaa: merkkijono("Voimassa olevan sopimuksen alkupäivä (VVVV-KK-PP)."),
          kausi_paattyy: merkkijono("Voimassa olevan sopimuksen päättymispäivä (VVVV-KK-PP)."),
        },
        required: ["tunnus", "nimi", "yleissitova", "tila"],
      },
      "Sopimukset nimen mukaan aakkosjärjestyksessä, enintään 50 ensimmäistä (rajaa hakusanalla).",
    ),
    yhteensa: kokonaisluku("Sopimuksia yhteensä."),
    rajattu: { type: "boolean", description: "true, jos sopimuksia on enemmän kuin rakenteisessa tuloksessa (50); tekstissä ovat kaikki." },
    tiivis: { type: "boolean", description: "Tekstituloste on tiivis (pitkä lista ilman hakusanaa)." },
    lahde: LAHDE_SKEEMA,
  },
  required: ["sopimukset", "yhteensa", "rajattu", "tiivis", "lahde"],
};

const TIEDOTTEET_SKEEMA = {
  type: "object",
  properties: {
    tiedotteet: lista(
      {
        type: "object",
        properties: {
          paiva: merkkijono("Tiedotteen päivä (VVVV-KK-PP)."),
          viranomainen: merkkijono("Viranomaisen lyhyt nimi, esim. \"Tukes\"."),
          otsikko: merkkijono("Otsikko."),
          tiivistelma: merkkijono("Tiivistelmä (enintään 400 merkkiä)."),
          linkki: merkkijono("Lähde-linkki: tiedote viranomaisen sivulla."),
        },
        required: ["viranomainen", "otsikko", "linkki"],
      },
      "Tiedotteet uusimmasta vanhimpaan, enintään parametrin enintaan verran.",
    ),
    yhteensa: kokonaisluku("Osumia syötteissä yhteensä."),
    naytetaan: kokonaisluku("Näytettyjen tiedotteiden määrä."),
    alkaen: merkkijono("Rajaus: tiedotteet alkaen (VVVV-KK-PP)."),
    syotteet: lista(
      {
        type: "object",
        properties: { viranomainen: { type: "string" }, maara: { type: "integer" }, alkaen: { type: "string" } },
        required: ["viranomainen", "maara"],
      },
      "Syötteissä nyt olevat tiedotteet viranomaisittain (määrä ja vanhimman päivä).",
    ),
    puuttuvat: lista(
      { type: "object", properties: { viranomainen: { type: "string" }, syy: { type: "string" } }, required: ["viranomainen", "syy"] },
      "Syötteet, joita ei saatu.",
    ),
    valtion_viranomaiset: { type: "boolean", description: "Haussa oli valtion viranomaisten syötteitä." },
    hyvinvointialueet: lista(
      { type: "object", properties: { nimi: { type: "string" }, palvelu: { type: "string" } }, required: ["nimi", "palvelu"] },
      "Haetut hyvinvointialueiden syötteet ja niiden palvelu.",
    ),
    lahde: LAHDE_SKEEMA,
  },
  required: ["tiedotteet", "yhteensa", "naytetaan", "syotteet", "puuttuvat", "valtion_viranomaiset", "hyvinvointialueet", "lahde"],
};

// ---------- virheet ----------

/**
 * Liittimen virheet rungon NaytettavaVirhe-muotoon samoilla teksteillä kuin callTool (virheTeksti). Muut poikkeukset
 * menevät rungolle, joka näyttää yleisen tekstin eikä kirjaa sisäistä tekstiä.
 */
function virheet(hae) {
  return async (args) => {
    try {
      return await hae(args ?? {});
    } catch (e) {
      const v = virheTeksti(e);
      if (v === null) throw e;
      throw new NaytettavaVirhe(v.teksti, v.koodi, v.lahteen_koodi === undefined ? {} : { lahteen_koodi: v.lahteen_koodi });
    }
  };
}

/** Lukeva työkalu. Rakenteiseen tulokseen ei viedä tekstin apukenttiä lahteenRiveja ja kaikkiRivit. */
const luku = ({ hae, ...muut }) =>
  tyokalu({ oikeus: "luku", avoin: true, hae: virheet(hae), poisRakenteesta: ["lahteenRiveja", "kaikkiRivit"], ...muut });

// ---------- työkalut ----------

export const TYOKALUT = [
  luku({
    nimi: "hae_saadoksia",
    otsikko: "Hae säädöksiä",
    kuvaus:
      "Hakee Finlexistä säädöksiä otsikon tai asiasanan perusteella ja palauttaa säädösnumerot ja nimet. Käytä tätä, kun säädöksen numero ei ole tiedossa. Haku kohdistuu ajantasaistettuun lainsäädäntöön. Otsikkohaku etsii merkkijonoa säädöksen nimestä, ei tekstistä (esim. \"arvonlisävero\", \"työaika\", \"osakeyhtiö\").",
    syote: {
      type: "object",
      properties: {
        otsikko: { type: "string", description: "Merkkijono, jonka säädöksen nimi sisältää. Kirjainkoolla ei ole väliä." },
        asiasana: { type: "string", description: "Finlexin asiasana, esim. \"Arvonlisävero\". Valinnainen." },
        vain_voimassa: { type: "boolean", description: "Vain voimassa olevat säädökset (oletus true)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
        kieli: commonProps.kieli,
      },
    },
    tulosSkeema: taiVirhe(SAADOKSET_SKEEMA),
    hae: haeSaadoksia,
    teksti: haeSaadoksiaTeksti,
  }),
  luku({
    nimi: "hae_hallituksen_esityksia",
    otsikko: "Hae hallituksen esityksiä",
    kuvaus:
      "Hakee Finlexistä hallituksen esityksiä otsikon osalla ja/tai vuosilla. Palauttaa tunnukset (HE numero/vuosi) ja otsikot. Säädöksen oman esityksen tunnus löytyy myös saados_tiedot-työkalun Esityöt-rivistä. Finlexin avoimessa datassa ovat esitykset vuodesta 1992.",
    syote: {
      type: "object",
      properties: {
        otsikko: { type: "string", description: "Merkkijono, jonka esityksen otsikko sisältää, esim. \"arvonlisäverolain\" tai \"sosiaalihuoltolain\"." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta. Tulokset ovat vuoden ja numeron mukaan vanhimmasta uusimpaan." },
      },
    },
    tulosSkeema: taiVirhe(ESITYKSET_SKEEMA),
    hae: haeHallituksenEsityksia,
    teksti: haeHallituksenEsityksiaTeksti,
  }),
  luku({
    nimi: "hae_ratkaisuja",
    otsikko: "Hae viranomaisratkaisuja",
    kuvaus:
      "Hakee Finlexistä viranomaisratkaisuja: tietosuojavaltuutettu, eduskunnan oikeusasiamies tai oikeuskansleri. Haku otsikon osalla, asiasanalla ja/tai vuosilla. Palauttaa ratkaisujen numerot, päivämäärät ja otsikot. Tuomioistuinten (KKO, KHO) ratkaisuja Finlexin avoimessa datassa ei ole. Ratkaisut ovat tapauskohtaisia kannanottoja, eivät lakia.",
    syote: {
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
    tulosSkeema: taiVirhe(RATKAISUT_SKEEMA),
    hae: haeRatkaisuja,
    teksti: haeRatkaisujaTeksti,
  }),
  luku({
    nimi: "hae_tyoehtosopimuksia",
    otsikko: "Hae työehtosopimuksia",
    kuvaus:
      "Hakee yleissitoviksi vahvistettuja työehtosopimuksia Finlexistä (työehtosopimuksen yleissitovuuden vahvistamislautakunnan päätökset): sopimuksen nimi, työnantaja- ja työntekijäliitot, voimassa oleva sopimuskausi. Ilman hakusanaa listaa kaikki yleissitovat sopimukset. Palauttaa tunnisteen (esim. 2020/19), jolla sopimuksen teksti haetaan tyoehtosopimus-työkalulla. Jos uusin sopimus ei ole vielä Finlexissä, kerro se.",
    syote: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana sopimuksen nimestä tai sopijaliiton nimestä, esim. \"sosiaalipalvelu\", \"terveyspalvelu\", \"kauneus\", \"HALI\" tai \"Palta\". Valinnainen." },
        kaikki: { type: "boolean", description: "true = myös päätökset, joiden yleissitovuus on päättynyt tai joita ei ole vahvistettu. Oletus: vain yleissitovat." },
      },
    },
    tulosSkeema: taiVirhe(TES_SKEEMA),
    hae: haeTyoehtosopimuksia,
    teksti: haeTyoehtosopimuksiaTeksti,
  }),
  luku({
    nimi: "viranomaistiedotteet",
    otsikko: "Viranomaisten tiedotteet",
    kuvaus:
      "Viranomaisten uusimmat tiedotteet yhdestä paikasta: Fimea (lääkkeet, lääkinnälliset laitteet), Tukes (kosmetiikka, kuluttajaturvallisuus, kemikaalit), Lupa- ja valvontavirasto (sote-valvonta, kuluttajansuoja, työsuojelu), Verohallinto (uutiset ja syventävät vero-ohjeet), tietosuojavaltuutettu, Traficomin Kyberturvallisuuskeskus ja KKV sekä hyvinvointialueet, HUS ja Helsingin sote (ei Keski-Pohjanmaata eikä Lappia). Rajaus viranomaisella, hakusanalla ja päivällä. Syötteissä on vain uusimmat tiedotteet. Kerro viranomainen, päivä, otsikko ja linkki. Tiedote on viranomaisen viestintää, ei säädös; tarkista määräykset ja lait niiden omilla työkaluilla. Tiedotteen tekstin saa viranomaistiedote-työkalulla, ei kuitenkaan Fimean eikä Tukesin tiedotteista.",
    syote: {
      type: "object",
      properties: {
        viranomainen: { type: "string", description: "fimea, tukes, lvv, vero, vero_ohjeet, tietosuoja, kyber, kkv; hyvinvointialue: hyvinvointialueet (kaikki), hus, helsinki, ita_uusimaa, keski_uusimaa, lansi_uusimaa, vantaa_kerava, varsinais_suomi, satakunta, kanta_hame, pirkanmaa, paijat_hame, kymenlaakso, etela_karjala, etela_savo, pohjois_savo, pohjois_karjala, keski_suomi, etela_pohjanmaa, pohjanmaa, keski_pohjanmaa, pohjois_pohjanmaa, kainuu. Oletus: valtion viranomaiset ilman hyvinvointialueita; kaikki = myös hyvinvointialueet. Useita pilkulla erotettuna." },
        hakusana: { type: "string", description: "Sana otsikosta tai tiivistelmästä, esim. \"kosmet\" tai \"arvonlisävero\". Valinnainen." },
        alkaen: { type: "string", description: "Tiedotteet alkaen (vvvv-kk-pp). Valinnainen." },
        enintaan: { type: "integer", description: "Montako näytetään (oletus 20, enintään 60)." },
      },
    },
    tulosSkeema: taiVirhe(TIEDOTTEET_SKEEMA),
    hae: viranomaistiedotteet,
    teksti: viranomaistiedotteetTeksti,
  }),
];

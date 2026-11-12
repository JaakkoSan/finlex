// MCP-työkalut: määrittelyt ja toteutukset.

import {
  fetchText,
  fetchListPage,
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
import { EDK_INDEX_VERSION, buildEdkIndex, partOf as edkPartOf, shardsFor as edkShardsFor, blockLabel as edkBlockLabel, blockPath as edkBlockPath, descendants as edkDescendants, findBlocks as edkFindBlocks, parseSection, labelMatches, decisionBlock } from "./edkDoc.js";
import { EduskuntaError, normTunnus, fetchMatter, fetchDocMeta, fetchDocHtml, docIndexUrl, docWebUrl, matterWebUrl, edkSearch, fetchVote, fetchMatterVotes, searchVotes, voteApiUrl, fetchDocPdfText } from "./eduskunta.js";
import { tesCatalog, tesDoc, tesWebUrl, tesFileUrl, pdfPages, tocLines, findSections, parsePages, regList, regDoc, regUrl } from "./agreements.js";
import { FEEDS, HVA_MISSING, TiedoteError, feedItems, itemText, veroSearch, veroGuide, veroFindDiaari, asDiaari, VERO_TYPES } from "./tiedotteet.js";
import { KilaError, KILA_BASE, kilaUrlAllowed, kilaSession, searchStatements, guideList, docPage, findByNumber, guideText, attachmentText, splitGuidePdfs, isExemption } from "./kila.js";
import { AUTHORITIES as OHJE_AUTH, KKV_TYPES, OhjeError, OhjeUserError, authorityOf, isBlockedHost, newBudget, ohjePage, ohjePdf, searchOhjeet } from "./ohjeet.js";
import { HankeikkunaError, searchProjects, projectByTunnus, projectsForProposal, asettajat, projectWebUrl, docText, docKind } from "./hankeikkuna.js";
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
  {
    name: "eduskuntakasittely",
    description:
      "Palauttaa asian (esim. hallituksen esitys) käsittelyn eduskunnassa: tila ja lopputulos, valiokunnan mietintö ja lausunnot (esim. perustuslakivaliokunnan lausunto), eduskunnan vastaus, lakiehdotusten päätökset (hyväksytty, hyväksytty muutettuna, hylätty), vahvistettujen lakien säädösnumerot sekä käsittelyn vaiheet päivämäärineen (lähetekeskustelu, valiokunnat, vastalauseet, ensimmäinen ja toinen käsittely). Lähde: Eduskunnan avoin data.",
    inputSchema: {
      type: "object",
      properties: {
        asia: { type: "string", description: "Asian tunnus, esim. \"HE 74/2022 vp\" tai \"HE 74/2022\". Myös lakialoitteet (LA), kansalaisaloitteet (KAA) ja muut valtiopäiväasiat." },
        kaikki_vaiheet: { type: "boolean", description: "true = myös valiokuntien kokouskohtaiset vaiheet (asiantuntijakuulemiset, keskustelut). Oletus: vain päävaiheet." },
      },
      required: ["asia"],
    },
  },
  {
    name: "eduskunnan_asiakirja",
    description:
      "Palauttaa valiokunnan mietinnön tai lausunnon (esim. StVM 21/2022 vp, PeVL 38/2022 vp) tai eduskunnan vastauksen (EV) tekstiä. Ilman lisäparametreja: perustiedot, sisällys, päätösehdotus tai lausunnon kannanotto sekä pykälät, joita valiokunta perustelee tai muuttaa. Parametrilla pykala valiokunnan perustelut ja ehdotettu tai hyväksytty sanamuoto pykälälle, parametrilla osa yksi lohko ja parametrilla hakusana osumat tekstistä. Vuotta 1999 vanhemmista asiakirjoista ei ole tekstiä.",
    inputSchema: {
      type: "object",
      properties: {
        asiakirja: { type: "string", description: "Asiakirjan tunnus, esim. \"PeVL 38/2022 vp\", \"StVM 21/2022 vp\" tai \"EV 150/2022 vp\"." },
        pykala: { type: "string", description: "Pykälä, esim. \"51 a\". Valinnainen." },
        luku: { type: "string", description: "Luku, jos pykälänumerointi alkaa joka luvussa alusta (esim. rikoslaki). Valinnainen." },
        laki: { type: "string", description: "Lakiehdotuksen numero (\"1\") tai osa lain nimestä, jos asiakirjassa on useita lakeja. Valinnainen." },
        osa: { type: "string", description: "Lohko otsikolla (\"Valiokunnan yleisperustelut\"), numerolla tai sisällyksen tunnisteella (\"#12\"). Valinnainen." },
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä). Valinnainen." },
      },
      required: ["asiakirja"],
    },
  },
  {
    name: "hae_eduskunnan_asiakirjoja",
    description:
      "Hakee valiokuntien mietintöjä ja lausuntoja, eduskunnan vastauksia ja kansanedustajien kirjallisia kysymyksiä sanalla tekstistä, valiokunnalla, laatijalla (kysyjä) ja vuosilla. Palauttaa tunnukset, päivämäärät ja käsitellyn asian (esim. HE). Yhden hallituksen esityksen asiakirjat saa suoremmin eduskuntakasittely-työkalulla.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana tai sanonta asiakirjan tekstistä, esim. \"omaishoito\". Haku vertaa sanoja sellaisinaan, joten kokeile myös taivutusmuotoja (\"omaishoidon\")." },
        tyyppi: { type: "string", enum: ["mietinto", "lausunto", "vastaus", "kysymys"], description: "Valiokunnan mietintö, valiokunnan lausunto, eduskunnan vastaus tai kirjallinen kysymys. Oletus: mietinnöt, lausunnot ja vastaukset." },
        laatija: { type: "string", description: "Kirjallisen kysymyksen kysyjä (kansanedustajan nimi). Valinnainen; rajaa kirjallisiin kysymyksiin." },
        valiokunta: { type: "string", description: "Valiokunnan nimi, esim. \"perustuslakivaliokunta\" tai \"sosiaali- ja terveysvaliokunta\". Valinnainen." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta, uusimmasta vanhimpaan." },
      },
    },
  },
  {
    name: "eduskunnan_aanestykset",
    description:
      "Eduskunnan täysistunnon äänestykset: tulos (jaa, ei, tyhjiä, poissa), hallitus- ja oppositioryhmien ja eduskuntaryhmien jakaumat, ryhmänsä enemmistöstä poikenneet edustajat sekä yksittäisen edustajan ääni. Hakutavat: aanestys (tunnus, esim. 2026-104-1), asia (esim. HE 151/2026 vp, kaikki asian äänestykset), tai hakusana, edustaja ja aikaväli.",
    inputSchema: {
      type: "object",
      properties: {
        aanestys: { type: "string", description: "Äänestyksen tunnus vuosi-istunto-numero, esim. \"2026-104-1\"." },
        asia: { type: "string", description: "Asian tunnus, esim. \"HE 151/2026 vp\". Palauttaa asian kaikki äänestykset." },
        hakusana: { type: "string", description: "Vapaa tekstihaku asian otsikosta ja äänestyksen otsikosta, esim. \"alkoholilain\"." },
        edustaja: { type: "string", description: "Kansanedustajan nimi (\"Petteri Orpo\" tai sukunimi). Näyttää edustajan äänen; haussa rajaa äänestyksiin, joissa edustaja oli mukana." },
        ryhma: { type: "string", description: "aanestys-haussa: listaa eduskuntaryhmän edustajien äänet (lyhenne kok, ps, sd, kesk, vihr, vas, r, kd tai nimen osa)." },
        kaikki_edustajat: { type: "boolean", description: "aanestys-haussa: true = kaikkien edustajien äänet." },
        alkaen: { type: "string", description: "Äänestykset alkaen (vvvv-kk-pp)." },
        asti: { type: "string", description: "Äänestykset asti (vvvv-kk-pp)." },
        sivu: { type: "integer", description: "Tulossivu (10 äänestystä sivulla)." },
      },
    },
  },
  {
    name: "kirjallinen_kysymys",
    description:
      "Kansanedustajan kirjallinen kysymys ministerille ja ministerin vastaus: kysyjä ja eduskuntaryhmä, päivät, tila, kysymyksen teksti ja vastauksen teksti (vastaukset ovat usein vain PDF:nä, jolloin teksti puretaan PDF:stä). Kysymyksiä haetaan hae_eduskunnan_asiakirjoja-työkalulla (tyyppi kysymys).",
    inputSchema: {
      type: "object",
      properties: {
        kysymys: { type: "string", description: "Kysymyksen tunnus, esim. \"KK 300/2026 vp\" tai \"300/2026\"." },
        vain_vastaus: { type: "boolean", description: "true = jätä kysymyksen teksti pois ja näytä vain vastaus." },
      },
      required: ["kysymys"],
    },
  },
  {
    name: "hae_tyoehtosopimuksia",
    description:
      "Hakee yleissitoviksi vahvistettuja työehtosopimuksia Finlexistä (työehtosopimuksen yleissitovuuden vahvistamislautakunnan päätökset): sopimuksen nimi, työnantaja- ja työntekijäliitot, voimassa oleva sopimuskausi. Ilman hakusanaa listaa kaikki yleissitovat sopimukset. Palauttaa tunnisteen (esim. 2020/19), jolla sopimuksen teksti haetaan tyoehtosopimus-työkalulla.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana sopimuksen nimestä tai sopijaliiton nimestä, esim. \"sosiaalipalvelu\", \"terveyspalvelu\", \"kauneus\", \"HALI\" tai \"Palta\". Valinnainen." },
        kaikki: { type: "boolean", description: "true = myös päätökset, joiden yleissitovuus on päättynyt tai joita ei ole vahvistettu. Oletus: vain yleissitovat." },
      },
    },
  },
  {
    name: "tyoehtosopimus",
    description:
      "Palauttaa yleissitovan työehtosopimuksen tiedot ja tekstiä Finlexistä: sopijaosapuolet, yleissitovuuspäätös ja soveltamisala, sopimusversiot voimassaoloaikoineen ja sopimuksen sisällysluettelo. Parametrilla pykala yksittäinen pykälä (esim. palkat, työaika, lisät, vuosiloma), hakusanalla osumat ja sivut-parametrilla sivualue. Oletuksena käytetään tänään voimassa olevaa sopimusversiota. Teksti puretaan sopimuksen PDF:stä.",
    inputSchema: {
      type: "object",
      properties: {
        sopimus: { type: "string", description: "Tunniste hae_tyoehtosopimuksia-työkalulta (esim. \"2020/19\") tai sopimuksen nimi (esim. \"yksityisen sosiaalipalvelualan työehtosopimus\")." },
        versio: { type: "string", description: "Sopimusversio: järjestysnumero luettelosta (\"1\") tai päivämäärä (vvvv-kk-pp), jolloin voimassa ollut versio valitaan. Oletus: tänään voimassa oleva." },
        pykala: { type: "string", description: "Pykälä, esim. \"5\" tai \"6 a\". Sama numero voi esiintyä sopimuksen eri osissa (työehtosopimus, palkkasopimus, liitteet); kaikki esiintymät palautetaan." },
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä). Valinnainen." },
        sivut: { type: "string", description: "PDF:n sivualue, esim. \"49\" tai \"49-55\". Valinnainen." },
      },
      required: ["sopimus"],
    },
  },
  {
    name: "hae_viranomaismaarayksia",
    description:
      "Hakee viranomaisten määräyksiä Finlexin määräyskokoelmista (esim. Valvira, THL, Fimea, Traficom, Verohallinto, Ruokavirasto, ministeriöt) otsikon sanalla, asiasanalla ja vuosilla. Palauttaa määräyksen numeron, viranomaisen, määräystunnuksen (esim. 1/2024) ja voimaantulon. Järjestys: vanhimmasta uusimpaan, joten rajaa vuosilla.",
    inputSchema: {
      type: "object",
      properties: {
        otsikko: { type: "string", description: "Sana tai sanan osa määräyksen otsikosta, esim. \"omavalvont\" tai \"potilasasiakirj\". Valinnainen." },
        asiasana: { type: "string", description: "Finlexin asiasana, esim. \"terveydenhuolto\". Valinnainen." },
        alkaen_vuosi: { type: "integer", description: "Ensimmäinen vuosi (valinnainen)." },
        paattyen_vuosi: { type: "integer", description: "Viimeinen vuosi (valinnainen)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 tulosta." },
      },
    },
  },
  {
    name: "viranomaismaarays",
    description:
      "Palauttaa viranomaisen määräyksen tiedot ja tekstin Finlexistä: otsikko, viranomainen, määräystunnus, diaarinumero, antopäivä ja voimaantulo, asiasanat sekä teksti (PDF:stä purettuna). Pitkä teksti sivuittain (sivut) tai hakusanalla.",
    inputSchema: {
      type: "object",
      properties: {
        maarays: { type: "string", description: "Tunnus hae_viranomaismaarayksia-työkalulta, esim. \"national-supervisory-authority-for-welfare-and-health/2024/50504\". Vanhemmat määräykset myös pelkällä Finlexin numerolla (\"50504\")." },
        vuosi: { type: "integer", description: "Vuosi, jos määräys annetaan pelkällä numerolla (vuodesta 2025 numerointi alkaa viranomaiskohtaisesti alusta). Valinnainen." },
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä). Valinnainen." },
        sivut: { type: "string", description: "PDF:n sivualue, esim. \"3\" tai \"3-6\". Valinnainen." },
      },
      required: ["maarays"],
    },
  },
  {
    name: "viranomaistiedotteet",
    description:
      "Viranomaisten uusimmat tiedotteet yhdestä paikasta: Fimea (lääkkeet, lääkinnälliset laitteet), Tukes (kosmetiikka, kuluttajaturvallisuus, kemikaalit), Lupa- ja valvontavirasto (sote-valvonta, kuluttajansuoja, työsuojelu), Verohallinto (uutiset ja syventävät vero-ohjeet), tietosuojavaltuutettu, Traficomin Kyberturvallisuuskeskus ja KKV sekä hyvinvointialueet, HUS ja Helsingin sote (ei Pohjois-Savoa eikä Lappia). Rajaus viranomaisella, hakusanalla ja päivällä. Syötteissä on vain uusimmat tiedotteet.",
    inputSchema: {
      type: "object",
      properties: {
        viranomainen: { type: "string", description: "fimea, tukes, lvv, vero, vero_ohjeet, tietosuoja, kyber, kkv; hyvinvointialue: hyvinvointialueet (kaikki), hus, helsinki, ita_uusimaa, keski_uusimaa, lansi_uusimaa, vantaa_kerava, varsinais_suomi, satakunta, kanta_hame, pirkanmaa, paijat_hame, kymenlaakso, etela_karjala, etela_savo, pohjois_karjala, keski_suomi, etela_pohjanmaa, pohjanmaa, keski_pohjanmaa, pohjois_pohjanmaa, kainuu. Oletus: valtion viranomaiset ilman hyvinvointialueita; kaikki = myös hyvinvointialueet. Useita pilkulla erotettuna." },
        hakusana: { type: "string", description: "Sana otsikosta tai tiivistelmästä, esim. \"kosmet\" tai \"arvonlisävero\". Valinnainen." },
        alkaen: { type: "string", description: "Tiedotteet alkaen (vvvv-kk-pp). Valinnainen." },
        enintaan: { type: "integer", description: "Montako näytetään (oletus 20, enintään 60)." },
      },
    },
  },
  {
    name: "viranomaistiedote",
    description:
      "Palauttaa Verohallinnon, Lupa- ja valvontaviraston, tietosuojavaltuutetun, Kyberturvallisuuskeskuksen, KKV:n tai hyvinvointialueen tiedotteen tekstin osoitteella. Syventävästä vero-ohjeesta (myös Verohallinnon päätös, kannanotto tai KVL:n ennakkoratkaisu) ilman lisäparametreja: diaarinumero, voimassaolo, muutokset ja sisällysluettelo (lyhyestä ohjeesta koko teksti). Parametrilla luku yksi luku alalukuineen sanatarkasti (esim. \"3.7.3\" tai \"Poistot\"), parametrilla hakusana osumat luvuittain otteineen.",
    inputSchema: {
      type: "object",
      properties: {
        osoite: { type: "string", description: "Osoite (vero.fi, sttinfo.fi, tietosuoja.fi, kyberturvallisuuskeskus.fi, kkv.fi tai hyvinvointialueen sivusto), esim. hae_vero_ohjeita- tai viranomaistiedotteet-työkalun tuloksesta." },
        luku: { type: "string", description: "Vero-ohjeen luku numerolla (\"3.7.3\", \"3.9\") tai otsikon sanalla (\"Poistot\"). Luku palautetaan alalukuineen. Valinnainen." },
        hakusana: { type: "string", description: "Sana tai sanonta, jota etsitään vero-ohjeen tekstistä; palauttaa luvut, joissa se esiintyy, otteineen. Käytä sanan vartaloa (esim. \"remont\"). Valinnainen." },
      },
      required: ["osoite"],
    },
  },
  {
    name: "hae_vero_ohjeita",
    description:
      "Hakee Verohallinnon syventäviä vero-ohjeita (sekä halutessa Verohallinnon päätöksiä, kannanottoja ja keskusverolautakunnan ennakkoratkaisuja) koko arkistosta otsikon ja tekstin sanoilla vero.fi:n hakurajapinnasta tai diaarinumerolla (myös korvatut versiot). Palauttaa otsikon, päivän, osoitteen ja otteen. Lue ohje tai sen luku viranomaistiedote-työkalulla (osoite, luku, hakusana).",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sanat, esim. \"vuokratulojen verotus\" tai \"remontti\", tai diaarinumero, esim. \"VH/7418/00.01.00/2025\". Tyhjä = uusimmat." },
        tyyppi: { type: "string", description: "ohje (oletus; diaarinumerolla ohje, paatos ja kannanotto), paatos, kannanotto, kvl tai kaikki. Useita pilkulla erotettuna." },
        jarjestys: { type: "string", enum: ["osuvuus", "uusin", "vanhin", "nimi"], description: "osuvuus (oletus, tai uusin kun hakusana puuttuu), uusin, vanhin tai nimi." },
        vuosi: { type: "integer", description: "Julkaisuvuosi. Valinnainen." },
        vanhat_versiot: { type: "boolean", description: "Näytä myös korvatut ohjeversiot. Oletus: ei." },
        kieli: { type: "string", enum: ["fi", "sv"], description: "fi (oletus) tai sv." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla 10 tulosta." },
      },
    },
  },
  {
    name: "hae_kila_lausuntoja",
    description:
      "Hakee kirjanpitolautakunnan (KILA) lausuntoja ja poikkeuslupia (noin 940 kpl, 1974 alkaen) sekä yleisohjeita kirjanpitolautakunta.fi:stä sivuston omalla haulla: hakusana, lausunnon numero, vuosi tai vuodesta vuoteen, tyyppi ja yleisohjeiden voimassaolo. Palauttaa numeron (esim. 1998/1516), päivän, otsikon ja osoitteen. Lue asiakirja kila_lausunto-työkalulla. Sivuston haku painottuu otsikkoon ja asiasanoihin, joten kokeile tarvittaessa useampaa sanaa.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana tai sanat, esim. \"leasing\", \"investointiavustus\" tai \"poistot\". Valinnainen." },
        numero: { type: "string", description: "Lausunnon numero, esim. \"1516\" tai \"1998/1516\". Valinnainen." },
        vuosi: { type: "integer", description: "Antovuosi. Valinnainen." },
        alkaen_vuosi: { type: "integer", description: "Annettu aikaisintaan tänä vuonna. Valinnainen." },
        paattyen_vuosi: { type: "integer", description: "Annettu viimeistään tänä vuonna. Valinnainen." },
        tyyppi: { type: "string", enum: ["lausunto", "poikkeuslupa", "yleisohje", "kaikki"], description: "kaikki (oletus: lausunnot ja poikkeusluvat sekä hakusanalla voimassa olevat yleisohjeet), lausunto, poikkeuslupa tai yleisohje." },
        voimassa: { type: "boolean", description: "Yleisohjeet: true = vain voimassa olevat, false = vain aiemmat (korvatut). Oletus tyypillä yleisohje: molemmat." },
        sivu: { type: "integer", description: "Lausuntojen tulossivu, 1 = ensimmäinen. Sivulla 25 tulosta." },
      },
    },
  },
  {
    name: "kila_lausunto",
    description:
      "Palauttaa kirjanpitolautakunnan lausunnon, poikkeusluvan tai yleisohjeen sanatarkan tekstin kirjanpitolautakunta.fi:stä numerolla (lausunto, esim. \"1998/1516\") tai osoitteella. Lausunnosta koko teksti lukunumeroineen (hakemus, perustelut, lausunto). Yleisohjeesta (teksti PDF:stä) ilman lisäparametreja sisällysluettelo ja liitteiden luettelo; parametrilla luku yksi luku alalukuineen (esim. \"2.4\" tai \"Jäännösarvo\"), parametrilla hakusana osumat luvuittain ja parametrilla liite liitteen teksti (esim. \"1\" tai \"3a\").",
    inputSchema: {
      type: "object",
      properties: {
        numero: { type: "string", description: "Lausunnon tai poikkeusluvan numero, esim. \"1516\" tai \"2010/1861\"." },
        osoite: { type: "string", description: "Asiakirjan osoite hae_kila_lausuntoja-työkalun tuloksesta (https://kirjanpitolautakunta.fi/-/...). Yleisohjeet haetaan osoitteella." },
        luku: { type: "string", description: "Luku numerolla (\"2.4\", \"3\") tai otsikon sanalla (\"Jäännösarvo\"). Luku palautetaan alalukuineen. Valinnainen." },
        hakusana: { type: "string", description: "Sana tai sanonta, jota etsitään tekstistä; palauttaa luvut, joissa se esiintyy, otteineen. Käytä sanan vartaloa (esim. \"leasing\"). Valinnainen." },
        liite: { type: "string", description: "Yleisohjeen liite numerolla tai tunnuksella, esim. \"1\" tai \"3a\". Liitteet haetaan vain pyydettäessä. Valinnainen." },
      },
    },
  },
  {
    name: "hae_viranomaisohjeita",
    description:
      "Hakee viranomaisten ohjeita ja linjauksia niiden verkkosivuilta: Traficom (Kyberturvallisuuskeskus: evästeet, sähköisen viestinnän tietoturva ja luottamuksellisuus, sähköinen tunnistaminen ja luottamuspalvelut, kyberturvallisuusohjeet ja -oppaat), tietosuojavaltuutettu (tietosuoja.fi:n ohjeet, esim. käsittelyperusteet, rekisteröidyn oikeudet, kameravalvonta, työelämä), KKV (kuluttaja-asiamiehen linjaukset ja ohjeistukset, kuluttaja-asioiden ohjeet, päätökset) ja PRH (kaupparekisteri, yhdistykset, säätiöt, tavaramerkit, patentit). Haku kohdistuu otsikkoon ja osoitteeseen (KKV:ssa sivujen otsikoihin WordPressin hakurajapinnalla ja päätöksissä osoitteeseen; KKV:n päätöksen voi hakea myös diaarinumerolla). Palauttaa otsikon ja osoitteen; lue ohje viranomaisohje-työkalulla.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana tai sanan alku otsikosta, esim. \"eväste\", \"vaikuttajamarkkinointi\", \"oikeutettu etu\", \"tilinpäätös\", tai KKV:n diaarinumero (KKV/1613/14.00.10/2026). Tyhjä = luettelo." },
        viranomainen: { type: "string", description: "traficom, tietosuoja, kkv, prh tai kaikki (oletus). Useita pilkulla erotettuna." },
        tyyppi: { type: "string", enum: ["ohje", "linjaus", "paatos", "kaikki"], description: "ohje (ohjeet ja linjaukset), linjaus (KKV:n kuluttaja-asiamiehen linjaukset ja ohjeistukset), paatos (KKV:n päätökset; tietosuoja.fi:n ratkaisusivut) tai kaikki (oletus)." },
        enintaan: { type: "integer", description: "Montako tulosta näytetään (oletus 20, enintään 60)." },
      },
    },
  },
  {
    name: "viranomaisohje",
    description:
      "Palauttaa viranomaisen ohjeen tai päätöksen tekstin osoitteella (kyberturvallisuuskeskus.fi, tietosuoja.fi, kkv.fi tai prh.fi; myös näiden PDF-tiedostot). Ilman lisäparametreja: otsikko, tiedot (esim. KKV:n päätöksen päivämäärä ja diaarinumero), sisällysluettelo ja liitteet (PDF); lyhyestä ohjeesta koko teksti. Parametrilla luku yksi luku alalukuineen sanatarkasti (esim. \"4.1\" tai otsikon sana), hakusanalla osumat luvuittain (PDF:ssä sivuittain) ja PDF:stä sivu-parametrilla sivualue.",
    inputSchema: {
      type: "object",
      properties: {
        osoite: { type: "string", description: "Ohjeen tai PDF:n osoite, esim. hae_viranomaisohjeita-työkalun tuloksesta tai ohjeen liiteluettelosta." },
        luku: { type: "string", description: "Luku numerolla (\"4.1\", \"2\") tai otsikon sanalla (\"Pääsääntö\"). Palautetaan alalukuineen. Valinnainen." },
        hakusana: { type: "string", description: "Sana tai sanan vartalo, jota etsitään tekstistä (esim. \"suostumu\"). Valinnainen." },
        sivu: { type: "string", description: "PDF:n sivu tai sivualue, esim. \"3\" tai \"3-5\". Valinnainen." },
      },
      required: ["osoite"],
    },
  },
  {
    name: "hae_lainvalmisteluhankkeita",
    description:
      "Hakee ministeriöiden lainvalmistelu- ja muita hankkeita valtioneuvoston Hankeikkunasta: hakusana, ministeriö, tila, valmisteluvaihe, hallituksen esitys tai asetus, asettamispäivä. lausuntokierros_auki: true listaa hankkeet, joiden lausuntokierros on nyt käynnissä, määräajan mukaan. Palauttaa hanketunnukset (esim. STM006:00/2020), vaiheen, lausuntokierrokset ja HE-numerot. Lähde: Hankeikkunan avoin rajapinta.",
    inputSchema: {
      type: "object",
      properties: {
        hakusana: { type: "string", description: "Sana hankkeen nimestä tai kuvauksesta, esim. \"kotihoito\" tai \"vanhuspalvelulaki\". Valinnainen." },
        ministerio: { type: "string", description: "Asettanut ministeriö lyhenteenä (STM, OM, VM, TEM, ...) tai nimellä. Valinnainen." },
        tyyppi: { type: "string", enum: ["lainsaadanto", "hanke", "toimielin", "strategia", "kaikki"], description: "lainsaadanto (oletus) = lainvalmistelu (HE, asetukset); hanke = muut hankkeet ja selvitykset; toimielin = työryhmät, neuvottelukunnat; strategia; kaikki." },
        laji: { type: "string", enum: ["he", "asetus"], description: "Lainsäädäntöhankkeista vain hallituksen esityksen valmistelu (he) tai asetuksen antaminen (asetus). Valinnainen." },
        tila: { type: "string", enum: ["suunnitteilla", "kaynnissa", "paattynyt"], description: "Hankkeen tila. Valinnainen." },
        vaihe: {
          type: "string",
          enum: ["esivalmistelu", "perusvalmistelu", "lausuntomenettely", "jatkovalmistelu", "valtioneuvoston_paatoksenteko", "eduskuntakasittely", "lain_vahvistaminen", "valmistunut", "keskeytetty"],
          description: "Lainvalmistelun vaihe. Valinnainen.",
        },
        lausuntokierros_auki: { type: "boolean", description: "true = vain hankkeet, joiden lausuntokierros on käynnissä tänään, lähin määräaika ensin." },
        alkaen: { type: "string", description: "Asetettu aikaisintaan (vvvv-kk-pp). Valinnainen." },
        paattyen: { type: "string", description: "Asetettu viimeistään (vvvv-kk-pp). Valinnainen." },
        jarjestys: { type: "string", enum: ["osuvuus", "muokattu", "asetettu"], description: "osuvuus (oletus hakusanalla), muokattu (oletus ilman hakusanaa) tai asetettu (uusin ensin)." },
        sivu: { type: "integer", description: "Tulossivu, 1 = ensimmäinen. Sivulla enintään 10 hanketta." },
      },
    },
  },
  {
    name: "lainvalmisteluhanke",
    description:
      "Palauttaa ministeriön lainvalmistelu- tai muun hankkeen tiedot Hankeikkunasta: tila ja valmisteluvaihe, tiivistelmä, tavoitteet, hallituksen esityksen tiedot (HE-numero, esittelyviikko HE-luettelossa, vastuuministeri, säädösnumerot), vaiheet ja lausuntokierrokset määräaikoineen, linkit lausuntopalveluun sekä asiakirjat (lausuntopyynnöt, luonnokset, muistiot, lausunnot laatijoittain). Hankkeen voi antaa tunnuksella tai hallituksen esityksen numerolla.",
    inputSchema: {
      type: "object",
      properties: {
        hanke: { type: "string", description: "Hanketunnus (esim. \"STM006:00/2020\") tai hallituksen esitys (esim. \"HE 231/2021\")." },
        asiakirjatyyppi: { type: "string", description: "Listaa vain tämän tyypin asiakirjat, esim. \"lausunto\", \"lausuntopyynto\", \"muistio\", \"yhteenveto\" tai \"kaikki\". Oletus: muut kuin lausunnot; lausunnoista määrä ja laatijat." },
        laatija: { type: "string", description: "Listaa asiakirjat, joiden laatijan nimessä on tämä teksti, esim. \"Kymenlaakso\" tai \"Kuntaliitto\". Valinnainen." },
        sivu: { type: "integer", description: "Asiakirjaluettelon sivu (100 asiakirjaa sivulla). Valinnainen." },
      },
      required: ["hanke"],
    },
  },
  {
    name: "lainvalmistelun_asiakirja",
    description:
      "Palauttaa Hankeikkunan hankkeen asiakirjan tekstin (PDF tai Word): esimerkiksi lausuntopyynnön ja esitysluonnoksen, muistion, lausuntoyhteenvedon tai yksittäisen lausunnon. Asiakirja annetaan numerolla lainvalmisteluhanke-työkalun luettelosta. Pitkä teksti jaetaan osiin (osa-parametri); hakusanalla palautetaan osumat ympäröivine teksteineen.",
    inputSchema: {
      type: "object",
      properties: {
        hanke: { type: "string", description: "Hanketunnus, esim. \"STM006:00/2020\", tai hallituksen esitys (\"HE 231/2021\")." },
        asiakirja: { type: "integer", description: "Asiakirjan numero lainvalmisteluhanke-työkalun luettelosta." },
        hakusana: { type: "string", description: "Etsittävä merkkijono (kirjainkoolla ei väliä). Valinnainen." },
        osa: { type: "integer", description: "Tekstin osa, 1 = alku (40 000 merkkiä osassa). Valinnainen." },
      },
      required: ["hanke", "asiakirja"],
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
  eduskuntakasittely: "Eduskuntakäsittely",
  eduskunnan_asiakirja: "Eduskunnan asiakirja",
  hae_eduskunnan_asiakirjoja: "Hae eduskunnan asiakirjoja",
  eduskunnan_aanestykset: "Eduskunnan äänestykset",
  kirjallinen_kysymys: "Kirjallinen kysymys ja vastaus",
  hae_lainvalmisteluhankkeita: "Hae lainvalmisteluhankkeita",
  lainvalmisteluhanke: "Lainvalmisteluhanke",
  lainvalmistelun_asiakirja: "Lainvalmistelun asiakirja",
  hae_tyoehtosopimuksia: "Hae työehtosopimuksia",
  tyoehtosopimus: "Työehtosopimus",
  hae_viranomaismaarayksia: "Hae viranomaisten määräyksiä",
  viranomaismaarays: "Viranomaisen määräys",
  viranomaistiedotteet: "Viranomaisten tiedotteet",
  viranomaistiedote: "Viranomaisen tiedote",
  hae_vero_ohjeita: "Hae vero-ohjeita",
  hae_viranomaisohjeita: "Hae viranomaisten ohjeita",
  viranomaisohje: "Viranomaisen ohje",
  hae_kila_lausuntoja: "Hae kirjanpitolautakunnan lausuntoja",
  kila_lausunto: "Kirjanpitolautakunnan lausunto tai yleisohje",
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

// Sivu haetaan kulkemalla edelliset sivut (ks. fetchListPage), joten selaussyvyys rajataan.
const MAX_LIST_PAGE = 30;
function asPage(v) {
  const n = Math.max(1, Number(v) || 1);
  if (!Number.isInteger(n)) throw new UserError("Anna sivu kokonaislukuna, esim. 2.");
  if (n > MAX_LIST_PAGE) throw new UserError(`Sivuja voi selata enintään ${MAX_LIST_PAGE}. Rajaa hakua (esim. vuosilla).`);
  return n;
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
  const page = asPage(args.sivu);
  const params = {
    langAndVersion: `${lang}@latest`,
    titleContains: args.otsikko,
    keyword: args.asiasana,
    limit: 10,
    sortBy: "number",
  };
  if (args.vain_voimassa !== false) params.isInForce = "true";
  const list = await fetchListPage(listUrl("statute-consolidated", params), page);
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
  const page = asPage(args.sivu);
  const params = {
    langAndVersion: "fin@",
    titleContains: args.otsikko,
    startYear: args.alkaen_vuosi,
    endYear: args.paattyen_vuosi,
    limit: 10,
    sortBy: "dateIssued",
  };
  const list = await fetchListPage(docListUrl("government-proposal", params), page);
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
    out.push("");
  }
  out.push(`Eduskuntakäsittely (mietintö, lausunnot, muutokset): eduskuntakasittely-työkalulla, asia "HE ${s.number}/${s.year} vp".`);
  out.push(`Valmistelu ministeriössä (lausuntokierros, lausunnot): lainvalmisteluhanke-työkalulla, hanke "HE ${s.number}/${s.year}".`);
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

// ---------- Eduskunnan asiakirjat ----------

const MATTER_TTL = 6 * 3600; // käsittely voi olla kesken
const DOC_TTL = 7 * 86400; // valmis asiakirja muuttuu harvoin (korjausversiot)

function asTunnus(v, what) {
  const t = normTunnus(v);
  if (!t) throw new UserError(`Anna ${what} tunnuksena, esim. ${what === "asia" ? '"HE 74/2022 vp"' : '"PeVL 38/2022 vp"'}.`);
  return t;
}

const fi = (o) => (o && typeof o === "object" && "fi" in o ? o.fi : o);
const lc1 = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

async function eduskuntakasittely(args) {
  const tunnus = asTunnus(args.asia, "asia");
  const m = await fetchMatter(tunnus, MATTER_TTL);
  if (!m) throw new UserError(`Asiaa ${tunnus} ei löytynyt Eduskunnan avoimesta datasta. Tarkista tunnus (esim. "HE 74/2022 vp").`);
  const out = [`${fi(m.eduskuntatunnus) ?? tunnus} ${fi(m.nimeke) ?? ""}`.trim()];
  const info = [];
  if (fi(m.tila)) info.push(`Tila: ${fi(m.tila)}`);
  if (fi(m.kokonaispaatosnimi)) info.push(`lopputulos: ${lc1(fi(m.kokonaispaatosnimi))}`);
  if (fi(m.viimeisinKasittelyvaihe)) info.push(`viimeisin vaihe: ${lc1(fi(m.viimeisinKasittelyvaihe))}`);
  if (info.length) out.push(info.join(", ") + ".");
  const dates = [];
  if (fi(m.laadintapvm)) dates.push(`Vireille ${fmtDate(fi(m.laadintapvm))}`);
  if (fi(m.paattymispvm)) dates.push(`käsittely päättyi ${fmtDate(fi(m.paattymispvm))}`);
  if (dates.length) out.push(dates.join(", ") + ".");
  out.push(`Lähde: ${matterWebUrl(fi(m.eduskuntatunnus) ?? tunnus)} (Eduskunnan avoin data, CC BY 4.0)`);

  // Keskeiset asiakirjat; yhdistetyt aloitteet näkyvät erikseen (niillä ei ole asiakirjatunnusta).
  const docs = (fi(m.keskeisetAsiakirjat) ?? []).filter((d) => d.eduskuntatunnus && d.edktunnus);
  if (docs.length) {
    out.push("", "Asiakirjat (mietinnön, lausunnon tai vastauksen teksti eduskunnan_asiakirja-työkalulla):");
    for (const d of docs) {
      const parts = [d.asiakirjatyyppinimi, d.valiokuntanimi ? lc1(d.valiokuntanimi) : null, d.laadintapvm ? fmtDate(d.laadintapvm) : null].filter(Boolean);
      const note = d.asiakirjatyyppikoodi === "HE" ? " – teksti hallituksen_esitys-työkalulla" : d.htmlSaatavilla === false ? " – ei tekstiä avoimessa datassa" : "";
      out.push(`- ${d.eduskuntatunnus}${parts.length ? ` (${parts.join(", ")})` : ""}${note}`);
    }
  }

  const bills = [...(fi(m.ehdotukset) ?? [])];
  if (bills.length) {
    // Rajapinta järjestää ehdotukset nimen mukaan; numeroiduissa (vanhat asiat) numerojärjestys.
    const numOf = (e) => {
      const nm = String(e.nimeke ?? "").match(/^\s*(\d+)\s*[.)]/);
      return nm ? +nm[1] : null;
    };
    if (bills.every((e) => numOf(e) !== null)) bills.sort((a, b2) => numOf(a) - numOf(b2));
    out.push("", "Lakiehdotukset ja päätökset:");
    for (const e of bills) {
      const parts = [];
      if (e.paatosnimi) parts.push(lc1(e.paatosnimi));
      if (e.vahvistuspvm) parts.push(`vahvistettu ${fmtDate(e.vahvistuspvm)}`);
      if (e.saadoskokoelmaviite) parts.push(`säädös ${e.saadoskokoelmaviite}`);
      if (e.sopimussarjaviite) parts.push(`SopS ${e.sopimussarjaviite}`);
      out.push(`- ${String(e.nimeke ?? "(nimetön ehdotus)").replace(/\s+/g, " ").trim()}${parts.length ? `: ${parts.join(", ")}` : ""}`);
    }
    if (bills.some((e) => e.saadoskokoelmaviite)) out.push("Säädöksen teksti: saados_tiedot tai hae_pykala (vuosi ja numero säädösnumerosta).");
  }

  const steps = matterSteps(fi(m.kasittelyt) ?? [], !!args.kaikki_vaiheet);
  if (steps.length) {
    out.push("", `Käsittelyn vaiheet${args.kaikki_vaiheet ? "" : " (päävaiheet; kaikki: kaikki_vaiheet: true)"}:`, ...steps);
  } else {
    // Varalla, jos tapahtumia ei ole: valiokuntien viimeisin vaihe.
    const comm = fi(m.valiokuntienViimeisimmatKasittelyt) ?? [];
    const commLines = comm
      .filter((k) => k?.valiokunta?.nimi)
      .map((k) => `- ${k.valiokunta.nimi}: ${k.fraasi?.fraasisisalto ?? k.kasittelyvaihe ?? ""}${k.tapahtumapvm ? ` (${fmtDate(k.tapahtumapvm)})` : ""}`.trimEnd());
    if (commLines.length) out.push("", "Valiokunnat (viimeisin käsittelyvaihe):", ...commLines);
  }

  const joined = (fi(m.yhdistetytAsiat) ?? []).map((a) => a?.eduskuntatunnus).filter(Boolean);
  if (joined.length) out.push("", `Yhdistetyt asiat: ${joined.join(", ")}`);
  const eu = (fi(m.euViittaukset) ?? []).map((a) => a?.eduskuntatunnus).filter(Boolean);
  if (eu.length) out.push("", `EU-viittaukset: ${eu.join(", ")}`);
  return clip(out.join("\n"));
}

// Käsittelytapahtumien päävaiheet (yleinenkasittelyvaihetunnus). Muut ovat valiokuntien
// kokouskohtaisia vaiheita (asiantuntijakuulemiset, keskustelut, esittelyt), joita
// suurissa asioissa on satoja. KASYLE on pöytäkirjan asiakohdan viite ilman sisältöä.
const MAIN_STEPS = new Set(["ANTO", "ILM", "LK", "ILMVK", "ILMVKA", "VK", "VKPM", "VKPLA", "VKPP", "EV", "TOIMEV", "PERU", "RAU", "HYL"]);
const PLENARY_STEP = /^(1K|2K|3K|OAO|AK|AINK|ENNK|PALVK)/;

function matterSteps(list, all) {
  const keep = (k) => {
    const c = k.yleinenkasittelyvaihetunnus ?? "";
    if (c === "KASYLE") return false;
    if (all) return true;
    const f = k.fraasi?.fraasisisalto ?? "";
    if (MAIN_STEPS.has(c) || PLENARY_STEP.test(c)) return true;
    // Valiokunnan ratkaisu (mietintöluonnos hyväksytty, vastalauseet).
    if (/^(YKSKAS|RATKAS)/.test(c)) return /hyväksyi|vastalause|äänest/i.test(f);
    return false;
  };
  const tp = (k) => {
    const m = String(k.kasittelytunnus ?? "").match(/TP-(\d+)$/);
    return m ? +m[1] : 0;
  };
  // Merkkijonovertailu ilman localeComparea (ICU:n alustus on kylmänä hidas). ISO-päivämäärät järjestyvät oikein.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const rows = list.filter(keep).sort((a, b) => cmp(String(a.tapahtumapvm ?? ""), String(b.tapahtumapvm ?? "")) || tp(a) - tp(b));
  const out = [];
  let prev = "";
  for (const k of rows) {
    let f = String(k.fraasi?.fraasisisalto ?? "").replace(/\s+/g, " ").trim();
    const who = k.valiokunta?.nimi ? `${k.valiokunta.nimi}${k.valiokunta.jaosto?.nimi ? ` (${k.valiokunta.jaosto.nimi})` : ""}: ` : "";
    const phase = String(k.kasittelyvaihe ?? k.yleinenkasittelyvaihe ?? "").replace(/[.,]?\s*aliasia$/i, "").replace(/\.$/, "");
    if (f.replace(/\.$/, "").toLowerCase() === phase.toLowerCase()) f = "";
    const line = `- ${fmtDate(k.tapahtumapvm) ?? "?"} ${phase}${who || f ? " – " : ""}${who}${f}`;
    if (line !== prev) out.push(line);
    prev = line;
  }
  return out;
}

// --- Asiakirjan hakemisto ---

async function loadEdkDoc(args) {
  const tunnus = asTunnus(args.asiakirja, "asiakirja");
  const meta = await fetchDocMeta(tunnus, DOC_TTL);
  if (!meta) throw new UserError(`Asiakirjaa ${tunnus} ei löytynyt Eduskunnan avoimesta datasta. Tarkista tunnus; asiakirjat löytyvät myös eduskuntakasittely-työkalulla.`);
  if (meta.htmlSaatavilla === false) {
    throw new UserError(`Asiakirjasta ${tunnus} ei ole tekstiä Eduskunnan avoimessa datassa (vanhimmista asiakirjoista on vain PDF). Asiakirja: ${docWebUrl(meta.edktunnus)}`);
  }
  const url = docIndexUrl(meta.edktunnus);
  const s = { url, tunnus, meta, built: null };
  let base = await getPart(url, "base", DOC_TTL, EDK_INDEX_VERSION);
  if (!base || base.v !== EDK_INDEX_VERSION) {
    s.built = await buildEdkDoc(s);
    base = s.built.base;
  }
  s.base = base;
  return s;
}

async function buildEdkDoc(s) {
  const html = await fetchDocHtml(s.meta.edktunnus);
  if (html === null) throw new UserError(`Asiakirjan ${s.tunnus} tekstiä ei saatu Eduskunnan rajapinnasta. Asiakirja: ${docWebUrl(s.meta.edktunnus)}`);
  const idx = buildEdkIndex(html, { title: s.meta.nimeketeksti });
  if (!idx) throw new UserError(`Asiakirjan ${s.tunnus} tekstiä ei voitu tulkita. Asiakirja: ${docWebUrl(s.meta.edktunnus)}`);
  const parts = { base: idx.base };
  idx.shards.forEach((p, i) => (parts[`p${i}`] = p));
  await putParts(s.url, DOC_TTL, parts, EDK_INDEX_VERSION);
  return idx;
}

async function edkShard(s, k) {
  if (s.built) return s.built.shards[k];
  const v = await getPart(s.url, `p${k}`, DOC_TTL, EDK_INDEX_VERSION);
  if (v !== undefined) return v;
  s.built = await buildEdkDoc(s);
  s.base = s.built.base;
  return s.built.shards[k];
}

async function edkParas(s, start, end) {
  const loaded = new Map();
  for (const k of edkShardsFor(s.base, start, end)) loaded.set(k, await edkShard(s, k));
  return (i) => {
    const k = edkPartOf(s.base.shardStarts, i);
    return loaded.get(k)[i - s.base.shardStarts[k]];
  };
}

function edkHeader(s) {
  const a = s.meta;
  // Vanhoissa asiakirjoissa tyypin nimessä on jo valiokunta ("Lakivaliokunnan mietintö").
  const typeName = a.asiakirjatyyppinimi ?? "";
  const showCommittee = a.valiokuntanimi && !typeName.toLowerCase().startsWith(a.valiokuntanimi.toLowerCase().slice(0, -3));
  const lines = [`${a.eduskuntatunnus} ${typeName}${showCommittee ? `, ${lc1(a.valiokuntanimi)}` : ""}`.trim()];
  const title = a.nimeketeksti || s.base.title;
  if (title) lines.push(title);
  const info = [];
  if (a.laadintapvm) info.push(`Päivätty ${fmtDate(a.laadintapvm)}`);
  const matter = a.vireilletuloEduskuntatunnus || s.base.matter;
  if (matter) info.push(`asia ${matter}`);
  if (info.length) lines.push(info.join(", ") + ".");
  lines.push(`Lähde: ${docWebUrl(a.edktunnus)} (Eduskunnan avoin data, CC BY 4.0)`);
  return lines.join("\n");
}

const lawName = (b, n) => {
  if (n === null || n === undefined) return null;
  for (const i of b.laws) {
    const blk = b.blocks[i];
    if (blk.num && parseInt(blk.num, 10) === n) return edkBlockLabel(blk);
  }
  return `${n}. lakiehdotus`;
};

function entryLabel(b, r) {
  const parts = [];
  if (r.vl) parts.push(`Vastalause ${r.vl}`);
  const law = r.law !== null && r.law !== undefined ? lawName(b, r.law) : null;
  if (law) parts.push(law);
  else {
    // Numeroimaton laki (esim. eduskunnan vastauksessa): lähin lakiotsikko.
    for (let j = r.b; j >= 0; j = b.blocks[j].parent) {
      if (/^(Laki|Lag)\b/.test(b.blocks[j].heading)) {
        parts.push(edkBlockLabel(b.blocks[j]));
        break;
      }
    }
  }
  if (r.ch) parts.push(`${r.ch} luku`);
  parts.push(r.l);
  return parts.join(", ");
}

function lawFilter(b, laki) {
  if (laki === undefined || laki === null || String(laki).trim() === "") return () => true;
  const q = String(laki).trim();
  if (/^\d+$/.test(q)) {
    const n = +q;
    // Numeroimattomat lait (eduskunnan vastaus): järjestysnumero lakien luettelossa.
    const unnumbered = b.laws.filter((i) => !b.blocks[i].num);
    return (r) => r.law === n || (r.law === null && unnumbered[n - 1] !== undefined && isUnder(b, r.b, unnumbered[n - 1]));
  }
  const ql = q.toLowerCase();
  return (r) => {
    for (let j = r.b; j >= 0; j = b.blocks[j].parent) if (edkBlockLabel(b.blocks[j]).toLowerCase().includes(ql)) return true;
    return false;
  };
}

function isUnder(b, i, a) {
  for (let j = i; j >= 0; j = b.blocks[j].parent) if (j === a) return true;
  return false;
}

function summarizeEntries(b, list) {
  // "1. Laki …: 51 a, 51 b §" lakikohtaisesti (vastalauseet erikseen).
  const groups = new Map();
  const keys = new Map(); // lohko → lain nimi (sama lohko toistuu)
  for (const r of list) {
    const kk = `${r.vl ?? 0}|${r.law}|${r.b}`;
    let key = keys.get(kk);
    if (key === undefined) {
      key = entryLabel(b, { ...r, l: "", ch: null }).replace(/, $/, "");
      keys.set(kk, key);
    }
    if (!groups.has(key)) groups.set(key, []);
    const lbl = (r.ch ? `${r.ch} luku ` : "") + r.l.replace(/ §$/, "");
    if (!groups.get(key).includes(lbl)) groups.get(key).push(lbl);
  }
  return [...groups].map(([k, v]) => `- ${k || "(laki ei tiedossa)"}: ${v.join(", ")} §`);
}

async function eduskunnanAsiakirja(args) {
  const s = await loadEdkDoc(args);
  const b = s.base;
  const out = [edkHeader(s), ""];
  const markNote = b.marks ? "«…» = valiokunnan muutos hallituksen esityksen tekstiin." : "";

  if (args.pykala !== undefined && String(args.pykala).trim() !== "") {
    const want = parseSection(args.pykala);
    if (!want) throw new UserError('Anna pykälä numerona, esim. "51" tai "51 a".');
    const luku = args.luku !== undefined && String(args.luku).trim() !== "" ? String(args.luku).trim().toLowerCase().replace(/\s+/g, " ") : null;
    const okLaw = lawFilter(b, args.laki);
    const pick = (list) => list.filter((r) => labelMatches(r.l, want) && (!luku || r.ch === luku) && okLaw(r));
    const rat = pick(b.rationale);
    const sec = pick(b.sections);
    const name = `${want.n}${want.letter ? " " + want.letter : ""} §`;
    if (!rat.length && !sec.length) {
      out.push(`Pykälää ${name}${luku ? ` (${luku} luku)` : ""} ei käsitellä asiakirjan pykäläkohtaisissa perusteluissa eikä lakiteksteissä.`);
      const listed = [...summarizeEntries(b, b.rationale.filter((r) => !r.vl))];
      if (listed.length) out.push("", "Pykäläkohtaisesti perustellut pykälät:", ...listed);
      out.push("", "Valiokunta käsittelee usein asiaa myös yleisperusteluissa: kokeile hakusana-parametria.");
      return clip(out.join("\n"));
    }
    const MAX_HITS = 8;
    const render = async (r) => {
      const paraAt = await edkParas(s, r.s, r.e);
      const parts = [];
      for (let i = r.s; i < r.e; i++) parts.push(paraAt(i).t);
      return parts.join("\n\n");
    };
    if (rat.length) {
      out.push("VALIOKUNNAN PERUSTELUT");
      for (const r of rat.slice(0, MAX_HITS)) out.push("", `${entryLabel(b, r)} [${edkBlockPath(b, r.b)}]`, "", await render(r));
      out.push("");
    }
    if (sec.length) {
      out.push(/^EV\b/.test(s.tunnus) ? "HYVÄKSYTTY LAKITEKSTI" : "LAKITEKSTI (valiokunnan muutosehdotukset; vastalauseen ehdotukset merkitty erikseen)");
      if (markNote) out.push(markNote);
      for (const r of sec.slice(0, MAX_HITS)) out.push("", `${entryLabel(b, r)} [${edkBlockPath(b, r.b)}]`, "", await render(r));
    }
    if (rat.length + sec.length > 2 * MAX_HITS) out.push("", "Osumia on enemmän: rajaa laki- tai luku-parametrilla.");
    return clip(out.join("\n").trimEnd());
  }

  if (args.hakusana !== undefined && String(args.hakusana).trim() !== "") {
    const q = String(args.hakusana).trim();
    if (q.length < 3) throw new UserError("Hakusanan pitää olla vähintään 3 merkkiä.");
    const ql = q.toLowerCase();
    const MAX = 30;
    const hits = [];
    // Osat luetaan yksi kerrallaan, ja haku lopetetaan, kun osumia on tarpeeksi.
    let shard = null;
    let shardNo = -1;
    for (let i = 0; i < b.nParas && hits.length < MAX; i++) {
      const k = edkPartOf(b.shardStarts, i);
      if (k !== shardNo) {
        shard = await edkShard(s, k);
        shardNo = k;
      }
      const p = shard[i - b.shardStarts[k]];
      const j = p.t.toLowerCase().indexOf(ql);
      if (j === -1) continue;
      const start = Math.max(0, j - 120);
      hits.push({ where: p.b >= 0 ? `${edkBlockPath(b, p.b)} [osa "#${p.b}"]` : "Alku", text: (start > 0 ? "…" : "") + p.t.slice(start, j + q.length + 160) + (j + q.length + 160 < p.t.length ? "…" : "") });
    }
    if (!hits.length) out.push(`Hakusanaa "${q}" ei löytynyt asiakirjasta. Kokeile sanan vartaloa.`);
    else {
      out.push(`Osumat hakusanalle "${q}" (${hits.length}${hits.length >= MAX ? "+, näytetään 30" : ""}):`);
      for (const h of hits) out.push("", h.where, `  ${h.text}`);
      out.push("", 'Hae koko lohko osa-parametrilla, esim. osa: "#12".');
    }
    return clip(out.join("\n"));
  }

  if (args.osa !== undefined && String(args.osa).trim() !== "") {
    const found = edkFindBlocks(b, args.osa);
    if (!found.length) throw new UserError(`Lohkoa "${args.osa}" ei löytynyt. Katso sisällys hakemalla asiakirja ilman osa-parametria.`);
    if (found.length > 1) {
      out.push(`"${args.osa}" vastaa useaa lohkoa. Valitse tunnisteella:`);
      for (const i of found.slice(0, 20)) out.push(`- osa "#${i}": ${edkBlockPath(b, i)}`);
      return out.join("\n");
    }
    out.push(edkBlockPath(b, found[0]), "", await renderEdkBlock(s, found[0]));
    if (markNote) out.push("", markNote);
    return clip(out.join("\n"));
  }

  // Yleiskuva.
  const many = b.blocks.length > 80;
  out.push(`Sisällys (lohko osa-parametrilla, esim. osa: "#3"; suluissa pituus merkkeinä${many ? "; vain kaksi ylintä tasoa" : ""}):`);
  b.blocks.forEach((blk, i) => {
    if (many && blk.depth > 2) return;
    out.push(`${"  ".repeat(blk.depth - 1)}#${i} ${edkBlockLabel(blk)} (${fmtCount(blk.len)})`);
  });
  const d = decisionBlock(b);
  if (d >= 0) {
    const text = await renderEdkBlock(s, d, 4000, true);
    out.push("", `${edkBlockLabel(b.blocks[d]).toUpperCase()}`, "", text);
  }
  const rat = summarizeEntries(b, b.rationale.filter((r) => !r.vl));
  if (rat.length) out.push("", "Pykäläkohtaiset perustelut (teksti pykala-parametrilla):", ...rat);
  const sec = summarizeEntries(b, b.sections.filter((r) => !r.vl));
  if (sec.length) out.push("", `${/^EV\b/.test(s.tunnus) ? "Hyväksyttyjen lakien pykälät" : "Lakitekstin pykälät (muutosehdotukset tai uudet lakiehdotukset)"} (pykala-parametrilla):`, ...sec);
  const vl = [...new Set([...b.rationale, ...b.sections].filter((r) => r.vl).map((r) => r.vl))];
  if (vl.length) out.push("", `Vastalauseissa (${vl.join(", ")}) on omia pykäläehdotuksia; ne näkyvät pykala-parametrilla.`);
  return clip(out.join("\n").trimEnd());
}

// Allekirjoitusosan alku ("Helsingissä 14.9.2022"): päätösosan yleiskuvassa allekirjoittajia ei näytetä.
const SIGNATURE_RE = /^(Helsingissä|Helsingfors)\s+\d/;

async function renderEdkBlock(s, i, maxChars = Infinity, stopAtSignature = false) {
  const b = s.base;
  const blk = b.blocks[i];
  const paraAt = await edkParas(s, blk.start, blk.end);
  const body = [];
  let cursor = blk.start;
  let n = 0;
  const push = (t) => {
    if (stopAtSignature && SIGNATURE_RE.test(t)) {
      n = Infinity;
      return;
    }
    body.push(t);
    n += t.length;
  };
  for (const d of edkDescendants(b, i)) {
    for (; cursor < b.blocks[d].start && n < maxChars; cursor++) push(paraAt(cursor).t);
    if (n >= maxChars) break;
    push(`${"#".repeat(Math.min(6, b.blocks[d].depth - blk.depth + 1))} ${edkBlockLabel(b.blocks[d])}`);
  }
  for (; cursor < blk.end && n < maxChars; cursor++) push(paraAt(cursor).t);
  if (n >= maxChars && n !== Infinity) body.push(`(katkaistu; koko lohko: osa "#${i}")`);
  return body.join("\n\n") || "(lohkossa ei ole tekstiä)";
}

// --- Haku ---

const DOC_TYPES = { mietinto: "Valiokunnan mietintö", lausunto: "Valiokunnan lausunto", vastaus: "Eduskunnan vastaus" };
const QUESTION_TYPE = "Kirjallinen kysymys";

async function haeEduskunnanAsiakirjoja(args) {
  const q = String(args.hakusana ?? "").trim();
  const committee = String(args.valiokunta ?? "").trim();
  const author = String(args.laatija ?? "").trim();
  if (!q && !committee && !author && !args.alkaen_vuosi && !args.paattyen_vuosi) throw new UserError("Anna hakusana, valiokunta, laatija tai vuosi.");
  if (args.tyyppi && !DOC_TYPES[args.tyyppi] && args.tyyppi !== "kysymys") throw new UserError("tyyppi: mietinto, lausunto, vastaus tai kysymys.");
  const page = Math.max(1, Number(args.sivu) || 1);
  const questions = args.tyyppi === "kysymys" || (author && !args.tyyppi);
  if (author && !questions) throw new UserError("laatija-rajaus toimii kirjallisille kysymyksille (tyyppi kysymys).");
  const types = questions ? [QUESTION_TYPE] : args.tyyppi ? [DOC_TYPES[args.tyyppi]] : Object.values(DOC_TYPES);
  const and = [
    { property: "kielikoodi", stringValue: "fi" },
    types.length === 1 ? { property: "asiakirjatyyppinimi", stringValue: types[0] } : { or: types.map((t) => ({ property: "asiakirjatyyppinimi", stringValue: t })) },
  ];
  if (committee) and.push({ property: "valiokuntanimi", stringValue: committee[0].toUpperCase() + committee.slice(1).toLowerCase() });
  if (author) and.push({ property: "toimijaLaatija.henkilo.nimi", match: author });
  if (args.alkaen_vuosi || args.paattyen_vuosi) {
    and.push({
      property: "laadintapvm",
      fromDate: args.alkaen_vuosi ? `${asYear(args.alkaen_vuosi)}-01-01` : null,
      toDate: args.paattyen_vuosi ? `${asYear(args.paattyen_vuosi) + 1}-01-01` : null,
    });
  }
  const req = {
    category: "asiakirja",
    maxResults: 10,
    startFromIndex: (page - 1) * 10,
    fields: { operation: "exclude", list: ["fullText", "asiasanat"] },
    sort: [{ property: "laadintapvm", ascending: false }],
    expression: { and },
  };
  if (q) req.query = q;
  const r = await edkSearch(req, 3600);
  const total = r.searchMetadata?.totalResultCount ?? 0;
  const rows = (r.results ?? []).map((x) => x.asiakirja).filter(Boolean);
  if (!rows.length) return page > 1 ? "Ei enempää tuloksia." : "Ei osumia. Kokeile sanan perusmuotoa tai vartaloa, toista valiokunnan nimeä (esim. \"perustuslakivaliokunta\") tai laajempaa vuosiväliä.";
  const out = [`Eduskunnan asiakirjat (${total} osumaa, sivu ${page}, uusimmasta vanhimpaan):`];
  for (const a of rows) {
    const parts = [a.laadintapvm ? fmtDate(a.laadintapvm) : null, a.vireilletuloEduskuntatunnus ? `asia ${a.vireilletuloEduskuntatunnus}` : null].filter(Boolean);
    out.push(`${a.eduskuntatunnus ?? a.edktunnus} ${a.asiakirjatyyppinimi ?? ""}${a.valiokuntanimi ? `, ${lc1(a.valiokuntanimi)}` : ""}${parts.length ? ` (${parts.join(", ")})` : ""}`);
    if (a.nimeketeksti) out.push(`  ${String(a.nimeketeksti).replace(/\s+/g, " ").trim()}`);
    const who = a.toimijaLaatija?.henkilo;
    if (questions && who?.nimi) out.push(`  Kysyjä: ${who.nimi}${who.eduskuntaryhma?.nimi ? ` (${who.eduskuntaryhma.nimi})` : ""}`);
  }
  if (total > page * 10) out.push("", `Lisää tuloksia: sivu ${page + 1}.`);
  out.push("", questions ? "Kysymys ja ministerin vastaus kirjallinen_kysymys-työkalulla (tunnus)." : "Hae teksti eduskunnan_asiakirja-työkalulla (tunnus) ja käsittelyn vaiheet eduskuntakasittely-työkalulla (asia).");
  return clip(out.join("\n"));
}

// ---------- Täysistunnon äänestykset ----------

const VOTE_SOURCE = "Lähde: Eduskunnan avoin data (CC BY 4.0), täysistuntojen äänestykset";
const VOTE_ID_RE = /^\s*(\d{4})\s*[-/]\s*(\d{1,3})\s*[-/]\s*(\d{1,3})\s*$/;
const VOTE_ORDER = ["Jaa", "Ei", "Tyhjää", "Poissa"];

const fiv = (v) => (v && typeof v === "object" ? v.fi ?? v.sv ?? null : v ?? null);
const foldName = (s) => String(s ?? "").toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

function parsePerson(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.length < 3) throw new UserError("Anna edustajan sukunimi tai koko nimi, esim. \"Petteri Orpo\".");
  const parts = s.split(" ");
  return parts.length === 1 ? { last: parts[0] } : { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

function personMatches(e, p) {
  if (!p) return false;
  if (foldName(e.sukunimi) !== foldName(p.last)) return false;
  return !p.first || foldName(e.etunimi).startsWith(foldName(p.first));
}

function voteTime(a) {
  const t = String(a.aanestysalkuaika ?? "").match(/T(\d{2}):(\d{2})/);
  return `${fmtDate(String(a.istuntopvm ?? "").slice(0, 10))}${t ? ` klo ${+t[1]}.${t[2]}` : ""}`;
}

const tally = (r) => (r ? `jaa ${r.jaa}, ei ${r.ei}, tyhjiä ${r.tyhjia}, poissa ${r.poissa}` : "–");

function voteMatter(a) {
  const doc = fiv(a.kohta?.asiakirjat?.paaasiakirjaEduskuntatunnus);
  const title = String(fiv(a.kohta?.otsikko) ?? "").replace(/\s+/g, " ").trim();
  return { doc, title };
}

function voteSummaryLine(a, p) {
  const { doc, title } = voteMatter(a);
  const mine = p ? (a.aanestystapahtumat ?? []).find((e) => personMatches(e, p)) : null;
  const lines = [`${a.id} · ${voteTime(a)} · ${doc ?? title.slice(0, 80)}${a.aanestysmitatoity ? " · MITÄTÖITY" : ""}`];
  if (doc && title) lines.push(`  ${title.length > 160 ? `${title.slice(0, 160)}…` : title}`);
  lines.push(`  ${String(fiv(a.aanestysotsikko) ?? "").replace(/\s+/g, " ").trim()}: ${tally(a.aanestystulos)}`);
  if (mine) lines.push(`  ${mine.etunimi} ${mine.sukunimi} (${fiv(mine.edkryhmalyhenne)}): ${fiv(mine.kayttaytyminen)}`);
  return lines.join("\n");
}

function voteDetail(a, { person, group, all }) {
  const { doc, title } = voteMatter(a);
  const out = [`Äänestys ${a.id}: täysistunto ${a.istuntonumero}/${a.istuntovpvuosi}, ${voteTime(a)}${a.aanestysmitatoity ? " (ÄÄNESTYS MITÄTÖITY)" : ""}`];
  out.push(`Asia: ${[doc, title].filter(Boolean).join(" ")}`);
  const phase = [fiv(a.kohta?.kasittelyotsikkonimi), fiv(a.kohta?.kasittelyvaihenimi)].filter(Boolean);
  if (phase.length) out.push(`Käsittely: ${[...new Set(phase)].join(", ")}`);
  out.push(`Äänestys: ${String(fiv(a.aanestysotsikko) ?? "").replace(/\s+/g, " ").trim()}`);
  out.push(`Tulos: ${tally(a.aanestystulos)} (yhteensä ${a.aanestystulos?.yhteensa ?? "?"})`);
  for (const j of a.hallitusoppositioJakaumat ?? []) out.push(`- ${fiv(j.nimi)}: ${tally(j)}`);
  const evs = a.aanestystapahtumat ?? [];
  const abbr = new Map();
  for (const e of evs) abbr.set(fiv(e.eduskuntaryhma), fiv(e.edkryhmalyhenne));
  if ((a.eduskuntaryhmaJakaumat ?? []).length) {
    out.push("", "Eduskuntaryhmät:");
    for (const j of a.eduskuntaryhmaJakaumat) {
      const ab = abbr.get(fiv(j.nimi));
      out.push(`- ${fiv(j.nimi)}${ab ? ` (${ab})` : ""}: ${tally(j)}`);
    }
  }
  // Ryhmänsä enemmistöstä poikkeavat (poissaoloja ei lasketa).
  const byGroup = new Map();
  for (const e of evs) {
    const g = fiv(e.edkryhmalyhenne) ?? "?";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(e);
  }
  const deviants = [];
  for (const [g, list] of byGroup) {
    const counts = {};
    for (const e of list) {
      const v = fiv(e.kayttaytyminen);
      if (v !== "Poissa") counts[v] = (counts[v] ?? 0) + 1;
    }
    const sorted = Object.entries(counts).sort((x, y) => y[1] - x[1]);
    if (sorted.length < 2 || sorted[0][1] === sorted[1][1]) continue;
    const major = sorted[0][0];
    for (const e of list) {
      const v = fiv(e.kayttaytyminen);
      if (v !== "Poissa" && v !== major) deviants.push(`${e.etunimi} ${e.sukunimi} (${g}): ${v}, ryhmän enemmistö ${major}`);
    }
  }
  if (deviants.length) {
    out.push("", `Ryhmänsä enemmistöstä poikkesi ${deviants.length}:`, ...deviants.slice(0, 40).map((d) => `- ${d}`));
    if (deviants.length > 40) out.push(`… ja ${deviants.length - 40} muuta.`);
  }
  if (person) {
    const hits = evs.filter((e) => personMatches(e, person));
    out.push("", hits.length ? hits.map((e) => `${e.etunimi} ${e.sukunimi} (${fiv(e.edkryhmalyhenne)}, ${fiv(e.vaalipiiri)}): ${fiv(e.kayttaytyminen)}`).join("\n") : `Edustajaa "${[person.first, person.last].filter(Boolean).join(" ")}" ei ole tämän äänestyksen tiedoissa.`);
  }
  if (group || all) {
    const g = group ? foldName(group) : null;
    const list = evs.filter((e) => !g || foldName(fiv(e.edkryhmalyhenne)) === g || foldName(fiv(e.eduskuntaryhma)).includes(g));
    if (!list.length) out.push("", `Eduskuntaryhmää "${group}" ei löytynyt. Käytä lyhennettä (esim. kok, ps, sd, kesk, vihr, vas, r, kd) tai nimen osaa.`);
    else {
      out.push("", group ? `Edustajien äänet (${group}):` : "Edustajien äänet:");
      for (const v of VOTE_ORDER) {
        const names = list.filter((e) => fiv(e.kayttaytyminen) === v).map((e) => `${e.etunimi} ${e.sukunimi}${group ? "" : ` (${fiv(e.edkryhmalyhenne)})`}`);
        if (names.length) out.push(`${v} (${names.length}): ${names.join(", ")}`);
      }
    }
  }
  if (a.puhemies?.sukunimi) out.push("", `Puhemiehenä ${a.puhemies.etunimi} ${a.puhemies.sukunimi}; puhemies ei osallistu äänestykseen.`);
  out.push("", `Tiedot: ${voteApiUrl(a.id)}`);
  if (doc) out.push(`Asian käsittely: ${matterWebUrl(doc)}`);
  out.push(VOTE_SOURCE);
  return out.join("\n");
}

async function eduskunnanAanestykset(args) {
  const person = parsePerson(args.edustaja);
  const id = String(args.aanestys ?? "").trim();
  if (id) {
    const m = id.match(VOTE_ID_RE);
    if (!m) throw new UserError("Äänestyksen tunnus on muotoa vuosi-istunto-äänestys, esim. 2026-104-1.");
    const a = await fetchVote(`${m[1]}-${+m[2]}-${+m[3]}`);
    if (!a) throw new UserError(`Äänestystä ${id} ei löytynyt.`);
    return clip(voteDetail(a, { person, group: args.ryhma, all: args.kaikki_edustajat === true }));
  }

  if (args.asia) {
    const tunnus = asTunnus(args.asia, "asia");
    const list = await fetchMatterVotes(tunnus);
    if (!list.length) return [`Asiassa ${tunnus} ei ole täysistunnon äänestyksiä Eduskunnan avoimessa datassa (asia voi olla ratkaistu ilman äänestystä).`, `Asian käsittely: ${matterWebUrl(tunnus)}`, VOTE_SOURCE].join("\n");
    list.sort((x, y) => (String(x.aanestysalkuaika) < String(y.aanestysalkuaika) ? -1 : 1));
    const out = [`${tunnus}: ${list.length} ${list.length === 1 ? "äänestys" : "äänestystä"} täysistunnossa (vanhimmasta uusimpaan).`, ""];
    for (const a of list.slice(0, 60)) {
      out.push(voteSummaryLine(a, person));
      const ho = (a.hallitusoppositioJakaumat ?? []).map((j) => `${lc1(fiv(j.nimi))} ${tally(j)}`).join("; ");
      if (ho) out.push(`  ${ho}`);
    }
    if (list.length > 60) out.push(`… ja ${list.length - 60} muuta.`);
    out.push("", "Yksittäisen äänestyksen ryhmittäiset tulokset ja edustajien äänet: aanestys-parametrilla (tunnus).", `Asian käsittely: ${matterWebUrl(tunnus)}`, VOTE_SOURCE);
    return clip(out.join("\n"));
  }

  const q = String(args.hakusana ?? "").trim();
  const from = args.alkaen ? asIsoDate(args.alkaen, "alkaen") : null;
  const to = args.asti ? asIsoDate(args.asti, "asti") : null;
  if (!q && !from && !to && !person) throw new UserError("Anna aanestys (tunnus), asia (esim. HE 151/2026 vp), hakusana, edustaja tai aikaväli.");
  const page = Math.max(1, Number(args.sivu) || 1);
  const { total, votes } = await searchVotes({ query: q || undefined, from, to, person, start: (page - 1) * 10, size: 10 });
  if (!votes.length) return page > 1 ? "Ei enempää tuloksia." : "Ei äänestyksiä näillä ehdoilla.";
  const crit = [q && `hakusana "${q}"`, person && `edustaja ${[person.first, person.last].filter(Boolean).join(" ")}`, (from || to) && `${from ? fmtDate(from) : ""}–${to ? fmtDate(to) : ""}`].filter(Boolean).join(", ");
  const out = [`Täysistunnon äänestykset (${crit}): ${total} osumaa, sivu ${page}, uusimmasta vanhimpaan.`, ""];
  for (const a of votes) out.push(voteSummaryLine(a, person));
  if (total > page * 10) out.push("", `Lisää tuloksia: sivu ${page + 1}.`);
  out.push("", "Yksittäisen äänestyksen ryhmittäiset tulokset ja edustajien äänet: aanestys-parametrilla.", VOTE_SOURCE);
  return clip(out.join("\n"));
}

// ---------- Kirjalliset kysymykset ----------

const QUESTION_TEXT_MAX = 12_000;

async function kirjallinenKysymys(args) {
  const raw = String(args.kysymys ?? "").trim();
  const t0 = asTunnus(/^\d/.test(raw) ? `KK ${raw}` : raw, "kysymys");
  const tunnus = t0.replace(/^KKV /, "KK ");
  if (!tunnus.startsWith("KK ")) throw new UserError("Anna kirjallisen kysymyksen tunnus, esim. \"KK 300/2026 vp\".");
  const answerTunnus = tunnus.replace(/^KK /, "KKV ");
  const [m, qMeta, aMeta] = await Promise.all([fetchMatter(tunnus, MATTER_TTL), fetchDocMeta(tunnus, DOC_TTL), fetchDocMeta(answerTunnus, DOC_TTL)]);
  if (!m && !qMeta) throw new UserError(`Kysymystä ${tunnus} ei löytynyt Eduskunnan avoimesta datasta.`);

  const out = [`${tunnus} ${String(qMeta?.nimeketeksti ?? fi(m?.nimeke) ?? "").replace(/\s+/g, " ").trim()}`];
  const who = qMeta?.toimijaLaatija?.henkilo;
  const info = [];
  if (who?.nimi) info.push(`Kysyjä: ${who.nimi}${who.eduskuntaryhma?.nimi ? ` (${who.eduskuntaryhma.nimi})` : ""}`);
  if (qMeta?.laadintapvm) info.push(`päivätty ${fmtDate(qMeta.laadintapvm)}`);
  if (info.length) out.push(info.join(", ") + ".");
  const st = [fi(m?.tila) && `Tila: ${fi(m.tila)}`, fi(m?.kokonaispaatosnimi) && `lopputulos: ${lc1(fi(m.kokonaispaatosnimi))}`, fi(m?.viimeisinKasittelyvaihe) && `viimeisin vaihe: ${lc1(fi(m.viimeisinKasittelyvaihe))}`].filter(Boolean);
  if (st.length) out.push(st.join(", ") + ".");
  out.push(`Lähde: ${matterWebUrl(tunnus)} (Eduskunnan avoin data, CC BY 4.0)`);

  if (args.vain_vastaus !== true && qMeta && qMeta.htmlSaatavilla !== false) {
    const s = await loadEdkDoc({ asiakirja: tunnus });
    const get = await edkParas(s, 0, s.base.nParas);
    const paras = [];
    for (let i = 0; i < s.base.nParas; i++) paras.push(get(i).t);
    let text = paras.join("\n\n").trim();
    if (text.length > QUESTION_TEXT_MAX) text = `${text.slice(0, QUESTION_TEXT_MAX)}\n… (katkaistu; koko teksti eduskunnan_asiakirja-työkalulla)`;
    out.push("", "Kysymys:", text);
  }

  if (aMeta) {
    out.push("", `Vastaus ${answerTunnus}${aMeta.laadintapvm ? `, päivätty ${fmtDate(aMeta.laadintapvm)}` : ""}:`);
    let text = null;
    if (aMeta.htmlSaatavilla) {
      const s = await loadEdkDoc({ asiakirja: answerTunnus });
      const get = await edkParas(s, 0, s.base.nParas);
      const paras = [];
      for (let i = 0; i < s.base.nParas; i++) paras.push(get(i).t);
      text = paras.join("\n\n").trim();
    } else {
      const pdf = await fetchDocPdfText(aMeta.edktunnus).catch(() => null);
      text = pdf?.text ?? null;
      if (text) out.push("(Teksti on purettu PDF:stä; rivitys voi poiketa alkuperäisestä.)");
    }
    if (text) {
      if (text.length > QUESTION_TEXT_MAX) text = `${text.slice(0, QUESTION_TEXT_MAX)}\n… (katkaistu)`;
      out.push(text);
    } else out.push("(Vastauksen tekstiä ei saatu.)");
    out.push(`Vastausasiakirja: ${docWebUrl(aMeta.edktunnus)}`);
  } else {
    out.push("", "Vastausta ei ole vielä Eduskunnan avoimessa datassa. Vastaus annetaan 21 päivän kuluessa siitä, kun kysymys toimitettiin valtioneuvostolle (eduskunnan työjärjestys 27 § 2 mom.).");
  }
  return clip(out.join("\n"));
}

// ---------- Viranomaisten tiedotteet ----------

const TIEDOTE_MAX = 60;
const TIEDOTE_TEXT_MAX = 15_000;

const FEED_ALIASES = {
  hva: "hyvinvointialueet", hyvinvointialue: "hyvinvointialueet", varha: "varsinais_suomi", pohde: "pohjois_pohjanmaa", keusote: "keski_uusimaa",
  oma_hame: "kanta_hame", siun_sote: "pohjois_karjala", siunsote: "pohjois_karjala", soite: "keski_pohjanmaa", eloisa: "etela_savo",
  ekhva: "etela_karjala", hyvaep: "etela_pohjanmaa", helsingin_sote: "helsinki", vakehyva: "vantaa_kerava", hus_yhtyma: "hus",
};
const normFeedKey = (s) => s.trim().toLowerCase().replace(/[äå]/g, "a").replace(/ö/g, "o").replace(/[-\s]+/g, "_");

/** viranomainen-parametrin syötteet. Oletus: valtion viranomaiset; hyvinvointialueet ja kaikki erikseen. */
function feedKeys(arg) {
  const national = Object.keys(FEEDS).filter((k) => !FEEDS[k].hva);
  const hva = Object.keys(FEEDS).filter((k) => FEEDS[k].hva);
  const raw = String(arg ?? "").trim();
  if (!raw) return national;
  const parts = raw.split(",").flatMap((p) => {
    const k = normFeedKey(p);
    return FEEDS[k] || FEED_ALIASES[k] || ["kaikki", "hyvinvointialueet"].includes(k) ? [k] : p.trim().split(/\s+/).map(normFeedKey);
  });
  const keys = [];
  for (const p of parts.filter(Boolean)) {
    const k = FEED_ALIASES[p] ?? p;
    if (k === "kaikki") keys.push(...national, ...hva);
    else if (k === "hyvinvointialueet") keys.push(...hva);
    else if (/^(pohjois_savo|lappi|lapin_hyvinvointialue|pohjois_savon_hyvinvointialue)$/.test(k)) throw new UserError(`Hyvinvointialueilta puuttuvat ${HVA_MISSING}. Katso tiedotteet alueen omilta sivuilta.`);
    else if (FEEDS[k]) keys.push(k);
    else throw new UserError(`viranomainen: ${national.join(", ")}, hyvinvointialueet, ${hva.join(", ")} tai kaikki.`);
  }
  return [...new Set(keys)];
}

async function viranomaistiedotteet(args) {
  const keys = feedKeys(args.viranomainen);
  const from = args.alkaen ? asIsoDate(args.alkaen, "alkaen") : null;
  const q = String(args.hakusana ?? "").trim().toLowerCase();
  const max = Math.min(TIEDOTE_MAX, Math.max(1, Number.parseInt(args.enintaan, 10) || 20));
  const results = await Promise.all(keys.map((k) => feedItems(k).then((items) => ({ k, items })).catch((e) => ({ k, items: [], err: e?.message ?? String(e) }))));
  let all = results.flatMap((r) => r.items);
  if (from) all = all.filter((i) => i.date && i.date.slice(0, 10) >= from);
  if (q) all = all.filter((i) => `${i.title} ${i.summary ?? ""}`.toLowerCase().includes(q));
  all.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const failed = results.filter((r) => r.err);
  const span = results
    .filter((r) => r.items.length)
    .map((r) => {
      const ds = r.items.map((i) => i.date).filter(Boolean).sort();
      return `${FEEDS[r.k].short} ${r.items.length} (alkaen ${ds.length ? fmtDate(ds[0].slice(0, 10)) : "?"})`;
    })
    .join(", ");
  const crit = [q && `hakusana "${args.hakusana}"`, from && `alkaen ${fmtDate(from)}`].filter(Boolean).join(", ");
  const out = [`Viranomaisten tiedotteet${crit ? ` (${crit})` : ""}: ${all.length} osumaa${all.length > max ? `, näytetään ${max} uusinta` : ""}.`];
  if (span) out.push(`Syötteissä nyt: ${span}. Syötteet sisältävät vain uusimmat tiedotteet.`);
  for (const f of failed) out.push(`HUOM: ${FEEDS[f.k].short}-syötettä ei saatu (${f.err}).`);
  out.push("");
  for (const i of all.slice(0, max)) {
    out.push(`${i.date ? fmtDate(i.date.slice(0, 10)) : "?"} · ${FEEDS[i.source].short} · ${i.title}`);
    if (i.summary) out.push(`  ${i.summary.length > 400 ? `${i.summary.slice(0, 400)}…` : i.summary}`);
    out.push(`  ${i.link}`);
  }
  if (!all.length) out.push("Ei osumia. Syötteissä on vain uusimmat tiedotteet; vanhempia etsi viraston verkkosivuilta.");
  out.push(
    "",
    "Tiedotteen tekstin saa viranomaistiedote-työkalulla (osoite); Fimean ja Tukesin tiedotteet luetaan viraston sivulta. Kaikki syventävät vero-ohjeet löytyvät hae_vero_ohjeita-työkalulla ja muiden viranomaisten ohjeet hae_viranomaisohjeita-työkalulla.",
  );
  const hvaKeys = keys.filter((k) => FEEDS[k].hva);
  if (keys.length > hvaKeys.length) out.push("Lähteet: Fimea, Tukes, Verohallinto, tietosuojavaltuutettu, Kyberturvallisuuskeskus ja KKV (RSS-syötteet), Lupa- ja valvontavirasto (STT Info).");
  if (hvaKeys.length) {
    out.push(`Lähteet, hyvinvointialueet: ${hvaKeys.map((k) => `${FEEDS[k].name} (${FEEDS[k].url.includes("sttinfo.fi") ? "STT Info" : new URL(FEEDS[k].url).hostname})`).join("; ")}.`);
    if (hvaKeys.length > 1) out.push(`Hyvinvointialueilta puuttuvat ${HVA_MISSING}.`);
  }
  return clip(out.join("\n"));
}

async function viranomaistiedote(args) {
  const url = String(args.osoite ?? "").trim();
  if (!/^https:\/\//.test(url)) throw new UserError("Anna tiedotteen osoite viranomaistiedotteet-työkalun tuloksesta.");
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (authorityOf(url)) return viranomaisohje(args);
  if (/(^|\.)fimea\.fi$|(^|\.)tukes\.fi$/.test(host)) {
    return `Fimean ja Tukesin sivut eivät salli automaattista hakua, joten tiedotteen teksti on luettava viraston sivulta: ${url}`;
  }
  if (/(^|\.)vero\.fi$/.test(host) && /\/(syventavat-vero-ohjeet|detaljerade_skatteanvisningar|syventavat_vero-ohjeet)\//i.test(url)) {
    const g = await veroGuide(url);
    if (g && g.sections.length) return veroGuideOut(g, args);
  }
  if (args.luku || args.hakusana) throw new UserError("luku ja hakusana toimivat vain Verohallinnon syventäville vero-ohjeille (ja päätöksille, kannanotoille ja ennakkoratkaisuille), joissa on numeroidut luvut.");
  const t = await itemText(url);
  if (!t) throw new UserError("Tekstin haku onnistuu vain Verohallinnon (vero.fi), STT Infon (sttinfo.fi: LVV, hyvinvointialueet) ja hyvinvointialueiden omien sivustojen tiedotteille. Tarkista osoite.");
  let text = t.text;
  if (text.length > TIEDOTE_TEXT_MAX) text = `${text.slice(0, TIEDOTE_TEXT_MAX)}\n… (katkaistu; koko teksti lähteessä)`;
  const src = host.endsWith("vero.fi") ? "Verohallinto" : host.endsWith("sttinfo.fi") ? `${t.source ?? "Lupa- ja valvontavirasto"}, STT Info` : t.source;
  return [t.title, t.date, "", text, "", `Lähde: ${url} (${src})`].filter((l, i) => l || i > 1).join("\n");
}

// ---------- Syventävät vero-ohjeet ----------

const secLabel = (x) => `${x.num ? `${x.num} ` : ""}${x.title}`;
const normLuku = (v) => String(v ?? "").trim().replace(/^luku\s+/i, "").replace(/\.$/, "").trim();

function guideHead(g) {
  const out = [`${g.title} (Verohallinto)`];
  for (const [k, v] of g.meta) if (/^(Antopäivä|Diaarinumero|Voimassaolo|Korvaa ohjeen)$/i.test(k)) out.push(`${k}: ${v}`);
  return out;
}

function guideToc(g) {
  return g.sections.map((x) => `${"  ".repeat(Math.max(0, x.level - 2))}${secLabel(x)}`);
}

/** Luku ja sen alaluvut (seuraavat syvemmän tason otsikot). */
function guideChapter(g, i) {
  const base = g.sections[i];
  const out = [base];
  for (let j = i + 1; j < g.sections.length && g.sections[j].level > base.level; j++) out.push(g.sections[j]);
  return out;
}

function veroGuideOut(g, args) {
  const src = `Lähde: ${g.url} (Verohallinto). Ohje kuvaa Verohallinnon tulkintaa; se ei ole lakia. Tarkista voimassaolo ohjeen sivulta.`;
  if (args.luku) {
    const want = normLuku(args.luku);
    let i = g.sections.findIndex((x) => x.num === want);
    let note = null;
    if (i < 0) {
      const lw = want.toLowerCase();
      // Paras osuma ensin: sama otsikko, otsikon alku, sanan alku, muu kohta.
      const rank = (t) => (t === lw ? 0 : t.startsWith(lw) ? 1 : new RegExp(`(^|[\\s(-])${lw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t) ? 2 : t.includes(lw) ? 3 : 9);
      const cand = g.sections
        .map((x, k) => [x, k, rank(x.title.toLowerCase())])
        .filter((c) => c[2] < 9)
        .sort((a, b) => a[2] - b[2] || a[1] - b[1]);
      if (cand.length) {
        i = cand[0][1];
        if (cand.length > 1) note = `Otsikkoon "${want}" osui myös: ${cand.slice(1, 8).map(([x]) => secLabel(x)).join("; ")}.`;
      }
    }
    if (i < 0) return [...guideHead(g), "", `Lukua "${args.luku}" ei löytynyt. Sisällysluettelo:`, ...guideToc(g), "", src].join("\n");
    const parts = guideChapter(g, i);
    const out = [...guideHead(g), ""];
    if (note) out.push(note, "");
    for (const x of parts) out.push(`${secLabel(x)}`, x.text || "(ei tekstiä ennen alalukuja)", "");
    out.push(src);
    return clip(out.join("\n"));
  }
  if (args.hakusana) {
    const q = String(args.hakusana).trim().toLowerCase();
    if (!q) throw new UserError("Anna hakusana.");
    const hits = [];
    const scan = (label, text) => {
      const r = excerpts(text, q);
      if (r.n) hits.push({ label, ...r });
    };
    scan("Johdanto ja muutokset", g.intro);
    for (const x of g.sections) scan(secLabel(x), `${x.title}\n${x.text}`);
    const out = [...guideHead(g), "", `Hakusana "${args.hakusana}": ${hits.reduce((s, h) => s + h.n, 0)} osumaa ${hits.length} luvussa.`];
    for (const h of hits.slice(0, 30)) {
      out.push("", `${h.label} (${h.n})`);
      for (const e of h.ex) out.push(`  ${e}`);
    }
    if (hits.length > 30) out.push("", `… ja ${hits.length - 30} muuta lukua.`);
    if (!hits.length) out.push("Ei osumia. Haku on kirjaimellinen: kokeile sanan vartaloa.");
    out.push("", "Lue luku sanatarkasti parametrilla luku (esim. \"3.7.3\").", src);
    return clip(out.join("\n"));
  }
  const total = g.sections.reduce((s, x) => s + x.text.length, 0);
  const out = [...guideHead(g), ""];
  if (g.intro) out.push(g.intro, "");
  if (total <= TIEDOTE_TEXT_MAX) {
    for (const x of g.sections) out.push(secLabel(x), x.text, "");
  } else {
    out.push(`Sisällysluettelo (ohjeessa noin ${Math.round(total / 1000)} 000 merkkiä; lue luku parametrilla luku, esim. "${g.sections.find((x) => x.text && x.num)?.num ?? "1"}", tai etsi parametrilla hakusana):`, ...guideToc(g), "");
  }
  out.push(src);
  return clip(out.join("\n"));
}

async function veroDiaariOut(diaari, keys, lang) {
  const r = await veroFindDiaari(diaari, { types: keys.map((k) => VERO_TYPES[k].id), lang });
  const names = keys.map((k) => VERO_TYPES[k].name).join(", ");
  const line = ({ hit: h, meta: [d, given] }) => [
    `${given ?? (h.date ? fmtDate(h.date) : "?")} · ${h.type ?? ""}${h.latest ? "" : " · KORVATTU VERSIO"} · ${h.title}`,
    `  Diaarinumero: ${d ?? "?"}`,
    `  ${h.url}`,
  ];
  const out = [`Verohallinnon haku diaarinumerolla ${diaari} (${names}):`];
  if (r.hit) {
    out.push("", ...line(r));
    if (!r.hit.latest) out.push("", "Tämä on korvattu ohjeversio. Voimassa olevan version löytää samalla otsikolla.");
  } else if (r.complete) {
    out.push(`Ei osumaa ${r.checked} ohjeesta. Tarkista diaarinumero tai tyyppi (myös paatos, kannanotto, kvl tai kaikki).`);
  } else {
    out.push(`Ei vielä osumaa: ${r.checked} ohjetta tarkistettu, osa on tarkistamatta. Tee sama haku uudelleen, niin haku jatkuu tarkistamattomista.`);
  }
  for (const x of r.replacedBy) {
    if (x.hit.url === r.hit?.url) continue;
    out.push("", `Korvaava ohje (korvaa diaarinumeron ${diaari}):`, ...line(x));
  }
  out.push(
    "",
    "Vero.fi:n haku ei hae diaarinumerolla, joten se luettiin ohjesivujen versiotiedoista.",
    "Lue ohje, sen luku tai hakusanan osumat viranomaistiedote-työkalulla (osoite, luku, hakusana).",
    "Lähde: Verohallinto, vero.fi (https://www.vero.fi/syventavat-vero-ohjeet/).",
  );
  return out.join("\n");
}

async function haeVeroOhjeita(args) {
  const diaari = asDiaari(args.hakusana);
  const want = String(args.tyyppi ?? (diaari ? "ohje,paatos,kannanotto" : "ohje")).trim().toLowerCase();
  const keys = want === "kaikki" ? Object.keys(VERO_TYPES) : want.split(/[,\s]+/).filter(Boolean);
  for (const k of keys) if (!VERO_TYPES[k]) throw new UserError(`tyyppi: ${Object.keys(VERO_TYPES).join(", ")} tai kaikki.`);
  const lang = args.kieli === "sv" ? "sv" : "fi";
  if (diaari) return veroDiaariOut(diaari, keys, lang);
  const query = String(args.hakusana ?? "").trim();
  const SORT = { osuvuus: 0, uusin: 1, vanhin: 2, nimi: 3 };
  const sort = args.jarjestys ? SORT[args.jarjestys] : query ? 0 : 1;
  if (sort === undefined) throw new UserError("jarjestys: osuvuus, uusin, vanhin tai nimi.");
  const page = asPage(args.sivu);
  const year = args.vuosi ? asYear(args.vuosi) : undefined;
  const r = await veroSearch({ query, types: keys.map((k) => VERO_TYPES[k].id), lang, sort, page, pageSize: 10, all: !!args.vanhat_versiot, year });
  const names = keys.map((k) => VERO_TYPES[k].name).join(", ");
  const out = [`Verohallinnon haku (${names}${query ? `, "${query}"` : ""}${year ? `, vuosi ${year}` : ""}): ${r.total} osumaa, sivu ${page}.`];
  if (!r.hits.length) out.push("Ei osumia. Kokeile toista sanaa tai sanan perusmuotoa.");
  for (const h of r.hits) {
    out.push("", `${h.date ? fmtDate(h.date) : "?"} · ${h.type ?? ""}${h.latest ? "" : " · KORVATTU VERSIO"} · ${h.title}`);
    if (h.excerpt) out.push(`  ${h.excerpt.length > 300 ? `${h.excerpt.slice(0, 300)}…` : h.excerpt}`);
    out.push(`  ${h.url}`);
  }
  if (r.hasMore) out.push("", `Lisää tuloksia: sivu ${page + 1}.`);
  out.push("", "Lue ohje, sen luku tai hakusanan osumat viranomaistiedote-työkalulla (osoite, luku, hakusana).", "Lähde: Verohallinto, vero.fi-haku (https://www.vero.fi/syventavat-vero-ohjeet/).");
  return out.join("\n");
}

// ---------- Viranomaisten ohjeet (Traficom, tietosuojavaltuutettu, KKV, PRH) ----------

const OHJE_NOTE = "Ohje on viranomaisen tulkinta, ei lakia. Tarkista lainkohdat hae_pykala-työkalulla ja ohjeen ajantasaisuus viranomaisen sivulta.";
const OHJE_TYPE_NAMES = { ohje: "ohje", linjaus: "linjaus", paatos: "päätös" };

async function haeViranomaisohjeita(args) {
  const want = String(args.viranomainen ?? "kaikki").trim().toLowerCase();
  const keys = want === "kaikki" ? Object.keys(OHJE_AUTH) : want.split(/[,\s]+/).filter(Boolean);
  for (const k of keys) if (!OHJE_AUTH[k]) throw new UserError(`viranomainen: ${Object.keys(OHJE_AUTH).join(", ")} tai kaikki.`);
  const type = String(args.tyyppi ?? "kaikki").trim().toLowerCase();
  if (!["ohje", "linjaus", "paatos", "kaikki"].includes(type)) throw new UserError("tyyppi: ohje, linjaus, paatos tai kaikki.");
  const query = String(args.hakusana ?? "").trim();
  const max = Math.min(60, Math.max(1, Number.parseInt(args.enintaan, 10) || 20));
  const { hits, errors } = await searchOhjeet({ query, authorities: keys, type });
  const names = keys.map((k) => OHJE_AUTH[k].short).join(", ");
  const out = [`Viranomaisten ohjeet (${names}${query ? `, "${query}"` : ""}${type !== "kaikki" ? `, tyyppi ${type}` : ""}): ${hits.length} osumaa${hits.length > max ? `, näytetään ${max}` : ""}.`];
  for (const e of errors) out.push(`HUOM: ${e}`);
  for (const h of hits.slice(0, max)) {
    out.push("", `${OHJE_AUTH[h.authority].short} · ${h.authority === "kkv" ? KKV_TYPES[h.type] ?? h.type : OHJE_TYPE_NAMES[h.type] ?? h.type} · ${h.title}${h.slug ? " (otsikko osoitteesta)" : ""}`, `  ${h.url}`);
  }
  if (!hits.length) out.push("", "Ei osumia. Haku kohdistuu otsikkoon ja osoitteeseen, ei tekstiin: kokeile lyhyempää sanaa tai sanan alkua (esim. \"eväste\", \"markkinoin\").");
  const tips = [];
  if (keys.includes("tietosuoja")) tips.push("Tietosuojavaltuutetun ratkaisut: hae_ratkaisuja (lahde tietosuojavaltuutettu).");
  if (keys.includes("traficom")) tips.push("Traficomin määräykset (esim. M72B tunnistus- ja luottamuspalveluista): hae_viranomaismaarayksia.");
  out.push(
    "",
    "Lue ohje, sen luku tai hakusanan osumat viranomaisohje-työkalulla (osoite, luku, hakusana).",
    ...tips,
    `Lähteet: ${keys.map((k) => `${OHJE_AUTH[k].name} (${OHJE_AUTH[k].base.replace("https://", "")})`).join("; ")}.`,
  );
  return clip(out.join("\n"));
}

function ohjeSource(url, auth) {
  return `Lähde: ${url} (${OHJE_AUTH[auth]?.name ?? "viranomainen"}). ${OHJE_NOTE}`;
}

function ohjeHead(d) {
  const out = [`${d.title ?? "Ohje"} (${OHJE_AUTH[d.authority].name})`];
  for (const [k, v] of d.meta ?? []) out.push(`${k}: ${v}`);
  return out;
}

/**
 * Hakusanan osumat ja enintään n otetta (160 merkkiä kummallekin puolelle). Osumaa ei näytetä
 * omana otteenaan, jos se on jo edellisen näytetyn otteen sisällä.
 */
function excerpts(text, q, n = 2) {
  const low = text.toLowerCase();
  const pos = [];
  for (let p = low.indexOf(q); p >= 0 && pos.length < 50; p = low.indexOf(q, p + q.length)) pos.push(p);
  const ex = [];
  let shownEnd = -1;
  for (const p of pos) {
    if (ex.length >= n) break;
    if (p + q.length <= shownEnd) continue;
    const a = Math.max(0, p - 160);
    const b = Math.min(text.length, p + q.length + 160);
    shownEnd = b;
    ex.push(`${a > 0 ? "…" : ""}${text.slice(a, b).replace(/\s+/g, " ")}${b < text.length ? "…" : ""}`);
  }
  return { n: pos.length, ex };
}

function findChapter(sections, luku) {
  const want = normLuku(luku);
  let i = sections.findIndex((x) => x.num === want);
  let note = null;
  if (i < 0) {
    const lw = want.toLowerCase();
    const rank = (t) => (t === lw ? 0 : t.startsWith(lw) ? 1 : new RegExp(`(^|[\\s(-])${lw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t) ? 2 : t.includes(lw) ? 3 : 9);
    const cand = sections
      .map((x, k) => [x, k, rank(x.title.toLowerCase())])
      .filter((c) => c[2] < 9)
      .sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    if (cand.length) {
      i = cand[0][1];
      if (cand.length > 1) note = `Otsikkoon "${want}" osui myös: ${cand.slice(1, 8).map(([x]) => secLabel(x)).join("; ")}.`;
    }
  }
  return { i, note };
}

function ohjeHtmlOut(d, args) {
  const src = ohjeSource(d.url, d.authority);
  const toc = () => guideToc(d);
  const pdfList = () => (d.pdfs.length ? ["", `Liitteet (PDF, lue viranomaisohje-työkalulla osoitteella):`, ...d.pdfs.map((p) => `- ${p.title}: ${p.url}`)] : []);
  if (args.sivu) throw new UserError("sivu toimii vain PDF-tiedostoille. Verkkosivulta lue luku (luku) tai etsi hakusanalla.");
  if (args.luku) {
    const { i, note } = findChapter(d.sections, args.luku);
    if (i < 0) return clip([...ohjeHead(d), "", `Lukua "${args.luku}" ei löytynyt. Sisällysluettelo:`, ...toc(), "", src].join("\n"));
    const out = [...ohjeHead(d), ""];
    if (note) out.push(note, "");
    for (const x of guideChapter(d, i)) out.push(secLabel(x), x.text || "(ei tekstiä ennen alalukuja)", "");
    out.push(src);
    return clip(out.join("\n"));
  }
  if (args.hakusana) {
    const q = String(args.hakusana).trim().toLowerCase();
    if (!q) throw new UserError("Anna hakusana.");
    const hits = [];
    const scan = (label, text) => {
      const r = excerpts(text, q);
      if (r.n) hits.push({ label, ...r });
    };
    scan("Johdanto", d.intro);
    for (const x of d.sections) scan(secLabel(x), `${x.title}\n${x.text}`);
    const out = [...ohjeHead(d), "", `Hakusana "${args.hakusana}": ${hits.reduce((s, h) => s + h.n, 0)} osumaa ${hits.length} luvussa.`];
    for (const h of hits.slice(0, 30)) {
      out.push("", `${h.label} (${h.n})`);
      for (const e of h.ex) out.push(`  ${e}`);
    }
    if (hits.length > 30) out.push("", `… ja ${hits.length - 30} muuta lukua.`);
    if (!hits.length) out.push("Ei osumia. Haku on kirjaimellinen: kokeile sanan vartaloa. Liitteinä olevista PDF-tiedostoista haetaan erikseen niiden osoitteella.");
    out.push("", "Lue luku sanatarkasti parametrilla luku.", src);
    return clip(out.join("\n"));
  }
  const total = d.intro.length + d.sections.reduce((s, x) => s + x.text.length, 0);
  const out = [...ohjeHead(d), ""];
  if (total <= TIEDOTE_TEXT_MAX) {
    if (d.intro) out.push(d.intro, "");
    for (const x of d.sections) out.push(secLabel(x), x.text, "");
  } else {
    if (d.intro) out.push(d.intro.length > 3000 ? `${d.intro.slice(0, 3000)}…` : d.intro, "");
    const ex = d.sections.find((x) => x.text && x.num)?.num ?? d.sections.find((x) => x.text)?.title ?? "1";
    out.push(`Sisällysluettelo (noin ${Math.round(total / 1000)} 000 merkkiä; lue luku parametrilla luku, esim. "${ex}", tai etsi parametrilla hakusana):`, ...toc());
  }
  out.push(...pdfList(), "", src);
  return clip(out.join("\n"));
}

// Numeroitu otsikko ilman pistettä numeron jälkeen ("2 Soveltamisala"); "1. Mitä…" on luettelo.
const PDF_HEAD_RE = /^(\d{1,2}(?:\.\d{1,2}){0,3})\s+([A-ZÅÄÖ].{1,150})$/;
const PDF_TOC_LINE = /(?:\.\s*){3,}\s*\d+\s*$/;

/**
 * PDF:n numeroitu luku. Sisällysluettelon otsikoiden avulla, jos sellainen on; muuten numeroiduista
 * otsikkoriveistä. Luku päättyy seuraavaan samantasoiseen tai ylempään otsikkoon.
 */
function pdfChapter(pages, luku) {
  const want = normLuku(luku);
  const byNum = /^\d/.test(want);
  const lines = [];
  pages.forEach((p, pi) => {
    for (const l of p.split("\n")) lines.push({ t: l.trim(), p: pi + 1 });
  });
  const depthOf = (n) => n.split(".").length;
  const cut = (k0, k1, title) => {
    const seg = lines.slice(k0, k1 >= 0 ? k1 : lines.length);
    const text = seg.map((l) => l.t).join("\n");
    return { from: seg[0].p, to: seg[seg.length - 1].p, title, text: text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (katkaistu; lue loput sivu-parametrilla)` : text };
  };
  const toc = tocLines(pages)
    .map((t) => t.match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(.+?) \(s\. \d+\)$/))
    .filter(Boolean)
    .map((m) => ({ num: m[1], title: m[2] }));
  if (toc.length) {
    const norm = (t) => t.toLowerCase().replace(/^(\d+(?:\.\d+)*)\.?\s+/, "$1 ").replace(/\s+/g, " ");
    const findLine = (e, from) => {
      const pre = norm(`${e.num} ${e.title}`).slice(0, e.num.length + 1 + Math.min(20, e.title.length));
      for (let k = from; k < lines.length; k++) if (!PDF_TOC_LINE.test(lines[k].t) && norm(lines[k].t).startsWith(pre)) return k;
      return -1;
    };
    let i = toc.findIndex((e) => e.num === want);
    if (i < 0 && !byNum) i = toc.findIndex((e) => e.title.toLowerCase().includes(want.toLowerCase()));
    if (i >= 0) {
      const e = toc[i];
      const k0 = findLine(e, 0);
      if (k0 >= 0) {
        const next = toc.slice(i + 1).find((x) => depthOf(x.num) <= depthOf(e.num));
        return cut(k0, next ? findLine(next, k0 + 1) : -1, `${e.num} ${e.title}`);
      }
    }
  }
  const heads = [];
  lines.forEach((l, k) => {
    const m = l.t.match(PDF_HEAD_RE);
    if (m && !PDF_TOC_LINE.test(l.t)) heads.push({ k, num: m[1], title: m[2] });
  });
  const cands = heads.filter((h) => (byNum ? h.num === want : h.title.toLowerCase().includes(want.toLowerCase())));
  if (!cands.length) return null;
  // Sisällysluettelossa otsikot ovat peräkkäin; valitaan ehdokas, jota seuraa tekstiä.
  const h = cands.find((x) => {
    const nx = heads.find((y) => y.k > x.k);
    return !nx || nx.k - x.k > 2;
  }) ?? cands[cands.length - 1];
  const end = heads.find((y) => y.k > h.k && depthOf(y.num) <= depthOf(h.num));
  return cut(h.k, end ? end.k : -1, `${h.num} ${h.title}`);
}

function ohjePdfOut(doc, auth, args) {
  const pages = doc.pages;
  const src = ohjeSource(doc.url, auth);
  const name = decodeURIComponent(new URL(doc.url).pathname.split("/").pop());
  const head = [`${name} (PDF, ${pages.length} sivua, ${OHJE_AUTH[auth].name})`];
  if (args.sivu) {
    const r = parsePages(args.sivu, pages.length);
    if (!r) throw new UserError(`Anna sivu tai sivualue väliltä 1–${pages.length}, esim. "3" tai "3-5".`);
    const out = [...head, ""];
    for (let p = r[0]; p <= r[1]; p++) out.push(`--- PDF:n sivu ${p} ---`, pages[p - 1], "");
    out.push(src);
    return clip(out.join("\n"));
  }
  if (args.luku) {
    const c = pdfChapter(pages, args.luku);
    if (!c) {
      const toc = tocLines(pages);
      return clip([...head, "", `Lukua "${args.luku}" ei tunnistettu.${toc.length ? " Sisällysluettelo:" : " Lue sivuittain parametrilla sivu."}`, ...toc, "", src].join("\n"));
    }
    return clip([...head, `Luku ${c.title}, PDF:n sivut ${c.from}${c.to !== c.from ? `–${c.to}` : ""}`, "", c.text, "", src].join("\n"));
  }
  if (args.hakusana) {
    const q = String(args.hakusana).trim().toLowerCase();
    if (!q) throw new UserError("Anna hakusana.");
    const hits = [];
    pages.forEach((p, i) => {
      const r = excerpts(p, q);
      if (r.n) hits.push({ page: i + 1, ...r });
    });
    const out = [...head, "", `Hakusana "${args.hakusana}": ${hits.reduce((s, h) => s + h.n, 0)} osumaa ${hits.length} sivulla.`];
    for (const h of hits.slice(0, 30)) {
      out.push("", `Sivu ${h.page} (${h.n})`);
      for (const e of h.ex) out.push(`  ${e}`);
    }
    if (!hits.length) out.push("Ei osumia. Haku on kirjaimellinen: kokeile sanan vartaloa.");
    out.push("", "Lue sivu parametrilla sivu tai luku parametrilla luku.", src);
    return clip(out.join("\n"));
  }
  const total = pages.reduce((s, p) => s + p.length, 0);
  const out = [...head, ""];
  if (total <= TIEDOTE_TEXT_MAX) {
    pages.forEach((p, i) => out.push(`--- PDF:n sivu ${i + 1} ---`, p, ""));
  } else {
    const toc = tocLines(pages);
    out.push(pages[0].length > 2000 ? `${pages[0].slice(0, 2000)}…` : pages[0], "");
    if (toc.length) out.push("Sisällysluettelo:", ...toc, "");
    out.push(`Teksti noin ${Math.round(total / 1000)} 000 merkkiä. Lue luku parametrilla luku (esim. "2"), sivut parametrilla sivu (esim. "3-5") tai etsi parametrilla hakusana.`);
  }
  out.push("", src);
  return clip(out.join("\n"));
}

async function viranomaisohje(args) {
  const url = String(args.osoite ?? "").trim();
  if (!/^https?:\/\//i.test(url)) throw new UserError("Anna ohjeen osoite (https://...), esim. hae_viranomaisohjeita-työkalun tuloksesta.");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    throw new UserError("Virheellinen osoite.");
  }
  if (isBlockedHost(host)) throw new UserError("Fimean ja Tukesin sivut torjuvat automaattiset haut, joten niitä ei haeta. Lue sivu viraston sivustolta.");
  const auth = authorityOf(url);
  if (!auth) throw new UserError("Ohjeita luetaan vain sivustoilta kyberturvallisuuskeskus.fi (Traficom), tietosuoja.fi, kkv.fi ja prh.fi (https). Vero-ohjeet: viranomaistiedote-työkalu.");
  const budget = newBudget();
  if (/\.pdf$/i.test(new URL(url).pathname)) {
    const doc = await ohjePdf(url, budget);
    if (!doc) throw new UserError(`PDF-tiedostoa ei löytynyt: ${url}`);
    return ohjePdfOut(doc, auth, args);
  }
  const d = await ohjePage(url, budget);
  if (!d) throw new UserError(`Sivua ei löytynyt: ${url}`);
  if (d.pdf) return ohjePdfOut(await ohjePdf(d.url, budget, d.bytes), auth, args);
  if (!d.sections.length && !d.intro) throw new UserError(`Sivulta ei löytynyt ohjetekstiä: ${url}`);
  return ohjeHtmlOut(d, args);
}

// ---------- Kirjanpitolautakunta (KILA) ----------

const KILA_SRC = "Kirjanpitolautakunta, kirjanpitolautakunta.fi";
const KILA_TEXT_MAX = 40_000;
const KILA_TYPES = ["lausunto", "poikkeuslupa", "yleisohje", "kaikki"];
const KILA_NOTE = {
  lausunto:
    "Lausunto koskee hakijan kuvaamaa tapausta, ja se perustuu antamisajankohdan säännöksiin. Se kertoo lautakunnan kannan hyvästä kirjanpitotavasta, mutta ei ole lakia; tarkista voimassa oleva laki hae_pykala-työkalulla (kirjanpitolaki 1336/1997).",
  poikkeuslupa:
    "Poikkeuslupa myönnetään yksittäistapauksessa määräajaksi (kirjanpitolaki 1336/1997 8 luku 2 § 2 mom.), ja se koskee vain hakijaa. Tarkista voimassa oleva laki hae_pykala-työkalulla (kirjanpitolaki 1336/1997).",
  yleisohje:
    "Yleisohje on kirjanpitolautakunnan ohje hyvästä kirjanpitotavasta (kirjanpitolaki 1336/1997 8 luku 2 § 1 mom.), ei lakia. Tarkista voimassaolo (hae_kila_lausuntoja, tyyppi yleisohje) ja lainkohdat hae_pykala-työkalulla.",
};

function kilaNumber(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, "");
  const m = s.match(/^(?:(\d{4})\/)?0*(\d{1,5})$/) ?? s.match(/^0*(\d{1,5})\/(\d{4})$/)?.slice(0, 3).reverse();
  if (!m) throw new UserError('Anna lausunnon numero muodossa "1516" tai "1998/1516".');
  const year = m[1] ? asYear(m[1]) : undefined;
  return { year, num: m[2] };
}

function kilaKind(x) {
  return x.status ? "Yleisohje" : isExemption(x.title) ? "Poikkeuslupa" : "Lausunto";
}

async function haeKilaLausuntoja(args) {
  const type = String(args.tyyppi ?? "kaikki").trim().toLowerCase();
  if (!KILA_TYPES.includes(type)) throw new UserError(`tyyppi: ${KILA_TYPES.join(", ")}.`);
  const query = String(args.hakusana ?? "").trim();
  const page = args.sivu === undefined ? 1 : Number(args.sivu);
  if (!Number.isInteger(page) || page < 1 || page > 60) throw new UserError("sivu: 1–60.");
  let from = args.alkaen_vuosi ? asYear(args.alkaen_vuosi) : undefined;
  let to = args.paattyen_vuosi ? asYear(args.paattyen_vuosi) : undefined;
  if (args.vuosi) from = to = asYear(args.vuosi);
  if (from && to && from > to) throw new UserError("alkaen_vuosi on myöhempi kuin paattyen_vuosi.");
  const sess = kilaSession();
  const out = [];
  const crit = [query && `"${query}"`, from && to && from === to ? `vuosi ${from}` : [from && `alkaen ${from}`, to && `päättyen ${to}`].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  if (args.numero !== undefined && String(args.numero).trim()) {
    const { year, num } = kilaNumber(args.numero);
    const hits = await findByNumber(sess, num, year);
    out.push(`Kirjanpitolautakunta, numero ${year ? `${year}/` : ""}${num}: ${hits.length ? `${hits.length} osuma${hits.length > 1 ? "a" : ""}` : "ei löytynyt"}.`);
    for (const h of hits) out.push("", `${h.year}/${h.num} · ${fmtDate(h.date) ?? "?"} · ${kilaKind(h)} · ${h.title}`, `  ${h.url}`);
    if (!hits.length) out.push("Tarkista numero tai hae hakusanalla. Yleisohjeilla ei ole numeroa; ne löytyvät tyypillä yleisohje.");
    out.push("", "Lue teksti kila_lausunto-työkalulla (numero tai osoite).", `Lähde: ${KILA_BASE}/lausunnot-ja-poikkeusluvat (${KILA_SRC})`);
    return out.join("\n");
  }

  const wantStatements = type !== "yleisohje";
  const wantGuides = type === "yleisohje" || (type === "kaikki" && !!query);
  if (wantStatements) {
    const term = query || (type === "poikkeuslupa" ? "poikkeuslupa" : "");
    const r = await searchStatements(sess, { term, yearStart: from, yearEnd: to, page });
    let items = r.items;
    if (type === "poikkeuslupa") items = items.filter((x) => isExemption(x.title));
    else if (type === "lausunto") items = items.filter((x) => !isExemption(x.title));
    const label = type === "lausunto" ? "lausunnot" : type === "poikkeuslupa" ? "poikkeusluvat" : "lausunnot ja poikkeusluvat";
    const span = r.pages ? `sivu ${page}/${r.pages} (${r.pageSize} sivulla)` : `sivu ${page}`;
    out.push(`Kirjanpitolautakunnan ${label}${crit ? ` (${crit})` : ""}: ${span}.`);
    if (items.length !== r.items.length) out.push(`Sivulla ${r.items.length} tulosta, joista tyypin ${type} mukaisia ${items.length} (tyyppi päätellään otsikosta).`);
    if (!items.length) out.push(page > 1 && !r.items.length ? "Sivulla ei ole tuloksia." : "Ei osumia. Kokeile toista sanaa, sanan perusmuotoa tai väljempää vuosirajausta.");
    for (const h of items) out.push("", `${h.year ? `${h.year}/${h.num}` : "?"} · ${fmtDate(h.date) ?? "?"} · ${kilaKind(h)} · ${h.title}`, `  ${h.url}`);
    if (r.hasMore) out.push("", `Lisää tuloksia${r.pages ? "" : " voi olla"}: sivu ${page + 1}.`);
  }
  if (wantGuides) {
    const lists = type === "kaikki" || args.voimassa === true ? ["voimassa"] : args.voimassa === false ? ["aiempi"] : ["voimassa", "aiempi"];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let guides = [];
    for (const l of lists) guides.push(...(await guideList(sess, l)));
    guides = guides.filter((g) => words.every((w) => g.title.toLowerCase().includes(w)));
    if (from) guides = guides.filter((g) => g.date && +g.date.slice(0, 4) >= from);
    if (to) guides = guides.filter((g) => g.date && +g.date.slice(0, 4) <= to);
    if (out.length) out.push("");
    const which = lists.length === 2 ? "voimassa olevat ja aiemmat" : lists[0] === "voimassa" ? "voimassa olevat" : "aiemmat (korvatut)";
    out.push(`Kirjanpitolautakunnan yleisohjeet, ${which}${crit ? ` (${crit}, haku otsikosta)` : ""}: ${guides.length} kpl.`);
    for (const g of guides) out.push("", `${fmtDate(g.date) ?? "?"} · Yleisohje, ${g.status === "voimassa" ? "voimassa" : "aiempi"} · ${g.title}`, `  ${g.url}`);
    if (type === "kaikki") out.push("", "Aiemmat (korvatut) yleisohjeet: tyyppi yleisohje.");
  }
  out.push(
    "",
    "Lue lausunto tai yleisohje kila_lausunto-työkalulla (numero tai osoite; luku, hakusana, liite).",
    "Lausunto koskee hakijan tapausta; yleisohje on ohje hyvästä kirjanpitotavasta, ei lakia.",
    `Lähde: ${KILA_BASE}/lausunnot-ja-poikkeusluvat ja ${KILA_BASE}/voimassaolevat (${KILA_SRC})`,
  );
  return clip(out.join("\n"));
}

function kilaChapter(sections, i) {
  const base = sections[i];
  const out = [base];
  for (let j = i + 1; j < sections.length && sections[j].level > base.level; j++) out.push(sections[j]);
  return out;
}

function kilaFindSection(sections, luku) {
  const want = normLuku(luku);
  let i = sections.findIndex((x) => x.num === want);
  let note = null;
  if (i < 0) {
    const lw = want.toLowerCase();
    const esc = lw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rank = (t) => (t === lw ? 0 : t.startsWith(lw) ? 1 : new RegExp(`(^|[\\s(-])${esc}`).test(t) ? 2 : t.includes(lw) ? 3 : 9);
    const cand = sections
      .map((x, k) => [x, k, rank(x.title.toLowerCase())])
      .filter((c) => c[2] < 9)
      .sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    if (cand.length) {
      i = cand[0][1];
      if (cand.length > 1) note = `Otsikkoon "${want}" osui myös: ${cand.slice(1, 8).map(([x]) => secLabel(x)).join("; ")}.`;
    }
  }
  return { i, note };
}

function kilaHits(intro, sections, q) {
  const needle = q.toLowerCase();
  const hits = [];
  const scan = (label, text) => {
    const r = excerpts(text, needle);
    if (r.n) hits.push({ label, ...r });
  };
  if (intro) scan("Alku", intro);
  for (const x of sections) scan(secLabel(x), `${x.title}\n${x.text}`);
  return hits;
}

function kilaHitsOut(hits, q) {
  const out = [`Hakusana "${q}": ${hits.reduce((s, h) => s + h.n, 0)} osumaa ${hits.length} luvussa.`];
  for (const h of hits.slice(0, 30)) {
    out.push("", `${h.label} (${h.n})`);
    for (const e of h.ex) out.push(`  ${e}`);
  }
  if (hits.length > 30) out.push("", `… ja ${hits.length - 30} muuta lukua.`);
  if (!hits.length) out.push("Ei osumia. Haku on kirjaimellinen: kokeile sanan vartaloa.");
  return out;
}

const kilaToc = (sections) => sections.map((x) => `${"  ".repeat(Math.max(0, x.level - 1))}${secLabel(x)}${x.page ? ` (s. ${x.page})` : ""}`);

async function kilaLausunto(args) {
  const sess = kilaSession();
  let url = String(args.osoite ?? "").trim();
  if (!url && String(args.numero ?? "").trim()) {
    const { year, num } = kilaNumber(args.numero);
    const hits = await findByNumber(sess, num, year);
    if (!hits.length) throw new UserError(`Lausuntoa numerolla ${year ? `${year}/` : ""}${num} ei löytynyt kirjanpitolautakunta.fi:stä. Tarkista numero tai hae hae_kila_lausuntoja-työkalulla.`);
    if (hits.length > 1) return [`Numerolla ${num} löytyi useita:`, ...hits.map((h) => `- ${h.year}/${h.num} ${h.title}: ${h.url}`), "", "Anna numero vuoden kanssa (esim. \"1998/1516\") tai osoite."].join("\n");
    url = hits[0].url;
  }
  if (!url) throw new UserError("Anna numero (esim. \"1998/1516\") tai osoite hae_kila_lausuntoja-työkalun tuloksesta.");
  if (!/^https:\/\/(www\.)?kirjanpitolautakunta\.fi\/-\/[^/?#]+/i.test(url) || !kilaUrlAllowed(url.replace(/[?#].*$/, ""))) {
    throw new UserError("Osoitteen pitää olla kirjanpitolautakunnan asiakirjasivu (https://kirjanpitolautakunta.fi/-/...). Sivuston robots.txt:n kieltämiä polkuja (esim. /-/q/, /haku/, /web/) ei haeta.");
  }
  const d = await docPage(sess, url);
  if (!d) throw new UserError("Asiakirjaa ei löytynyt osoitteesta. Hae se uudelleen hae_kila_lausuntoja-työkalulla.");

  const kind = d.kind;
  const head = [d.title];
  if (kind === "yleisohje") {
    const [v, a] = await Promise.all([guideList(sess, "voimassa", { cacheOnly: true }), guideList(sess, "aiempi", { cacheOnly: true })]);
    const status = v?.some((g) => g.url === d.url) ? "voimassa" : a?.some((g) => g.url === d.url) ? "aiempi (korvattu)" : null;
    head.push(`Kirjanpitolautakunnan yleisohje, annettu ${fmtDate(d.date) ?? "?"}${status ? `, ${status}` : ""}`);
  } else {
    head.push(`Kirjanpitolautakunnan ${kind} ${d.number ? `${d.date?.slice(0, 4) ?? "?"}/${d.number}` : ""}, annettu ${fmtDate(d.date) ?? "?"}`.replace(/\s+,/, ","));
  }
  if (d.keywords) head.push(`Asiasanat: ${d.keywords}`);
  const src = `Lähde: ${d.url} (${KILA_SRC})`;
  const note = KILA_NOTE[kind] ?? KILA_NOTE.lausunto;

  // Yleisohje: teksti PDF:stä, liitteet vain pyydettäessä.
  const { main, annexes } = splitGuidePdfs(d.pdfs);
  const pdfBased = kind === "yleisohje" && main && d.sections.length === 0;
  if (args.liite !== undefined && String(args.liite).trim()) {
    if (!annexes.length) throw new UserError("Asiakirjalla ei ole liitteitä.");
    const w = String(args.liite).trim().toLowerCase().replace(/^liite\s*/, "");
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`liite\\s*0*${esc}(?![0-9a-z])`, "i");
    let ax = annexes.find((x) => re.test(x.name));
    if (!ax && /^\d+$/.test(w) && annexes[+w - 1] && !annexes.some((x) => /liite/i.test(x.name))) ax = annexes[+w - 1];
    if (!ax) throw new UserError(`Liitettä "${args.liite}" ei löytynyt. Liitteet:\n${annexes.map((x) => `- ${x.name}`).join("\n")}`);
    const pages = await attachmentText(sess, ax.url);
    if (!pages?.length) throw new UserError(`Liitteen tekstiä ei saatu PDF:stä. Avaa liite: ${ax.url}`);
    let text = pages.map((p, i) => (pages.length > 1 ? `--- sivu ${i + 1} ---\n${p}` : p)).join("\n\n");
    if (text.length > KILA_TEXT_MAX) text = `${text.slice(0, KILA_TEXT_MAX)}\n… (katkaistu; koko liite lähteessä)`;
    return clip([...head, `Liite: ${ax.name}`, "", text, "", "Teksti on purettu PDF:stä automaattisesti; tarkista taulukoiden luvut PDF:stä.", `Lähde: ${ax.url} (${KILA_SRC})`, note].join("\n"));
  }

  let intro = d.intro;
  let sections = d.sections;
  let pages = null;
  if (pdfBased) {
    const g = await guideText(sess, main.url);
    if (!g) throw new UserError(`Yleisohjeen PDF:ää ei saatu. Avaa se: ${main.url}`);
    sections = g.sections;
    pages = g.pages;
    // Sivun teksti ilman otsikon toistoa ja PDF-tiedostojen nimiä (esim. "Tämä yleisohje korvaa ...").
    intro = d.intro
      .split("\n")
      .filter((l) => l !== d.title && !/\.pdf$/i.test(l.replace(/^- /, "")))
      .join("\n");
    head.push(`Teksti: ${main.name} (${g.pageCount} sivua, purettu PDF:stä automaattisesti): ${main.url}`);
  }
  const annexList = annexes.length ? [`Liitteet (${annexes.length}, haetaan parametrilla liite, esim. "1"):`, ...annexes.map((x) => `- ${x.name}`)] : [];

  if (args.luku !== undefined && String(args.luku).trim()) {
    if (!sections.length) throw new UserError("Tekstissä ei tunnistettu numeroituja lukuja. Hae parametrilla hakusana tai lue koko teksti ilman parametreja.");
    const { i, note: n2 } = kilaFindSection(sections, args.luku);
    if (i < 0) return clip([...head, "", `Lukua "${args.luku}" ei löytynyt. Sisällys:`, ...kilaToc(sections), "", src].join("\n"));
    const o = [...head, ""];
    if (n2) o.push(n2, "");
    for (const x of kilaChapter(sections, i)) o.push(`${secLabel(x)}${x.page ? ` [PDF:n s. ${x.page}]` : ""}`, x.text || "(ei tekstiä ennen alalukuja)", "");
    o.push(src, note);
    return clip(o.join("\n"));
  }
  if (args.hakusana !== undefined && String(args.hakusana).trim()) {
    const q = String(args.hakusana).trim();
    const o = [...head, ""];
    if (sections.length) o.push(...kilaHitsOut(kilaHits(intro, sections, q), q), "", "Lue luku sanatarkasti parametrilla luku.");
    else if (pages) {
      const hits = textHits(pages, q);
      o.push(hits.length ? `Osumat hakusanalle "${q}" (${hits.length}${hits.length >= 30 ? "+" : ""}):` : `Hakusanaa "${q}" ei löytynyt. Kokeile sanan vartaloa.`);
      for (const h of hits) o.push("", h);
    } else o.push(...kilaHitsOut(kilaHits(intro, [], q), q));
    o.push("", src, note);
    return clip(o.join("\n"));
  }

  const o = [...head, ""];
  if (intro) o.push(intro, "");
  const total = sections.reduce((s, x) => s + x.text.length, 0);
  if (pdfBased) {
    if (sections.length) {
      if (total <= 15_000) for (const x of sections) o.push(secLabel(x), x.text, "");
      else o.push(`Sisällysluettelo (noin ${Math.round(total / 1000)} 000 merkkiä; lue luku parametrilla luku, esim. "${sections.find((x) => x.text)?.num ?? "1"}", tai etsi parametrilla hakusana):`, ...kilaToc(sections), "");
    } else if (pages) {
      let text = pages.map((p, i) => `--- sivu ${i + 1} ---\n${p}`).join("\n\n");
      if (text.length > KILA_TEXT_MAX) text = `${text.slice(0, KILA_TEXT_MAX)}\n… (katkaistu; etsi parametrilla hakusana)`;
      o.push(text, "");
    }
  } else if (total + intro.length <= KILA_TEXT_MAX) {
    for (const x of sections) o.push(secLabel(x), x.text, "");
  } else {
    o.push(`Sisällys (noin ${Math.round(total / 1000)} 000 merkkiä; lue luku parametrilla luku tai etsi parametrilla hakusana):`, ...kilaToc(sections), "");
  }
  if (annexList.length) o.push(...annexList, "");
  o.push(src, note);
  return clip(o.join("\n"));
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
  const page = asPage(args.sivu);
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
    sortBy: "dateIssued",
  };
  const list = await fetchListPage(decisionListUrl(src, params), page);
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

// ---------- Lainvalmistelu (Hankeikkuna) ----------

const HK_TYPES = { lainsaadanto: ["LAINSAADANTO"], hanke: ["HANKE"], toimielin: ["TOIMIELIN"], strategia: ["STRATEGIA"], kaikki: null };
const HK_TILA = { suunnitteilla: "SUUNNITTEILLA", kaynnissa: "KAYNNISSA", paattynyt: "PAATTYNYT" };
const HK_TILA_FI = { SUUNNITTEILLA: "suunnitteilla", KAYNNISSA: "käynnissä", PAATTYNYT: "päättynyt" };
const HK_VAIHE_FI = {
  ESIVALMISTELU: "esivalmistelu",
  PERUSVALMISTELU: "perusvalmistelu",
  LAUSUNTOMENETTELY: "lausuntomenettely",
  JATKOVALMISTELU: "jatkovalmistelu",
  VALTIONEUVOSTON_PAATOKSENTEKO: "valtioneuvoston päätöksenteko",
  EDUSKUNTAKASITTELY: "eduskuntakäsittely",
  LAIN_VAHVISTAMINEN: "lain vahvistaminen",
  VALMISTUNUT: "valmistunut",
  KESKEYTETTY: "keskeytetty",
};
const HK_LUOKKA_FI = {
  HALLITUKSEN_ESITYKSEN_VALMISTELU: "hallituksen esityksen valmistelu",
  ASETUKSEN_ANTAMINEN: "asetuksen antaminen",
  TALOUSARVIOT: "talousarvio",
  VALTION_LAINANOTTO_JA_ANTO: "valtion lainanotto ja -anto",
  VALTIONTAKAUKSET: "valtiontakaukset",
};
const HK_TYYPPI_FI = { LAINSAADANTO: "lainsäädäntöhanke", HANKE: "hanke", TOIMIELIN: "toimielin", STRATEGIA: "strategia" };
const HK_ETAPPI_FI = {
  LAUSUNTOKIERROS: "Lausuntokierros",
  KUULEMISTILAISUUS: "Kuulemistilaisuus",
  TYORYHMA: "Työryhmä",
  SAADOS: "Säädös",
  LINJAUSPAATOS: "Linjauspäätös",
  KOKOUS: "Kokous",
  RAPORTOINTI: "Raportointi",
  VALIRAPORTOINTI: "Väliraportointi",
  TIEDOTUSTILAISUUS: "Tiedotustilaisuus",
  VERKKOKESKUSTELU: "Verkkokeskustelu",
  HANKINTA: "Hankinta",
  BUDJETTIPAATOS: "Budjettipäätös",
  KOULUTUS: "Koulutus",
  MUU: "Vaihe",
};
const HK_DOC_FI = {
  LAUSUNTO: "lausunto",
  LAUSUNTOPYYNTO: "lausuntopyyntö",
  KIRJE: "kirje",
  POYTAKIRJA: "pöytäkirja",
  MUISTIO: "muistio",
  ASETTAMISPAATOS: "asettamispäätös",
  YHTEENVETO: "yhteenveto",
  PAATOS: "päätös",
  LIITE: "liite",
  ESITYS: "esitys",
  RAPORTTI: "raportti",
  SUUNNITELMA: "suunnitelma",
  MIETINTO: "mietintö",
  JULKAISU: "julkaisu",
  KUTSU: "kutsu",
  KANNANOTTO: "kannanotto",
};
const HK_SOURCE = "Hankeikkuna, valtioneuvosto, CC BY 4.0";
const HK_TEXT_CHUNK = 40_000;

// Suomen päivämäärä (EU:n kesäaika: maaliskuun viimeisestä sunnuntaista lokakuun viimeiseen klo 1 UTC).
function finnishToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const lastSunday = (m) => {
    const d = new Date(Date.UTC(y, m + 1, 0, 1));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  };
  const dst = now.getTime() >= lastSunday(2) && now.getTime() < lastSunday(9);
  return new Date(now.getTime() + (dst ? 3 : 2) * 3600_000).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function asIsoDate(v, what) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  throw new UserError(`Anna ${what} muodossa vvvv-kk-pp, esim. 2026-01-31.`);
}

function dateRange(a, l) {
  if (a && l) {
    const [ya, ma, da] = a.split("-");
    const [yl, ml, dl] = l.split("-");
    return ya === yl ? `${+da}.${+ma}.–${+dl}.${+ml}.${yl}` : `${fmtDate(a)}–${fmtDate(l)}`;
  }
  if (a) return `alkaen ${fmtDate(a)}`;
  if (l) return `päättyy ${fmtDate(l)}`;
  return "";
}

function etappiStatus(e, today) {
  if (e.l && e.l < today) return "päättynyt";
  if (e.a && e.a > today) return "tulossa";
  return "käynnissä";
}

async function ministryUuids(v) {
  const q = String(v).trim().toLowerCase();
  const list = await asettajat();
  const hits = list.filter((a) => (a.lyhenne ?? "").toLowerCase() === q);
  const byName = hits.length ? hits : list.filter((a) => (a.nimi ?? "").toLowerCase().includes(q));
  if (!byName.length) throw new UserError(`Ministeriötä "${v}" ei tunnistettu. Vaihtoehdot: ${[...new Set(list.filter((a) => a.aktiivinen).map((a) => a.lyhenne))].join(", ")}.`);
  return byName.map((a) => a.uuid);
}

async function ministryLabel(uuid) {
  if (!uuid) return null;
  const a = (await asettajat()).find((x) => x.uuid === uuid);
  return a ? (a.lyhenne ?? a.nimi) : null;
}

function rowStatus(r) {
  const parts = [];
  if (r.tila) parts.push(HK_TILA_FI[r.tila] ?? r.tila.toLowerCase());
  if (r.vaihe) parts.push(`vaihe: ${HK_VAIHE_FI[r.vaihe] ?? r.vaihe.toLowerCase()}`);
  return parts;
}

function heTilaText(h) {
  if (!h?.kuvaus) return null;
  const week = h.viikko && h.vuosi ? `, esittely vko ${h.viikko}/${h.vuosi}` : "";
  return `${h.kuvaus}${h.tila === "ANNETTU_EK" ? "" : week}`;
}

async function haeLainvalmisteluhankkeita(args) {
  const page = Number.isInteger(args.sivu) && args.sivu > 0 ? args.sivu : 1;
  if (page > 20) throw new UserError("Sivuja voi selata enintään 20. Rajaa hakua.");
  const form = {};
  const hakusana = String(args.hakusana ?? "").trim();
  if (hakusana) form.teksti = hakusana;
  const tyyppiKey = args.tyyppi ?? "lainsaadanto";
  if (!(tyyppiKey in HK_TYPES)) throw new UserError("tyyppi: lainsaadanto, hanke, toimielin, strategia tai kaikki.");
  if (HK_TYPES[tyyppiKey]) form.tyyppi = HK_TYPES[tyyppiKey];
  if (args.laji === "he") form.lainsaadantoTehtavaluokka = ["HALLITUKSEN_ESITYKSEN_VALMISTELU"];
  else if (args.laji === "asetus") form.lainsaadantoTehtavaluokka = ["ASETUKSEN_ANTAMINEN"];
  if (args.tila) {
    if (!HK_TILA[args.tila]) throw new UserError("tila: suunnitteilla, kaynnissa tai paattynyt.");
    form.tila = [HK_TILA[args.tila]];
  }
  if (args.vaihe) {
    const v = String(args.vaihe).toUpperCase();
    if (!HK_VAIHE_FI[v]) throw new UserError(`vaihe: ${Object.keys(HK_VAIHE_FI).map((k) => k.toLowerCase()).join(", ")}.`);
    form.valmisteluvaihe = [v];
  }
  if (args.ministerio) form.asettajaUuid = await ministryUuids(args.ministerio);
  const alkaen = asIsoDate(args.alkaen, "alkaen");
  const paattyen = asIsoDate(args.paattyen, "paattyen");
  if (alkaen) form.asettamisPaivaAlku = alkaen;
  if (paattyen) form.asettamisPaivaLoppu = paattyen;
  const order = args.jarjestys ?? (hakusana ? "osuvuus" : "muokattu");
  if (order === "muokattu") form.sort = [{ field: "kohde.muokattu", order: "DESC" }];
  else if (order === "asetettu") form.sort = [{ field: "kohde.asettamisPaiva", order: "DESC" }];
  else if (order !== "osuvuus") throw new UserError("jarjestys: osuvuus, muokattu tai asetettu.");

  const today = finnishToday();
  let total;
  let rows;
  const open = args.lausuntokierros_auki === true;
  if (open) {
    // Käynnissä olevat kierrokset alkoivat yleensä viimeisten kuukausien aikana; suodatus tehdään
    // tässä, koska rajapinta ei rajaa päättymispäivällä.
    form.etappiTyyppi = ["LAUSUNTOKIERROS"];
    form.etappiAlkamisPaivaAlku = addDays(today, -180);
    if (!form.tila) form.tila = ["KAYNNISSA", "SUUNNITTEILLA"];
    form.sort = [{ field: "kohde.muokattu", order: "DESC" }];
    const res = await searchProjects(form, 300);
    const withRound = [];
    for (const r of res.rows) {
      const cur = r.lk.filter((e) => e.l && e.l >= today && (!e.a || e.a <= today)).sort((a, b) => cmpStr(a.l, b.l))[0];
      if (cur) withRound.push({ ...r, cur });
    }
    withRound.sort((a, b) => cmpStr(a.cur.l, b.cur.l) || cmpStr(a.tunnus ?? "", b.tunnus ?? ""));
    total = withRound.length;
    rows = withRound.slice((page - 1) * 10, page * 10);
  } else {
    const res = await searchProjects(form, page * 10);
    total = res.total;
    rows = res.rows.slice((page - 1) * 10, page * 10);
  }

  const crit = [];
  if (hakusana) crit.push(`hakusana "${hakusana}"`);
  if (args.ministerio) crit.push(`ministeriö ${args.ministerio}`);
  if (args.laji) crit.push(args.laji === "he" ? "hallituksen esitykset" : "asetukset");
  if (args.vaihe) crit.push(`vaihe ${HK_VAIHE_FI[String(args.vaihe).toUpperCase()]}`);
  if (args.tila) crit.push(HK_TILA_FI[HK_TILA[args.tila]]);
  if (alkaen || paattyen) crit.push(`asetettu ${dateRange(alkaen, paattyen)}`);
  if (open) crit.push(`lausuntokierros käynnissä ${fmtDate(today)}`);
  const head = `Hankeikkunan hankkeet${crit.length ? ` (${crit.join(", ")})` : ""}: ${total} osumaa, sivu ${page}${open ? ", lähin määräaika ensin" : order === "osuvuus" ? ", osuvin ensin" : order === "asetettu" ? ", uusin ensin" : ", viimeksi muokattu ensin"}.`;
  if (!rows.length) return `${head}\n\nEi tuloksia${page > 1 ? " tällä sivulla" : ""}. Kokeile toista hakusanaa tai väljempiä ehtoja.`;
  const out = [head, ""];
  for (const r of rows) {
    const min = await ministryLabel(r.asettaja);
    const status = rowStatus(r);
    out.push(`${r.tunnus} ${r.nimi ?? "(nimetön hanke)"}${[min, ...status].filter(Boolean).length ? ` (${[min, ...status].filter(Boolean).join(", ")})` : ""}`);
    const det = [];
    if (r.lain?.luokka) det.push(HK_LUOKKA_FI[r.lain.luokka] ?? r.lain.luokka.toLowerCase());
    if (r.lain?.he?.length) det.push(r.lain.he.join(", "));
    const ht = heTilaText(r.lain?.heTila);
    if (ht && !r.lain?.he?.length) det.push(ht);
    if (open) det.push(`lausuntokierros ${dateRange(r.cur.a, r.cur.l)}`);
    else {
      const lk = r.lk.filter((e) => e.a || e.l).sort((a, b) => cmpStr(b.a ?? "", a.a ?? ""))[0];
      if (lk) det.push(`lausuntokierros ${dateRange(lk.a, lk.l)} (${etappiStatus(lk, today)})`);
    }
    if (r.asetettu) det.push(`asetettu ${fmtDate(r.asetettu)}`);
    if (det.length) out.push(`  ${det.join(" | ")}`);
  }
  if (total > page * 10) out.push("", `Lisää tuloksia: sivu ${page + 1}.`);
  out.push("", `Hankkeen tiedot ja asiakirjat: lainvalmisteluhanke-työkalulla (hanke: tunnus). Lähde: ${HK_SOURCE}.`);
  return clip(out.join("\n"));
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function loadProject(v) {
  const s = String(v ?? "").trim();
  const m = s.match(/^HE\s*(\d{1,4})\s*\/\s*(\d{4})(?:\s*vp)?$/i);
  if (m) {
    const he = `HE ${+m[1]}/${m[2]}`;
    const tunnukset = await projectsForProposal(he);
    if (!tunnukset.length) throw new UserError(`Hallituksen esitykselle ${he} ei löytynyt valmisteluhanketta Hankeikkunasta. Kaikkia esityksiä ei ole liitetty hankkeeseen; kokeile hae_lainvalmisteluhankkeita-työkalua hakusanalla.`);
    const p = await projectByTunnus(tunnukset[0]);
    if (!p) throw new UserError(`Hanketta ${tunnukset[0]} ei saatu Hankeikkunasta.`);
    return { p, others: tunnukset.slice(1) };
  }
  const t = s.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-ZÅÄÖ]{2,4}\d{1,4}:\d{2}\/\d{4}$/.test(t)) throw new UserError('Anna hanke tunnuksena, esim. "STM006:00/2020", tai hallituksen esityksenä, esim. "HE 231/2021".');
  const p = await projectByTunnus(t);
  if (!p) throw new UserError(`Hanketta ${t} ei löytynyt Hankeikkunasta.`);
  return { p, others: [] };
}

function docLine(d, i) {
  const bits = [HK_DOC_FI[d.t] ?? (d.t ? d.t.toLowerCase() : "asiakirja")];
  if (d.d) bits.push(fmtDate(d.d));
  const name = d.n && d.n.toLowerCase() !== (HK_DOC_FI[d.t] ?? "") ? d.n : null;
  const who = d.l ? ` – ${d.l}` : "";
  const file = d.u ? (docKind(d) ? "" : " (tiedosto, tekstiä ei pureta)") : " (vain viitetiedot)";
  return `${i}. ${name ?? bits[0]}${who} (${bits.join(", ")})${file}`;
}

async function lainvalmisteluhanke(args) {
  const { p, others } = await loadProject(args.hanke);
  const today = finnishToday();
  const min = await ministryLabel(p.asettaja);
  const out = [`${p.tunnus} ${p.nimi ?? "(nimetön hanke)"}`];
  const info = [HK_TYYPPI_FI[p.tyyppi] ?? p.tyyppi, min, ...rowStatus(p)].filter(Boolean);
  out.push(info.join(", ") + ".");
  const dates = [];
  if (p.asetettu) dates.push(`asetettu ${fmtDate(p.asetettu)}`);
  if (p.aloitus && p.aloitus !== p.asetettu) dates.push(`alkanut ${fmtDate(p.aloitus)}`);
  if (p.valmistuminen) dates.push(`${p.valmistuminen < today ? "valmistunut" : "valmistuu"} ${fmtDate(p.valmistuminen)}`);
  if (dates.length) out.push(dates.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".");
  out.push(`Lähde: ${projectWebUrl(p.tunnus)} (${HK_SOURCE})`);
  if (others.length) out.push(`Samaan esitykseen liittyy myös: ${others.join(", ")}.`);

  const showDocsOnly = args.asiakirjatyyppi || args.laatija || args.sivu;
  if (!showDocsOnly) {
    const l = p.lain;
    if (l) {
      const rows = [];
      if (l.luokka) rows.push(`Tehtävä: ${HK_LUOKKA_FI[l.luokka] ?? l.luokka.toLowerCase()}`);
      if (l.otsikko) rows.push(`Esityksen otsikko: ${l.otsikko}`);
      if (l.he.length) rows.push(`Hallituksen esitys: ${l.he.join(", ")} (teksti hallituksen_esitys-työkalulla, käsittely eduskuntakasittely-työkalulla)`);
      const ht = heTilaText(l.heTila);
      if (ht) rows.push(`HE-luettelo: ${ht}`);
      if (l.ministeri) rows.push(`Vastuuministeri: ${l.ministeri}`);
      if (l.sisalto) rows.push(`Sisältö: ${l.sisalto}`);
      if (l.pev === "KYLLA") rows.push("Perustuslakivaliokunnan lausunto arvioitu tarpeelliseksi.");
      if (l.kiire) rows.push("Merkitty kiireelliseksi.");
      if (l.lan) rows.push("Lainsäädännön arviointineuvosto arvioi esitysluonnoksen.");
      if (l.ev.length) rows.push(`Eduskunnan vastaus: ${l.ev.join(", ")}`);
      if (l.sk.length) rows.push(`Säädökset: ${l.sk.join(", ")} (teksti saados_tiedot- tai hae_pykala-työkalulla)`);
      if (l.rauennut) rows.push("Esitys on rauennut.");
      if (rows.length) out.push("", ...rows);
    }
    for (const [label, text] of [["Tiivistelmä", p.tiivistelma], ["Tavoitteet", p.tavoitteet], ["Tilanne", p.tilanne], ["Vaikutukset", p.vaikutukset], ["Kuvaus", p.kuvaus]]) {
      if (text) out.push("", `${label}:`, text.length > 3000 ? `${text.slice(0, 3000)} …` : text);
    }
    if (p.etapit.length) {
      out.push("", "Vaiheet:");
      for (const e of p.etapit) {
        const range = dateRange(e.a, e.l);
        const st = e.t === "LAUSUNTOKIERROS" || e.l ? ` (${etappiStatus(e, today)})` : "";
        const name = e.n && e.n !== HK_ETAPPI_FI[e.t] ? `: ${e.n}` : "";
        out.push(`- ${HK_ETAPPI_FI[e.t] ?? e.t ?? "Vaihe"}${name}${range ? `, ${range}` : ""}${st}`);
        const links = p.linkit.filter((x) => x.e && x.e === e.id);
        for (const x of links) out.push(`  ${x.n ?? "Linkki"}: ${x.u}`);
      }
    }
    const loose = p.linkit.filter((x) => !x.e || !p.etapit.some((e) => e.id === x.e));
    if (loose.length) {
      out.push("", "Linkit:");
      for (const x of loose) out.push(`- ${x.n ?? "Linkki"}: ${x.u}`);
    }
  }

  // Asiakirjat numeroituina (numero = järjestys koko luettelossa).
  const numbered = p.docs.map((d, i) => ({ d, i: i + 1 }));
  let list;
  let title;
  if (showDocsOnly) {
    let sel = numbered;
    const tq = String(args.asiakirjatyyppi ?? "").trim().toLowerCase();
    if (tq && tq !== "kaikki") {
      const norm = (x) => x.replace(/ä/g, "a").replace(/ö/g, "o");
      sel = sel.filter(({ d }) => norm((d.t ?? "").toLowerCase()) === norm(tq) || norm(HK_DOC_FI[d.t] ?? "") === norm(tq));
    }
    const lq = String(args.laatija ?? "").trim().toLowerCase();
    if (lq) sel = sel.filter(({ d }) => (d.l ?? "").toLowerCase().includes(lq) || (d.n ?? "").toLowerCase().includes(lq));
    const page = Number.isInteger(args.sivu) && args.sivu > 0 ? args.sivu : 1;
    list = sel.slice((page - 1) * 100, page * 100);
    title = `Asiakirjat${tq ? ` (${tq})` : ""}${lq ? ` (laatija "${args.laatija}")` : ""}: ${sel.length} kpl${sel.length > 100 ? `, sivu ${page}` : ""}`;
    if (sel.length > page * 100) title += `; lisää: sivu ${page + 1}`;
  } else {
    list = numbered.filter(({ d }) => d.t !== "LAUSUNTO");
    title = `Asiakirjat (${p.docs.length} kpl${list.length < p.docs.length ? "; lausunnot erikseen alla" : ""})`;
    if (list.length > 60) {
      title += `; näytetään 60 viimeisintä, kaikki: asiakirjatyyppi "kaikki"`;
      list = list.slice(-60);
    }
  }
  if (p.docs.length) {
    out.push("", `${title}:`);
    for (const { d, i } of list) out.push(docLine(d, i));
    if (!showDocsOnly) {
      const statements = numbered.filter(({ d }) => d.t === "LAUSUNTO");
      if (statements.length) {
        const names = [...new Set(statements.map(({ d }) => d.l).filter(Boolean))];
        out.push("", `Lausunnot: ${statements.length} kpl${names.length ? `, laatijoita ${names.length}` : ""}. Luettelo: asiakirjatyyppi "lausunto"; tietyn tahon lausunto: laatija-parametrilla.`);
        if (names.length) out.push(`Laatijoita: ${names.slice(0, 40).join("; ")}${names.length > 40 ? " …" : ""}`);
      }
    }
    out.push("", "Asiakirjan teksti: lainvalmistelun_asiakirja-työkalulla (hanke ja asiakirjan numero).");
  } else {
    out.push("", "Hankkeelle ei ole julkaistu asiakirjoja Hankeikkunassa.");
  }
  return clip(out.join("\n"));
}

async function lainvalmistelunAsiakirja(args) {
  const { p } = await loadProject(args.hanke);
  const n = Number(args.asiakirja);
  if (!Number.isInteger(n) || n < 1 || n > p.docs.length) {
    throw new UserError(p.docs.length ? `Asiakirjaa ${args.asiakirja} ei ole. Hankkeessa ${p.tunnus} on ${p.docs.length} asiakirjaa (luettelo lainvalmisteluhanke-työkalulla).` : `Hankkeessa ${p.tunnus} ei ole asiakirjoja.`);
  }
  const d = p.docs[n - 1];
  const out = [`${p.tunnus} ${p.nimi ?? ""}`.trim(), `Asiakirja ${docLine(d, n).replace(/^\d+\.\s*/, "")}`];
  if (d.g.length) out.push(`Ryhmä: ${d.g.join("; ")}`);
  if (d.k) out.push(`Kuvaus: ${d.k}`);
  if (d.u) out.push(`Tiedosto: ${d.u}`);
  out.push(`Hanke: ${projectWebUrl(p.tunnus)} (${HK_SOURCE})`);
  if (!d.u) {
    out.push("", "Asiakirjasta on julkaistu vain viitetiedot, ei tiedostoa.");
    return out.join("\n");
  }
  if (!docKind(d)) {
    out.push("", `Tiedoston tekstiä ei pureta (tyyppi ${d.s ?? "tuntematon"}). Avaa tiedosto linkistä.`);
    return out.join("\n");
  }
  const t = await docText(d);
  if (!t?.text) {
    out.push("", "Tiedostosta ei saatu tekstiä (esimerkiksi skannattu PDF ilman tekstikerrosta). Avaa tiedosto linkistä.");
    return out.join("\n");
  }
  const text = t.text;
  const parts = Math.max(1, Math.ceil(text.length / HK_TEXT_CHUNK));
  out.push(`Teksti: ${fmtCount(text.length)} merkkiä${t.pages ? `, ${t.pages} sivua` : ""}, purettu automaattisesti (muotoilu voi poiketa alkuperäisestä).`);

  const q = String(args.hakusana ?? "").trim();
  if (q) {
    const low = text.toLowerCase();
    const needle = q.toLowerCase();
    const hits = [];
    for (let i = low.indexOf(needle); i >= 0 && hits.length < 30; i = low.indexOf(needle, i + needle.length)) hits.push(i);
    if (!hits.length) {
      out.push("", `Hakusanaa "${q}" ei löytynyt. Kokeile sanan vartaloa.`);
      return out.join("\n");
    }
    out.push("", `Osumat hakusanalle "${q}" (${hits.length}${hits.length === 30 ? "+" : ""}; suluissa tekstin osa):`);
    let lastEnd = -1;
    for (const i of hits) {
      const s = Math.max(0, i - 400);
      const e = Math.min(text.length, i + needle.length + 400);
      if (s < lastEnd) continue; // päällekkäinen osuma näkyy jo edellisessä
      lastEnd = e;
      out.push("", `[osa ${Math.floor(i / HK_TEXT_CHUNK) + 1}] …${text.slice(s, e).replace(/\n+/g, " ")}…`);
    }
    return clip(out.join("\n"));
  }
  const k = Number.isInteger(args.osa) && args.osa > 0 ? args.osa : 1;
  if (k > parts) throw new UserError(`Tekstissä on ${parts} osaa.`);
  if (parts > 1) out.push(`Osa ${k}/${parts}${k < parts ? ` (seuraava: osa ${k + 1})` : ""}.`);
  out.push("");
  out.push(text.slice((k - 1) * HK_TEXT_CHUNK, k * HK_TEXT_CHUNK));
  return clip(out.join("\n"));
}

// ---------- Työehtosopimukset ja viranomaisten määräykset ----------

const PAGE_TEXT_MAX = 40_000;

function lcFold(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tesMatches(c, words) {
  const hay = lcFold(`${c.title} ${c.employer} ${c.employee}`);
  return words.every((w) => hay.includes(w));
}

function currentVersion(c, today) {
  const vs = c.versions ?? [];
  const cur = vs.filter((v) => (!v.a || v.a <= today) && (!v.l || v.l >= today)).sort((a, b) => cmpStr(b.a ?? "", a.a ?? ""))[0];
  return cur ?? null;
}

function tesStatus(c, today) {
  if (c.uni === false) return "ei yleissitova (päätöksen mukaan)";
  const cur = currentVersion(c, today);
  if (cur) return `yleissitova, voimassa oleva sopimus ${dateRange(cur.a, cur.l)}`;
  const last = [...(c.versions ?? [])].sort((a, b) => cmpStr(b.a ?? "", a.a ?? ""))[0];
  if (last?.a && last.a > today) return `yleissitova, seuraava sopimus voimaan ${fmtDate(last.a)}`;
  if (last) return `yleissitova, viimeisin Finlexissä oleva sopimus ${dateRange(last.a, last.l)} (päättynyt; uudempaa ei ole vielä Finlexissä)`;
  return "yleissitova";
}

async function haeTyoehtosopimuksia(args) {
  const all = await tesCatalog();
  const today = finnishToday();
  const q = lcFold(args.hakusana);
  const words = q ? q.split(" ").filter(Boolean) : [];
  let rows = all.filter((c) => (args.kaikki === true || c.uni !== false) && (!words.length || tesMatches(c, words)));
  rows.sort((a, b) => cmpStr(lcFold(a.title), lcFold(b.title)) || b.y - a.y);
  const head = `Yleissitovat työehtosopimukset Finlexissä${q ? ` (hakusana "${args.hakusana}")` : ""}${args.kaikki ? ", myös päättyneet" : ""}: ${rows.length} kpl.`;
  if (!rows.length) return `${head}\n\nEi osumia. Kokeile sanan osaa (esim. "sosiaali") tai liiton nimeä, tai kaikki: true.`;
  const out = [head, ""];
  const compact = !words.length && rows.length > 40;
  for (const c of rows) {
    if (compact) {
      const cur = currentVersion(c, today);
      out.push(`${c.y}/${c.n} ${c.title}${c.employer ? ` (${c.employer}${cur ? `; ${dateRange(cur.a, cur.l)}` : ""})` : ""}`);
    } else {
      out.push(`${c.y}/${c.n} ${c.title}`);
      out.push(`  Työnantaja: ${c.employer ?? "?"} | Työntekijät: ${c.employee ?? "?"}`);
      out.push(`  ${tesStatus(c, today)}`);
    }
  }
  out.push("", "Sopimuksen teksti, pykälät ja soveltamisala: tyoehtosopimus-työkalulla (sopimus: tunniste, esim. \"2020/19\").");
  out.push("Lähde: Finlex, työehtosopimusten yleissitovuuspäätökset (https://www.finlex.fi/fi/viranomaiset/tyoehtosopimukset), CC BY 4.0.");
  return clip(out.join("\n"));
}

async function resolveTes(v) {
  const s = String(v ?? "").trim();
  const all = await tesCatalog();
  const m = s.match(/^(\d{4})\s*\/\s*(\d{1,4})$/) ?? s.match(/^(\d{1,4})\s*\/\s*(\d{4})$/)?.slice(0, 3).reverse();
  if (m) {
    const [y, n] = /^\d{4}$/.test(m[1]) ? [+m[1], String(+m[2])] : [+m[2], String(+m[1])];
    const c = all.find((x) => x.y === y && x.n === n);
    if (!c) throw new UserError(`Yleissitovuuspäätöstä ${y}/${n} ei löytynyt. Hae tunniste hae_tyoehtosopimuksia-työkalulla.`);
    return c;
  }
  const q = lcFold(s);
  if (!q) throw new UserError('Anna sopimuksen tunniste (esim. "2020/19") tai nimi.');
  const exact = all.filter((x) => lcFold(x.title) === q);
  const cands = exact.length ? exact : all.filter((x) => tesMatches(x, q.split(" ")));
  const live = cands.filter((x) => x.uni !== false);
  const pick = live.length ? live : cands;
  if (pick.length === 1) return pick[0];
  if (!pick.length) throw new UserError(`Sopimusta "${s}" ei löytynyt. Hae hae_tyoehtosopimuksia-työkalulla.`);
  throw new UserError(`"${s}" vastaa useaa sopimusta. Valitse tunnisteella:\n${pick.slice(0, 20).map((x) => `- ${x.y}/${x.n} ${x.title}`).join("\n")}`);
}

function pickVersion(c, v, today) {
  const vs = c.versions ?? [];
  if (!vs.length) return null;
  if (v !== undefined && v !== null && String(v).trim() !== "") {
    const s = String(v).trim();
    if (/^\d{1,2}$/.test(s)) {
      const k = +s;
      if (k < 1 || k > vs.length) throw new UserError(`Versiota ${k} ei ole. Sopimuksella on ${vs.length} versiota.`);
      return { v: vs[k - 1], i: k };
    }
    const d = asIsoDate(s, "versio");
    const hit = vs.map((x, i) => ({ v: x, i: i + 1 })).filter(({ v: x }) => (!x.a || x.a <= d) && (!x.l || x.l >= d)).sort((a, b) => cmpStr(b.v.a ?? "", a.v.a ?? ""))[0];
    if (!hit) throw new UserError(`Päivänä ${fmtDate(d)} voimassa ollutta versiota ei ole Finlexissä.`);
    return hit;
  }
  const cur = currentVersion(c, today);
  if (cur) return { v: cur, i: vs.indexOf(cur) + 1 };
  const last = [...vs].sort((a, b) => cmpStr(b.a ?? "", a.a ?? ""))[0];
  return { v: last, i: vs.indexOf(last) + 1 };
}

/** Kappaleet otsikosta seuraavaan (iso kirjain -otsikko tai lyhyt otsikkorivi). */
function paraSection(paras, startRe, max = 6) {
  const i = paras.findIndex((p) => startRe.test(p));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < paras.length && out.length < max; j++) {
    const p = paras[j];
    if (/^[A-ZÅÄÖ ]{6,}$/.test(p) || (p.length < 70 && !/[.:]$/.test(p) && j > i + 1)) break;
    out.push(p);
  }
  return out;
}

function textHits(pages, q, max = 30) {
  const needle = q.toLowerCase();
  const hits = [];
  pages.forEach((p, pi) => {
    const flat = p.replace(/\n+/g, " ");
    const low = flat.toLowerCase();
    let last = -1;
    for (let i = low.indexOf(needle); i >= 0 && hits.length < max; i = low.indexOf(needle, i + needle.length)) {
      if (i < last) continue;
      const s = Math.max(0, i - 350);
      const e = Math.min(flat.length, i + needle.length + 350);
      last = e;
      hits.push(`[s. ${pi + 1}] …${flat.slice(s, e)}…`);
    }
  });
  return hits;
}

function pageRangeText(pages, range) {
  const [a, b] = range;
  const parts = [];
  let len = 0;
  for (let i = a; i <= b; i++) {
    const t = pages[i - 1] ?? "";
    if (len + t.length > PAGE_TEXT_MAX && parts.length) {
      parts.push(`… (katkaistu; jatka sivusta ${i})`);
      break;
    }
    parts.push(`--- sivu ${i} ---\n${t}`);
    len += t.length;
  }
  return parts.join("\n\n");
}

async function tyoehtosopimus(args) {
  const c = await resolveTes(args.sopimus);
  const today = finnishToday();
  const doc = await tesDoc(c.y, c.n);
  const out = [`${c.title} (yleissitovuuspäätös ${c.y}/${c.n})`];
  out.push(`Työnantaja: ${c.employer ?? "?"}`, `Työntekijät: ${c.employee ?? "?"}`);
  out.push(`Tila: ${tesStatus(c, today)}.`);
  out.push(`Lähde: ${tesWebUrl(c.y, c.n)} (Finlex, CC BY 4.0)`);

  const sel = pickVersion(c, args.versio, today);
  const wantsText = args.pykala || args.hakusana || args.sivut;
  if (!wantsText) {
    const paras = doc?.paras ?? [];
    const head = paras.filter((p) => /^(PÄÄTÖS|Antamispäivä|Asian nro)/i.test(p)).slice(0, 3);
    if (head.length) out.push("", `Yleissitovuuspäätös: ${head.join(", ").replace(/Antamispäivä\s*/i, "annettu ")}`);
    const scope = paraSection(paras, /^Sopimuksen soveltamisala$/i, 3);
    if (scope.length) out.push("", "Soveltamisala (päätöksen mukaan):", ...scope);
    const ratk = paraSection(paras, /^RATKAISU$/i, 2);
    if (ratk.length) out.push("", "Ratkaisu:", ...ratk);
  }
  if (c.versions?.length) {
    out.push("", "Sopimusversiot Finlexissä:");
    c.versions.forEach((v, i) => out.push(`${i + 1}. ${v.t}, ${dateRange(v.a, v.l) || "voimassaolo ei tiedossa"}${sel && sel.i === i + 1 ? " ← tässä käytetty" : ""}`));
  }
  if (!sel?.v?.f) {
    out.push("", "Päätökseen ei ole liitetty sopimustekstiä Finlexissä.");
    return clip(out.join("\n"));
  }
  const url = tesFileUrl(c.y, c.n, sel.v.f);
  out.push(`Sopimusteksti (PDF): ${url}`);
  const pdf = await pdfPages(url);
  if (!pdf?.pages?.length) {
    out.push("", "PDF:stä ei saatu tekstiä. Avaa sopimus linkistä.");
    return clip(out.join("\n"));
  }
  const pages = pdf.pages;
  out.push(`Teksti: ${pages.length} sivua, purettu PDF:stä automaattisesti (taulukot ja rivitys voivat poiketa alkuperäisestä; tarkista luvut PDF:stä).`);

  if (args.pykala) {
    const hits = findSections(pages, args.pykala);
    if (!hits.length) {
      out.push("", `Pykälää ${args.pykala} ei tunnistettu sopimustekstistä. Kokeile hakusanaa tai sisällysluetteloa (ilman lisäparametreja).`);
      return clip(out.join("\n"));
    }
    if (hits.length > 1) out.push("", `Pykälä ${args.pykala} esiintyy ${hits.length} kertaa (eri osissa, esim. työehtosopimus, palkkasopimus, liitteet).`);
    for (const h of hits) out.push("", `[PDF:n sivu ${h.page}${h.header ? `, ${h.header}` : ""}]`, h.text);
    return clip(out.join("\n"));
  }
  if (args.hakusana) {
    const hits = textHits(pages, String(args.hakusana));
    out.push("", hits.length ? `Osumat hakusanalle "${args.hakusana}" (${hits.length}${hits.length >= 30 ? "+" : ""}):` : `Hakusanaa "${args.hakusana}" ei löytynyt. Kokeile sanan vartaloa.`);
    for (const h of hits) out.push("", h);
    return clip(out.join("\n"));
  }
  if (args.sivut) {
    const range = parsePages(args.sivut, pages.length);
    if (!range) throw new UserError(`Anna sivut muodossa "12" tai "12-15" (sivuja ${pages.length}).`);
    out.push("", pageRangeText(pages, range));
    return clip(out.join("\n"));
  }
  const toc = tocLines(pages);
  if (toc.length) {
    out.push("", "Sisällysluettelo (sivunumerot ovat sopimuksen omia; PDF:n sivu voi poiketa):", ...toc.slice(0, 250));
  } else {
    out.push("", "Sopimuksen alku:", pages.slice(0, 3).join("\n\n").slice(0, 4000));
  }
  out.push("", "Pykälä: pykala-parametrilla (esim. \"5\"); sanahaku: hakusana; sivualue: sivut (esim. \"49-55\").");
  return clip(out.join("\n"));
}

async function haeViranomaismaarayksia(args) {
  const page = asPage(args.sivu);
  const params = {};
  if (args.otsikko) params.titleContains = String(args.otsikko).trim();
  if (args.asiasana) params.keyword = keywordValue(args.asiasana);
  if (args.alkaen_vuosi) params.startYear = asYear(args.alkaen_vuosi);
  if (args.paattyen_vuosi) params.endYear = asYear(args.paattyen_vuosi);
  if (!params.titleContains && !params.keyword && !params.startYear && !params.endYear) {
    throw new UserError("Anna otsikko, asiasana tai vuosirajaus (määräyksiä on tuhansia).");
  }
  const { ids, full } = await regList(params, page);
  if (!ids.length) return `Viranomaisten määräyksiä ei löytynyt${page > 1 ? " tältä sivulta" : ""}. Kokeile sanan osaa (esim. "omavalvont") tai väljempää rajausta.`;
  const docs = await Promise.all(ids.map((id) => regDoc(id).catch(() => null)));
  const out = [`Viranomaisten määräykset (sivu ${page}, vanhimmasta uusimpaan):`, ""];
  ids.forEach((id, i) => {
    const d = docs[i];
    const bits = [d?.authority, d?.number ? `${d.type ?? "määräys"} ${d.number}`.toLowerCase().replace(/^./, (x) => x.toUpperCase()) : null, d?.entry ? `voimaan ${fmtDate(d.entry)}` : null].filter(Boolean);
    out.push(`${d?.title ?? "(otsikko ei saatavilla)"}${bits.length ? `\n  ${bits.join(" | ")}` : ""}\n  tunnus: ${id.authority}/${id.y}/${id.n}`);
  });
  if (full) out.push("", `Lisää tuloksia voi olla: sivu ${page + 1}, tai rajaa vuosilla.`);
  out.push("", "Määräyksen teksti: viranomaismaarays-työkalulla (maarays: tunnus). Lähde: Finlex, viranomaisten määräyskokoelmat, CC BY 4.0.");
  return clip(out.join("\n"));
}

async function viranomaismaarays(args) {
  const raw = String(args.maarays ?? args.numero ?? "").trim();
  let id = null;
  const full = raw.match(/^([a-z0-9-]+)\/(\d{4})\/(\d{1,7})$/);
  if (full) id = { authority: full[1], y: +full[2], n: full[3] };
  else if (/^\d{1,7}$/.test(raw)) {
    const y = args.vuosi ? asYear(args.vuosi) : null;
    const { ids } = await regList({ documentNumber: raw, ...(y ? { startYear: y, endYear: y } : {}) });
    if (!ids.length) throw new UserError(`Määräystä numerolla ${raw}${y ? ` (${y})` : ""} ei löytynyt Finlexistä.`);
    if (ids.length > 1) {
      throw new UserError(`Numerolla ${raw} löytyi useita määräyksiä (vuodesta 2025 numerointi on viranomaiskohtainen). Valitse tunnuksella:\n${ids.map((x) => `- ${x.authority}/${x.y}/${x.n}`).join("\n")}`);
    }
    id = ids[0];
  } else {
    throw new UserError('Anna määräyksen tunnus hae_viranomaismaarayksia-työkalulta, esim. "national-supervisory-authority-for-welfare-and-health/2024/50504".');
  }
  const n = `${id.authority}/${id.y}/${id.n}`;
  const d = await regDoc(id);
  if (!d) throw new UserError(`Määräyksen ${n} tietoja ei saatu Finlexistä.`);
  const base = regUrl(id.authority, id.y, id.n);
  const out = [d.title ?? "(otsikoton määräys)"];
  if (d.authority) out.push(`Viranomainen: ${d.authority}`);
  if (d.number) out.push(`${d.type ?? "Määräys"}: ${d.number}`);
  if (d.diary) out.push(`Diaarinumero: ${d.diary}`);
  if (d.issued) out.push(`Annettu: ${fmtDate(d.issued)}`);
  if (d.entry) out.push(`Voimaantulo: ${fmtDate(d.entry)}`);
  if (d.endDate) out.push(`Voimassa: ${fmtDate(d.endDate)} asti`);
  if (d.keywords.length) out.push(`Asiasanat: ${d.keywords.join(", ")}`);
  const pdfUrl = d.pdfs.length ? `${base}/${d.pdfs[0].replace(/^\.?\//, "")}` : null;
  out.push(`Lähde: ${pdfUrl ?? base} (Finlex, viranomaisten määräyskokoelmat, CC BY 4.0)`);
  out.push("Voimassaolo: Finlexin metatiedoissa ei aina ole kumoamistietoa; tarkista ajantasaisuus viranomaiselta.");
  if (!pdfUrl) {
    if (d.bodyText.length) out.push("", d.bodyText.join("\n\n"));
    else out.push("", "(Määräykselle ei ole tekstiä Finlexin avoimessa datassa.)");
    return clip(out.join("\n"));
  }
  const pdf = await pdfPages(pdfUrl);
  if (!pdf?.pages?.length) {
    out.push("", "PDF:stä ei saatu tekstiä. Avaa määräys linkistä.");
    return clip(out.join("\n"));
  }
  const pages = pdf.pages;
  out.push(`Teksti: ${pages.length} sivua, purettu PDF:stä automaattisesti.`);
  if (args.hakusana) {
    const hits = textHits(pages, String(args.hakusana));
    out.push("", hits.length ? `Osumat hakusanalle "${args.hakusana}" (${hits.length}${hits.length >= 30 ? "+" : ""}):` : `Hakusanaa "${args.hakusana}" ei löytynyt. Kokeile sanan vartaloa.`);
    for (const h of hits) out.push("", h);
    return clip(out.join("\n"));
  }
  const range = args.sivut ? parsePages(args.sivut, pages.length) : [1, pages.length];
  if (!range) throw new UserError(`Anna sivut muodossa "3" tai "3-6" (sivuja ${pages.length}).`);
  out.push("", pageRangeText(pages, range));
  return clip(out.join("\n"));
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
  eduskuntakasittely: eduskuntakasittely,
  eduskunnan_asiakirja: eduskunnanAsiakirja,
  hae_eduskunnan_asiakirjoja: haeEduskunnanAsiakirjoja,
  eduskunnan_aanestykset: eduskunnanAanestykset,
  kirjallinen_kysymys: kirjallinenKysymys,
  hae_lainvalmisteluhankkeita: haeLainvalmisteluhankkeita,
  lainvalmisteluhanke: lainvalmisteluhanke,
  lainvalmistelun_asiakirja: lainvalmistelunAsiakirja,
  hae_tyoehtosopimuksia: haeTyoehtosopimuksia,
  tyoehtosopimus: tyoehtosopimus,
  hae_viranomaismaarayksia: haeViranomaismaarayksia,
  viranomaismaarays: viranomaismaarays,
  viranomaistiedotteet,
  viranomaistiedote,
  hae_vero_ohjeita: haeVeroOhjeita,
  hae_viranomaisohjeita: haeViranomaisohjeita,
  viranomaisohje,
  hae_kila_lausuntoja: haeKilaLausuntoja,
  kila_lausunto: kilaLausunto,
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
        : e instanceof EduskuntaError
          ? `Eduskunnan rajapinnan haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : e instanceof KilaError
          ? `Kirjanpitolautakunnan sivuston haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : e instanceof OhjeUserError
          ? e.message
          : e instanceof OhjeError
          ? `Ohjeen haku viranomaisen sivustolta epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : e instanceof TiedoteError
          ? `Tiedotteiden haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : e instanceof HankeikkunaError
          ? `Hankeikkunan haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : e instanceof FinlexError
          ? `Finlex-haku epäonnistui: ${e.message}. Yritä hetken päästä uudelleen.`
          : `Odottamaton virhe: ${e?.message ?? e}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

export { futureWarning, excerpts };
